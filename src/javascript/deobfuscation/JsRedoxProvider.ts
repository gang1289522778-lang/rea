import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { TextDecoder } from "node:util";
import type { JavaScriptDeobfuscationPort } from "../../application/javascript/JavaScriptDeobfuscationPort.js";
import type {
  AnalysisExecution,
  ExecutionOptions,
} from "../../application/AnalysisProvider.js";
import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import { SafeOutputTreeCreationFailure } from "../../artifacts/SafeOutputTreeCreationFailure.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisTimeoutError,
} from "../../domain/analysisErrorCore.js";
import type { JavaScriptDeobfuscationInput } from "../../domain/javascript/javascriptDeobfuscation.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../../process/OwnedCommand.js";
import { PrivateRuntimeRoot } from "../../process/PrivateRuntimeRoot.js";
import { readLinuxResourceLimits } from "../../process/LinuxResourceLimits.js";
import type { ProviderProcessSupervisor } from "../../process/ProviderProcess.js";
import {
  JS_REDOX_LIMITS,
  JS_REDOX_PROVIDER_IDENTITY,
} from "./JsRedoxRelease.js";
import { executeJsRedox, type JsRedoxRunRequest } from "./JsRedoxExecution.js";

const OPERATION = "deobfuscate_javascript_source";
const HOST_REQUIREMENT =
  "On Linux x64, provide an absolute REA_JS_REDOX_COMMAND pointing to js-redox deobfuscate-safe 0.1.0, util-linux prlimit, and an executable private runtime filesystem (TMPDIR must not be mounted noexec).";

export type JsRedoxLauncher = NonNullable<
  Parameters<typeof runOwnedCommand>[2]
>["launcher"];

type PendingCleanup = {
  root: Pick<PrivateRuntimeRoot, "path" | "close"> | undefined;
  process: ProviderProcessSupervisor | undefined;
  tree: SafeOutputTree | undefined;
};

/** Caller-supplied js-redox adapter for proof-gated static JavaScript rewriting. */
export class JsRedoxProvider implements JavaScriptDeobfuscationPort {
  #tail: Promise<void> = Promise.resolve();
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #pendingCleanup: PendingCleanup | undefined;

  constructor(
    readonly environment: Readonly<NodeJS.ProcessEnv> = process.env,
    readonly launcher?: JsRedoxLauncher,
    readonly createRuntime: () => Promise<
      Pick<PrivateRuntimeRoot, "path" | "close">
    > = () => PrivateRuntimeRoot.create({ prefix: "rea-js-redox-" }),
  ) {}

