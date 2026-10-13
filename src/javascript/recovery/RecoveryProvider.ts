import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JavaScriptRecoveryPort } from "../../application/javascript/JavaScriptRecoveryPort.js";
import type {
  AnalysisExecution,
  ExecutionOptions,
} from "../../application/AnalysisProvider.js";
import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import { SafeOutputTreeCreationFailure } from "../../artifacts/SafeOutputTreeCreationFailure.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import {
  javascriptRecoveryResultSchema,
  type JavaScriptRecoveryInput,
} from "../../domain/javascript/javascriptRecovery.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  checkRecoveryCancellation,
  checkRecoveryDeadline,
  recoveryFailureMessage,
  recoveryInputFailure,
  snapshotRecoveryInputs,
} from "./RecoveryFiles.js";
import { RecoveryCleanupFailure } from "./RecoveryCommand.js";
import type { RecoveryEngine, RecoveryLauncher } from "./RecoveryEngine.js";
import type { ProviderProcessSupervisor } from "../../process/ProviderProcess.js";

const OPERATION = "recover_javascript_sources";

/** Serialized recovery adapter retaining failed process, workspace and publication cleanup. */
export class RecoveryProvider implements JavaScriptRecoveryPort {
  readonly #engines: ReadonlyMap<RecoveryEngine["id"], RecoveryEngine>;
  #tail: Promise<void> = Promise.resolve();
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #pendingCleanup:
    | {
        providerId: string;
        root: string | undefined;
        process: ProviderProcessSupervisor | undefined;
        tree: SafeOutputTree | undefined;
      }
    | undefined;

  constructor(
    engines: readonly RecoveryEngine[],
    readonly environment: Readonly<
      Record<string, string | undefined>
    > = process.env,
    readonly launcher?: RecoveryLauncher,
  ) {
    this.#engines = new Map(engines.map((engine) => [engine.id, engine]));
  }

