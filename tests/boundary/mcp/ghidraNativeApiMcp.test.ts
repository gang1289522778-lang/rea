import { describe, expect, it } from "vitest";
import { connectGhidraMcp, sessionEvidence } from "./ghidraMcpHarness.js";
import { ghidraFunctionDossier } from "../../../src/domain/ghidraValues.fixture.js";
import { functionDossierSchema } from "../../../src/domain/hopperValues.js";
import { jsonValueSchema } from "../../../src/domain/jsonValue.js";
import { ok } from "../../../src/domain/result.js";

describe("Ghidra MCP native API evidence", () => {
  it("retains conflicts and incomplete checks in workflow Evidence and selected dossier views", async () => {
    const dossier = functionDossierSchema.parse(ghidraFunctionDossier());
    if (dossier.native_api?.available !== true)
      throw new Error("Missing API fixture");
    const unknown = "Hidden parameters or a custom ABI remain unresolved.";
    const limit = "Only the straight-line entry prefix was checked.";
    const diagnostic = {
      kind: "stack-cleanup",
      classification: "conflict",
      inferred_claim: "Four parameters occupy 16 bytes.",
      evidence: [{ kind: "return", address: "0x401004", detail: "RET 20" }],
      residual_unknowns: [unknown],
    };
    const output = jsonValueSchema.parse({
      ...dossier,
      native_api: {
        ...dossier.native_api,
        prototype_diagnostics: [diagnostic],
        prototype_check_limitations: [limit],
      },
    });
    const harness = await connectGhidraMcp(
      "ghidra-prototype-conflict",
      async () => ok({ value: output, limitations: [] }),
    );
    try {
      const inspection = sessionEvidence(
        harness.session,
        (
          await harness.mcp.callTool({
            name: "inspect_native_api",
            arguments: { procedure: "0x401000" },
          })
        ).structuredContent,
      );
      expect(inspection.normalized_result).toMatchObject({
        boundary: {
          prototype_diagnostics: [diagnostic],
          signature_source: "analysis",
        },
        residual_unknowns: expect.arrayContaining([unknown, limit]),
      });
      const analyzed = sessionEvidence(
        harness.session,
        (
          await harness.mcp.callTool({
            name: "analyze_function",
            arguments: { procedure: "0x401000" },
          })
        ).structuredContent,
      );
      for (const facet of ["native_api", "assembly"] as const) {
        const selected = (
          await harness.mcp.callTool({
            name: "inspect_analysis_view",
            arguments: {
              source: {
                kind: "retained-evidence",
                evidence_id: analyzed.evidence_id,
              },
              view: { kind: "native", facet, offset: 0, limit: 64 },
            },
          })
        ).structuredContent;
        expect(selected).toMatchObject({
          normalized_result: {
            unknowns: expect.arrayContaining([unknown]),
            limitations: expect.arrayContaining([limit]),
          },
        });
      }
    } finally {
      await harness.close();
    }
  }, 30_000);

  it("returns complete native API boundaries without output-cap unknowns", async () => {
    const harness = await connectGhidraMcp("ghidra-native-api");
    const { mcp, session } = harness;
    try {
      const inspection = sessionEvidence(
        session,
        (
          await mcp.callTool({
            name: "inspect_native_api",
            arguments: { procedure: "fixture_main" },
          })
        ).structuredContent,
      );
      expect(inspection.normalized_result).toMatchObject({
        procedure: { address: "0x401000", name: "fixture_main" },
        boundary: {
          available: true,
          return_type: { data_type: "int", confidence: "medium" },
          jump_tables: [
            {
              dispatch_address: "0x401010",
              data_sources: [{ address: "0x403000" }],
              mappings: [{ case_value: 0, target_address: "0x401020" }],
              default_targets: [
                { target_address: "0x401030", confidence: "high" },
              ],
            },
          ],
        },
        unsupported_branches: [],
        residual_unknowns: [],
      });
      expect(
        (
          await mcp.callTool({
            name: "list_unknowns",
            arguments: {},
          })
        ).structuredContent,
      ).toMatchObject({ result: { items: [] } });
    } finally {
      await harness.close();
    }
  }, 30_000);
});