  deobfuscate(
    input: JavaScriptDeobfuscationInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (this.#closing) return Promise.resolve(err(this.#closedError()));
    const operation = this.#tail.then(() =>
      this.#closing
        ? err(this.#closedError())
        : this.#deobfuscate(input, options),
    );
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #deobfuscate(
    input: JavaScriptDeobfuscationInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const pending = await this.#retire();
    if (pending !== undefined) return err(pending);
    let root: Pick<PrivateRuntimeRoot, "path" | "close"> | undefined;
    let tree: SafeOutputTree | undefined;
    let processOwner: ProviderProcessSupervisor | undefined;
    let execution: AnalysisExecution | undefined;
    let failure: unknown;
    try {
      if (options?.signal?.aborted) throw new AnalysisCancelledError(OPERATION);
      const engine = await this.#resolveEngine(options?.signal);
      const source = await this.#readInput(input.path, options?.signal);
      root = await this.createRuntime();
      try {
        tree = await SafeOutputTree.create(input.output_directory);
      } catch (cause: unknown) {
        if (cause instanceof SafeOutputTreeCreationFailure) tree = cause.tree;
        throw new AnalysisInputError(OPERATION, { cause }, [
          {
            path: ["output_directory"],
            reason: "invalid_value",
            message: `Cannot create new deobfuscation directory ${input.output_directory}: ${failureMessage(cause)}`,
          },
        ]);
      }
      execution = await executeJsRedox({
        request: input,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        engine,
        source,
        runtimePath: root.path,
        tree,
        run: (request) => this.#run(engine, request),
      });
      await root.close();
      root = undefined;
      if (options?.signal?.aborted) throw new AnalysisCancelledError(OPERATION);
      await tree.commit(options?.signal);
    } catch (cause: unknown) {
      failure = cause;
      if (cause instanceof OwnedCommandFailure)
        processOwner = cause.cleanupOwner;
    }
    if (failure === undefined)
      return execution === undefined
        ? err(
            new AnalysisOutputError(
              OPERATION,
              "Deobfuscation returned no execution",
            ),
          )
        : ok(execution);

    return this.#handleFailure({
      failure,
      root,
      tree,
      processOwner,
      execution,
      signal: options?.signal,
    });
  }

  async #handleFailure(state: {
    readonly failure: unknown;
    readonly root: Pick<PrivateRuntimeRoot, "path" | "close"> | undefined;
    readonly tree: SafeOutputTree | undefined;
    readonly processOwner: ProviderProcessSupervisor | undefined;
    readonly execution: AnalysisExecution | undefined;
    readonly signal: AbortSignal | undefined;
  }): Promise<Result<AnalysisExecution, AnalysisError>> {
    let failedTree: SafeOutputTree | undefined;
    if (state.tree !== undefined) {
      try {
        await state.tree.rollback();
      } catch {
        failedTree = state.tree;
      }
    }
    let failedRoot = state.root;
    if (failedRoot !== undefined && state.processOwner === undefined) {
      try {
        await failedRoot.close();
        failedRoot = undefined;
      } catch {
        // Retain ownership for close() retry below.
      }
    }
    if (
      state.processOwner !== undefined ||
      failedTree !== undefined ||
      failedRoot !== undefined
    ) {
      this.#pendingCleanup = {
        root: failedRoot,
        process: state.processOwner,
        tree: failedTree,
      };
      return err(
        this.#cleanupError(
          state.failure,
          failedRoot,
          failedTree,
          state.processOwner,
        ),
      );
    }
    if (state.tree?.published === true && state.execution !== undefined)
      return ok(state.execution);
    return err(this.#projectFailure(state.failure, state.signal));
  }

  #cleanupError(
    failure: unknown,
    root: Pick<PrivateRuntimeRoot, "path" | "close"> | undefined,
    tree: SafeOutputTree | undefined,
    processOwner: ProviderProcessSupervisor | undefined,
  ): ProviderCleanupError {
    return new ProviderCleanupError(
      JS_REDOX_PROVIDER_IDENTITY.id,
      [
        ...(processOwner === undefined
          ? []
          : [processOwner.launch.ownership?.runId ?? "js-redox-worker"]),
        ...(tree === undefined ? [] : [tree.outputRoot]),
        ...(root === undefined ? [] : [root.path]),
      ],
      { previous_error: failureMessage(failure) },
      { operation: OPERATION, cause: failure },
    );
  }

  async #resolveEngine(signal?: AbortSignal) {
    const configured = this.environment.REA_JS_REDOX_COMMAND;
    const limiter =
      this.environment.REA_JAVASCRIPT_PRLIMIT_COMMAND ?? "/usr/bin/prlimit";
    if (
      process.platform !== "linux" ||
      process.arch !== "x64" ||
      configured === undefined ||
      !isAbsolute(configured) ||
      !isAbsolute(limiter)
    )
      throw new AnalysisCapabilityUnavailableError(
        JS_REDOX_PROVIDER_IDENTITY.id,
        OPERATION,
        HOST_REQUIREMENT,
        { userMessage: HOST_REQUIREMENT },
      );
    try {
      const command = await realpath(configured);
      await access(command, constants.R_OK | constants.X_OK);
      await access(limiter, constants.X_OK);
      if (!(await stat(limiter)).isFile())
        throw new TypeError(
          `Resource limiter is not a regular file: ${limiter}`,
        );
      const executable = await readStableArtifact(
        command,
        JS_REDOX_LIMITS.executableBytes,
        signal,
      );
      return {
        configuredCommand: configured,
        command,
        limiter,
        sha256: executable.sha256,
        bytes: executable.bytes.length,
        executable: executable.bytes,
      };
    } catch (cause: unknown) {
      if (signal?.aborted) throw new AnalysisCancelledError(OPERATION);
      const reason = `Configured js-redox or util-linux prlimit is unavailable: ${failureMessage(cause)}`;
      throw new AnalysisCapabilityUnavailableError(
        JS_REDOX_PROVIDER_IDENTITY.id,
        OPERATION,
        reason,
        { cause, userMessage: reason },
      );
    }
  }

  async #readInput(path: string, signal?: AbortSignal) {
    try {
      const source = await readStableArtifact(
        path,
        JS_REDOX_LIMITS.inputBytes,
        signal,
      );
      new TextDecoder("utf-8", { fatal: true }).decode(source.bytes);
      return source;
    } catch (cause: unknown) {
      if (signal?.aborted) throw new AnalysisCancelledError(OPERATION);
      throw new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Cannot read stable UTF-8 JavaScript input ${path}: ${failureMessage(cause)}`,
        },
      ]);
    }
  }

  async #run(engine: { limiter: string }, request: JsRedoxRunRequest) {
    const limits = await readLinuxResourceLimits({
      address_space_bytes: JS_REDOX_LIMITS.addressSpaceBytes,
      file_bytes: JS_REDOX_LIMITS.outputBytes,
      cpu_seconds: JS_REDOX_LIMITS.cpuSeconds,
    });
    return runOwnedCommand(
      {
        command: engine.limiter,
        arguments: [
          `--as=${String(limits.address_space_bytes)}`,
          `--fsize=${String(limits.file_bytes)}`,
          "--core=0",
          `--cpu=${String(limits.cpu_seconds)}`,
          "--",
          request.command,
          ...request.arguments,
        ],
        expectedCommand: null,
        runId: `rea-js-redox-${randomUUID()}`,
        cwd: request.cwd,
        hostEnvironment: this.environment,
        env: { TMPDIR: request.cwd, RAYON_NUM_THREADS: "1", NO_COLOR: "1" },
      },
      {
        timeoutMs: request.timeoutMs,
        diagnosticBytes: JS_REDOX_LIMITS.diagnosticBytes,
      },
      {
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(this.launcher === undefined ? {} : { launcher: this.launcher }),
      },
    );
  }

  #projectFailure(cause: unknown, signal?: AbortSignal): AnalysisError {
    if (cause instanceof AnalysisError) return cause;
    if (signal?.aborted)
      return new AnalysisCancelledError(OPERATION, { cause });
    if (cause instanceof OwnedCommandFailure) {
      if (cause.reason === "cancelled")
        return new AnalysisCancelledError(OPERATION, { cause });
      if (cause.reason === "timeout")
        return new AnalysisTimeoutError(OPERATION, JS_REDOX_LIMITS.timeoutMs, {
          cause,
        });
      if (cause.reason === "output-limit")
        return new AnalysisOutputError(OPERATION, cause.message, { cause });
    }
    return new ProviderAdapterError(JS_REDOX_PROVIDER_IDENTITY.id, OPERATION, {
      cause,
      diagnostics:
        cause instanceof OwnedCommandFailure
          ? ownedCommandDiagnostics(cause)
          : { reason: failureMessage(cause) },
    });
  }

  #closedError(): ProviderCleanupError {
    return new ProviderCleanupError(
      JS_REDOX_PROVIDER_IDENTITY.id,
      [],
      { reason: "Provider is closing" },
      { operation: OPERATION },
    );
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#closePromise ??= this.#tail
      .then(async () => {
        const failure = await this.#retire();
        if (failure !== undefined) throw failure;
      })
      .catch((cause: unknown) => {
        this.#closePromise = undefined;
        throw cause;
      });
    return this.#closePromise;
  }

  async #retire(): Promise<ProviderCleanupError | undefined> {
    const pending = this.#pendingCleanup;
    if (pending === undefined) return undefined;
    if (pending.process !== undefined) {
      const stopped = await pending.process.stop();
      if (stopped.status === "incomplete")
        return new ProviderCleanupError(
          JS_REDOX_PROVIDER_IDENTITY.id,
          [pending.process.launch.ownership?.runId ?? "js-redox-worker"],
          { reason: stopped.reason },
          { operation: OPERATION },
        );
      pending.process = undefined;
    }
    if (pending.tree !== undefined) {
      const tree = pending.tree;
      try {
        await tree.rollback();
        pending.tree = undefined;
      } catch (cause: unknown) {
        return new ProviderCleanupError(
          JS_REDOX_PROVIDER_IDENTITY.id,
          [tree.outputRoot],
          { reason: failureMessage(cause) },
          { operation: OPERATION, cause },
        );
      }
    }
    if (pending.root !== undefined) {
      const runtime = pending.root;
      try {
        await runtime.close();
        pending.root = undefined;
      } catch (cause: unknown) {
        return new ProviderCleanupError(
          JS_REDOX_PROVIDER_IDENTITY.id,
          [runtime.path],
          { reason: failureMessage(cause) },
          { operation: OPERATION, cause },
        );
      }
    }
    this.#pendingCleanup = undefined;
    return undefined;
  }
}

const ownedCommandDiagnostics = (
  failure: OwnedCommandFailure,
): Readonly<Record<string, import("../../domain/jsonValue.js").JsonValue>> => ({
  reason: failure.message,
  exit_code: failure.snapshot?.exitCode ?? null,
  exit_signal: failure.snapshot?.signal ?? null,
  diagnostic_truncated: failure.snapshot?.diagnosticTruncated === true,
  stdout:
    failure.snapshot === null
      ? null
      : {
          text: failure.snapshot.stdout.text,
          bytes: failure.snapshot.stdout.observedBytes,
          retained_bytes: failure.snapshot.stdout.bytes,
        },
  stderr:
    failure.snapshot === null
      ? null
      : {
          text: failure.snapshot.stderr.text,
          bytes: failure.snapshot.stderr.observedBytes,
          retained_bytes: failure.snapshot.stderr.bytes,
        },
});

const failureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
