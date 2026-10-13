/**
 * Cordis service provider for REA's local stdio MCP launcher.
 *
 * This module is intentionally build-free. Git-based Harness plugin installs
 * receive source files, and pnpm >=10 may block install-time build scripts.
 * Resolve the npm package's shipped executable using Node's package resolver
 * rather than assuming a particular pnpm/desktop node_modules layout.
 */
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { statSync } from "node:fs";

const require = createRequire(import.meta.url);
const REA_ENTRY = "rea-agents/scripts/rea.mjs";
const PROVIDER_ENVIRONMENT_KEYS = [
  "REA_ANALYSIS_PROVIDER",
  "REA_IDA_MCP_CONFIG",
  "GHIDRA_INSTALL_DIR",
  "JAVA_HOME",
  "REA_GHIDRA_NATIVEAOT_JAR",
  "REA_GHIDRA_STARTUP_TIMEOUT_MS",
  "REA_HOPPER_STARTUP_TIMEOUT_MS",
  "REA_GHIDRA_LANGUAGE_ID",
  "REA_GHIDRA_COMPILER_SPEC_ID",
  "REA_GHIDRA_DISABLED_ANALYZERS",
  "REA_GHIDRA_SEED_FILE",
  "REA_ILSPY_CMD_PATH",
  "HOPPER_LAUNCHER_PATH",
  "HOPPER_TARGET_PATH",
  "HOPPER_TARGET_KIND",
  "HOPPER_LOADER_ARGS_JSON",
  "REA_LOG_LEVEL",
  "REA_MCP_MAX_RESPONSE_BYTES",
  "REA_REFERENCE_SECRET_PATTERNS_JSON",
  "REA_ADB_PATH",
  "REA_APKTOOL_COMMAND",
  "REA_JADX_MCP_JAR",
  "REA_JADX_HEAP_MIB",
  "REA_JADX_ACTIVE_PROCESSOR_COUNT",
  "REA_JEB_MCP_URL",
  "REA_BROWSER_EXECUTABLE",
  "REA_BROWSER_NO_SANDBOX",
  "REA_BINWALK_COMMAND",
  "REA_UNBLOB_COMMAND",
  "REA_FIRMWARE_PRLIMIT_COMMAND",
  "REA_TSHARK_COMMAND",
  "REA_CAPINFOS_COMMAND",
  "REA_TSHARK_PRLIMIT_COMMAND",
  "REA_MITMDUMP_COMMAND",
  "REA_SIGROK_COMMAND",
  "REA_SIGROK_PRLIMIT_COMMAND",
  "REA_WABT_BIN_DIRECTORY",
  "REA_EVM_PRLIMIT_COMMAND",
  "REA_WAKARU_COMMAND",
  "REA_JAVASCRIPT_PRLIMIT_COMMAND",
  "REA_PWNTOOLS_PYTHON",
  "REA_PWNDBG_GDB",
  "REA_PWNDBG_GDBINIT",
  "REA_PWNDBG_VENV_PATH",
  "REA_DARWIN_SWIFTC_PATH",
  "REA_DARWIN_MODULE_CACHE_PATH",
  "SDKROOT",
];
const PROFILE_VALUES = new Set(["compact", "full"]);

export const name = "rea-launcher";

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

/**
 * Resolve an explicit local fork checkout, or the pinned prebuilt npm REA.
 * Node hosts reuse their executable. Electron hosts require an explicit standalone
 * Node path; neither a shell nor npx is used and no runtime is downloaded.
 */
export function resolveReaLauncher({
  env = process.env,
  execPath = process.execPath,
  electronVersion = process.versions.electron,
  resolvePackage = (specifier) => require.resolve(specifier),
  fileExists = isFile,
} = {}) {
  const override = env.REA_DSH_ENTRYPOINT;
  let entrypoint;
  if (override !== undefined) {
    if (typeof override !== "string" || !isAbsolute(override)) {
      throw new Error(
        "REA_DSH_ENTRYPOINT must be an absolute path to scripts/rea.mjs",
      );
    }
    entrypoint = resolve(override);
  } else {
    try {
      entrypoint = resolvePackage(REA_ENTRY);
    } catch (cause) {
      throw new Error(
        "REA npm runtime is unavailable; install the bundle dependencies or set REA_DSH_ENTRYPOINT",
        { cause },
      );
    }
  }
  if (!fileExists(entrypoint)) {
    throw new Error(`REA launcher is not a regular file: ${entrypoint}`);
  }

  const profile = env.REA_DSH_SCHEMA_PROFILE ?? "compact";
  if (!PROFILE_VALUES.has(profile)) {
    throw new Error("REA_DSH_SCHEMA_PROFILE must be either compact or full");
  }
  const selectedNode =
    env.REA_DSH_NODE_PATH ??
    (electronVersion === undefined ? execPath : undefined);
  if (
    selectedNode === undefined ||
    !isAbsolute(selectedNode) ||
    (env.REA_DSH_NODE_PATH !== undefined && !fileExists(selectedNode))
  )
    throw new Error(
      "Electron hosts require REA_DSH_NODE_PATH to name an existing standalone Node executable",
    );
  if (
    electronVersion !== undefined &&
    resolve(selectedNode) === resolve(execPath)
  )
    throw new Error(
      "REA_DSH_NODE_PATH must name standalone Node, not the Electron application executable",
    );
  const timeout = Number(env.REA_DSH_TOOL_CALL_TIMEOUT_MS ?? "2147483647");
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647)
    throw new Error(
      "REA_DSH_TOOL_CALL_TIMEOUT_MS must be an integer from 1 through 2147483647",
    );
  const environment = Object.fromEntries(
    PROVIDER_ENVIRONMENT_KEYS.filter((key) => env[key] !== undefined).map(
      (key) => [key, env[key]],
    ),
  );
  // Only explicitly defined REA configuration is forwarded. Harness owns
  // ambient credential filtering and process isolation for the spawned child.
  return Object.freeze({
    command: selectedNode,
    args: Object.freeze([entrypoint, "mcp"]),
    env: Object.freeze({
      ...environment,
      REA_MCP_INPUT_SCHEMA_PROFILE: profile,
    }),
    toolCallTimeoutMs: timeout,
  });
}

export function apply(ctx) {
  // Cordis owns the service lifecycle. The MCP client waits for this service
  // through `inject`, then owns its stdio child, tools and reconnect cleanup.
  ctx.provide("reaLauncher", resolveReaLauncher());
}
