import { isAbsolute } from "node:path";

import type { ProviderAvailability } from "../application/AnalysisProvider.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import type { JsonValue } from "../domain/jsonValue.js";
import {
  execFileOutput,
  execFileOutputFailure,
} from "../process/ExecFileOutput.js";

export const IOS_IDEVICE_ID_PATH_ENV = "REA_IDEVICE_ID_PATH";
export const IOS_IDEVICEINFO_PATH_ENV = "REA_IDEVICEINFO_PATH";
export const IOS_IDEVICESYSLOG_PATH_ENV = "REA_IDEVICESYSLOG_PATH";
export const IOS_IDEVICEINSTALLER_PATH_ENV = "REA_IDEVICEINSTALLER_PATH";
export const IOS_IPROXY_PATH_ENV = "REA_IPROXY_PATH";
export const IOS_SSH_PATH_ENV = "REA_IOS_SSH_PATH";
export const IOS_SSHPASS_PATH_ENV = "REA_IOS_SSHPASS_PATH";
export const IOS_SSH_USER_ENV = "REA_IOS_SSH_USER";
export const IOS_SSH_PASSWORD_ENV = "REA_IOS_SSH_PASSWORD";
export const IOS_FRIDA_PATH_ENV = "REA_IOS_FRIDA_PATH";
export const IOS_LLDB_PATH_ENV = "REA_IOS_LLDB_PATH";

export type IosToolName =
  | "idevice_id"
  | "ideviceinfo"
  | "idevicesyslog"
  | "ideviceinstaller"
  | "iproxy"
  | "ssh"
  | "sshpass"
  | "frida"
  | "lldb";

const environmentKey: Record<IosToolName, string> = {
  idevice_id: IOS_IDEVICE_ID_PATH_ENV,
  ideviceinfo: IOS_IDEVICEINFO_PATH_ENV,
  idevicesyslog: IOS_IDEVICESYSLOG_PATH_ENV,
  ideviceinstaller: IOS_IDEVICEINSTALLER_PATH_ENV,
  iproxy: IOS_IPROXY_PATH_ENV,
  ssh: IOS_SSH_PATH_ENV,
  sshpass: IOS_SSHPASS_PATH_ENV,
  frida: IOS_FRIDA_PATH_ENV,
  lldb: IOS_LLDB_PATH_ENV,
};

const defaultBinary: Record<IosToolName, string> = {
  idevice_id: "idevice_id",
  ideviceinfo: "ideviceinfo",
  idevicesyslog: "idevicesyslog",
  ideviceinstaller: "ideviceinstaller",
  iproxy: "iproxy",
  ssh: "ssh",
  sshpass: "sshpass",
  frida: "frida",
  lldb: "lldb",
};

export interface IosToolSelection {
  readonly name: IosToolName;
  readonly binary: string;
  readonly pathSource: "environment" | "path";
}

export class IosConfigurationFailure extends Error {
  constructor(
    readonly code:
      | "not_absolute"
      | "binary_missing"
      | "version_unresolved"
      | "password_missing"
      | "invalid_user",
    message: string,
    readonly diagnostics: Readonly<Record<string, JsonValue>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "IosConfigurationFailure";
  }
}

export const resolveIosTool = (
  name: IosToolName,
  environment: Readonly<Record<string, string | undefined>>,
): IosToolSelection => {
  const key = environmentKey[name];
  const configured = environment[key];
  if (configured === undefined || configured.trim() === "")
    return { name, binary: defaultBinary[name], pathSource: "path" };
  if (!isAbsolute(configured))
    throw new IosConfigurationFailure(
      "not_absolute",
      `${key} must be an absolute path to the ${name} executable`,
      { configured_path: configured },
    );
  return { name, binary: configured, pathSource: "environment" };
};

export interface IosToolIdentity {
  readonly name: IosToolName;
  readonly binary: string;
  readonly pathSource: "environment" | "path";
  readonly version: string | null;
}

const extractVersion = (stdout: string, stderr: string): string | null => {
  const value = `${stdout}\n${stderr}`.match(
    /(?:version\s*)?([0-9]+(?:\.[0-9]+)+(?:[-+._A-Za-z0-9]*)?)/iu,
  )?.[1];
  return value?.trim() || null;
};

export const inspectIosTool = async (
  selection: IosToolSelection,
  signal?: AbortSignal,
): Promise<IosToolIdentity> => {
  try {
    const result = await execFileOutput(
      selection.binary,
      [selection.name === "ssh" ? "-V" : "--version"],
      {
        timeout: 10_000,
        stopSignal: "SIGTERM",
        maxBuffer: 64 * 1024,
        ...(signal === undefined ? {} : { signal }),
      },
    );
    return {
      ...selection,
      version: extractVersion(result.stdout, result.stderr),
    };
  } catch (cause) {
    const failure = execFileOutputFailure(cause);
    if (signal?.aborted || failure?.code === "ABORT_ERR")
      throw new AnalysisCancelledError("inspect_ios_toolchain", { cause });
    if (failure?.code === "ENOENT")
      throw new IosConfigurationFailure(
        "binary_missing",
        `The selected ${selection.name} executable was not found: ${selection.binary}`,
        {
          selected_binary: selection.binary,
          path_source: selection.pathSource,
          remediation: `Install libimobiledevice/libusbmuxd or set ${environmentKey[selection.name]} to an absolute path`,
        },
        { cause },
      );
    throw new IosConfigurationFailure(
      "version_unresolved",
      `The selected ${selection.name} executable did not report a usable version`,
      {
        selected_binary: selection.binary,
        stderr_excerpt: failure?.stderr.slice(0, 512) ?? "",
      },
      { cause },
    );
  }
};

export const iosConfigurationAvailability = (
  cause: IosConfigurationFailure,
): ProviderAvailability => ({
  status: "unavailable",
  code:
    cause.code === "binary_missing"
      ? "executable_missing"
      : cause.code === "not_absolute" || cause.code === "invalid_user"
        ? "not_configured"
        : "version_unresolved",
  reason: cause.message,
  diagnostics: { ...cause.diagnostics },
});
