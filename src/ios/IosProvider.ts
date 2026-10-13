import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { connect, createServer } from "node:net";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../process/ProcessOwnership.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";

import type {
  ExecutionOptions,
  AnalysisExecution,
  ProviderAvailability,
  ProviderIdentity,
} from "../application/AnalysisProvider.js";
import { createAnalysisExecution } from "../application/AnalysisProvider.js";
import { providerConfigurationRefusal } from "../domain/providerConfigurationRefusal.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
  AnalysisProtocolError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  execFileBytes,
  execFileOutput,
  execFileOutputFailure,
} from "../process/ExecFileOutput.js";
import type {
  IosRequest,
  IosOperation,
} from "../domain/ios/iosDeviceAnalysis.js";
import {
  parseIosApps,
  parseIosDeviceIds,
  parseIosInfo,
  parseIosProcessList,
  parseIosRemoteTools,
  parseIosStopReason,
  quoteIosShell,
  IOS_JAILBREAK_PATH_SCRIPT,
} from "./IosDeviceOutput.js";
import {
  IosConfigurationFailure,
  inspectIosTool,
  iosConfigurationAvailability,
  resolveIosTool,
  IOS_SSH_PASSWORD_ENV,
  IOS_SSH_USER_ENV,
  type IosToolIdentity,
  type IosToolName,
  type IosToolSelection,
} from "./IosConfiguration.js";

export const IOS_PROVIDER_IDENTITY = {
  id: "ios-device",
  name: "iOS device (libimobiledevice + jailbreak SSH)",
  version: null,
} as const;

const IDEVICE_TIMEOUT_MS = 30_000;
const IDEVICE_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const SSH_TIMEOUT_MS = 30_000;
const SSH_MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const LOG_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const IPROXY_START_TIMEOUT_MS = 10_000;
const STDERR_EXCERPT_BYTES = 512;

const IOS_REQUIRED_TOOLS: Record<IosOperation, readonly IosToolName[]> = {
  inspect_ios_toolchain: [
    "idevice_id",
    "ideviceinfo",
    "idevicesyslog",
    "ideviceinstaller",
    "iproxy",
    "ssh",
  ],
  list_ios_devices: ["idevice_id"],
  inspect_ios_device: ["ideviceinfo"],
  list_ios_apps: ["ideviceinstaller"],
  list_ios_processes: ["idevicesyslog"],
  read_ios_log: ["idevicesyslog"],
  inspect_ios_process: ["iproxy", "ssh"],
  pull_ios_file: ["iproxy", "ssh"],
  run_ios_command: ["iproxy", "ssh"],
  inspect_ios_runtime: ["iproxy", "ssh"],
  attach_ios_debugserver: ["iproxy", "ssh"],
  run_ios_lldb_command: ["iproxy", "ssh", "lldb"],
  dump_ios_process_memory: ["iproxy", "ssh", "lldb"],
  run_ios_frida_script: ["iproxy", "ssh", "frida"],
};

type IosProviderOptions = {
  readonly environment?: Readonly<Record<string, string | undefined>>;
};

interface Tunnel {
  readonly key: string;
  readonly remotePort: number;
  readonly port: number;
  readonly supervisor: ProviderProcessSupervisor;
  readonly startupFailure: () => string | undefined;
  ready: boolean;
}

interface CapturedRemote {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly exitCode: number | null;
  readonly stopReason?: "duration" | "exited" | "output_limit";
  readonly outputTruncated?: boolean;
}

interface RemoteHelperOwner {
  readonly deviceId: string;
  readonly user: "root" | "mobile";
  readonly runToken: string;
  launchAcknowledged: boolean;
  directoryCreated: boolean | undefined;
}

/** Prove that the device can observe an explicitly selected child token before launching helpers. */
const remoteTokenPrefix = (token: string): string => {
  const split = Math.floor(token.length / 2);
  return `${IOS_JAILBREAK_PATH_SCRIPT}; rea_token='${token.slice(0, split)}''${token.slice(split)}'; rea_probe=$(REA_PROCESS_RUN_ID="$rea_token" sh -c 'ps eww -p $$ -o command=') || exit 70; case " $rea_probe " in *" REA_PROCESS_RUN_ID=$rea_token "*) ;; *) echo 'Remote process-token observation is unavailable' >&2; exit 70 ;; esac`;
};

/** Match a private environment token, never a reusable PID or executable name alone. */
const remoteTokenPids = `rea_rows=$(ps eww -axo pid=,command=) || exit 70; rea_pids=$(printf '%s\\n' "$rea_rows" | awk -v token="$rea_token" '{ if (index($0 " ", " REA_PROCESS_RUN_ID=" token " ") > 0) print $1 }')`;

/** Callers own only their wait; shared startup belongs to the provider lifetime. */
const waitForSharedStartup = <T>(
  pending: Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  if (signal === undefined) return pending;
  if (signal.aborted)
    return Promise.reject(new AnalysisCancelledError("ios_shared_startup"));
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(new AnalysisCancelledError("ios_shared_startup"));
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(cause);
      },
    );
    if (signal.aborted) abort();
  });
};

const remoteHelperDirectory = (owner: RemoteHelperOwner): string =>
  `/tmp/rea-helper-${owner.runToken}`;

/** Exclusive mkdir with a private umask refuses any pre-existing path before redirecting logs. */
const remoteHelperLogPrefix = (owner: RemoteHelperOwner): string =>
  `umask 077; rea_dir=${quoteIosShell(remoteHelperDirectory(owner))}; mkdir "$rea_dir" || { printf 'directory_created\\t0\\n'; exit 73; }; printf 'directory_created\\t1\\n'; log="$rea_dir/helper.log"`;

interface DebugSession {
  readonly owner: RemoteHelperOwner;
  readonly pid: number;
  readonly remotePort: number;
  readonly localPort: number;
  readonly remotePid: number | null;
  readonly debugserverPath: string | null;
}

const parseHelperMarkers = (stdout: Buffer): Map<string, string> => {
  const markers = new Map<string, string>();
  for (const line of stdout.toString("utf8").split(/\r?\n/u)) {
    const separator = line.indexOf("\t");
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    if (markers.has(key))
      throw new AnalysisProtocolError(`Duplicate iOS helper marker: ${key}`);
    markers.set(key, line.slice(separator + 1));
  }
  return markers;
};

/** Consume one completed shell receipt without reinterpreting it in helper consumers. */
const captureRemoteHelperLaunch = (
  owner: RemoteHelperOwner,
  result: CapturedRemote,
): Map<string, string> => {
  owner.launchAcknowledged = result.exitCode !== 255;
  const markers = parseHelperMarkers(result.stdout);
  const created = markers.get("directory_created");
  owner.directoryCreated =
    created === "1"
      ? true
      : created === "0" ||
          result.exitCode === 127 ||
          markers.get("status") === "missing" ||
          markers.get("owned") === "0"
        ? false
        : undefined;
  return markers;
};

const asFailure = (
  operation: string,
  cause: unknown,
  timeoutMs: number,
  outputBudget = SSH_MAX_OUTPUT_BYTES,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  const failure = execFileOutputFailure(cause);
  if (failure?.code === "ABORT_ERR")
    return new AnalysisCancelledError(operation, { cause });
  if (failure?.outputTruncated)
    return new AnalysisResourceConstraintError(
      operation,
      "memory",
      `Captured output exceeded the ${String(outputBudget)}-byte budget`,
      { max_output_bytes: outputBudget },
      { cause },
    );
  if (failure?.killed)
    return new AnalysisTimeoutError(operation, timeoutMs, { cause });
  const excerpt = `${failure?.stderr ?? ""}\n${failure?.stdout ?? ""}`
    .trim()
    .slice(0, STDERR_EXCERPT_BYTES);
  if (
    /not found|no such device|unable to connect|connection refused|permission denied|operation not permitted|not permitted|authentication failed|debugserver|lldb-server|attach|task_for_pid|no such process|invalid process/iu.test(
      excerpt,
    )
  )
    return new AnalysisUnsupportedTargetError(
      operation,
      "iOS device",
      excerpt || "device command failed",
      { cause },
    );
  return new AnalysisProtocolError(
    excerpt || `iOS command failed during ${operation}`,
    { cause },
  );
};

