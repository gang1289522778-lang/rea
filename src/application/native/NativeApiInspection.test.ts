import { describe, expect, it } from "vitest";

import { functionDossierSchema } from "../../domain/hopperValues.js";
import { ghidraFunctionDossier } from "../../domain/ghidraValues.fixture.js";
import { nativeApiBoundarySchema } from "../../domain/native/nativeApiBoundary.js";
import { projectNativeApiInspection } from "./NativeApiInspection.js";

describe("native API switch uncertainty", () => {
  it("reports an unevidenced default path independently of known numeric cases", () => {
    const dossier = functionDossierSchema.parse(ghidraFunctionDossier());
    const boundary = dossier.native_api;
    if (boundary?.available !== true)
      throw new TypeError("Ghidra native API fixture is unavailable");
    const table = boundary.jump_tables[0];
    if (table === undefined)
      throw new TypeError("Ghidra jump-table fixture is unavailable");
    const incomplete = functionDossierSchema.parse({
      ...dossier,
      native_api: {
        ...boundary,
        jump_tables: [{ ...table, default_targets: [] }],
      },
    });
    expect(projectNativeApiInspection(incomplete).residual_unknowns).toContain(
      "Which default or out-of-range path, if any, belongs to the dispatch at 0x401010?",
    );
  });

  it("does not report evidenced defaults as unknown cases and retains genuinely unresolved mappings", () => {
    const dossier = functionDossierSchema.parse(ghidraFunctionDossier());
    const boundary = dossier.native_api;
    if (boundary?.available !== true)
      throw new TypeError("Ghidra native API fixture is unavailable");
    const table = boundary.jump_tables[0];
    const mapping = table?.mappings[0];
    if (table === undefined || mapping === undefined)
      throw new TypeError("Ghidra jump-table fixture is unavailable");
    const defaultTarget = {
      target_address: mapping.target_address,
      confidence: "high",
      evidence: mapping.evidence,
    };
    const complete = functionDossierSchema.parse({
      ...dossier,
      native_api: {
        ...boundary,
        jump_tables: [{ ...table, default_targets: [defaultTarget] }],
      },
    });
    expect(projectNativeApiInspection(complete).residual_unknowns).toEqual([]);
    const unresolved = functionDossierSchema.parse({
      ...complete,
      native_api: {
        ...boundary,
        jump_tables: [
          {
            ...table,
            default_targets: [defaultTarget],
            mappings: [
              mapping,
              { ...mapping, case_value: null, target_address: "0x401030" },
            ],
          },
        ],
      },
    });
    expect(projectNativeApiInspection(unresolved).residual_unknowns).toContain(
      "Which source-level case values correspond to every target dispatched at 0x401010?",
    );
  });
});

describe("native API inspection", () => {
  it("keeps older Evidence readable without inventing a completed prototype check", () => {
    const dossier = functionDossierSchema.parse(ghidraFunctionDossier());
    if (dossier.native_api?.available !== true)
      throw new Error("Missing API fixture");
    const boundary = Object.fromEntries(
      Object.entries(dossier.native_api).filter(
        ([key]) =>
          !["prototype_diagnostics", "prototype_check_limitations"].includes(
            key,
          ),
      ),
    );
    const retained = functionDossierSchema.parse({
      ...dossier,
      native_api: boundary,
    });
    const inspection = projectNativeApiInspection(retained);
    expect(inspection.boundary).not.toHaveProperty("prototype_diagnostics");
    expect(inspection.residual_unknowns).toContain(
      "Instruction/prototype consistency was not recorded in this Evidence.",
    );
  });

  it("carries instruction conflicts and their unresolved assumptions into inspection", () => {
    const dossier = functionDossierSchema.parse(ghidraFunctionDossier());
    if (dossier.native_api?.available !== true)
      throw new Error("Missing API fixture");
    const unknown =
      "Are hidden stack parameters or a custom convention responsible?";
    const diagnostic = {
      kind: "stack-cleanup",
      classification: "conflict",
      inferred_claim: "Four stack parameters occupy 16 bytes.",
      evidence: [{ kind: "return", address: "0x401005", detail: "RET 20" }],
      residual_unknowns: [unknown],
    };
    const input = functionDossierSchema.parse({
      ...dossier,
      native_api: {
        ...dossier.native_api,
        prototype_diagnostics: [diagnostic],
      },
    });
    expect(projectNativeApiInspection(input)).toMatchObject({
      boundary: {
        prototype_diagnostics: [diagnostic],
        signature_source: "analysis",
      },
      residual_unknowns: [unknown],
    });
  });

  it("preserves unsupported provider branches as residual unknowns", () => {
    const value = ghidraFunctionDossier();
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new TypeError("Ghidra dossier fixture is invalid");
    const dossier = functionDossierSchema.parse({ ...value, native_api: null });

    expect(projectNativeApiInspection(dossier)).toMatchObject({
      boundary: { available: false },
      unsupported_branches: [
        "structured-boundary-types",
        "jump-table-data-mapping",
      ],
      residual_unknowns: [
        expect.stringContaining("boundary types"),
        expect.stringContaining("jump table"),
      ],
    });
  });

  it("reports missing jump-table targets as an explicit unknown", () => {
    const value = ghidraFunctionDossier();
    const dossier = functionDossierSchema.parse(value);
    const boundary = dossier.native_api;
    if (boundary?.available !== true)
      throw new TypeError("Ghidra native API fixture is unavailable");
    const table = boundary.jump_tables[0];
    if (table === undefined)
      throw new TypeError("Ghidra jump-table fixture is unavailable");

    const incomplete = functionDossierSchema.parse({
      ...dossier,
      native_api: {
        ...boundary,
        jump_tables: [{ ...table, mappings: [] }],
      },
    });
    expect(projectNativeApiInspection(incomplete).residual_unknowns).toContain(
      "Which case values and targets belong to the dispatch at 0x401010?",
    );
  });

  it("rejects boundary types placed in the wrong ABI role", () => {
    const boundary = functionDossierSchema.parse(
      ghidraFunctionDossier(),
    ).native_api;
    if (boundary === null || boundary.available !== true)
      throw new TypeError("Ghidra native API fixture is unavailable");

    expect(
      nativeApiBoundarySchema.safeParse({
        ...boundary,
        return_type: { ...boundary.return_type, role: "parameter" },
      }).success,
    ).toBe(false);
    expect(
      nativeApiBoundarySchema.safeParse({
        ...boundary,
        parameters: [
          {
            ...boundary.return_type,
            role: "return",
          },
        ],
      }).success,
    ).toBe(false);
  });
});
