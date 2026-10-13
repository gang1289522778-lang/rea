import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";

import { z } from "zod";

import {
  createAnalysisExecution,
  type AnalysisClient,
  type AnalysisProvider,
  type CapabilityDescriptor,
  type ExecutionOptions,
  type ProviderIdentity,
} from "../application/AnalysisProvider.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  MAX_WINDOWS_WINDOW_PNG_BYTES,
  windowsWindowPngSchema,
  windowsWindowHandleSchema,
  windowsWindowScreenshotInputSchema,
  windowsWindowScreenshotResultSchema,
  type WindowsWindowScreenshotResult,
} from "../domain/native/windowsWindowScreenshot.js";
import { err, ok, type Result } from "../domain/result.js";
import { requireWindowsNativeAuthority } from "./WindowsNativeLoader.js";
import {
  NATIVE_WINDOWS_UI_PROVIDER_IDENTITY as IDENTITY,
  nativeWindowsUiCapabilities,
} from "./NativeWindowsUiProviderMetadata.js";

const OPERATION = "capture_windows_window_screenshot" as const;
const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;

const rawCaptureSchema = z.strictObject({
  pid: z.number().int().positive(),
  window_handle: windowsWindowHandleSchema,
  process_image_path: z.string().min(1),
  process_start_time_unix_ms: z.number().int().nonnegative(),
  title: z.string(),
  source_width: z
    .number()
    .int()
    .positive()
    .max(4 * 1024 * 1024),
  source_height: z
    .number()
    .int()
    .positive()
    .max(4 * 1024 * 1024),
  width: z.number().int().positive().max(4096),
  height: z.number().int().positive().max(4096),
  png: z.custom<Buffer>(Buffer.isBuffer, "Expected a native PNG buffer"),
});

const captureWorkSchema = z.strictObject({
  completion: z.custom<Promise<unknown>>((value) => value instanceof Promise),
  cancel: z.custom<() => void>((value) => typeof value === "function"),
});

interface ExecutableIdentity {
  readonly fileIdentity: string;
  readonly sha256: string;
}

/** Narrow test seam: no test needs a Windows desktop or a packaged addon. */
export interface WindowsWindowCaptureHost {
  capture(
    pid: number,
    windowHandle: string,
    maximumDimension: number,
    targetIdentity: {
      readonly path: string;
      readonly sha256: string;
      readonly fileIdentity: string;
    },
    signal?: AbortSignal,
  ): unknown;
  identifyExecutable(
    path: string,
    signal?: AbortSignal,
  ): Promise<ExecutableIdentity>;
}

