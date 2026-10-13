import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const script = resolve(
  repo,
  "integrations/deepseek-harness/scripts/stage-git-plugin.sh",
);

test("tag staging is valid and creates a standalone build-free package tree", () => {
  const syntax = spawnSync("bash", ["-n", script], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);

  const run = spawnSync("bash", [script, "--check"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(
    run.stdout,
    /Distribution tag: dsh-plugin-v[0-9]+\.[0-9]+\.[0-9]+/,
  );
  const tree = /Standalone DSH tree: ([a-f0-9]{40})/.exec(run.stdout)?.[1];
  assert(tree, "a standalone tree should exist");
  const listed = spawnSync("git", ["ls-tree", "-r", "--name-only", tree], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.stdout.trim().split("\n"), [
    "LICENSE",
    "README.md",
    "README.zh-CN.md",
    "cordis.patch.yml",
    "launcher.mjs",
    "package.json",
    "scripts/activate-installed.mjs",
    "scripts/cordis-contract.mjs",
  ]);
  const metadata = spawnSync("git", ["show", `${tree}:package.json`], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(metadata.status, 0, metadata.stderr);
  const manifest = JSON.parse(metadata.stdout);
  assert.equal(manifest.name, "dsh-rea-bundle");
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(manifest.scripts?.prepare, undefined);
  assert.equal(manifest.scripts?.prepack, undefined);
  assert.equal(manifest.dependencies["rea-agents"], "6.4.0");
});
