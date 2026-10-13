import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { dirname, join } from "node:path";
import {
  execFileOutput,
  execFileOutputFailure,
  type ExecFileOutputFailure,
} from "../process/ExecFileOutput.js";

/** Bound each configuration-helper stream before retention and redaction. */
export const GHIDRA_LAUNCH_SUPPORT_CAPTURE_BYTES = 64 * 1024;

type LaunchSupportPhase = "-envvars" | "-vmargs";
type LaunchSupportOutcome = Omit<
  ExecFileOutputFailure,
  "killed" | "outputTruncated"
> & {
  readonly killed: boolean | null;
  readonly outputTruncated: boolean | null;
};

/** Captured failure from Ghidra's release configuration helper. */
export class GhidraLaunchSupportError extends Error {
  readonly outcome: LaunchSupportOutcome | undefined;

  constructor(phase: LaunchSupportPhase, cause: unknown) {
    super(`Ghidra LaunchSupport ${phase} failed`, { cause });
    this.name = "GhidraLaunchSupportError";
    const outcome = execFileOutputFailure(cause);
    // Native execFile aborts can settle before exit and final stream delivery.
    this.outcome =
      outcome === undefined
        ? undefined
        : {
            ...outcome,
            killed: outcome.code === "ABORT_ERR" ? null : outcome.killed,
            outputTruncated:
              outcome.code === "ABORT_ERR" ? null : outcome.outputTruncated,
          };
  }
}

/** Launch coordinates obtained from Ghidra's own release configuration helper. */
export const ghidraJavaLaunch = async (options: {
  readonly platform: NodeJS.Platform;
  readonly analyzeHeadlessPath: string;
  readonly javaHome: string;
  readonly javaVmName?: string;
  readonly homeRoot: string;
  readonly tempRoot: string;
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly onStderr: (mode: "-envvars" | "-vmargs", stderr: string) => void;
}): Promise<{
  readonly command: string;
  readonly arguments: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
}> => {
  const supportRoot = dirname(options.analyzeHeadlessPath);
  const installRoot = dirname(supportRoot);
  const command = join(options.javaHome, "bin", "java");
  const isolatedProperties = [
    `-Duser.home=${options.homeRoot}`,
    `-Djava.io.tmpdir=${options.tempRoot}`,
  ];
  const supportArguments = [
    ...isolatedProperties,
    // Only identified HotSpot VMs have these unified-logging semantics. OpenJ9
    // uses different -Xlog behavior; missing VM identity must stay unknown.
    ...(/^(?:OpenJDK|Java HotSpot\(TM\)) (?:64-Bit )?(?:Server|Client|Zero) VM$/u.test(
      options.javaVmName ?? "",
    )
      ? ["-Xlog:disable", "-Xlog:all=warning:stderr"]
      : []),
    "-cp",
    join(supportRoot, "LaunchSupport.jar"),
    "LaunchSupport",
    installRoot,
  ];
  const environment = {
    ...snapshotEnvironment(options.environment, options.platform),
  };
  const supportOutput = async (phase: LaunchSupportPhase) => {
    try {
      return await execFileOutput(command, [...supportArguments, phase], {
        env: environment,
        maxBuffer: GHIDRA_LAUNCH_SUPPORT_CAPTURE_BYTES,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (cause: unknown) {
      throw new GhidraLaunchSupportError(phase, cause);
    }
  };
  const configuredEnvironment = await supportOutput("-envvars");
  options.onStderr("-envvars", configuredEnvironment.stderr);
  for (const line of configuredEnvironment.stdout.split(/\r?\n/u)) {
    if (line === "") continue;
    const separator = line.indexOf("=");
    const sourceKey = line.slice(0, separator);
    const key =
      options.platform === "win32" ? sourceKey.toUpperCase() : sourceKey;
    if (separator < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))
      throw new Error(
        `Invalid Ghidra LaunchSupport environment entry: ${line}`,
      );
    if ((environment[key] ?? "") === "")
      environment[key] = line.slice(separator + 1);
  }
  const configuredArguments = await supportOutput("-vmargs");
  options.onStderr("-vmargs", configuredArguments.stderr);
  const vmArguments = configuredArguments.stdout
    .split(/\r?\n/u)
    .filter((line) => line !== "");
  if (
    vmArguments.some(
      (argument) => !argument.startsWith("-") || argument.includes("\0"),
    )
  )
    throw new Error("Invalid Ghidra LaunchSupport JVM argument");
  return {
    command,
    environment,
    arguments: [
      ...vmArguments,
      ...(options.platform === "darwin" ? ["-Xdock:name=Ghidra-Headless"] : []),
      `-Xmx${environment.GHIDRA_HEADLESS_MAXMEM || environment.GHIDRA_MAXMEM || "2G"}`,
      "-XX:ParallelGCThreads=2",
      "-XX:CICompilerCount=2",
      "-Djava.awt.headless=true",
      ...isolatedProperties,
      "-showversion",
      "-cp",
      join(installRoot, "Ghidra", "Framework", "Utility", "lib", "Utility.jar"),
      "ghidra.Ghidra",
      "ghidra.app.util.headless.AnalyzeHeadless",
      ...options.arguments,
    ],
  };
};