const systemCaptureHost = (): WindowsWindowCaptureHost => ({
  capture: async (
    pid,
    windowHandle,
    maximumDimension,
    targetIdentity,
    signal,
  ) => {
    let authority: ReturnType<typeof requireWindowsNativeAuthority>;
    try {
      authority = requireWindowsNativeAuthority();
    } catch (cause) {
      throw new AnalysisCapabilityUnavailableError(
        IDENTITY.id,
        OPERATION,
        nativeFailureReason(cause),
        { cause },
      );
    }
    const work = captureWorkSchema.parse(
      authority.call("capture_window_png", [
        pid,
        windowHandle,
        maximumDimension,
        targetIdentity.path,
        targetIdentity.sha256,
        targetIdentity.fileIdentity,
      ]),
    );
    const cancel = () => work.cancel();
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
    try {
      // Await settlement so cancellation cannot abandon native surfaces or COM
      // resources while the bounded paint request still uses them.
      return await work.completion;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  },
  identifyExecutable: hashExecutable,
});

/** Optional auxiliary provider for one passive, target-bound Windows PNG observation. */
export class NativeWindowsUiProvider implements AnalysisProvider {
  readonly #capabilities: readonly CapabilityDescriptor[];

  constructor(
    private readonly captureHost: WindowsWindowCaptureHost = systemCaptureHost(),
    platform: NodeJS.Platform = process.platform,
  ) {
    this.#capabilities = nativeWindowsUiCapabilities(platform);
  }

  identity(): ProviderIdentity {
    return IDENTITY;
  }

  capabilities(): readonly CapabilityDescriptor[] {
    return this.#capabilities;
  }

  createClient(target: BinaryTarget): AnalysisClient {
    return {
      execute: async (operation, parameters, options) => {
        if (operation === "health")
          return ok(createAnalysisExecution(null, IDENTITY));
        if (operation !== OPERATION)
          return err(
            new AnalysisCapabilityUnavailableError(
              IDENTITY.id,
              operation,
              "Operation is not implemented by the Windows selected-window adapter.",
            ),
          );
        const result = await captureWindowsWindowScreenshot(
          target,
          parameters,
          this.captureHost,
          options,
        );
        return result.ok
          ? ok(
              createAnalysisExecution(result.value, IDENTITY, {
                limitations: [
                  "One target-bound client-area frame was requested through WM_PRINT; no desktop, region, title-search, or input fallback exists.",
                  "GPU-composited, minimized, protected, elevated, or custom-drawn windows can refuse or incompletely render WM_PRINT; a successful PNG does not prove what was visible on a physical display.",
                  "WM_PRINT can execute the selected process's paint handler, which can change UI state or cause target filesystem and network effects. The title and PNG can contain private application data and REA retains them only in returned Evidence for this selected window.",
                  "The selected on-disk executable matched the active target before and after capture. That comparison does not prove every byte originally mapped into the process.",
                ],
              }),
            )
          : result;
      },
      close: async () => ok(null),
    };
  }
}

/** Validate target identity around one short native capture without broad fallback. */
export const captureWindowsWindowScreenshot = async (
  target: BinaryTarget,
  parameters: Readonly<Record<string, unknown>>,
  host: WindowsWindowCaptureHost = systemCaptureHost(),
  options: ExecutionOptions = {},
): Promise<Result<WindowsWindowScreenshotResult, AnalysisError>> => {
  if (options.signal?.aborted)
    return err(new AnalysisCancelledError(OPERATION));
  const input = windowsWindowScreenshotInputSchema.safeParse(parameters);
  if (!input.success)
    return err(
      analysisInputErrorFromIssues(OPERATION, input.error.issues, parameters, {
        cause: input.error,
      }),
    );
  if (
    target.kind !== "executable" ||
    target.format !== "pe" ||
    target.executableRole !== "application"
  )
    return err(
      new AnalysisCapabilityUnavailableError(
        IDENTITY.id,
        OPERATION,
        "Selected-window capture requires an active PE application target.",
      ),
    );
  let before: ExecutableIdentity;
  try {
    before = await host.identifyExecutable(target.path, options.signal);
  } catch (cause) {
    return err(identityError(target.path, cause));
  }
  if (before.sha256 !== target.sha256)
    return err(
      new AnalysisArtifactChangedError(
        OPERATION,
        target.path,
        "The active target bytes no longer match its opened SHA-256 identity.",
      ),
    );
  if (options.signal?.aborted)
    return err(new AnalysisCancelledError(OPERATION));

  let reply: unknown;
  try {
    reply = await host.capture(
      input.data.pid,
      input.data.window_handle,
      input.data.max_dimension,
      {
        path: target.path,
        sha256: target.sha256,
        fileIdentity: before.fileIdentity,
      },
      options.signal,
    );
  } catch (cause) {
    return err(
      captureFailure(
        target.path,
        input.data.pid,
        input.data.window_handle,
        cause,
      ),
    );
  }
  const parsed = rawCaptureSchema.safeParse(reply);
  if (!parsed.success)
    return err(
      new AnalysisOutputError(
        OPERATION,
        "Native capture returned malformed output.",
        { cause: parsed.error },
      ),
    );
  const raw = parsed.data;
  if (options.signal?.aborted)
    return err(new AnalysisCancelledError(OPERATION));
  if (
    raw.pid !== input.data.pid ||
    raw.window_handle !== input.data.window_handle
  )
    return err(
      new AnalysisOutputError(
        OPERATION,
        "Native capture returned a different process or window handle.",
      ),
    );
  if (
    raw.width > input.data.max_dimension ||
    raw.height > input.data.max_dimension ||
    raw.width > raw.source_width ||
    raw.height > raw.source_height ||
    raw.source_width * raw.source_height > 4 * 1024 * 1024
  )
    return err(
      new AnalysisOutputError(
        OPERATION,
        "Native capture violated the declared pixel bounds.",
      ),
    );

  let afterTarget: ExecutableIdentity;
  let processImage: ExecutableIdentity;
  try {
    [afterTarget, processImage] = await Promise.all([
      host.identifyExecutable(target.path, options.signal),
      host.identifyExecutable(raw.process_image_path, options.signal),
    ]);
  } catch (cause) {
    return err(identityError(target.path, cause));
  }
  if (options.signal?.aborted)
    return err(new AnalysisCancelledError(OPERATION));
  if (
    afterTarget.sha256 !== target.sha256 ||
    afterTarget.fileIdentity !== before.fileIdentity
  )
    return err(
      new AnalysisArtifactChangedError(
        OPERATION,
        target.path,
        "The active target path or bytes changed during capture.",
      ),
    );
  if (
    processImage.sha256 !== target.sha256 ||
    processImage.fileIdentity !== before.fileIdentity
  )
    return err(
      analysisInputErrorFromIssues(
        OPERATION,
        [
          {
            path: ["pid"],
            code: "custom",
            message: "Selected PID does not map to the active PE target bytes.",
          },
        ],
        parameters,
      ),
    );

  try {
    const screenshot = windowsWindowPngSchema.parse({
      media_type: "image/png",
      data_base64: raw.png.toString("base64"),
      sha256: createHash("sha256").update(raw.png).digest("hex"),
      bytes: raw.png.byteLength,
      width: raw.width,
      height: raw.height,
      source_width: raw.source_width,
      source_height: raw.source_height,
    });
    return ok(
      windowsWindowScreenshotResultSchema.parse({
        target_sha256: target.sha256,
        window: {
          pid: raw.pid,
          window_handle: raw.window_handle,
          executable: target.path,
          process_image_path: raw.process_image_path,
          process_start_time_unix_ms: raw.process_start_time_unix_ms,
          title: raw.title,
        },
        screenshot,
        gaps: [
          "Accessibility-tree capture and UI actions are unavailable in this screenshot-only Windows capability.",
        ],
      }),
    );
  } catch (cause) {
    return err(
      new AnalysisOutputError(
        OPERATION,
        "Native capture returned an invalid PNG result.",
        { cause },
      ),
    );
  }
};

const hashExecutable = async (
  path: string,
  signal?: AbortSignal,
): Promise<ExecutableIdentity> => {
  const resolvedPath = await realpath(path);
  const handle = await open(resolvedPath, "r");
  try {
    const metadata = await handle.stat({ bigint: true });
    if (metadata.ino === 0n)
      throw new AnalysisOutputError(
        OPERATION,
        "The host did not report stable executable file identity.",
      );
    if (metadata.size > BigInt(MAX_EXECUTABLE_BYTES))
      throw new AnalysisResourceConstraintError(
        OPERATION,
        "file-size",
        "Selected executable exceeds the 256 MiB target-identity budget.",
        { maximum_bytes: MAX_EXECUTABLE_BYTES },
      );
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    const size = Number(metadata.size);
    while (position < size) {
      if (signal?.aborted) throw new AnalysisCancelledError(OPERATION);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.byteLength,
        position,
      );
      if (signal?.aborted) throw new AnalysisCancelledError(OPERATION);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (signal?.aborted) throw new AnalysisCancelledError(OPERATION);
    if (position !== size)
      throw new Error(
        "Selected executable changed while its identity was read",
      );
    return {
      fileIdentity: `${String(metadata.dev)}:${String(metadata.ino)}`,
      sha256: digest.digest("hex"),
    };
  } finally {
    await handle.close();
  }
};

const identityError = (path: string, cause: unknown): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  const filesystem = z.object({ code: z.string() }).safeParse(cause);
  if (filesystem.success) {
    if (filesystem.data.code === "EACCES" || filesystem.data.code === "EPERM")
      return new AnalysisAccessDeniedError(
        OPERATION,
        path,
        filesystem.data.code,
        { cause },
      );
    if (filesystem.data.code === "ENOENT")
      return new AnalysisArtifactChangedError(
        OPERATION,
        path,
        "Selected executable is no longer available.",
        { cause },
      );
  }
  return new AnalysisOutputError(
    OPERATION,
    `Cannot establish selected executable identity: ${cause instanceof Error ? cause.message : String(cause)}`,
    { cause },
  );
};

