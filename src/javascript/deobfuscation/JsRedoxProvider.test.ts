import { access, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";

import {
  assertDeobfuscationCleanup,
  deobfuscationFixture,
} from "../../../tests/fixtures/javascript-deobfuscation/provider.js";
import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import { PrivateRuntimeRoot } from "../../process/PrivateRuntimeRoot.js";
import { JS_REDOX_LIMITS } from "./JsRedoxRelease.js";
import { javascriptDeobfuscationResultSchema } from "../../domain/javascript/javascriptDeobfuscation.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";

it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "publishes source, proof report and safe rewritten JavaScript through the owned-process boundary",
  async () => {
    const fixture = await deobfuscationFixture();
    onTestFinished(async () => fixture.provider.close?.());
    const response = await fixture.service.deobfuscate({
      path: fixture.path,
      output_directory: fixture.output,
      max_iterations: 16,
    });
    if (!response.ok) throw response.error;
    expect(response.value).toMatchObject({
      operation: "deobfuscate_javascript_source",
      provider: { id: "js-redox", version: "0.1.0" },
      normalized_result: {
        status: "changed",
        runtime_execution: "not-performed",
        proof: {
          schema: "js-safe-deobfuscate/v1",
          transforms: { static_array_lookup: 2, constant_fold: 1 },
          runtime_semantics_preserved_by_design: true,
        },
      },
    });
    await expect(
      readFile(`${fixture.output}/deobfuscated/source.js`, "utf8"),
    ).resolves.toContain('console.log("hello world")');
    await expect(
      access(`${fixture.output}/manifest.json`),
    ).resolves.toBeUndefined();
    expect(fixture.engineSnapshots).toHaveLength(2);
    expect(new Set(fixture.engineSnapshots.map(({ path }) => path)).size).toBe(
      2,
    );
    expect(fixture.engineSnapshots[0]?.path).not.toBe(fixture.command);
    expect(fixture.engineSnapshots[0]?.bytes.toString("utf8")).toBe(
      "#!/bin/sh\nexit 0\n",
    );
    await assertDeobfuscationCleanup(fixture.launches);
  },
);

