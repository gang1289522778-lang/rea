import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import { javascriptDeobfuscationResultSchema } from "../../domain/javascript/javascriptDeobfuscation.js";
import type { ProviderProcessSnapshot } from "../../process/ProviderProcess.js";
import { publishJsRedox } from "./JsRedoxPublication.js";

it("retains six MiB of worker diagnostics as files while keeping Evidence projections small", async () => {
  const root = await createTestTempDirectory("rea-redox-diagnostics-");
  const tree = await SafeOutputTree.create(join(root, "output"));
  const bytes = Buffer.from("const value = 1;\n");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const text = "x".repeat(6 * 1024 * 1024);
  const snapshot: ProviderProcessSnapshot = {
    exitCode: 0,
    signal: null,
    stdout: { text, bytes: text.length, observedBytes: text.length },
    stderr: { text: "", bytes: 0, observedBytes: 0 },
  };
  try {
    const execution = await publishJsRedox({
      sourcePath: join(root, "selected.js"),
      maxIterations: 1,
      tree,
      source: { bytes, sha256 },
      output: { bytes, sha256 },
      reportFile: {
        bytes: Buffer.from("{}"),
        sha256: createHash("sha256").update("{}").digest("hex"),
      },
      report: {
        schema: "js-safe-deobfuscate/v1",
        input: join(root, "source.js"),
        input_sha256: sha256,
        output_sha256: sha256,
        analysis_source_sha256: sha256,
        changed: false,
        iterations: 1,
        transforms: {},
        arithmetic_state_proofs: [],
        static_alias_installer_calls: [],
        safe_static_only: true,
        presentation_formatted: false,
        runtime_semantics_preserved_by_design: true,
      },
      engine: {
        command: "/canonical/engine",
        configuredCommand: "/selected/engine",
        sha256,
        bytes: bytes.length,
      },
      version: "0.1.0",
      versionRun: snapshot,
      executionRun: snapshot,
    });
    await tree.commit();
    const result = javascriptDeobfuscationResultSchema.parse(execution.result);
    expect(Buffer.byteLength(JSON.stringify(execution))).toBeLessThan(20_000);
    expect(result.engine.executable).toMatchObject({
      path: "/selected/engine",
      resolved_path: "/canonical/engine",
    });
    expect(result.diagnostics?.execution.stdout).toMatchObject({
      bytes: text.length,
      observed_bytes: text.length,
    });
    await expect(
      readFile(result.diagnostics!.execution.stdout.path, "utf8"),
    ).resolves.toBe(text);
    const manifest = JSON.parse(await readFile(result.manifest.path, "utf8"));
    expect(manifest.diagnostics.execution.stdout.sha256).toBe(
      createHash("sha256").update(text).digest("hex"),
    );
    expect(manifest.engine).toMatchObject({
      path: "/selected/engine",
      resolved_path: "/canonical/engine",
    });
  } finally {
    await tree.rollback();
  }
});
