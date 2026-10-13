import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../scripts/prepare-desktop-install.sh",
);

test("Desktop installer validates as Bash and documents the Git-root failure", () => {
  const syntax = spawnSync("bash", ["-n", script], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const help = spawnSync("bash", [script, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /build-required rea-agents CLI/);
  assert.match(help.stdout, /Desktop > Plugins > Add plugin/);
});

test("Desktop installer fails closed on a corrupt download without changing profile", () => {
  const home = mkdtempSync(join(tmpdir(), "rea-desktop-install-"));
  const bin = join(home, "bin");
  const profile = join(home, "profiles", "desktop");
  try {
    mkdirSync(bin);
    mkdirSync(profile, { recursive: true });
    const manifest = '{"dependencies":{"another-plugin":"1.2.3"}}';
    writeFileSync(join(profile, "package.json"), manifest);
    const mockCurl = join(bin, "curl");
    writeFileSync(
      mockCurl,
      '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n if [ "$1" = "--output" ]; then\n shift\n printf "%s" bad-archive > "$1"\n exit 0\n fi\n shift\ndone\nexit 9\n',
    );
    chmodSync(mockCurl, 0o755);
    const run = spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        DSH_HOME: home,
        PATH: [bin, process.env.PATH].join(":"),
      },
    });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /SHA-256 mismatch/);
    assert.equal(
      existsSync(join(home, "plugin-packages", "dsh-rea-bundle-0.2.1.tgz")),
      false,
    );
    assert.deepEqual(readdirSync(join(home, "plugin-packages")), []);
    assert.equal(readFileSync(join(profile, "package.json"), "utf8"), manifest);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