it
  .skipIf(process.platform !== "linux" || process.arch !== "x64")
  .each([
    "bad-digest",
    "bad-input-digest",
    "bad-analysis-digest",
    "bad-iterations",
    "bad-changed",
    "unsafe-static",
    "formatted",
    "unsafe-semantics",
  ])(
  "rejects a proof report with %s without retaining a publication",
  async (mode) => {
    const fixture = await deobfuscationFixture(mode);
    onTestFinished(async () => fixture.provider.close?.());
    const response = await fixture.service.deobfuscate({
      path: fixture.path,
      output_directory: fixture.output,
    });
    if (response.ok) throw new Error("expected proof mismatch");
    expect(response.error._tag).toBe("AnalysisOutputError");
    await expect(access(fixture.output)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await assertDeobfuscationCleanup(fixture.launches);
  },
);

it
  .skipIf(process.platform !== "linux" || process.arch !== "x64")
  .each([false, true])(
  "preserves configured engine symlinks and rejects retargeting=%s",
  async (retarget) => {
    const root = await createTestTempDirectory("rea-redox-selection-");
    const canonical = join(root, "engine");
    const replacement = join(root, "replacement");
    const selected = join(root, "current");
    await writeFile(canonical, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await writeFile(replacement, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await symlink(canonical, selected);
    const fixture = await deobfuscationFixture(
      retarget ? "engine-retarget" : "normal",
      undefined,
      {
        REA_JS_REDOX_COMMAND: selected,
        REA_DEOBFUSCATION_ENGINE_LINK: selected,
        REA_DEOBFUSCATION_ENGINE_REPLACEMENT: replacement,
      },
    );
    onTestFinished(async () => fixture.provider.close?.());
    const response = await fixture.service.deobfuscate({
      path: fixture.path,
      output_directory: fixture.output,
    });
    if (retarget) {
      if (response.ok) throw new Error("expected engine selection mismatch");
      expect(response.error._tag).toBe("AnalysisOutputError");
      await expect(access(fixture.output)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } else {
      if (!response.ok) throw response.error;
      const result = javascriptDeobfuscationResultSchema.parse(
        response.value.normalized_result,
      );
      expect(result.engine.executable).toMatchObject({
        path: selected,
        resolved_path: canonical,
      });
      expect(
        JSON.parse(await readFile(result.manifest.path, "utf8")).engine,
      ).toMatchObject({ path: selected, resolved_path: canonical });
    }
    await assertDeobfuscationCleanup(fixture.launches);
  },
);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "publishes large diagnostics without expanding the inline result",
  async () => {
    const fixture = await deobfuscationFixture("large-diagnostics");
    onTestFinished(async () => fixture.provider.close?.());
    const response = await fixture.service.deobfuscate({
      path: fixture.path,
      output_directory: fixture.output,
    });
    if (!response.ok) throw response.error;
    expect(Buffer.byteLength(JSON.stringify(response.value))).toBeLessThan(
      20_000,
    );
    const result = javascriptDeobfuscationResultSchema.parse(
      response.value.normalized_result,
    );
    expect(result.diagnostics?.execution.stdout.bytes).toBe(6 * 1024 * 1024);
    expect(
      await readFile(result.diagnostics!.execution.stdout.path, "utf8"),
    ).toBe("x".repeat(6 * 1024 * 1024));
    await assertDeobfuscationCleanup(fixture.launches);
  },
);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "releases a published tree before returning success when commit cleanup reports failure",
  async () => {
    const fixture = await deobfuscationFixture();
    onTestFinished(async () => fixture.provider.close?.());
    const originalCommit = SafeOutputTree.prototype.commit;
    const rollback = vi.spyOn(SafeOutputTree.prototype, "rollback");
    vi.spyOn(SafeOutputTree.prototype, "commit").mockImplementationOnce(
      async function (this: SafeOutputTree) {
        await originalCommit.call(this);
        throw new Error("fixture directory-handle close failure");
      },
    );
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const response = await fixture.service.deobfuscate({
      path: fixture.path,
      output_directory: fixture.output,
    });
    if (!response.ok) throw response.error;
    expect(rollback).toHaveBeenCalledTimes(1);
    await assertDeobfuscationCleanup(fixture.launches);
  },
);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "preserves cancellation during publication I/O",
  async () => {
    const fixture = await deobfuscationFixture();
    onTestFinished(async () => fixture.provider.close?.());
    const controller = new AbortController();
    const originalWrite = SafeOutputTree.prototype.write;
    vi.spyOn(SafeOutputTree.prototype, "write").mockImplementationOnce(
      async function (this: SafeOutputTree, ...args) {
        controller.abort();
        return originalWrite.apply(this, args);
      },
    );
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const response = await fixture.service.deobfuscate(
      {
        path: fixture.path,
        output_directory: fixture.output,
      },
      { signal: controller.signal },
    );
    if (response.ok) throw new Error("expected cancellation");
    expect(response.error._tag).toBe("AnalysisCancelledError");
    await expect(access(fixture.output)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await assertDeobfuscationCleanup(fixture.launches);
  },
);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "shares one wall deadline across the version and transformation launches",
  async () => {
    const fixture = await deobfuscationFixture("slow-both");
    onTestFinished(async () => fixture.provider.close?.());
    const limits = JS_REDOX_LIMITS as { timeoutMs: number };
    const originalTimeout = limits.timeoutMs;
    limits.timeoutMs = 1_000;
    onTestFinished(() => {
      limits.timeoutMs = originalTimeout;
    });
    const response = await fixture.service.deobfuscate({
      path: fixture.path,
      output_directory: fixture.output,
    });
    if (response.ok) throw new Error("expected shared deadline timeout");
    expect(response.error._tag).toBe("AnalysisTimeoutError");
    expect(fixture.launches).toHaveLength(2);
    await expect(access(fixture.output)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await assertDeobfuscationCleanup(fixture.launches);
  },
);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "rejects transformed JavaScript that is not valid UTF-8",
  async () => {
    const fixture = await deobfuscationFixture("invalid-output-utf8");
    onTestFinished(async () => fixture.provider.close?.());
    const response = await fixture.service.deobfuscate({
      path: fixture.path,
      output_directory: fixture.output,
    });
    if (response.ok) throw new Error("expected malformed output rejection");
    expect(response.error._tag).toBe("AnalysisOutputError");
    await expect(access(fixture.output)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await assertDeobfuscationCleanup(fixture.launches);
  },
);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "rejects a relative resource-limiter override before launch",
  async () => {
    const fixture = await deobfuscationFixture("normal", undefined, {
      REA_JAVASCRIPT_PRLIMIT_COMMAND: "prlimit",
    });
    onTestFinished(async () => fixture.provider.close?.());
    const response = await fixture.service.deobfuscate({
      path: fixture.path,
      output_directory: fixture.output,
    });
    if (response.ok) throw new Error("expected relative limiter rejection");
    expect(response.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(fixture.launches).toHaveLength(0);
    await expect(access(fixture.output)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "observes cancellation immediately before output publication",
  async () => {
    const fixture = await deobfuscationFixture();
    onTestFinished(async () => fixture.provider.close?.());
    const controller = new AbortController();
    const originalClose = PrivateRuntimeRoot.prototype.close;
    vi.spyOn(PrivateRuntimeRoot.prototype, "close").mockImplementationOnce(
      async function (this: PrivateRuntimeRoot) {
        await originalClose.call(this);
        controller.abort();
      },
    );
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const response = await fixture.service.deobfuscate(
      {
        path: fixture.path,
        output_directory: fixture.output,
      },
      { signal: controller.signal },
    );
    if (response.ok) throw new Error("expected pre-commit cancellation");
    expect(response.error._tag).toBe("AnalysisCancelledError");
    await expect(access(fixture.output)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await assertDeobfuscationCleanup(fixture.launches);
  },
);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "retains bounded process diagnostics for a nonzero engine exit",
  async () => {
    const fixture = await deobfuscationFixture("nonzero");
    onTestFinished(async () => fixture.provider.close?.());
    const response = await fixture.service.deobfuscate({
      path: fixture.path,
      output_directory: fixture.output,
    });
    if (response.ok) throw new Error("expected engine failure");
    expect(response.error).toMatchObject({
      _tag: "ProviderAdapterError",
      diagnostics: {
        exit_code: 23,
        exit_signal: null,
        diagnostic_truncated: false,
        stdout: {
          text: "fixture stdout diagnostic\n",
          bytes: 26,
          retained_bytes: 26,
        },
        stderr: {
          text: "fixture stderr diagnostic\n",
          bytes: 26,
          retained_bytes: 26,
        },
      },
    });
    await expect(access(fixture.output)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await assertDeobfuscationCleanup(fixture.launches);
  },
);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "executes a harmless fingerprinted engine snapshot through the real util-linux limiter",
  async (context) => {
    try {
      await access("/usr/bin/prlimit");
    } catch {
      context.skip();
      return;
    }
    const root = await createTestTempDirectory("rea-redox-real-limiter-");
    const command = join(root, "harmless-engine");
    const source = join(root, "selected.js");
    await writeFile(source, "const value = 1;\n");
    await writeFile(
      command,
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "jsvm-lift 0.1.0"; exit 0; fi',
        'cp -- "$1" "$2"',
        'digest=$(sha256sum "$1" | cut -d " " -f1)',
        'printf \'{"schema":"js-safe-deobfuscate/v1","input":"%s","input_sha256":"%s","output_sha256":"%s","analysis_source_sha256":"%s","changed":false,"iterations":0,"transforms":{},"arithmetic_state_proofs":[],"static_alias_installer_calls":[],"safe_static_only":true,"presentation_formatted":false,"runtime_semantics_preserved_by_design":true}\\n\' "$1" "$digest" "$digest" "$digest" > "$4"',
      ].join("\n") + "\n",
      { mode: 0o700 },
    );
    const { JsRedoxProvider } = await import("./JsRedoxProvider.js");
    const provider = new JsRedoxProvider({
      ...process.env,
      REA_JS_REDOX_COMMAND: command,
    });
    onTestFinished(() => provider.close());
    const response = await provider.deobfuscate({
      path: source,
      output_directory: join(root, "output"),
      max_iterations: 1,
    });
    if (!response.ok) throw response.error;
    expect(
      javascriptDeobfuscationResultSchema.parse(response.value.result),
    ).toMatchObject({ status: "unchanged", proof: { iterations: 0 } });
  },
);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "rebuilds the transform executable from retained bytes after a mutating version probe",
  async () => {
    const fixture = await deobfuscationFixture("replace-version-snapshot");
    onTestFinished(async () => fixture.provider.close?.());
    const response = await fixture.service.deobfuscate({
      path: fixture.path,
      output_directory: fixture.output,
    });
    if (!response.ok) throw response.error;
    expect(new Set(fixture.engineSnapshots.map(({ path }) => path)).size).toBe(
      2,
    );
    expect(
      fixture.engineSnapshots.map(({ bytes }) => bytes.toString("utf8")),
    ).toEqual(["#!/bin/sh\nexit 0\n", "#!/bin/sh\nexit 0\n"]);
    await assertDeobfuscationCleanup(fixture.launches);
  },
);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "cancels at commit entry without publishing output",
  async () => {
    const fixture = await deobfuscationFixture();
    onTestFinished(async () => fixture.provider.close?.());
    const controller = new AbortController();
    const originalCommit = SafeOutputTree.prototype.commit;
    vi.spyOn(SafeOutputTree.prototype, "commit").mockImplementationOnce(
      async function (this: SafeOutputTree, signal?: AbortSignal) {
        controller.abort();
        await originalCommit.call(this, signal);
      },
    );
    onTestFinished(() => vi.restoreAllMocks());
    const response = await fixture.service.deobfuscate(
      { path: fixture.path, output_directory: fixture.output },
      { signal: controller.signal },
    );
    if (response.ok) throw new Error("expected commit cancellation");
    expect(response.error._tag).toBe("AnalysisCancelledError");
    await expect(access(fixture.output)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await assertDeobfuscationCleanup(fixture.launches);
  },
);
