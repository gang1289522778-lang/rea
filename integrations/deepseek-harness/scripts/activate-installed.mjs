#!/usr/bin/env node
/**
 * Opt-in activation of an already-installed REA bundle in Harness Desktop.
 * No pnpm operations, no install hooks, and no writes without --activate.
 */
import { randomBytes } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseReaCordisPatch } from "./cordis-contract.mjs";

const name = "dsh-rea-bundle";
const usage = [
  "Usage: node activate-installed.mjs [--status | --activate | --verify]",
  "--status: read-only check (default)",
  "--activate: back up the profile and enable the installed bundle",
  "--verify: report whether live Desktop runtime inspection is available",
  "Quit DeepSeek Harness Desktop completely before using --activate.",
].join("\n");

function fail(message) {
  throw new Error(message);
}

function parseJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail("Cannot read or parse " + path + ": " + error.message);
  }
}

function inspect(profileDir) {
  const manifest = join(profileDir, "package.json");
  if (!existsSync(manifest)) fail("Desktop profile missing: " + manifest);
  const original = readFileSync(manifest);
  const config = parseJson(manifest);
  const dependencies = config.dependencies;
  if (
    !dependencies ||
    typeof dependencies !== "object" ||
    Array.isArray(dependencies)
  ) {
    fail("Invalid Desktop dependency map; refusing to modify the profile");
  }
  const selected = config.dsh?.profile?.bundles;
  if (
    !Array.isArray(selected) ||
    selected.some((item) => typeof item !== "string")
  ) {
    fail("Invalid dsh.profile.bundles; refusing to reconstruct a profile");
  }
  if (new Set(selected).size !== selected.length) {
    fail(
      "dsh.profile.bundles already contains duplicates; repair via Desktop first",
    );
  }
  const installed =
    typeof dependencies[name] === "string" && dependencies[name].length > 0;
  const active = selected.includes(name);
  const packageDir = join(profileDir, "node_modules", name);
  const installedManifest = join(packageDir, "package.json");
  const pkg = existsSync(installedManifest)
    ? parseJson(installedManifest)
    : undefined;
  const patchPath = join(packageDir, "cordis.patch.yml");
  const patch = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "";
  const correctBundle =
    pkg?.name === name && pkg?.dsh?.bundle?.patch === "./cordis.patch.yml";
  const parsedPatch = parseReaCordisPatch(patch);
  const correctPatch = parsedPatch.ok;
  return {
    manifest,
    original,
    config,
    selected,
    installed,
    active,
    correctBundle,
    correctPatch,
    patchFailure: parsedPatch.ok ? undefined : parsedPatch.error,
    version: pkg?.version,
    profileDir,
  };
}

function status(info) {
  console.log("Profile: " + info.profileDir);
  console.log("Installed in dependencies: " + (info.installed ? "yes" : "NO"));
  console.log(
    "Installed package: " +
      (info.correctBundle
        ? "valid " + (info.version ?? "")
        : "missing/invalid"),
  );
  console.log(
    "REA Cordis patch: " + (info.correctPatch ? "valid" : "missing/invalid"),
  );
  console.log(
    "Enabled in dsh.profile.bundles: " +
      (info.active ? "yes" : "NO") +
      " (" +
      info.selected.length +
      " bundles)",
  );
  if (
    info.installed &&
    info.correctBundle &&
    info.correctPatch &&
    !info.active
  ) {
    console.log(
      "Next: enable dsh-rea-bundle in Desktop > Plugins > Installed plugins.",
    );
    console.log(
      "If the switch is unavailable, quit Desktop and run --activate.",
    );
  }
}

function activate(info) {
  if (!info.installed) {
    fail(
      "REA is not a direct Desktop dependency; first install dsh-rea-bundle",
    );
  }
  if (!info.correctBundle || !info.correctPatch) {
    fail(
      "The installed REA plugin is missing required bundle files; activation refused" +
        (info.patchFailure ? ": " + info.patchFailure : ""),
    );
  }
  if (info.active) {
    console.log("Already enabled: no write, no new backup, no duplicate.");
    return;
  }

  const updated = structuredClone(info.config);
  updated.dsh.profile.bundles.push(name);
  const current = readFileSync(info.manifest);
  if (!current.equals(info.original)) {
    fail("Profile changed during inspection; close Desktop and retry");
  }

  // Preserve a byte-identical recovery copy. Replace the manifest atomically.
  const nonce =
    new Date().toISOString().replace(/[:.]/g, "-") +
    "-" +
    process.pid +
    "-" +
    randomBytes(4).toString("hex");
  const backup = info.manifest + ".rea-backup-" + nonce;
  copyFileSync(info.manifest, backup, constants.COPYFILE_EXCL);
  const tmp = join(
    dirname(info.manifest),
    ".package.json.rea-" + nonce + ".tmp",
  );
  try {
    const mode = statSync(info.manifest).mode & 0o777;
    writeFileSync(tmp, JSON.stringify(updated, null, 2) + "\n", {
      flag: "wx",
      mode,
    });
    if (!readFileSync(info.manifest).equals(info.original)) {
      fail(
        "Profile changed before replacement; original retained and backup saved",
      );
    }
    renameSync(tmp, info.manifest);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
  console.log(
    "Enabled dsh-rea-bundle after " +
      (updated.dsh.profile.bundles.length - 1) +
      " existing bundle entries.",
  );
  console.log("Exact backup: " + backup);
  console.log(
    "Fully restart DeepSeek Harness Desktop, then inspect mcp__rea__* tools in a live session.",
  );
}

function verify(info) {
  if (!info.installed || !info.active) {
    fail("REA is not installed and enabled; quit Desktop then run --activate");
  }
  if (!info.correctBundle || !info.correctPatch)
    fail("Installed REA bundle metadata or its Cordis patch is invalid");
  fail(
    "Live Desktop composition remains unverified. cordis.yml is an empty loader root, not the effective runtime. Check mcp__rea__* discovery in a live Desktop session; stored profile files do not prove MCP startup.",
  );
}

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["-h", "--help"].includes(args[0])) {
    console.log(usage);
  } else {
    const action =
      args.length === 0 ? "--status" : args.length === 1 ? args[0] : "";
    if (!["--status", "--activate", "--verify"].includes(action)) fail(usage);
    const home = process.env.DSH_HOME || join(homedir(), ".dsh");
    const info = inspect(join(home, "profiles", "desktop"));
    status(info);
    if (action === "--activate") activate(info);
    if (action === "--verify") verify(info);
  }
} catch (error) {
  console.error("REA Desktop activation: " + error.message);
  process.exitCode = 1;
}
