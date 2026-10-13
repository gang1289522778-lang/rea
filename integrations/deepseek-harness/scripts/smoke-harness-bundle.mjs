/** API-key-free check of the installed bundle through Harness's real Loader and MCP bridge. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const harnessRoot = resolve(process.argv[2] ?? "harness-upstream");
const installedProfile = resolve(process.argv[3] ?? "");
if (!process.argv[3])
  throw new Error("Expected Harness checkout and installed profile paths");
const home = await mkdtemp(join(tmpdir(), "rea-harness-boot-"));
const profileDir = join(home, "profiles", "rea-bundle-smoke");
let runtime;
let succeeded = false;
// This bounds initialization/disposal, not any user-selected analysis operation.
const watchdog = setTimeout(() => process.kill(process.pid, "SIGINT"), 120_000);
try {
  const installAnchor = join(harnessRoot, "apps/cli/package.json");
  const harnessRequire = createRequire(installAnchor);
  const profileRequire = createRequire(join(installedProfile, "package.json"));
  const bundleDir = dirname(profileRequire.resolve("dsh-rea-bundle"));
  const bundle = JSON.parse(
    await readFile(join(bundleDir, "package.json"), "utf8"),
  );
  assert.equal(bundle.name, "dsh-rea-bundle");
  const { loadProfileDirectory } = await import(
    pathToFileURL(harnessRequire.resolve("@deepseek-ai/dsh-app-boot"))
  );
  const { createLaunchEnvironmentSnapshot } = await import(
    pathToFileURL(harnessRequire.resolve("@deepseek-ai/dsh-launch-environment"))
  );
  const { runProfile } = await import(
    pathToFileURL(join(harnessRoot, "apps/cli/lib/profile-boot.js"))
  );
  await mkdir(profileDir, { recursive: true });
  await symlink(
    join(installedProfile, "node_modules"),
    join(profileDir, "node_modules"),
    "dir",
  );
  await writeFile(
    join(profileDir, "package.json"),
    JSON.stringify({
      name: "rea-bundle-smoke",
      version: "0.0.0",
      private: true,
      dependencies: { "dsh-rea-bundle": bundle.version },
      dsh: { profile: { bundles: ["dsh-rea-bundle"] } },
    }),
  );
  // Supply only the keyless registry dependencies. The installed bundle supplies
  // both launcher and MCP rows; do not duplicate their config or evaluate !!js here.
  await writeFile(
    join(profileDir, "cordis.patch.yml"),
    [
      "- insert:",
      "    - id: system-prompt",
      "      name: '@deepseek-ai/dsh-system-prompt'",
      "    - id: tools",
      "      name: '@deepseek-ai/dsh-tools'",
      "",
    ].join("\n"),
  );
  process.env.DSH_HOME = home;
  process.env.DSH_TELEMETRY_DISABLED = "1";
  const environment = createLaunchEnvironmentSnapshot([
    {
      source: "process",
      values: Object.fromEntries(
        Object.entries(process.env).filter(([, value]) => value !== undefined),
      ),
    },
  ]);
  runtime = await runProfile({
    environment,
    profile: "rea-bundle-smoke",
    patchFiles: [],
    args: [],
    resolvedProfile: {
      profile: loadProfileDirectory("dsh", profileDir, installAnchor),
      installAnchor,
    },
  });
  const tools = runtime.ctx.get("tools");
  assert(tools, "Harness must provide its live tool registry");
  const names = tools.schemas().map((tool) => tool.name);
  assert(
    names.includes("mcp__rea__analyze_javascript_application"),
    "Installed REA tools must be discovered through Harness's MCP client",
  );
  assert(names.filter((name) => name.startsWith("mcp__rea__")).length > 0);
  succeeded = true;
  console.log(
    "Harness Loader boot and live REA MCP bridge discovery: OK (no model/API key)",
  );
} finally {
  // Cleanup failure or forced cleanup timeout must fail this check, even after discovery.
  if (runtime) await runtime.shutdown.shutdown(1);
  clearTimeout(watchdog);
  await rm(home, { recursive: true, force: true });
  if (succeeded) process.exitCode = 0;
}
