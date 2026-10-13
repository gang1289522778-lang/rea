import { describe, expect, it } from "vitest";

import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import type { JavaScriptDeobfuscationResult } from "../../domain/javascript/javascriptDeobfuscation.js";
import { err, ok } from "../../domain/result.js";
import { createAnalysisExecution } from "../AnalysisProvider.js";
import { JavaScriptDeobfuscationService } from "./JavaScriptDeobfuscationService.js";

const file = { path: "/tmp/source.js", sha256: "a".repeat(64), bytes: 12 };
const provider = {
  id: "js-redox",
  name: "js-redox",
  version: "0.1.0",
} as const;
const result = (): JavaScriptDeobfuscationResult => ({
  source: { ...file, published_copy: file },
  engine: {
    ...provider,
    executable: file,
    audited_source_revision: "revision",
    executed_source_revision: null,
  },
  options: { max_iterations: 16 },
  status: "unchanged",
  output: file,
  report: file,
  manifest: file,
  proof: {
    schema: "js-safe-deobfuscate/v1",
    iterations: 1,
    transforms: {},
    arithmetic_state_proofs: 0,
    static_alias_installer_calls: {
      total: 0,
      forwarding_installer_proven: 0,
      semantics_proven: 0,
    },
    analysis_source_sha256: file.sha256,
    safe_static_only: true,
    presentation_formatted: false,
    runtime_semantics_preserved_by_design: true,
  },
  analysis_input: {
    input_path: "/tmp/output/deobfuscated",
    format: "directory",
  },
  runtime_execution: "not-performed",
  limitations: [],
});

describe("JavaScript deobfuscation workflow", () => {
  it.each([
    [64, 64],
    [1, 2],
  ])(
    "rejects provider options=%s and proof iterations=%s for a requested bound of one",
    async (maximum, iterations) => {
      const returned = result();
      returned.options.max_iterations = maximum;
      returned.proof.iterations = iterations;
      const service = new JavaScriptDeobfuscationService({
        deobfuscate: async () =>
          ok(
            createAnalysisExecution(returned, provider, {
              subject: {
                path: file.path,
                sha256: file.sha256,
                format: "javascript",
              },
            }),
          ),
      });
      const response = await service.deobfuscate({
        path: file.path,
        output_directory: "/tmp/out",
        max_iterations: 1,
      });
      if (response.ok) throw new Error("expected iteration binding rejection");
      expect(response.error._tag).toBe("AnalysisOutputError");
    },
  );
  it("preserves provider failures", async () => {
    const failure = new AnalysisCapabilityUnavailableError(
      "js-redox",
      "deobfuscate_javascript_source",
      "fixture unavailable",
    );
    const service = new JavaScriptDeobfuscationService({
      deobfuscate: async () => err(failure),
    });
    expect(
      await service.deobfuscate({
        path: file.path,
        output_directory: "/tmp/out",
      }),
    ).toEqual(err(failure));
  });

  it.each([
    "invalid-result",
    "missing-subject",
    "subject-mismatch",
    "engine-mismatch",
    "proof-output-mismatch",
  ])("rejects %s returned across the provider boundary", async (mode) => {
    const service = new JavaScriptDeobfuscationService({
      deobfuscate: async () =>
        ok(
          createAnalysisExecution(
            mode === "invalid-result"
              ? {}
              : mode === "proof-output-mismatch"
                ? {
                    ...result(),
                    proof: {
                      ...result().proof,
                      analysis_source_sha256: "b".repeat(64),
                    },
                  }
                : result(),
            mode === "engine-mismatch"
              ? { ...provider, id: "other" }
              : provider,
            mode === "missing-subject"
              ? {}
              : {
                  subject: {
                    path: mode === "subject-mismatch" ? "/wrong.js" : file.path,
                    sha256: file.sha256,
                    format: "javascript" as const,
                  },
                },
          ),
        ),
    });
    const response = await service.deobfuscate({
      path: file.path,
      output_directory: "/tmp/out",
    });
    if (response.ok) throw new Error("expected invalid provider output");
    expect(response.error._tag).toBe("AnalysisOutputError");
  });

  it.each(["path", "output_directory"])(
    "rejects relative %s before invoking the provider",
    async (field) => {
      let invoked = false;
      const service = new JavaScriptDeobfuscationService({
        deobfuscate: async () => {
          invoked = true;
          return ok(createAnalysisExecution(result(), provider));
        },
      });
      const response = await service.deobfuscate({
        path: file.path,
        output_directory: "/tmp/out",
        [field]: "relative.js",
      });
      expect(invoked).toBe(false);
      if (response.ok) throw new Error("expected invalid path");
      expect(response.error._tag).toBe("AnalysisInputError");
    },
  );
});
