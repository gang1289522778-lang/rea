#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const bundlePath = process.argv[2];
if (bundlePath === undefined || process.argv.length !== 3)
  throw new Error(
    "Usage: node verify-windows-gui-bundle.mjs <bundle-directory>",
  );
const root = resolve(bundlePath);
if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("The Windows GUI bundle verifier requires Windows x64.");

const packageRoot = join(root, "node_modules", "rea-agents");
const launcher = join(root, "rea-gui.exe");
const node = join(root, "node.exe");
const packageJson = JSON.parse(
  await readFile(join(packageRoot, "package.json"), "utf8"),
);
for (const path of [
  launcher,
  node,
  join(root, "README-KO.md"),
  join(root, "NODE-LICENSE.txt"),
  join(root, "DOTNET-LICENSE.txt"),
  join(root, "DOTNET-ThirdPartyNotices.txt"),
  join(packageRoot, "scripts", "rea.mjs"),
  join(packageRoot, "windows-gui", "rea-gui.ps1"),
  join(packageRoot, "native", "windows", "build", "manifest.json"),
  join(packageRoot, "native", "windows", "build", "rea-windows-x64.node"),
]) {
  await access(path);
}
if (
  packageJson.bin?.["rea-gui"] !== "windows-gui/rea-gui.mjs" ||
  packageJson.engines?.node === undefined
)
  throw new Error(
    "The bundled REA package is missing its expected runtime contract.",
  );

for (const path of [launcher, node]) {
  const bytes = await readFile(path);
  const offset = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : bytes.length;
  if (
    bytes.toString("latin1", 0, 2) !== "MZ" ||
    offset > bytes.length - 26 ||
    bytes.toString("latin1", offset, offset + 4) !== "PE\0\0" ||
    bytes.readUInt16LE(offset + 4) !== 0x8664 ||
    bytes.readUInt16LE(offset + 24) !== 0x20b
  )
    throw new Error(`${path} must be a Windows x64 PE32+ executable.`);
}

const bundledNode = await execFileAsync(node, ["--version"]);
if (bundledNode.stdout.trim() !== process.version)
  throw new Error(
    "The bundled Node.js runtime differs from the build runtime.",
  );
const launcherCheck = await execFileAsync(launcher, ["--validate-only"], {
  windowsHide: true,
});
process.stdout.write(
  JSON.stringify({
    ok: true,
    packageVersion: packageJson.version,
    nodeVersion: bundledNode.stdout.trim(),
    validation: launcherCheck.stdout.trim(),
  }) + "\n",
);