const mergeAppPaths = (
  apps: ReturnType<typeof parseIosApps>["apps"],
  output: string,
): void => {
  const byId = new Map(apps.map((app) => [app.bundle_id, app]));
  for (const line of output.split(/\r?\n/u)) {
    const match = /^([^\t]+)\t([^\t]*)\t([^\t]*)$/u.exec(line);
    if (match === null) continue;
    const appPath = match[1]!;
    const executable = match[3] || null;
    const bundleId = match[2] || null;
    if (bundleId !== null && byId.has(bundleId)) {
      const app = byId.get(bundleId)!;
      app.path = appPath;
      app.executable = executable;
    }
  }
};

/** Provider for USB pairing plus Dopamine/rootless SSH runtime observations. */
export class IosProvider {
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #tunnels = new Map<string, Tunnel>();
  readonly #tunnelStarts = new Map<string, Promise<Tunnel>>();
  readonly #startupLifetime = new AbortController();
  readonly #debugSessions = new Map<string, DebugSession>();
  readonly #remoteHelpers = new Map<string, RemoteHelperOwner>();
  readonly #debugStarts = new Map<
    string,
    Promise<Result<DebugSession, AnalysisError>>
  >();
  readonly #activeOperations = new Set<Promise<void>>();
  #closing = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: IosProviderOptions = {}) {
    this.#environment = options.environment ?? process.env;
  }

  #selection(name: IosToolName): IosToolSelection {
    return resolveIosTool(name, this.#environment);
  }

  #resolveUser(selected?: "root" | "mobile"): "root" | "mobile" {
    if (selected !== undefined) return selected;
    const value = this.#environment[IOS_SSH_USER_ENV] ?? "root";
    if (value === "root" || value === "mobile") return value;
    throw new IosConfigurationFailure(
      "invalid_user",
      "REA_IOS_SSH_USER must be root or mobile",
    );
  }

  async inspectAvailability(
    signal?: AbortSignal,
  ): Promise<ProviderAvailability> {
    try {
      const required: IosToolName[] = [
        "idevice_id",
        "ideviceinfo",
        "idevicesyslog",
        "ideviceinstaller",
        "iproxy",
        "ssh",
        ...(this.#environment[IOS_SSH_PASSWORD_ENV] === undefined
          ? []
          : ["sshpass" as const]),
      ];
      const identities = await Promise.all(
        required.map((name) => inspectIosTool(this.#selection(name), signal)),
      );
      return {
        status: "available",
        code: null,
        reason: null,
        diagnostics: {
          idevice_id: this.#selection("idevice_id").binary,
          iproxy: this.#selection("iproxy").binary,
          tool_versions: Object.fromEntries(
            identities.map((identity) => [identity.name, identity.version]),
          ) as Record<string, string | null>,
          ssh_user: this.#resolveUser(),
          ssh_password_source:
            this.#environment[IOS_SSH_PASSWORD_ENV] === undefined
              ? "none"
              : "environment",
        },
      };
    } catch (cause) {
      if (cause instanceof IosConfigurationFailure)
        return iosConfigurationAvailability(cause);
      throw cause;
    }
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#startupLifetime.abort();
    if (this.#closePromise !== undefined) return this.#closePromise;
    const closing = (async () => {
      await Promise.all(this.#activeOperations);
      await Promise.allSettled([
        ...this.#tunnelStarts.values(),
        ...this.#debugStarts.values(),
      ]);
      const failures: unknown[] = [];
      for (const owner of this.#remoteHelpers.values()) {
        const retired = await this.#retireRemoteHelper(owner);
        if (!retired.ok) failures.push(retired.error);
      }
      for (const tunnel of this.#tunnels.values()) {
        try {
          await this.#stopTunnel(tunnel);
        } catch (cause) {
          failures.push(cause);
        }
      }
      if (failures.length > 0)
        throw new ProviderCleanupError(
          IOS_PROVIDER_IDENTITY.id,
          [...this.#tunnels.keys(), ...this.#remoteHelpers.keys()],
          { reason: "iOS helper cleanup is incomplete; ownership is retained" },
          {
            operation: "close_ios_provider",
            cause: new AggregateError(failures),
          },
        );
    })().finally(() => {
      if (this.#closePromise === closing) this.#closePromise = undefined;
    });
    this.#closePromise = closing;
    return closing;
  }

  async execute(
    request: IosRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (this.#closing)
      return err(new AnalysisCancelledError(request.operation));
    let release!: () => void;
    const active = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#activeOperations.add(active);
    try {
      return await this.#executeOperation(request, options);
    } finally {
      this.#activeOperations.delete(active);
      release();
    }
  }

  async #executeOperation(
    request: IosRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    const signal = options?.signal;
    if (signal?.aborted)
      return err(new AnalysisCancelledError(request.operation));
    let toolchain: IosToolIdentity[];
    try {
      const names = [...IOS_REQUIRED_TOOLS[request.operation]];
      if (
        names.includes("ssh") &&
        this.#environment[IOS_SSH_PASSWORD_ENV] !== undefined
      )
        names.push("sshpass");
      toolchain = await Promise.all(
        names.map((name) => inspectIosTool(this.#selection(name), signal)),
      );
    } catch (cause) {
      if (cause instanceof AnalysisCancelledError) return err(cause);
      if (cause instanceof IosConfigurationFailure)
        return err(
          providerConfigurationRefusal(
            IOS_PROVIDER_IDENTITY.id,
            request.operation,
            cause,
          ),
        );
      return err(
        new AnalysisProtocolError(
          `iOS toolchain probe failed for ${request.operation}`,
          { cause },
        ),
      );
    }
    const provider: ProviderIdentity = {
      ...IOS_PROVIDER_IDENTITY,
      version:
        toolchain.find((tool) => tool.name === "idevice_id")?.version ?? null,
    };
    const clientTools = toolchain.map(({ name, binary, version }) => ({
      name,
      binary_path: binary,
      version,
      available: true,
      reason: null,
    }));
    try {
      switch (request.operation) {
        case "inspect_ios_toolchain":
          return ok(
            createAnalysisExecution(
              {
                tools: clientTools,
                ssh_password_source:
                  this.#environment[IOS_SSH_PASSWORD_ENV] === undefined
                    ? "none"
                    : "environment",
              },
              provider,
              {
                limitations: [
                  "The toolchain probe does not establish that any device is currently paired",
                  "SSH passwords are read only from the caller environment and are never returned",
                ],
              },
            ),
          );
        case "list_ios_devices": {
          const listed = await this.#runIdevice(
            "list_ios_devices",
            "idevice_id",
            ["-l"],
            signal,
            IDEVICE_TIMEOUT_MS,
            IDEVICE_MAX_OUTPUT_BYTES,
          );
          if (!listed.ok) return listed;
          const parsed = parseIosDeviceIds(
            listed.value.stdout.toString("utf8"),
          );
          return ok(
            createAnalysisExecution(
              {
                devices: parsed.ids.map((device_id) => ({
                  device_id,
                  name: null,
                  transport: "usb" as const,
                })),
                unparsed_lines: parsed.unparsed,
                coverage:
                  parsed.unparsed.length === 0
                    ? ("complete" as const)
                    : ("partial" as const),
              },
              provider,
              {
                rawResult: listed.value.stdout.toString("utf8"),
                limitations: [
                  "idevice_id -l reports paired USB transports; network transports require an explicit network scan",
                  "Device name is not fetched until inspect_ios_device",
                ],
              },
            ),
          );
        }
        case "inspect_ios_device": {
          const info = await this.#runIdevice(
            request.operation,
            "ideviceinfo",
            ["-u", request.input.device_id],
            signal,
            IDEVICE_TIMEOUT_MS,
            IDEVICE_MAX_OUTPUT_BYTES,
          );
          if (!info.ok) return info;
          const facts = parseIosInfo(info.value.stdout.toString("utf8"));
          const ssh = await this.#runRemote(
            request.operation,
            request.input.device_id,
            this.#resolveUser(),
            `${IOS_JAILBREAK_PATH_SCRIPT}; id; uname -a; printf '\\n--ROOTLESS--\\n'; for root in /var/jb /var/containers/Bundle/Application/.jbroot-*; do [ -d "$root" ] && printf '%s\\n' "$root"; done`,
            signal,
            SSH_TIMEOUT_MS,
          );
          const sshValue = ssh.ok ? ssh.value.stdout.toString("utf8") : "";
          return ok(
            createAnalysisExecution(
              {
                device_id: request.input.device_id,
                name: facts.get("DeviceName") ?? null,
                product_type: facts.get("ProductType") ?? null,
                product_version: facts.get("ProductVersion") ?? null,
                build_version: facts.get("BuildVersion") ?? null,
                architecture: facts.get("CPUArchitecture") ?? null,
                jailbroken_ssh: {
                  connected: ssh.ok,
                  user: ssh.ok ? this.#resolveUser() : null,
                  uname: ssh.ok
                    ? (sshValue
                        .split(/\r?\n/u)
                        .find((line) => line.startsWith("Darwin ")) ?? null)
                    : null,
                  jailbreak_roots: sshValue
                    .split(/\r?\n/u)
                    .filter((line) => line.startsWith("/var/")),
                  reason: ssh.ok ? null : ssh.error.message,
                },
                selected_info: [
                  "DeviceName",
                  "ProductType",
                  "ProductVersion",
                  "BuildVersion",
                  "CPUArchitecture",
                ].flatMap((key) =>
                  facts.has(key) ? [{ key, value: facts.get(key)! }] : [],
                ),
              },
              provider,
              {
                rawResult: null,
                limitations: [
                  "SSH connectivity uses the configured account and depends on caller-provided REA_IOS_SSH_PASSWORD or existing SSH credentials",
                  "Dopamine rootless/roothide jailbreak status is inferred from successful SSH access and /var/jb or .jbroot-* visibility",
                ],
              },
            ),
          );
        }
        case "list_ios_apps": {
          const scopeArg =
            request.input.scope === "all"
              ? "--all"
              : request.input.scope === "user"
                ? "--user"
                : "--system";
          const listed = await this.#runIdevice(
            request.operation,
            "ideviceinstaller",
            ["-u", request.input.device_id, "list", scopeArg, "--xml"],
            signal,
            IDEVICE_TIMEOUT_MS,
            IDEVICE_MAX_OUTPUT_BYTES,
          );
          if (!listed.ok) return listed;
          const parsed = parseIosApps(listed.value.stdout.toString("utf8"));
          const apps =
            request.input.scope === "all"
              ? parsed.apps
              : parsed.apps.filter((app) => app.scope === request.input.scope);
          const paths = await this.#runRemote(
            request.operation,
            request.input.device_id,
            this.#resolveUser(),
            `${IOS_JAILBREAK_PATH_SCRIPT}; find /var/containers/Bundle/Application /Applications -maxdepth 2 -type d -name '*.app' -print 2>/dev/null | while IFS= read -r app; do bid=$(plutil -extract CFBundleIdentifier raw "$app/Info.plist" 2>/dev/null || true); exe=$(plutil -extract CFBundleExecutable raw "$app/Info.plist" 2>/dev/null || true); printf '%s\\t%s\\t%s\\n' "$app" "$bid" "$exe"; done`,
            signal,
            SSH_TIMEOUT_MS,
          );
          if (paths.ok)
            mergeAppPaths(apps, paths.value.stdout.toString("utf8"));
          return ok(
            createAnalysisExecution(
              {
                device_id: request.input.device_id,
                scope: request.input.scope,
                apps,
                unparsed_lines:
                  parsed.invalidEntries === 0
                    ? []
                    : [
                        `${String(parsed.invalidEntries)} installer entries were not usable`,
                      ],
                coverage:
                  parsed.invalidEntries === 0
                    ? ("complete" as const)
                    : ("partial" as const),
              },
              provider,
              {
                rawResult: null,
                limitations: [
                  "Application metadata comes from ideviceinstaller; app paths and executable names are enriched from jailbreak SSH when available",
                  "The installer output does not prove that an app is currently running",
                ],
              },
            ),
          );
        }
        case "list_ios_processes": {
          const listed = await this.#runIdevice(
            request.operation,
            "idevicesyslog",
            ["-u", request.input.device_id, "pidlist"],
            signal,
            IDEVICE_TIMEOUT_MS,
            IDEVICE_MAX_OUTPUT_BYTES,
          );
          if (!listed.ok) return listed;
          const parsed = parseIosProcessList(
            listed.value.stdout.toString("utf8"),
          );
          return ok(
            createAnalysisExecution(
              {
                device_id: request.input.device_id,
                processes: parsed.processes,
                source: "idevicesyslog" as const,
                unparsed_lines: parsed.unparsed,
                coverage:
                  parsed.unparsed.length === 0
                    ? ("complete" as const)
                    : ("partial" as const),
              },
              provider,
              {
                rawResult: listed.value.stdout.toString("utf8"),
                limitations: [
                  "pidlist is the libimobiledevice process inventory and may omit short-lived processes between observations",
                  "It reports pid/name only; inspect_ios_process adds jailbreak-side command output",
                ],
              },
            ),
          );
        }
        case "inspect_ios_process": {
          const command = `${IOS_JAILBREAK_PATH_SCRIPT}; for rea_tool in ps lsof; do rea_path=$(command -v "$rea_tool" 2>/dev/null || true); if [ -z "$rea_path" ]; then for rea_root in /var/jb /var/containers/Bundle/Application/.jbroot-*; do if [ -x "$rea_root/usr/bin/$rea_tool" ]; then rea_path="$rea_root/usr/bin/$rea_tool"; break; fi; done; fi; if [ -z "$rea_path" ]; then printf '%s unavailable\\n' "$rea_tool" >&2; rea_status=127; elif [ "$rea_tool" = ps ]; then "$rea_path" -p ${String(request.input.pid)} -ww -o pid,ppid,user,state,command; rea_status=$?; else "$rea_path" -p ${String(request.input.pid)}; rea_status=$?; fi; printf '\\nREA_PROBE_%s_EXIT=%s\\n' "$rea_tool" "$rea_status" >&2; done; exit 0`;
          const ran = await this.#runRemote(
            request.operation,
            request.input.device_id,
            this.#resolveUser(request.input.user),
            command,
            signal,
            SSH_TIMEOUT_MS,
          );
          if (!ran.ok) return ran;
          const probeStatuses = new Map<string, number>();
          const stderr = ran.value.stderr
            .toString("utf8")
            .split(/\r?\n/u)
            .filter((line) => {
              const marker = /^REA_PROBE_(ps|lsof)_EXIT=(\d+)$/u.exec(line);
              if (marker === null) return true;
              probeStatuses.set(marker[1]!, Number(marker[2]));
              return false;
            })
            .join("\n")
            .trim();
          const probes = (["ps", "lsof"] as const).map((name) => ({
            name,
            exit_code: probeStatuses.get(name) ?? null,
          }));
          return ok(
            createAnalysisExecution(
              {
                device_id: request.input.device_id,
                pid: request.input.pid,
                probes,
                user: this.#resolveUser(request.input.user),
                stdout: ran.value.stdout.toString("utf8"),
                stderr,
                exit_code: ran.value.exitCode,
                coverage:
                  stderr.length === 0 &&
                  probes.every((probe) => probe.exit_code === 0)
                    ? ("complete" as const)
                    : ("partial" as const),
              },
              provider,
              {
                rawResult: ran.value.stdout.toString("utf8"),
                limitations: [
                  "Process inspection uses commands available in the jailbreak environment; missing ps/lsof remains an explicit partial observation",
                  "This operation does not pause, inject into, or modify the process",
                ],
              },
            ),
          );
        }
        case "read_ios_log": {
          const args = [
            "-u",
            request.input.device_id,
            "--no-colors",
            ...(request.input.match === undefined
              ? []
              : ["-m", request.input.match]),
            ...(request.input.process === undefined
              ? []
              : ["-p", request.input.process]),
          ];
          const ran = await this.#runIdevice(
            request.operation,
            "idevicesyslog",
            args,
            signal,
            request.input.duration_ms,
            LOG_MAX_OUTPUT_BYTES,
            true,
          );
          if (!ran.ok) return ran;
          const allLines = ran.value.stdout
            .toString("utf8")
            .split(/\r?\n/u)
            .filter(Boolean);
          return ok(
            createAnalysisExecution(
              {
                device_id: request.input.device_id,
                count: request.input.count,
                lines: allLines.slice(-request.input.count),
                duration_ms: request.input.duration_ms,
                stop_reason: ran.value.stopReason ?? "exited",
                source: "idevicesyslog" as const,
                coverage:
                  ran.value.outputTruncated === true ||
                  allLines.length > request.input.count
                    ? ("partial" as const)
                    : ("complete" as const),
              },
              provider,
              {
                rawResult: null,
                limitations: [
                  "The live syslog relay is bounded by the provider deadline and line cap; it is not a persistent log archive",
                  "Use idevicesyslog archive through run_ios_command when a full logarchive is required",
                ],
              },
            ),
          );
        }
        case "pull_ios_file": {
          const localDirectory = request.input.output_directory;
          await mkdir(localDirectory, { recursive: true });
          const fileName = basename(request.input.remote_path);
          if (fileName === "." || fileName === ".." || fileName.length === 0)
            return err(
              new AnalysisOutputError(
                request.operation,
                "Remote path has no usable file name",
              ),
            );
          const localPath = join(localDirectory, fileName);
          try {
            await stat(localPath);
            return err(
              new AnalysisOutputError(
                request.operation,
                `The local output already exists: ${localPath}`,
              ),
            );
          } catch (cause) {
            if (
              !(
                cause instanceof Error &&
                Reflect.get(cause, "code") === "ENOENT"
              )
            )
              return err(
                new AnalysisOutputError(
                  request.operation,
                  `Cannot reserve local output ${localPath}`,
                  { cause },
                ),
              );
          }
          const remote = await this.#runRemote(
            request.operation,
            request.input.device_id,
            this.#resolveUser(request.input.user),
            `${IOS_JAILBREAK_PATH_SCRIPT}; cat -- ${quoteIosShell(request.input.remote_path)}`,
            signal,
            600_000,
            SSH_MAX_OUTPUT_BYTES,
          );
          if (!remote.ok) return remote;
          if (
            remote.value.stderr.length > 0 &&
            remote.value.stdout.length === 0
          )
            return err(
              new AnalysisUnsupportedTargetError(
                request.operation,
                request.input.remote_path,
                remote.value.stderr
                  .toString("utf8")
                  .slice(0, STDERR_EXCERPT_BYTES),
              ),
            );
          await writeFile(localPath, remote.value.stdout, { flag: "wx" });
          const sha256 = createHash("sha256")
            .update(remote.value.stdout)
            .digest("hex");
          return ok(
            createAnalysisExecution(
              {
                device_id: request.input.device_id,
                remote_path: request.input.remote_path,
                local_path: localPath,
                bytes: remote.value.stdout.length,
                sha256,
                user: this.#resolveUser(request.input.user),
              },
              provider,
              {
                rawResult: null,
                locations: [
                  { kind: "artifact-path", path: request.input.remote_path },
                ],
                limitations: [
                  "The file is read through SSH and is a point-in-time copy; a changing file may not be internally consistent",
                  "The device file is never removed or modified",
                ],
              },
            ),
          );
        }
        case "run_ios_command": {
          const ran = await this.#runRemote(
            request.operation,
            request.input.device_id,
            this.#resolveUser(request.input.user),
            `${IOS_JAILBREAK_PATH_SCRIPT}; ${request.input.command}`,
            signal,
            request.input.timeout_ms,
            SSH_MAX_OUTPUT_BYTES,
            true,
          );
          if (!ran.ok) return ran;
          return ok(
            createAnalysisExecution(
              {
                device_id: request.input.device_id,
                user: this.#resolveUser(request.input.user),
                stdout: ran.value.stdout.toString("utf8"),
                stderr: ran.value.stderr.toString("utf8"),
                exit_code: ran.value.exitCode,
                timed_out: false,
                coverage:
                  ran.value.exitCode === 0
                    ? ("complete" as const)
                    : ("partial" as const),
              },
              provider,
              {
                rawResult: ran.value.stdout.toString("utf8"),
                limitations: [
                  "This is an explicitly caller-selected remote command on a jailbroken device; it may launch or modify foreign code and device state",
                  "REA records stdout/stderr and exit status but cannot infer what a command did internally",
                  "Credentials are never included in the command output or Evidence parameters",
                ],
              },
            ),
          );
        }
        case "inspect_ios_runtime": {
          const remote = await this.#runRemote(
            request.operation,
            request.input.device_id,
            this.#resolveUser(),
            `${IOS_JAILBREAK_PATH_SCRIPT}; for tool in debugserver lldb-server frida-server; do path=$(command -v "$tool" 2>/dev/null || true); printf '%s\\t%s\\n' "$tool" "$path"; done`,
            signal,
            SSH_TIMEOUT_MS,
          );
          if (!remote.ok) return remote;
          const parsed = parseIosRemoteTools(
            remote.value.stdout.toString("utf8"),
          );
          const hostTools = await Promise.all(
            ["frida", "lldb"].map((name) =>
              this.#inspectOptionalTool(name as "frida" | "lldb", signal),
            ),
          );
          return ok(
            createAnalysisExecution(
              {
                device_id: request.input.device_id,
                host_tools: hostTools,
                remote_tools: parsed.tools,
                unparsed_lines: parsed.unparsed,
                coverage:
                  parsed.unparsed.length === 0
                    ? ("complete" as const)
                    : ("partial" as const),
              },
              provider,
              {
                rawResult: null,
                limitations: [
                  "Remote tool discovery uses the jailbroken user's PATH, including Dopamine /var/jb and roothide .jbroot-* paths",
                  "A discovered server binary is not started by this read-only operation",
                  "Host Frida scripts require the configured frida CLI and a compatible frida-server on the device",
                ],
              },
            ),
          );
        }
        case "attach_ios_debugserver": {
          const attached = await this.#attachDebugserver(
            request.input.device_id,
            request.input.pid,
            request.input.remote_port,
            this.#resolveUser(request.input.user),
            signal,
          );
          if (!attached.ok) return attached;
          return ok(
            createAnalysisExecution(
              {
                device_id: request.input.device_id,
                pid: request.input.pid,
                remote_port: request.input.remote_port,
                local_port: attached.value.localPort,
                remote_pid: attached.value.remotePid,
                debugserver_path: attached.value.debugserverPath,
                status: "attached" as const,
              },
              provider,
              {
                rawResult: null,
                limitations: [
                  "debugserver is launched on the jailbroken device and remains owned by this provider until close",
                  "The local port is an iproxy USB forward and is only reachable from the REA host",
                  "Attaching may pause or alter the target process according to debugserver and task-policy behavior",
                ],
              },
            ),
          );
        }
        case "run_ios_lldb_command": {
          const attached = await this.#attachDebugserver(
            request.input.device_id,
            request.input.pid,
            request.input.remote_port,
            this.#resolveUser(request.input.user),
            signal,
          );
          if (!attached.ok) return attached;
          const ran = await this.#runLldb(
            attached.value.localPort,
            request.input.commands,
            request.input.timeout_ms,
            signal,
          );
          if (!ran.ok) return ran;
          const stdout = ran.value.stdout.toString("utf8");
          const stderr = ran.value.stderr.toString("utf8");
          return ok(
            createAnalysisExecution(
              {
                device_id: request.input.device_id,
                pid: request.input.pid,
                local_port: attached.value.localPort,
                commands: request.input.commands,
                stdout,
                stderr,
                exit_code: ran.value.exitCode,
                stop_reason: parseIosStopReason(stdout),
                coverage:
                  ran.value.exitCode === 0
                    ? ("complete" as const)
                    : ("partial" as const),
              },
              provider,
              {
                rawResult: stdout,
                limitations: [
                  "Commands are passed to the host lldb client and can set breakpoints, continue execution, inspect registers, read memory, and evaluate expressions on the attached process",
                  "The command list is caller-selected and may change target state; output is bounded by the provider capture budget",
                  "Use dump_ios_process_memory for a bounded memory read with an explicit byte limit",
                ],
              },
            ),
          );
        }
        case "run_ios_frida_script": {
          const server = await this.#ensureFridaServer(
            request.input.device_id,
            request.input.remote_port,
            this.#resolveUser(request.input.user),
            signal,
          );
          if (!server.ok) return server;
          const forwarded = await this.#ensureForward(
            request.input.device_id,
            request.input.remote_port,
            signal,
          );
          const ran = await this.#runFrida(
            forwarded.port,
            request.input,
            request.input.timeout_ms,
            signal,
          );
          if (!ran.ok) return ran;
          return ok(
            createAnalysisExecution(
              {
                device_id: request.input.device_id,
                pid: request.input.pid ?? null,
                process: request.input.process ?? null,
                local_port: forwarded.port,
                stdout: ran.value.stdout.toString("utf8"),
                stderr: ran.value.stderr.toString("utf8"),
                exit_code: ran.value.exitCode,
                timed_out: ran.value.stopReason === "duration",
                stop_reason: ran.value.stopReason ?? "exited",
                coverage:
                  ran.value.exitCode === 0 && ran.value.outputTruncated !== true
                    ? ("complete" as const)
                    : ("partial" as const),
              },
              provider,
              {
                rawResult: ran.value.stdout.toString("utf8"),
                limitations: [
                  "The script is executed by the host frida CLI against a frida-server started on the jailbroken device",
                  "Frida scripts can inject code, change process state, and access sensitive memory; this operation is explicitly side-effectful",
                  "The provider stops the host CLI at timeout but does not kill a pre-existing frida-server on the device",
                ],
              },
            ),
          );
        }
        case "dump_ios_process_memory": {
          const attached = await this.#attachDebugserver(
            request.input.device_id,
            request.input.pid,
            request.input.remote_port,
            this.#resolveUser(request.input.user),
            signal,
          );
          if (!attached.ok) return attached;
          const command = `memory read --format x --size 1 --count ${String(request.input.size)} ${request.input.address}`;
          const ran = await this.#runLldb(
            attached.value.localPort,
            [command],
            request.input.timeout_ms,
            signal,
          );
          if (!ran.ok) return ran;
          const stdout = ran.value.stdout.toString("utf8");
          return ok(
            createAnalysisExecution(
              {
                device_id: request.input.device_id,
                pid: request.input.pid,
                address: request.input.address,
                size: request.input.size,
                local_port: attached.value.localPort,
                hexdump: stdout,
                stderr: ran.value.stderr.toString("utf8"),
                exit_code: ran.value.exitCode,
                stop_reason: parseIosStopReason(stdout),
                coverage:
                  ran.value.exitCode === 0
                    ? ("complete" as const)
                    : ("partial" as const),
              },
              provider,
              {
                rawResult: stdout,
                limitations: [
                  "This is an lldb memory read through debugserver; it is bounded to the requested 1 MiB maximum and does not write device memory",
                  "The address must be valid in the target process at the time of the read",
                  "A readable hexdump does not prove that a page is executable or free of pointer authentication",
                ],
              },
            ),
          );
        }
      }
    } catch (cause) {
      if (cause instanceof IosConfigurationFailure)
        return err(
          providerConfigurationRefusal(
            IOS_PROVIDER_IDENTITY.id,
            request.operation,
            cause,
          ),
        );
      return err(asFailure(request.operation, cause, SSH_TIMEOUT_MS));
    }
  }

  async #runIdevice(
    operation: string,
    name: "idevice_id" | "ideviceinfo" | "idevicesyslog" | "ideviceinstaller",
    args: readonly string[],
    signal: AbortSignal | undefined,
    timeoutMs: number,
    maxBuffer: number,
    acceptTimeout = false,
  ): Promise<Result<CapturedRemote, AnalysisError>> {
    try {
      const result = await execFileBytes(this.#selection(name).binary, args, {
        timeout: timeoutMs,
        stopSignal: "SIGTERM",
        maxBuffer,
        ...(signal === undefined ? {} : { signal }),
      });
      return ok({ stdout: result.stdout, stderr: result.stderr, exitCode: 0 });
    } catch (cause) {
      if (acceptTimeout) {
        const failure = execFileOutputFailure(cause);
        if (failure?.outputTruncated || failure?.killed === true)
          return ok({
            stdout: Buffer.from(failure.stdout),
            stderr: Buffer.from(failure.stderr),
            exitCode: null,
            stopReason: failure.outputTruncated ? "output_limit" : "duration",
            outputTruncated: failure.outputTruncated,
          });
      }
      return err(asFailure(operation, cause, timeoutMs, maxBuffer));
    }
  }

  async #runRemote(
    operation: string,
    deviceId: string,
    user: "root" | "mobile",
    command: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    maxBuffer = SSH_MAX_OUTPUT_BYTES,
    acceptNonZero = false,
  ): Promise<Result<CapturedRemote, AnalysisError>> {
    let tunnel: Tunnel;
    try {
      tunnel = await this.#ensureForward(deviceId, 22, signal);
      const ssh = this.#selection("ssh");
      const args = [
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `HostKeyAlias=rea-ios-${deviceId}`,
        "-o",
        "LogLevel=ERROR",
        "-o",
        "ConnectTimeout=8",
        "-p",
        String(tunnel.port),
        `${user}@127.0.0.1`,
        command,
      ];
      const password = this.#environment[IOS_SSH_PASSWORD_ENV];
      let binary = ssh.binary;
      let finalArgs = args;
      const env: Record<string, string | undefined> = { ...this.#environment };
      if (password !== undefined) {
        const sshpass = this.#selection("sshpass");
        binary = sshpass.binary;
        finalArgs = ["-e", "-P", "assword", ssh.binary, ...args];
        env.SSHPASS = password;
      } else {
        finalArgs = ["-o", "BatchMode=yes", ...args];
      }
      const result = await execFileBytes(binary, finalArgs, {
        env,
        timeout: timeoutMs,
        stopSignal: "SIGTERM",
        maxBuffer,
        ...(signal === undefined ? {} : { signal }),
      });
      return ok({ stdout: result.stdout, stderr: result.stderr, exitCode: 0 });
    } catch (cause) {
      const failure = execFileOutputFailure(cause);
      if (acceptNonZero && typeof failure?.code === "number")
        return ok({
          stdout: Buffer.from(failure.stdout),
          stderr: Buffer.from(failure.stderr),
          exitCode: failure.code,
        });
      return err(asFailure(operation, cause, timeoutMs, maxBuffer));
    }
  }

  async #inspectOptionalTool(
    name: "frida" | "lldb",
    signal?: AbortSignal,
  ): Promise<{
    name: string;
    path: string;
    available: boolean;
    version: string | null;
    reason: string | null;
  }> {
    const selection = this.#selection(name);
    try {
      const identity = await inspectIosTool(selection, signal);
      return {
        name,
        path: identity.binary,
        available: true,
        version: identity.version,
        reason: null,
      };
    } catch (cause) {
      if (cause instanceof AnalysisCancelledError) throw cause;
      if (signal?.aborted)
        throw new AnalysisCancelledError("inspect_ios_runtime", { cause });
      return {
        name,
        path: selection.binary,
        available: false,
        version: null,
        reason: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  async #retireRemoteHelper(
    owner: RemoteHelperOwner,
  ): Promise<Result<void, AnalysisError>> {
    const stopped = await this.#runRemote(
      "close_ios_remote_helper",
      owner.deviceId,
      owner.user,
      `${remoteTokenPrefix(owner.runToken)}; ${remoteTokenPids}; for rea_pid in $rea_pids; do rea_identity=$(ps eww -p "$rea_pid" -o command=) || exit 70; case " $rea_identity " in *" REA_PROCESS_RUN_ID=$rea_token "*) kill -TERM "$rea_pid" || exit 71 ;; esac; done; sleep 0.1; ${remoteTokenPids}; [ -z "$rea_pids" ]`,
      undefined,
      5_000,
    );
    if (!stopped.ok)
      return err(
        new ProviderCleanupError(
          IOS_PROVIDER_IDENTITY.id,
          [owner.runToken],
          {
            reason: "Remote token-owned helper shutdown could not be verified",
          },
          { operation: "close_ios_remote_helper", cause: stopped.error },
        ),
      );
    if (!owner.launchAcknowledged)
      return err(
        new ProviderCleanupError(
          IOS_PROVIDER_IDENTITY.id,
          [owner.runToken],
          {
            reason:
              "Remote launch completion remains unknown after interruption; token ownership is retained",
          },
          { operation: "close_ios_remote_helper" },
        ),
      );
    if (owner.directoryCreated === undefined)
      return err(
        new ProviderCleanupError(
          IOS_PROVIDER_IDENTITY.id,
          [owner.runToken, remoteHelperDirectory(owner)],
          {
            reason:
              "Private remote directory creation remains unknown; ownership is retained",
          },
          { operation: "close_ios_remote_helper_directory" },
        ),
      );
    if (owner.directoryCreated) {
      const directory = quoteIosShell(remoteHelperDirectory(owner));
      const removed = await this.#runRemote(
        "close_ios_remote_helper_directory",
        owner.deviceId,
        owner.user,
        `${IOS_JAILBREAK_PATH_SCRIPT}; rea_dir=${directory}; if [ ! -e "$rea_dir" ] && [ ! -L "$rea_dir" ]; then exit 0; fi; [ -d "$rea_dir" ] && [ ! -L "$rea_dir" ] && rm -f "$rea_dir/helper.log" && rmdir "$rea_dir"`,
        undefined,
        5_000,
      );
      if (!removed.ok)
        return err(
          new ProviderCleanupError(
            IOS_PROVIDER_IDENTITY.id,
            [owner.runToken, remoteHelperDirectory(owner)],
            {
              reason:
                "Remote private log directory cleanup could not be verified",
            },
            {
              operation: "close_ios_remote_helper_directory",
              cause: removed.error,
            },
          ),
        );
    }
    this.#remoteHelpers.delete(owner.runToken);
    for (const [key, session] of this.#debugSessions)
      if (session.owner.runToken === owner.runToken)
        this.#debugSessions.delete(key);
    return ok(undefined);
  }

  async #remoteStartFailure(
    owner: RemoteHelperOwner,
    previous: AnalysisError,
    operation: string,
  ): Promise<Result<never, AnalysisError>> {
    const retired = await this.#retireRemoteHelper(owner);
    if (retired.ok) return err(previous);
    return err(
      new ProviderCleanupError(
        IOS_PROVIDER_IDENTITY.id,
        [owner.runToken],
        {
          reason: retired.error.message,
          previous_failure: previous.message,
          previous_failure_tag: previous._tag,
        },
        { operation, cause: new AggregateError([previous, retired.error]) },
      ),
    );
  }

  async #attachDebugserver(
    deviceId: string,
    pid: number,
    remotePort: number,
    user: "root" | "mobile",
    signal?: AbortSignal,
  ): Promise<Result<DebugSession, AnalysisError>> {
    const key = `${deviceId}:${user}:${String(pid)}:${String(remotePort)}`;
    const existing = this.#debugStarts.get(key);
    if (existing !== undefined) {
      try {
        return await waitForSharedStartup(existing, signal);
      } catch (cause) {
        return err(asFailure("attach_ios_debugserver", cause, SSH_TIMEOUT_MS));
      }
    }
    const started = this.#startDebugserver(
      deviceId,
      pid,
      remotePort,
      user,
      key,
      this.#startupLifetime.signal,
    );
    this.#debugStarts.set(key, started);
    const release = () => {
      if (this.#debugStarts.get(key) === started) this.#debugStarts.delete(key);
    };
    void started.then(release, release);
    try {
      return await waitForSharedStartup(started, signal);
    } catch (cause) {
      return err(asFailure("attach_ios_debugserver", cause, SSH_TIMEOUT_MS));
    }
  }

  async #startDebugserver(
    deviceId: string,
    pid: number,
    remotePort: number,
    user: "root" | "mobile",
    key: string,
    signal?: AbortSignal,
  ): Promise<Result<DebugSession, AnalysisError>> {
    const current = this.#debugSessions.get(key);
    if (current !== undefined) {
      const live = await this.#runRemote(
        "inspect_ios_debugserver",
        deviceId,
        user,
        `${remoteTokenPrefix(current.owner.runToken)}; ${remoteTokenPids}; printf '%s\\n' "$rea_pids" | grep -Fx '${String(current.remotePid)}' >/dev/null && kill -0 ${String(pid)} && command -v lsof >/dev/null && lsof -nP -a -p ${String(current.remotePid)} -iTCP:${String(remotePort)} -sTCP:LISTEN >/dev/null`,
        signal,
        SSH_TIMEOUT_MS,
      );
      const tunnel = this.#tunnels.get(`${deviceId}:${String(remotePort)}`);
      if (
        live.ok &&
        tunnel !== undefined &&
        tunnel.supervisor.observedExit() === undefined
      )
        return ok(current);
      const retired = await this.#retireRemoteHelper(current.owner);
      if (!retired.ok) return retired;
    }
    const owner: RemoteHelperOwner = {
      deviceId,
      user,
      runToken: randomUUID(),
      launchAcknowledged: false,
      directoryCreated: undefined,
    };
    this.#remoteHelpers.set(owner.runToken, owner);
    const command = `${remoteTokenPrefix(owner.runToken)}; dbg=$(command -v debugserver 2>/dev/null || true); mode=debugserver; if [ -z "$dbg" ]; then dbg=$(command -v lldb-server 2>/dev/null || true); mode=lldb-server; fi; if [ -z "$dbg" ]; then printf 'status\\tmissing\\n'; printf 'reason\\tdebugserver/lldb-server not found\\n'; exit 0; fi; ${remoteHelperLogPrefix(owner)}; if [ "$mode" = lldb-server ]; then REA_PROCESS_RUN_ID="$rea_token" nohup "$dbg" gdbserver 127.0.0.1:${String(remotePort)} --attach ${String(pid)} >"$log" 2>&1 </dev/null & else REA_PROCESS_RUN_ID="$rea_token" nohup "$dbg" 127.0.0.1:${String(remotePort)} -a ${String(pid)} >"$log" 2>&1 </dev/null & fi; dspid=$!; sleep 1; rea_identity=$(ps eww -p "$dspid" -o command=) || exit 70; case " $rea_identity " in *" REA_PROCESS_RUN_ID=$rea_token "*) rea_owned=1 ;; *) rea_owned=0 ;; esac; if [ "$rea_owned" -eq 1 ] && kill -0 "$dspid" 2>/dev/null; then printf 'status\\tattached\\n'; printf 'path\\t%s\\n' "$dbg"; printf 'pid\\t%s\\n' "$dspid"; else printf 'status\\tfailed\\n'; cat "$log" 2>/dev/null || true; fi; exit 0`;
    const started = await this.#runRemote(
      "attach_ios_debugserver",
      deviceId,
      user,
      command,
      signal,
      SSH_TIMEOUT_MS,
      SSH_MAX_OUTPUT_BYTES,
      true,
    );
    if (!started.ok)
      return this.#remoteStartFailure(
        owner,
        started.error,
        "start_ios_remote_helper",
      );
    let markers: Map<string, string>;
    try {
      markers = captureRemoteHelperLaunch(owner, started.value);
    } catch (cause) {
      return this.#remoteStartFailure(
        owner,
        asFailure("start_ios_remote_helper", cause, SSH_TIMEOUT_MS),
        "start_ios_remote_helper",
      );
    }
    if (started.value.exitCode !== 0)
      return this.#remoteStartFailure(
        owner,
        new AnalysisProtocolError(
          `Remote helper command exited ${String(started.value.exitCode)}: ${started.value.stderr.toString("utf8").slice(0, STDERR_EXCERPT_BYTES)}`,
        ),
        "start_ios_remote_helper",
      );
    if (markers.get("status") !== "attached") {
      const retired = await this.#retireRemoteHelper(owner);
      if (!retired.ok) return retired;
      return err(
        new AnalysisUnsupportedTargetError(
          "attach_ios_debugserver",
          "iOS process",
          markers.get("reason") ??
            (started.value.stdout
              .toString("utf8")
              .slice(0, STDERR_EXCERPT_BYTES) ||
              "debugserver could not attach"),
        ),
      );
    }
    if (owner.directoryCreated !== true)
      return this.#remoteStartFailure(
        owner,
        new AnalysisProtocolError(
          "Debugserver did not acknowledge its private log directory",
        ),
        "attach_ios_debugserver",
      );
    const remotePid = Number(markers.get("pid"));
    if (!Number.isSafeInteger(remotePid) || remotePid <= 0) {
      const retired = await this.#retireRemoteHelper(owner);
      return retired.ok
        ? err(
            new AnalysisProtocolError(
              "debugserver did not report a valid remote PID",
            ),
          )
        : retired;
    }
    let forwarded: Tunnel;
    try {
      forwarded = await this.#ensureForward(deviceId, remotePort, signal);
    } catch (cause) {
      return this.#remoteStartFailure(
        owner,
        asFailure("attach_ios_debugserver", cause, SSH_TIMEOUT_MS),
        "attach_ios_debugserver",
      );
    }
    const session: DebugSession = {
      owner,
      pid,
      remotePort,
      localPort: forwarded.port,
      remotePid,
      debugserverPath: markers.get("path") ?? null,
    };
    this.#debugSessions.set(key, session);
    return ok(session);
  }

  async #ensureFridaServer(
    deviceId: string,
    remotePort: number,
    user: "root" | "mobile",
    signal?: AbortSignal,
  ): Promise<
    Result<
      { path: string | null; pid: number | null; owned: boolean },
      AnalysisError
    >
  > {
    const owner: RemoteHelperOwner = {
      deviceId,
      user,
      runToken: randomUUID(),
      launchAcknowledged: false,
      directoryCreated: undefined,
    };
    this.#remoteHelpers.set(owner.runToken, owner);
    const command = `${remoteTokenPrefix(owner.runToken)}; frida=$(command -v frida-server 2>/dev/null || true); [ -n "$frida" ] || { echo 'frida-server not found' >&2; exit 127; }; existing=''; owned=0; if command -v pgrep >/dev/null 2>&1; then existing=$(pgrep -x frida-server | head -1 || true); fi; if [ -n "$existing" ]; then printf 'directory_created\\t0\\n'; command -v lsof >/dev/null && lsof -nP -a -p "$existing" -iTCP:${String(remotePort)} -sTCP:LISTEN >/dev/null || { echo 'Existing frida-server endpoint is not verified for the requested port' >&2; exit 1; }; else ${remoteHelperLogPrefix(owner)}; REA_PROCESS_RUN_ID="$rea_token" nohup "$frida" -l 127.0.0.1:${String(remotePort)} >"$log" 2>&1 </dev/null & existing=$!; owned=1; sleep 1; fi; if [ "$owned" -eq 1 ]; then rea_identity=$(ps eww -p "$existing" -o command=) || exit 70; case " $rea_identity " in *" REA_PROCESS_RUN_ID=$rea_token "*) ;; *) exit 70 ;; esac; fi; if kill -0 "$existing" 2>/dev/null && command -v lsof >/dev/null && lsof -nP -a -p "$existing" -iTCP:${String(remotePort)} -sTCP:LISTEN >/dev/null; then printf 'path\\t%s\\n' "$frida"; printf 'pid\\t%s\\n' "$existing"; printf 'owned\\t%s\\n' "$owned"; exit 0; fi; [ "$owned" -eq 0 ] || cat "$log" 2>/dev/null || true; exit 1`;
    const started = await this.#runRemote(
      "run_ios_frida_script",
      deviceId,
      user,
      command,
      signal,
      SSH_TIMEOUT_MS,
      SSH_MAX_OUTPUT_BYTES,
      true,
    );
    if (!started.ok)
      return this.#remoteStartFailure(
        owner,
        started.error,
        "start_ios_remote_helper",
      );
    let markers: Map<string, string>;
    try {
      markers = captureRemoteHelperLaunch(owner, started.value);
    } catch (cause) {
      return this.#remoteStartFailure(
        owner,
        asFailure("start_ios_remote_helper", cause, SSH_TIMEOUT_MS),
        "start_ios_remote_helper",
      );
    }
    if (started.value.exitCode !== 0)
      return this.#remoteStartFailure(
        owner,
        new AnalysisProtocolError(
          `Remote helper command exited ${String(started.value.exitCode)}: ${started.value.stderr.toString("utf8").slice(0, STDERR_EXCERPT_BYTES)}`,
        ),
        "start_ios_remote_helper",
      );
    const pid = Number(markers.get("pid"));
    const validPid = Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    const ownershipMarker = markers.get("owned");
    if (
      validPid === null ||
      (ownershipMarker !== "0" && ownershipMarker !== "1")
    )
      return this.#remoteStartFailure(
        owner,
        new AnalysisProtocolError(
          "Frida did not report a valid process and ownership marker",
        ),
        "run_ios_frida_script",
      );
    if (ownershipMarker === "1" && owner.directoryCreated !== true)
      return this.#remoteStartFailure(
        owner,
        new AnalysisProtocolError(
          "Frida did not acknowledge its private log directory",
        ),
        "run_ios_frida_script",
      );
    if (ownershipMarker === "0") this.#remoteHelpers.delete(owner.runToken);
    return ok({
      path: markers.get("path") ?? null,
      pid: validPid,
      owned: ownershipMarker === "1",
    });
  }

  async #runLldb(
    localPort: number,
    commands: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Result<CapturedRemote, AnalysisError>> {
    const args = [
      "--batch",
      "--no-lldbinit",
      "-o",
      `gdb-remote 127.0.0.1:${String(localPort)}`,
    ];
    for (const command of commands) args.push("-o", command);
    try {
      const result = await execFileBytes(this.#selection("lldb").binary, args, {
        timeout: timeoutMs,
        stopSignal: "SIGTERM",
        maxBuffer: SSH_MAX_OUTPUT_BYTES,
        ...(signal === undefined ? {} : { signal }),
      });
      return ok({ stdout: result.stdout, stderr: result.stderr, exitCode: 0 });
    } catch (cause) {
      const failure = execFileOutputFailure(cause);
      if (typeof failure?.code === "number")
        return ok({
          stdout: Buffer.from(failure.stdout),
          stderr: Buffer.from(failure.stderr),
          exitCode: failure.code,
        });
      return err(asFailure("run_ios_lldb_command", cause, timeoutMs));
    }
  }

  async #runFrida(
    localPort: number,
    input: Extract<IosRequest, { operation: "run_ios_frida_script" }>["input"],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Result<CapturedRemote, AnalysisError>> {
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), "rea-ios-frida-"));
      const scriptPath = join(directory, "agent.js");
      await writeFile(scriptPath, input.script, {
        encoding: "utf8",
        mode: 0o600,
      });
      const target =
        input.pid === undefined
          ? ["-n", input.process!]
          : ["-p", String(input.pid)];
      const args = [
        "-H",
        `127.0.0.1:${String(localPort)}`,
        "-q",
        ...target,
        "-l",
        scriptPath,
        "--no-pause",
      ];
      const result = await execFileBytes(
        this.#selection("frida").binary,
        args,
        {
          timeout: timeoutMs,
          stopSignal: "SIGTERM",
          maxBuffer: SSH_MAX_OUTPUT_BYTES,
          ...(signal === undefined ? {} : { signal }),
        },
      );
      return ok({ stdout: result.stdout, stderr: result.stderr, exitCode: 0 });
    } catch (cause) {
      const failure = execFileOutputFailure(cause);
      if (failure?.outputTruncated || failure?.killed === true)
        return ok({
          stdout: Buffer.from(failure.stdout),
          stderr: Buffer.from(failure.stderr),
          exitCode: null,
          stopReason: failure.outputTruncated ? "output_limit" : "duration",
          outputTruncated: failure.outputTruncated,
        });
      if (typeof failure?.code === "number")
        return ok({
          stdout: Buffer.from(failure.stdout),
          stderr: Buffer.from(failure.stderr),
          exitCode: failure.code,
        });
      return err(asFailure("run_ios_frida_script", cause, timeoutMs));
    } finally {
      if (directory !== undefined)
        await rm(directory, { recursive: true, force: true });
    }
  }

  async #stopTunnel(tunnel: Tunnel): Promise<void> {
    const stopped = await tunnel.supervisor.stop();
    if (stopped.status === "incomplete")
      throw new ProviderCleanupError(
        IOS_PROVIDER_IDENTITY.id,
        [tunnel.key],
        { reason: stopped.reason },
        { operation: "close_ios_forward" },
      );
    if (this.#tunnels.get(tunnel.key) === tunnel)
      this.#tunnels.delete(tunnel.key);
  }

  async #ensureForward(
    deviceId: string,
    remotePort: number,
    signal?: AbortSignal,
  ): Promise<Tunnel> {
    if (signal?.aborted) throw new AnalysisCancelledError("iproxy");
    const key = `${deviceId}:${String(remotePort)}`;
    const pending = this.#tunnelStarts.get(key);
    if (pending !== undefined) return waitForSharedStartup(pending, signal);
    const existing = this.#tunnels.get(key);
    if (
      existing !== undefined &&
      existing.ready &&
      existing.supervisor.observedExit() === undefined &&
      existing.startupFailure() === undefined
    )
      return existing;
    const started = (async () => {
      if (existing !== undefined) await this.#stopTunnel(existing);
      return this.#startForward(
        deviceId,
        remotePort,
        key,
        this.#startupLifetime.signal,
      );
    })();
    this.#tunnelStarts.set(key, started);
    const release = () => {
      if (this.#tunnelStarts.get(key) === started)
        this.#tunnelStarts.delete(key);
    };
    void started.then(release, release);
    return waitForSharedStartup(started, signal);
  }

  async #startForward(
    deviceId: string,
    remotePort: number,
    key: string,
    signal?: AbortSignal,
  ): Promise<Tunnel> {
    const selection = this.#selection("iproxy");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("Could not allocate an iproxy port");
    }
    const port = address.port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (signal?.aborted) throw new AnalysisCancelledError("iproxy");
    const spawned = await spawnOwnedProviderProcess({
      command: selection.binary,
      arguments: [`${String(port)}:${String(remotePort)}`, "-u", deviceId],
      runId: `rea-ios-forward-${randomUUID()}`,
      hostEnvironment: this.#environment,
      ...(signal === undefined ? {} : { signal }),
    });
    let startupFailure: string | undefined;
    const supervisor = new ProviderProcessSupervisor(
      {
        ...spawned,
        ownsProcessLifetime: true,
        cleanup:
          spawned.cleanup ??
          (() => cleanupOwnedProcessGroup(spawned.ownership)),
      },
      {
        maxDiagnosticBytes: 64 * 1024,
        onDiagnostic: (event) => {
          if (event.type === "error") startupFailure = event.message;
        },
      },
    );
    const tunnel: Tunnel = {
      key,
      remotePort,
      port,
      supervisor,
      startupFailure: () => startupFailure,
      ready: false,
    };
    this.#tunnels.set(key, tunnel);
    try {
      await this.#waitForPort(port, tunnel, signal);
      if (signal?.aborted) throw new AnalysisCancelledError("iproxy");
      tunnel.ready = true;
      return tunnel;
    } catch (cause) {
      try {
        await this.#stopTunnel(tunnel);
      } catch (cleanup) {
        throw new ProviderCleanupError(
          IOS_PROVIDER_IDENTITY.id,
          [key],
          { reason: "Forward startup and cleanup failed" },
          {
            operation: "start_ios_forward",
            cause: new AggregateError([cause, cleanup]),
          },
        );
      }
      throw cause;
    }
  }

  async #waitForPort(
    port: number,
    tunnel: Tunnel,
    signal?: AbortSignal,
  ): Promise<void> {
    const started = performance.now();
    while (performance.now() - started < IPROXY_START_TIMEOUT_MS) {
      if (signal?.aborted) throw new AnalysisCancelledError("iproxy");
      const startupFailure = tunnel.startupFailure();
      if (startupFailure !== undefined) throw new Error(startupFailure);
      if (tunnel.supervisor.observedExit() !== undefined)
        throw new Error("iproxy exited before opening its local port");
      const connected = await new Promise<boolean>((resolve) => {
        const socket = connect({ host: "127.0.0.1", port });
        const done = (value: boolean) => {
          socket.destroy();
          resolve(value);
        };
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
        socket.setTimeout(250, () => done(false));
      });
      if (
        connected &&
        tunnel.supervisor.observedExit() === undefined &&
        tunnel.startupFailure() === undefined
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new AnalysisTimeoutError("iproxy", IPROXY_START_TIMEOUT_MS);
  }
}
