import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { JavaScriptRecoveryService } from "../../../src/application/javascript/JavaScriptRecoveryService.js";
import { createJavaScriptRecoveryProvider } from "../../../src/composition/javascriptRecovery.js";
import { javascriptRecoveryResultSchema } from "../../../src/domain/javascript/javascriptRecovery.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const linux = it.skipIf(process.platform !== "linux");

/**
 * A jsbeautify stand-in speaking the real CLI shape: `--version`, then
 * `<input> --output <file> --quiet [flags]`. It records its arguments next to
 * the output and, like the real tool, reports both re-parse checks on stderr
 * when deobfuscating. A source containing FAIL omits the phase 21.5 check.
 */
const ENGINE = `#!${process.execPath}
const { readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("jsbeautify 9.9.9+abc1234"); process.exit(0); }
const source = readFileSync(args[0], "utf8");
const output = args[args.indexOf("--output") + 1];
writeFileSync(output, "/* recovered */\\n" + source);
writeFileSync(output + ".args.json", JSON.stringify(args));
if (args.includes("--deobfuscate") || args.includes("--rename-vars")) {
  console.error("[DEOBFUSCATE] Phase 0.9: esbuild/Bun runtime check: detected esbuild runtime with 9 helpers");
  console.error("[OPTIONAL_CHAINING] Detected optional chaining with depth 1");
  console.error("[DEOBFUSCATE] Phase 19.6: Generated output re-parse succeeded");
  if (!source.includes("FAIL")) console.error("[DEOBFUSCATE] Phase 21.5: Generated output re-parse succeeded");
}
`;

const fixture = async (environment: Record<string, string> = {}) => {
  const root = await createTestTempDirectory("rea-jsbeautify-recovery-");
  const command = join(root, "jsbeautify");
  await writeFile(command, ENGINE, { mode: 0o700 });
  const main = join(root, "main.cjs");
  const chunk = join(root, "chunk.js");
  await writeFile(main, "module.exports = !0;");
  await writeFile(chunk, "var a = 1;");
  const service = new JavaScriptRecoveryService(
    createJavaScriptRecoveryProvider({
      ...process.env,
      REA_JSBEAUTIFY_COMMAND: command,
      ...environment,
    }),
  );
  return { root, main, chunk, service, output: join(root, "output") };
};

const recovered = (evidence: { normalized_result: unknown }) =>
  javascriptRecoveryResultSchema.parse(evidence.normalized_result);

linux(
  "deobfuscates each selected file whole and binds it to its original",
  async () => {
    const { main, chunk, service, output } = await fixture();
    const evidence = await service.recover({
      path: main,
      additional_paths: [chunk],
      output_directory: output,
      engine: "jsbeautify",
    });
    if (!evidence.ok) throw evidence.error;
    const result = recovered(evidence.value);

    expect(evidence.value.provider).toMatchObject({
      id: "jsbeautify",
      version: "9.9.9+abc1234",
    });
    expect(result).toMatchObject({
      status: "complete",
      total: 2,
      failed: 0,
      detected_formats: ["esbuild"],
      analysis_input: { input_path: join(output, "modules") },
    });
    expect(
      result.modules.map((module) => ({
        name: module.reported_filename,
        original: module.provenance.original_path,
        ranges: module.provenance.byte_ranges,
      })),
    ).toEqual([
      { name: "main.cjs", original: main, ranges: [{ start: 0, end: 20 }] },
      { name: "chunk.js", original: chunk, ranges: [{ start: 0, end: 10 }] },
    ]);
    const [mainModule] = result.modules;
    if (mainModule === undefined) throw new Error("Expected a module");
    expect(await readFile(mainModule.artifact.path, "utf8")).toBe(
      "/* recovered */\nmodule.exports = !0;",
    );
    const phases = await readFile(result.report.path, "utf8");
    expect(phases).toContain("Phase 21.5");
    expect(phases).not.toContain("OPTIONAL_CHAINING");
    const provenance = JSON.parse(
      await readFile(result.provenance.path, "utf8"),
    ) as { runs: { module: string; arguments: string[] }[] };
    expect(provenance.runs[0]?.arguments).toEqual(
      expect.arrayContaining(["--deobfuscate", "--source-type", "commonjs"]),
    );
    expect(provenance.runs[1]?.arguments).not.toContain("--source-type");
  },
);

linux(
  "withholds a file whose generated output fails a re-parse check",
  async () => {
    const { main, chunk, service, output } = await fixture();
    await writeFile(chunk, "var FAIL = 1;");
    const evidence = await service.recover({
      path: main,
      additional_paths: [chunk],
      output_directory: output,
      engine: "jsbeautify",
    });
    if (!evidence.ok) throw evidence.error;
    const result = recovered(evidence.value);

    expect(result).toMatchObject({ status: "partial", total: 2, failed: 1 });
    expect(result.modules.map((module) => module.reported_filename)).toEqual([
      "main.cjs",
    ]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        filename: "chunk.js",
        kind: "validity-gate",
        is_error: true,
        message: expect.stringContaining("21.5=false"),
      }),
    ]);
  },
);

linux("formats without deobfuscating at rewrite_level minimal", async () => {
  const { main, service, output } = await fixture();
  const evidence = await service.recover({
    path: main,
    output_directory: output,
    engine: "jsbeautify",
    rewrite_level: "minimal",
  });
  if (!evidence.ok) throw evidence.error;
  const result = recovered(evidence.value);

  expect(result).toMatchObject({
    status: "complete",
    reported_strategy: "jsbeautify",
  });
  expect(result.modules[0]?.reported_status).toBe("formatted");
});

linux("refuses module extraction modes jsbeautify cannot honour", async () => {
  const { main, service, output } = await fixture();
  const evidence = await service.recover({
    path: main,
    output_directory: output,
    engine: "jsbeautify",
    extraction_mode: "heuristic",
  });

  expect(evidence.ok).toBe(false);
  if (evidence.ok) return;
  expect(evidence.error).toMatchObject({
    _tag: "AnalysisInputError",
    issues: [expect.objectContaining({ path: ["extraction_mode"] })],
  });
});

it("names the jsbeautify configuration when it is not configured", async () => {
  const { main, output } = await fixture();
  const service = new JavaScriptRecoveryService(
    createJavaScriptRecoveryProvider({}),
  );
  const evidence = await service.recover({
    path: main,
    output_directory: output,
    engine: "jsbeautify",
  });

  expect(evidence.ok).toBe(false);
  if (evidence.ok) return;
  expect(evidence.error).toMatchObject({
    _tag: "AnalysisCapabilityUnavailableError",
    reason: expect.stringContaining("REA_JSBEAUTIFY_COMMAND"),
  });
});
