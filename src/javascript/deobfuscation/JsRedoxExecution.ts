import { constants } from "node:fs";
import { access, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TextDecoder } from "node:util";

import type { AnalysisExecution } from "../../application/AnalysisProvider.js";
import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisCancelledError,
  AnalysisOutputError,
  AnalysisTimeoutError,
} from "../../domain/analysisErrorCore.js";
import type { JavaScriptDeobfuscationInput } from "../../domain/javascript/javascriptDeobfuscation.js";
import type { ProviderProcessSnapshot } from "../../process/ProviderProcess.js";
import {
  JS_REDOX_LIMITS,
  JS_REDOX_PROVIDER_IDENTITY,
  JS_REDOX_RELEASE,
} from "./JsRedoxRelease.js";
import {
  parseJsRedoxReport,
  parseJsRedoxVersion,
  validateJsRedoxReport,
} from "./JsRedoxProtocol.js";
import {
  publishJsRedox,
  type JsRedoxEngineIdentity,
} from "./JsRedoxPublication.js";

const OPERATION = "deobfuscate_javascript_source";

export interface JsRedoxEngine extends JsRedoxEngineIdentity {
  readonly limiter: string;
  readonly executable: Buffer;
}

interface StableSource {
  readonly bytes: Buffer;
  readonly sha256: string;
}

export interface JsRedoxRunRequest {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

export const executeJsRedox = async (input: {
  readonly request: JavaScriptDeobfuscationInput;
  readonly signal?: AbortSignal;
  readonly engine: JsRedoxEngine;
  readonly source: StableSource;
  readonly runtimePath: string;
  readonly tree: SafeOutputTree;
  readonly run: (
    request: JsRedoxRunRequest,
  ) => Promise<ProviderProcessSnapshot>;
}): Promise<AnalysisExecution> => {
  const snapshotPath = join(input.runtimePath, "source.js");
  const versionEnginePath = await snapshotEngine(input, "version");
  const outputPath = join(input.runtimePath, "deobfuscated.js");
  const reportPath = join(input.runtimePath, "report.json");
  assertActive(input.signal);
  await writeFile(snapshotPath, input.source.bytes, {
    flag: "wx",
    mode: 0o600,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const deadlineAt = Date.now() + JS_REDOX_LIMITS.timeoutMs;
  const runWithinDeadline = (command: string, arguments_: readonly string[]) =>
    input.run({
      command,
      arguments: arguments_,
      cwd: input.runtimePath,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      timeoutMs: remainingTimeoutMs(deadlineAt),
    });

  const versionRun = await runWithinDeadline(versionEnginePath, ["--version"]);
  const version = parseJsRedoxVersion(versionRun.stdout.text);
  if (version !== JS_REDOX_RELEASE.version)
    throw new AnalysisCapabilityUnavailableError(
      JS_REDOX_PROVIDER_IDENTITY.id,
      OPERATION,
      `Unsupported js-redox version ${version ?? (versionRun.stdout.text.trim() || "missing")}; verified version is ${JS_REDOX_RELEASE.version}.`,
      {
        userMessage: `Provide js-redox deobfuscate-safe ${JS_REDOX_RELEASE.version}.`,
      },
    );

  // runOwnedCommand has settled the complete version process family. A fresh
  // exclusive copy cannot follow a pathname the version probe replaced.
  const transformEnginePath = await snapshotEngine(input, "transform");
  const executionRun = await runWithinDeadline(transformEnginePath, [
    snapshotPath,
    outputPath,
    "--report",
    reportPath,
    "--max-iterations",
    String(input.request.max_iterations),
  ]);
  const output = await readStableArtifact(
    outputPath,
    JS_REDOX_LIMITS.outputBytes,
    input.signal,
  );
  assertUtf8JavaScript(output.bytes);
  const reportFile = await readStableArtifact(
    reportPath,
    JS_REDOX_LIMITS.reportBytes,
    input.signal,
  );
  const report = parseJsRedoxReport(reportFile.bytes);
  validateJsRedoxReport(report, {
    inputSha256: input.source.sha256,
    outputSha256: output.sha256,
    changed: output.sha256 !== input.source.sha256,
    maxIterations: input.request.max_iterations,
  });
  await assertInputsUnchanged(
    input.request.path,
    input.source.sha256,
    input.engine,
    input.signal,
  );
  return publishJsRedox({
    sourcePath: input.request.path,
    maxIterations: input.request.max_iterations,
    tree: input.tree,
    source: input.source,
    output,
    reportFile,
    report,
    engine: input.engine,
    version,
    versionRun,
    executionRun,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
};

const assertUtf8JavaScript = (bytes: Buffer): void => {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause: unknown) {
    throw new AnalysisOutputError(
      OPERATION,
      "js-redox returned transformed JavaScript that is not valid UTF-8.",
      { cause },
    );
  }
};

const snapshotEngine = async (
  input: {
    readonly runtimePath: string;
    readonly engine: JsRedoxEngine;
    readonly signal?: AbortSignal;
  },
  phase: "version" | "transform",
): Promise<string> => {
  const enginePath = join(input.runtimePath, `deobfuscate-safe-${phase}`);
  assertActive(input.signal);
  await writeFile(enginePath, input.engine.executable, {
    flag: "wx",
    mode: 0o700,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  try {
    // Linux access(X_OK) also checks the filesystem's noexec mount policy.
    await access(enginePath, constants.X_OK);
  } catch (cause: unknown) {
    assertActive(input.signal);
    throw new AnalysisCapabilityUnavailableError(
      JS_REDOX_PROVIDER_IDENTITY.id,
      OPERATION,
      "The private js-redox snapshot is not executable. Select an exec-capable TMPDIR; noexec runtime mounts are unsupported.",
      {
        cause,
        userMessage:
          "Set TMPDIR to a writable exec-capable filesystem and retry.",
      },
    );
  }
  const snapshot = await readStableArtifact(
    enginePath,
    JS_REDOX_LIMITS.executableBytes,
    input.signal,
  );
  if (
    snapshot.sha256 !== input.engine.sha256 ||
    snapshot.bytes.length !== input.engine.bytes
  )
    throw new AnalysisOutputError(
      OPERATION,
      "Owned js-redox executable snapshot disagrees with the fingerprinted engine bytes.",
    );
  return enginePath;
};

const remainingTimeoutMs = (deadlineAt: number): number => {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0)
    throw new AnalysisTimeoutError(OPERATION, JS_REDOX_LIMITS.timeoutMs);
  return Math.max(1, remaining);
};

const assertActive = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new AnalysisCancelledError(OPERATION);
};

const assertInputsUnchanged = async (
  sourcePath: string,
  sourceSha256: string,
  engine: JsRedoxEngine,
  signal?: AbortSignal,
): Promise<void> => {
  if ((await realpath(engine.configuredCommand)) !== engine.command)
    throw new AnalysisOutputError(
      OPERATION,
      "Configured js-redox executable selection changed during deobfuscation.",
    );
  const currentSource = await readStableArtifact(
    sourcePath,
    JS_REDOX_LIMITS.inputBytes,
    signal,
  );
  const currentEngine = await readStableArtifact(
    engine.command,
    JS_REDOX_LIMITS.executableBytes,
    signal,
  );
  if (currentSource.sha256 !== sourceSha256)
    throw new AnalysisOutputError(
      OPERATION,
      `Original input changed during deobfuscation: ${sourcePath}`,
    );
  if (currentEngine.sha256 !== engine.sha256)
    throw new AnalysisOutputError(
      OPERATION,
      "Configured js-redox executable changed during deobfuscation.",
    );
};
