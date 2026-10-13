import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { cleanupOwnedProcessGroup } from "../../process/ProcessOwnership.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../../process/ProviderProcess.js";
import type {
  RecoveryDeadline,
  RecoveryLauncher,
  RecoveryLimits,
  RecoveryTool,
} from "./RecoveryEngine.js";
import {
  checkRecoveryDeadline,
  inventoryRecoveryFiles,
  fingerprintRecoveryFile,
  recoveryFailureMessage,
} from "./RecoveryFiles.js";

const OPERATION = "recover_javascript_sources";

/** Cleanup failure carrying the live supervisor so the provider can retry it. */
export class RecoveryCleanupFailure extends ProviderCleanupError {
  constructor(
    readonly cleanupOwner: ProviderProcessSupervisor,
    providerId: string,
    readonly runId: string,
    readonly cwd: string,
    reason: string,
    previousError: unknown,
    snapshot: ReturnType<ProviderProcessSupervisor["snapshot"]>,
  ) {
    super(
      providerId,
      [runId, cwd],
      {
        reason,
        previous_error:
          previousError instanceof Error ? previousError.message : null,
        exit_code: snapshot.exitCode ?? null,
        signal: snapshot.signal ?? null,
      },
      { operation: OPERATION, cause: previousError },
    );
  }
}

/** Fingerprint an explicitly configured engine and util-linux prlimit; acquire nothing. */
export const resolveRecoveryTool = async (
  environment: Readonly<Record<string, string | undefined>>,
  engine: {
    readonly id: string;
    readonly name: string;
    readonly configured: string | undefined;
    readonly supported: boolean;
    readonly requirement: string;
    readonly limits: RecoveryLimits;
  },
): Promise<RecoveryTool> => {
  if (
    !engine.supported ||
    engine.configured === undefined ||
    !isAbsolute(engine.configured)
  )
    throw new AnalysisCapabilityUnavailableError(
      engine.id,
      OPERATION,
      engine.requirement,
      { userMessage: engine.requirement },
    );
  try {
    const command = await realpath(engine.configured);
    await access(command, constants.R_OK | constants.X_OK);
    const fingerprint = await fingerprintRecoveryFile(
      command,
      engine.limits.outputBytes,
    );
    const limiter =
      environment.REA_JAVASCRIPT_PRLIMIT_COMMAND ?? "/usr/bin/prlimit";
    if (!isAbsolute(limiter))
      throw new TypeError("REA_JAVASCRIPT_PRLIMIT_COMMAND must be absolute");
    await access(limiter, constants.X_OK);
    if (!(await stat(limiter)).isFile())
      throw new TypeError(`Resource limiter is not a regular file: ${limiter}`);
    return { command, limiter, ...fingerprint };
  } catch (cause: unknown) {
    const reason = `Configured ${engine.name} or util-linux prlimit is unavailable: ${recoveryFailureMessage(cause)}`;
    throw new AnalysisCapabilityUnavailableError(engine.id, OPERATION, reason, {
      cause,
      userMessage: reason,
    });
  }
};

type RecoveryCommandContext = RecoveryTool & {
  providerId: string;
  name: string;
  limits: RecoveryLimits;
  arguments: readonly string[];
  cwd: string;
  deadline: RecoveryDeadline;
  environment: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  launcher?: RecoveryLauncher;
  staging?: string;
};

/** Run one bounded command and verify cleanup before consuming its output. */
export const runRecoveryCommand = async (context: RecoveryCommandContext) => {
  checkRecoveryDeadline(context.deadline, context.signal);
  const runId = `rea-${context.providerId}-${randomUUID()}`;
  const streamLimit = `${context.name} diagnostic stream exceeds ${String(context.limits.reportBytes / 1024 / 1024)} MiB`;
  const spawned = await (context.launcher ?? spawnOwnedProviderProcess)({
    command: context.limiter,
    arguments: [
      `--as=${String(context.limits.addressSpaceBytes)}`,
      `--fsize=${String(context.limits.outputBytes)}`,
      "--core=0",
      `--cpu=${String(Math.ceil(context.limits.timeoutMs / 1000))}`,
      "--",
      context.command,
      ...context.arguments,
    ],
    expectedCommand: null,
    runId,
    cwd: context.cwd,
    hostEnvironment: context.environment,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    env: { TMPDIR: context.cwd, RAYON_NUM_THREADS: "1", NO_COLOR: "1" },
  }).catch((cause: unknown) => {
    if (context.signal?.aborted === true)
      throw new AnalysisCancelledError(OPERATION);
    throw new ProviderAdapterError(context.providerId, OPERATION, {
      cause,
      diagnostics: {
        reason: `Failed to launch configured ${context.name} through util-linux prlimit`,
        command: context.command,
        detail: recoveryFailureMessage(cause),
      },
    });
  });
  let oversized = false;
  const supervisor = new ProviderProcessSupervisor(
    {
      ...spawned,
      ownsProcessLifetime: true,
      cleanup:
        spawned.cleanup ?? (() => cleanupOwnedProcessGroup(spawned.ownership)),
    },
    {
      maxDiagnosticBytes: 2 * context.limits.reportBytes,
      onDiagnostic: (event) => {
        if (
          event.type === "output" &&
          event.totalBytes > context.limits.reportBytes
        )
          oversized = true;
      },
    },
  );
  let failure: unknown;
  try {
    while (!(await supervisor.waitForOutputClose(100))) {
      checkRecoveryDeadline(context.deadline, context.signal);
      if (oversized) throw new AnalysisOutputError(OPERATION, streamLimit);
      if (context.staging !== undefined)
        await inventoryRecoveryFiles(
          context.staging,
          context.limits,
          context.signal,
        );
    }
    checkRecoveryDeadline(context.deadline, context.signal);
    if (oversized) throw new AnalysisOutputError(OPERATION, streamLimit);
  } catch (cause: unknown) {
    failure = cause;
  }
  const stopped = await supervisor.stop();
  const snapshot = supervisor.snapshot();
  if (stopped.status === "incomplete")
    throw new RecoveryCleanupFailure(
      supervisor,
      context.providerId,
      runId,
      context.cwd,
      stopped.reason,
      failure,
      snapshot,
    );
  if (failure !== undefined) throw failure;
  if (context.signal?.aborted === true)
    throw new AnalysisCancelledError(OPERATION);
  return {
    exit_code: snapshot.exitCode ?? null,
    signal: snapshot.signal ?? null,
    stdout: snapshot.stdout.text,
    stderr: snapshot.stderr.text,
    command: context.command,
    arguments: [...context.arguments],
    resource_limiter: context.limiter,
  };
};
