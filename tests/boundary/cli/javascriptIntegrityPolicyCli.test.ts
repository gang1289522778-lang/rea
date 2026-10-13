import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { createStrippedAsarAddon } from "../../fixtures/strippedAsarAddon.js";

const execute = promisify(execFile);
const run = async (arguments_: readonly string[]): Promise<unknown> => {
  const { stdout } = await execute(
    process.execPath,
    ["scripts/rea.mjs", ...arguments_, "--json"],
    { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
};

it.each(["analyze-javascript-application", "analyze"])(
  "%s carries the integrity policy into shared JavaScript analysis",
  async (command) => {
    const { archive, addon } = await createStrippedAsarAddon();
    const result = await run([
      command,
      archive,
      "--integrity-policy",
      "record-and-continue",
    ]);
    expect(result).toMatchObject({
      operation: "analyze_javascript_application",
      parameters: { integrity_policy: "record-and-continue" },
      normalized_result: {
        integrity_contradictions: [
          { logical_path: addon, trust: "observed-untrusted" },
        ],
        graph: { coverage: { status: "partial" } },
      },
    });
  },
);

it("rejects the JavaScript integrity policy on binary-only inspection", async () => {
  await expect(
    run(["inspect", "unused.asar", "--integrityPolicy", "record-and-continue"]),
  ).rejects.toMatchObject({
    code: 1,
    stdout: expect.stringContaining("Unknown flag: --integrityPolicy"),
  });
});

it("rejects the JavaScript integrity policy on a binary analyze target", async () => {
  // `analyze` has to declare the option for its JavaScript lane, so a binary
  // target needs an explicit refusal rather than proceeding without it.
  await expect(
    run(["analyze", "unused.bin", "--integrity-policy", "record-and-continue"]),
  ).rejects.toMatchObject({
    code: 1,
    stdout: expect.stringContaining("integrity_policy"),
  });
});

it("still routes a binary analyze target without an integrity policy", async () => {
  // The option carries a default, so the refusal above must key off the value
  // rather than the flag's presence, or every binary analyze would be refused.
  await expect(run(["analyze", "unused.bin"])).rejects.toMatchObject({
    code: 1,
    stdout: expect.stringContaining("target does not exist"),
  });
});