  get engines(): readonly JavaScriptRecoveryInput["engine"][] {
    return [...this.#engines.keys()];
  }

  /** Recover selected scripts using validated reports and verified output bytes. */
  recover(
    input: JavaScriptRecoveryInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (this.#closing)
      return Promise.resolve(
        err(
          new ProviderCleanupError(
            input.engine,
            [],
            { reason: "Provider is closing" },
            { operation: OPERATION },
          ),
        ),
      );
    const operation = this.#tail.then(() =>
      this.#closing
        ? err(
            new ProviderCleanupError(
              input.engine,
              [],
              { reason: "Provider is closing" },
              { operation: OPERATION },
            ),
          )
        : this.#recover(input, options),
    );
    this.#tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #recover(
    input: JavaScriptRecoveryInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const pending = await this.#retire();
    if (pending !== undefined) return err(pending);
    const engine = this.#engines.get(input.engine);
    if (engine === undefined)
      return err(
        recoveryInputFailure(
          "engine",
          `Recovery engine ${input.engine} is not available in this build`,
        ),
      );
    const rejected = engine.validate(input);
    if (rejected !== undefined) return err(rejected);
    let root: string | undefined;
    let tree: SafeOutputTree | undefined;
    let failed: { readonly cause: unknown } | undefined;
    let execution: AnalysisExecution | undefined;
    const deadline = {
      at: performance.now() + engine.limits.timeoutMs,
      timeoutMs: engine.limits.timeoutMs,
    };
    try {
      checkRecoveryCancellation(options?.signal);
      const tool = await engine.resolve(this.environment);
      root = await mkdtemp(join(tmpdir(), `rea-${engine.id}-`));
      const inputs = join(root, "inputs");
      const staging = join(root, "modules");
      await mkdir(inputs, { mode: 0o700 });
      await mkdir(staging, { mode: 0o700 });
      const sources = await snapshotRecoveryInputs(
        [input.path, ...(input.additional_paths ?? [])],
        inputs,
        engine.limits.inputBytes,
        options?.signal,
      );
      try {
        tree = await SafeOutputTree.create(input.output_directory);
      } catch (cause: unknown) {
        if (cause instanceof SafeOutputTreeCreationFailure) tree = cause.tree;
        throw recoveryInputFailure(
          "output_directory",
          `Cannot create new recovery directory ${input.output_directory}: ${recoveryFailureMessage(cause)}`,
          cause,
        );
      }
      execution = await engine.execute({
        root,
        tree,
        input,
        sources,
        tool,
        environment: this.environment,
        launcher: this.launcher,
        options,
        deadline,
      });
      checkRecoveryDeadline(deadline, options?.signal);
      await rm(root, { recursive: true, force: true });
      root = undefined;
      checkRecoveryDeadline(deadline, options?.signal);
      await tree.commit(options?.signal);
    } catch (cause: unknown) {
      failed = { cause };
    }
    if (failed !== undefined) {
      const failure =
        failed.cause instanceof ArtifactReaderFailure &&
        failed.cause.reason === "cancelled"
          ? new AnalysisCancelledError(OPERATION, { cause: failed.cause })
          : failed.cause;
      const residuals: string[] = [];
      const cleanupFailures: { resource: string; reason: string }[] = [];
      const cleanupOwner =
        failure instanceof RecoveryCleanupFailure
          ? failure.cleanupOwner
          : undefined;
      let failedTree: SafeOutputTree | undefined;
      try {
        await tree?.rollback();
      } catch (cause: unknown) {
        if (tree !== undefined) {
          failedTree = tree;
          residuals.push(tree.outputRoot);
          cleanupFailures.push({
            resource: tree.outputRoot,
            reason: recoveryFailureMessage(cause),
          });
        }
      }
      if (cleanupOwner !== undefined)
        residuals.push(
          cleanupOwner.launch.ownership?.runId ?? `${engine.id}-worker`,
        );
      if (root !== undefined && cleanupOwner === undefined) {
        const failedRoot = root;
        try {
          await rm(failedRoot, { recursive: true, force: true });
          root = undefined;
        } catch (cause: unknown) {
          residuals.push(failedRoot);
          cleanupFailures.push({
            resource: failedRoot,
            reason: recoveryFailureMessage(cause),
          });
        }
      }
      if (
        cleanupOwner !== undefined ||
        failedTree !== undefined ||
        root !== undefined
      ) {
        this.#pendingCleanup = {
          providerId: engine.id,
          root,
          process: cleanupOwner,
          tree: failedTree,
        };
        if (root !== undefined) residuals.push(root);
        root = undefined;
      }
      if (residuals.length > 0)
        return err(
          new ProviderCleanupError(
            engine.id,
            residuals,
            {
              ...(failure instanceof RecoveryCleanupFailure
                ? failure.diagnostics
                : {}),
              previous_error:
                failure instanceof RecoveryCleanupFailure
                  ? (failure.diagnostics?.previous_error ?? null)
                  : recoveryFailureMessage(failure),
              cleanup_failures: cleanupFailures,
            },
            {
              operation: OPERATION,
              cause: failure,
              ...(tree?.published && execution !== undefined
                ? {
                    partialObservation: {
                      kind: "javascript-recovery" as const,
                      result: javascriptRecoveryResultSchema.parse(
                        execution.result,
                      ),
                    },
                  }
                : {}),
            },
          ),
        );
      if (tree?.published === true && execution !== undefined)
        return ok(execution);
      return err(
        failure instanceof AnalysisError
          ? failure
          : new ProviderAdapterError(engine.id, OPERATION, {
              cause: failure,
              diagnostics: { reason: recoveryFailureMessage(failure) },
            }),
      );
    }
    return execution === undefined
      ? err(
          new AnalysisOutputError(OPERATION, "Recovery returned no execution"),
        )
      : ok(execution);
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
          pending.providerId,
          [
            pending.process.launch.ownership?.runId ??
              `${pending.providerId}-worker`,
            ...(pending.root === undefined ? [] : [pending.root]),
          ],
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
          pending.providerId,
          [tree.outputRoot],
          { reason: recoveryFailureMessage(cause) },
          { operation: OPERATION, cause },
        );
      }
    }
    if (pending.root !== undefined) {
      const root = pending.root;
      try {
        await rm(root, { recursive: true, force: true });
        pending.root = undefined;
      } catch (cause: unknown) {
        return new ProviderCleanupError(
          pending.providerId,
          [root],
          { reason: recoveryFailureMessage(cause) },
          { operation: OPERATION, cause },
        );
      }
    }
    this.#pendingCleanup = undefined;
    return undefined;
  }
}
