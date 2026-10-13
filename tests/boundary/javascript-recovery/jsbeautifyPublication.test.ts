import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const scenario = vi.hoisted(() => ({ mutateSnapshot: false }));
beforeEach(() => {
  scenario.mutateSnapshot = false;
});

vi.mock(
  "../../../src/javascript/recovery/JsBeautifyRelease.js",
  async (original) => {
    const actual =
      await original<
        typeof import("../../../src/javascript/recovery/JsBeautifyRelease.js")
      >();
    return {
      ...actual,
      JSBEAUTIFY_LIMITS: {
        ...actual.JSBEAUTIFY_LIMITS,
        outputBytes: 16 * 1024,
      },
    };
  },
);
vi.mock(
  "../../../src/javascript/recovery/RecoveryCommand.js",
  async (original) => {
    const actual =
      await original<
        typeof import("../../../src/javascript/recovery/RecoveryCommand.js")
      >();
    return {
      ...actual,
      runRecoveryCommand: async (
        context: Parameters<typeof actual.runRecoveryCommand>[0],
      ) => {
        const version = context.arguments[0] === "--version";
        let stderr = "";
        if (!version) {
          expect(context.staging).toBe(join(context.cwd, "modules"));
          const source = await readFile(context.arguments[0]!, "utf8");
          if (scenario.mutateSnapshot)
            await writeFile(context.arguments[0]!, "const value = 99;");
          const output =
            context.arguments[context.arguments.indexOf("--output") + 1]!;
          await mkdir(dirname(output), { recursive: true });
          await writeFile(output, "const value = 42;".padEnd(4 * 1024, " "));
          stderr =
            "[DEOBFUSCATE] Phase 19.6: Generated output re-parse succeeded\n" +
            (source.includes("FAIL")
              ? ""
              : "[DEOBFUSCATE] Phase 21.5: Generated output re-parse succeeded");
        }
        return {
          exit_code: 0,
          signal: null,
          stdout: version ? "jsbeautify 1.0" : "",
          stderr,
          command: context.command,
          arguments: [...context.arguments],
          resource_limiter: context.limiter,
        };
      },
    };
  },
);

import { JavaScriptRecoveryService } from "../../../src/application/javascript/JavaScriptRecoveryService.js";
import { jsbeautifyEngine } from "../../../src/javascript/recovery/JsBeautifyEngine.js";
import { RecoveryProvider } from "../../../src/javascript/recovery/RecoveryProvider.js";
import { fingerprintRecoveryFile } from "../../../src/javascript/recovery/RecoveryFiles.js";
import { javascriptRecoveryResultSchema } from "../../../src/domain/javascript/javascriptRecovery.js";

const recover = async (names: string[], failing = false) => {
  const root = await createTestTempDirectory("rea-jsbeautify-publication-");
  const command = join(root, "engine");
  await writeFile(command, "fixture engine");
  const fingerprint = await fingerprintRecoveryFile(command, 16 * 1024);
  const sources = names.map((name) => join(root, name));
  for (const path of sources)
    await writeFile(path, failing ? "FAIL" : "const value = 42;");
  const provider = new RecoveryProvider(
    [
      {
        ...jsbeautifyEngine,
        resolve: async () => ({
          command,
          limiter: "/fixture/prlimit",
          ...fingerprint,
        }),
      },
    ],
    {},
  );
  const service = new JavaScriptRecoveryService(provider);
  try {
    return await service.recover({
      path: sources[0]!,
      additional_paths: sources.slice(1),
      output_directory: join(root, "output"),
      engine: "jsbeautify",
    });
  } finally {
    await provider.close();
  }
};

it.each([{ names: ["bundle"] }, { names: ["bundle", "chunk.data"] }])(
  "publishes extensionless scripts with discoverable JavaScript names: $names",
  async ({ names }) => {
    const evidence = await recover(names);
    if (!evidence.ok) throw evidence.error;
    const result = javascriptRecoveryResultSchema.parse(
      evidence.value.normalized_result,
    );
    expect(result.modules.map((module) => module.reported_filename)).toEqual(
      names.map((name) => `${name}.js`),
    );
    expect(
      result.modules.map((module) =>
        module.provenance.original_path.split("/").at(-1),
      ),
    ).toEqual(names);
  },
);

it.skipIf(process.platform === "win32")(
  "uses the safe snapshot basename for native-only filenames",
  async () => {
    const evidence = await recover(["a\\b.js"]);
    if (!evidence.ok) throw evidence.error;
    const result = javascriptRecoveryResultSchema.parse(
      evidence.value.normalized_result,
    );
    expect(result.modules[0]?.reported_filename).toBe("bundle.js");
  },
);

it("rejects combined staging output beyond one operation's budget", async () => {
  const evidence = await recover(
    ["a.js", "b.js", "c.js", "d.js", "e.js"],
    true,
  );
  expect(evidence.ok).toBe(false);
  if (!evidence.ok)
    expect(evidence.error).toMatchObject({
      _tag: "AnalysisOutputError",
      message: expect.stringContaining("Recovery staging exceeds"),
    });
});

it("does not claim successful reparsing when every file fails its gate", async () => {
  const evidence = await recover(["a.js", "b.js"], true);
  if (!evidence.ok) throw evidence.error;
  const result = javascriptRecoveryResultSchema.parse(
    evidence.value.normalized_result,
  );
  expect(result.modules).toEqual([]);
  expect(result.analysis_input).toBeNull();
  expect(result.reported_safety).toContain("No output passed");
});

it("allocates distinct discoverable outputs for an extension collision", async () => {
  const evidence = await recover(["bundle", "bundle.js"]);
  if (!evidence.ok) throw evidence.error;
  const result = javascriptRecoveryResultSchema.parse(
    evidence.value.normalized_result,
  );
  expect(result.modules).toHaveLength(2);
  expect(
    new Set(result.modules.map((module) => module.artifact.path)).size,
  ).toBe(2);
  expect(
    result.modules.every((module) => module.reported_filename.endsWith(".js")),
  ).toBe(true);
  expect(
    result.modules.map((module) =>
      module.provenance.original_path.split("/").at(-1),
    ),
  ).toEqual(["bundle", "bundle.js"]);
});

it("refuses output when the engine mutates its input snapshot", async () => {
  scenario.mutateSnapshot = true;
  const evidence = await recover(["a.js"]);
  expect(evidence.ok).toBe(false);
  if (!evidence.ok)
    expect(evidence.error).toMatchObject({
      _tag: "AnalysisOutputError",
      message: expect.stringContaining("input snapshot changed"),
    });
});