const nativeFailureReason = (cause: unknown): string =>
  cause instanceof Error && cause.message.length > 0
    ? cause.message
    : "Selected window capture is unavailable on this host.";

/** Only the addon-loading owner produces capability errors; native failures stay request-scoped. */
const captureFailure = (
  path: string,
  pid: number,
  windowHandle: string,
  cause: unknown,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  const native = z
    .object({
      win32Code: z.number().int().nonnegative(),
      requestedPath: z.string().exactOptional(),
      failureKind: z
        .enum([
          "artifact_changed",
          "window_owner_mismatch",
          "process_identity_mismatch",
        ])
        .exactOptional(),
    })
    .safeParse(cause);
  if (!native.success)
    return new AnalysisOutputError(OPERATION, nativeFailureReason(cause), {
      cause,
    });
  if (native.data.failureKind === "artifact_changed")
    return new AnalysisArtifactChangedError(
      OPERATION,
      path,
      nativeFailureReason(cause),
      { cause },
    );
  if (
    native.data.failureKind === "window_owner_mismatch" ||
    native.data.failureKind === "process_identity_mismatch"
  ) {
    const field =
      native.data.failureKind === "window_owner_mismatch"
        ? "window_handle"
        : "pid";
    return analysisInputErrorFromIssues(
      OPERATION,
      [{ path: [field], code: "custom", message: nativeFailureReason(cause) }],
      { pid, window_handle: windowHandle },
      { cause },
    );
  }
  const code = native.data.win32Code;
  if (code === 995) return new AnalysisCancelledError(OPERATION, { cause });
  if (
    code === 5 &&
    native.data.requestedPath !== undefined &&
    native.data.requestedPath.length > 0
  )
    return new AnalysisAccessDeniedError(
      OPERATION,
      native.data.requestedPath,
      "EACCES",
      { cause },
    );
  if (code === 1460 || code === 258)
    return new AnalysisTimeoutError(OPERATION, 5000, { cause });
  // STG_E_MEDIUMFULL is the fixed retained PNG stream's capacity refusal.
  if (code === 0x80030070)
    return new AnalysisResourceConstraintError(
      OPERATION,
      "capacity",
      nativeFailureReason(cause),
      { maximum_png_bytes: MAX_WINDOWS_WINDOW_PNG_BYTES },
      { cause, remediationAction: "Retry with a smaller max_dimension." },
    );
  // Native allocation failures and HRESULT_FROM_WIN32 allocation failures.
  if ([8, 14, 1455, 0x8007000e, 0x80070008].includes(code))
    return new AnalysisResourceConstraintError(
      OPERATION,
      "memory",
      nativeFailureReason(cause),
      null,
      { cause },
    );
  if (code === 1400 || code === 6 || code === 87)
    return analysisInputErrorFromIssues(
      OPERATION,
      [
        {
          path: ["window_handle"],
          code: "custom",
          message: nativeFailureReason(cause),
        },
      ],
      { pid, window_handle: windowHandle },
      { cause },
    );
  return new AnalysisOutputError(OPERATION, nativeFailureReason(cause), {
    cause,
  });
};
