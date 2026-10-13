import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseReaCordisPatch } from "./cordis-contract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert.equal(pkg.name, "dsh-rea-bundle");
assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml");
assert.equal(pkg.type, "module");
assert.equal(pkg.dependencies["rea-agents"], "6.4.0");
for (const script of [
  "prepare",
  "prepack",
  "install",
  "postinstall",
  "preinstall",
]) {
  assert.equal(pkg.scripts?.[script], undefined);
}
for (const file of [
  "launcher.mjs",
  "cordis.patch.yml",
  "README.md",
  "README.zh-CN.md",
  "LICENSE",
  "scripts/activate-installed.mjs",
  "scripts/cordis-contract.mjs",
]) {
  assert(existsSync(join(root, file)), `missing bundled file ${file}`);
  assert(pkg.files.includes(file), `missing packlist file ${file}`);
}
const patch = readFileSync(join(root, "cordis.patch.yml"), "utf8");
const parsed = parseReaCordisPatch(patch);
assert.ok(parsed.ok, parsed.ok ? undefined : parsed.error);
console.log("dsh-rea-bundle manifest/patch contract: OK");
