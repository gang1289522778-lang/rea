import assert from "node:assert/strict";
import { pageViewCoverage } from "../dist/domain/analysisView/analysisViewCoverage.js";
import { parseGhidraFunctionResult } from "../dist/ghidra/GhidraFunctionValues.js";
import { projectNativeApiInspection } from "../dist/application/native/NativeApiInspection.js";
import { projectAnalysisView } from "../dist/domain/analysisView/analysisView.js";

/** Source-owned instruction controls, independent of inferred source signatures. */
export function assertPrototypeDiagnosticsReport(report) {
  const checked = [];
  const dossier = (name) => {
    const entry = report[name];
    assert.ok(entry, `Missing producer case ${name}`);
    assert.equal(
      entry.owned_body_after,
      entry.owned_body_before,
      `${name}: ownership changed`,
    );
    const parsed = parseGhidraFunctionResult(
      "analyze_function",
      entry.wire_observation,
    );
    assert.equal(
      parsed.ok,
      true,
      `${name}: producer output violates canonical adapter contract`,
    );
    const value = parsed.value.value;
    assert.deepEqual(value, entry.dossier, `${name}: wire/dossier mismatch`);
    const api = value.native_api;
    assert.equal(api.available, true, name);
    assert.ok(
      api.prototype_check_limitations.length > 0,
      `${name}: missing check scope`,
    );
    const inspection = projectNativeApiInspection(value);
    for (const diagnostic of api.prototype_diagnostics) {
      assert.match(diagnostic.inferred_claim, /^The recovered /u);
      if (api.signature_source === "user_defined") {
        assert.doesNotMatch(
          [
            diagnostic.inferred_claim,
            ...diagnostic.evidence.map((item) => item.detail),
          ].join(" "),
          /inferred/u,
          `${name}: user-defined signature was mislabeled as inferred`,
        );
      }
      for (const unknown of diagnostic.residual_unknowns)
        assert.ok(
          inspection.residual_unknowns.includes(unknown),
          `${name}: lost inspection unknown`,
        );
      for (const facet of ["native_api", "assembly", "procedure"]) {
        const view = projectAnalysisView(
          {
            evidenceId: "ev_" + "b".repeat(64),
            operation: "analyze_function",
            normalizedResult: value,
            limitations: [],
            artifact: {
              path: "/source-owned/prototype-fixture",
              sha256: "a".repeat(64),
            },
          },
          { kind: "native", facet, offset: 0, limit: 64 },
        );
        assert.equal(view.ok, true, `${name}: ${facet} projection failed`);
        for (const unknown of diagnostic.residual_unknowns)
          assert.ok(
            view.value.unknowns.includes(unknown),
            `${name}: ${facet} lost unknown`,
          );
        if (facet === "native_api") assert.deepEqual(view.value.item, api);
        if (facet === "assembly") {
          assert.deepEqual(view.value.item, value.assembly.slice(0, 64));
          assert.deepEqual(
            view.value.coverage,
            pageViewCoverage(
              0,
              Math.min(64, value.assembly.length),
              value.assembly.length,
            ),
          );
        }
      }
    }
    checked.push(name);
    return api;
  };
  const has = (api, kind) =>
    api.prototype_diagnostics.find((item) => item.kind === kind);
  const noConflict = (name) => {
    const api = dossier(name);
    assert.deepEqual(
      api.prototype_diagnostics.filter(
        (item) => item.classification === "conflict",
      ),
      [],
      `${name}: false prototype conflict`,
    );
    return api;
  };
  const x87 = dossier("rea_stack_x87");
  assert.equal(x87.signature_source, "analysis");
  assert.equal(x87.return_type.confidence, "medium");
  assert.deepEqual(x87.parameters, []);
  assert.equal(has(x87, "stack-parameter-read").classification, "conflict");
  assert.match(
    has(x87, "stack-parameter-read").evidence[0].detail,
    /8 bytes at entry ESP \+ 4/u,
  );
  assert.ok(
    has(x87, "x87-expression").evidence.some(
      (item) => item.kind === "call-site",
    ),
  );
  assert.match(
    has(x87, "x87-expression").residual_unknowns.join(" "),
    /complete expression/u,
  );
  const cleanup = dossier("rea_cleanup_conflict");
  assert.equal(cleanup.parameters.length, 4);
  assert.equal(cleanup.calling_convention, "__stdcall");
  assert.equal(has(cleanup, "stack-cleanup").classification, "observation");
  assert.match(
    has(cleanup, "stack-cleanup").evidence[0].detail,
    /20 bytes.*16 recovered/u,
  );
  for (const name of [
    "rea_cleanup_control",
    "rea_local_control",
    "rea_stack_control",
    "rea_written_slot_control",
    "rea_unknown_store_control",
    "rea_conditional_pointer_control",
    "rea_dynamic_stack_control",
    "rea_userop_control",
  ])
    noConflict(name);
  const padded = noConflict("rea_padding_control");
  assert.equal(padded.parameters.length, 1);
  assert.equal(
    padded.parameters[0].size_bytes,
    1,
    "Padding control must retain a one-byte inferred type",
  );
  for (const [name, pattern] of [
    ["rea_written_slot_control", /data written by this entry prefix/u],
    ["rea_unknown_store_control", /unresolved aliasing/u],
    ["rea_conditional_pointer_control", /Raw p-code control flow/u],
    ["rea_userop_control", /unsupported user-op/u],
  ])
    assert.match(
      report[name].dossier.native_api.prototype_check_limitations.join(" "),
      pattern,
      `${name}: uncertainty was lost`,
    );
  const forward = dossier("rea_forward_return");
  assert.equal(
    has(forward, "return-register-forwarding").classification,
    "observation",
  );
  assert.ok(
    has(forward, "return-register-forwarding").evidence.some(
      (item) =>
        item.kind === "instruction" && item.detail.includes("immediate caller"),
    ),
  );
  assert.equal(
    has(dossier("rea_overwrite_return"), "return-register-forwarding"),
    undefined,
  );
  for (const name of [
    "rea_forward_clear_xor",
    "rea_forward_clear_sub",
    "rea_forward_clear_and",
    "rea_forward_clear_test",
  ]) {
    const diagnostic = has(dossier(name), "return-register-forwarding");
    assert.equal(diagnostic.classification, "observation");
    assert.equal(
      diagnostic.evidence.some((item) =>
        item.detail.includes("immediate caller"),
      ),
      false,
      `${name}: clearing EAX must not corroborate use of the returned value`,
    );
  }
  const cdecl = dossier("rea_cdecl_cleanup_conflict");
  assert.equal(cdecl.calling_convention, "__cdecl");
  assert.equal(has(cdecl, "stack-cleanup").classification, "conflict");
  assert.match(
    has(cdecl, "stack-cleanup").evidence[0].detail,
    /4 bytes.*4 recovered/u,
  );
  for (const name of [
    "rea_named_undefined_return",
    "rea_undefined_pointer_return",
  ])
    assert.equal(
      has(dossier(name), "return-register-forwarding"),
      undefined,
      `${name}: display spelling must not classify a known return type as undefined`,
    );
  const many = dossier("rea_many_forwarding");
  const forwarding = many.prototype_diagnostics.filter(
    (item) => item.kind === "return-register-forwarding",
  );
  assert.equal(
    forwarding.length,
    1,
    "Forwarding paths must share one function-level diagnostic",
  );
  assert.ok(forwarding[0].evidence.length <= 256);
  assert.equal(
    new Set(forwarding[0].evidence.map(({ address }) => address)).size,
    forwarding[0].evidence.length,
  );
  assert.match(
    many.prototype_check_limitations.join(" "),
    /256-fact evidence budget/u,
  );
  const shared = dossier("rea_shared_cleanup");
  assert.ok(
    has(shared, "stack-cleanup").evidence.some(
      (item) => item.kind === "branch",
    ),
  );
  noConflict("rea_tail_call_control");
  assert.match(
    has(noConflict("rea_stdcall_missing_cleanup"), "stack-cleanup").evidence[0]
      .detail,
    /0 bytes.*4 recovered/u,
  );
  for (const [name, convention] of [
    ["rea_fastcall_missing_cleanup", "__fastcall"],
    ["rea_thiscall_missing_cleanup", "__thiscall"],
  ]) {
    const api = noConflict(name);
    assert.equal(api.calling_convention, convention);
    assert.equal(has(api, "stack-cleanup").classification, "observation");
    assert.match(
      has(api, "stack-cleanup").evidence[0].detail,
      /0 bytes.*4 recovered/u,
    );
  }
  const custom = noConflict("rea_custom_allocation_control");
  assert.match(
    custom.prototype_check_limitations.join(" "),
    /allocation could not be established/u,
  );
  assert.equal(
    has(custom, "stack-parameter-read").classification,
    "observation",
  );
  const prefix = dossier("rea_long_entry_prefix");
  assert.match(
    prefix.prototype_check_limitations.join(" "),
    /Entry-prefix checks reached/u,
  );
  assert.ok(
    prefix.prototype_diagnostics.reduce(
      (count, item) => count + item.evidence.length,
      0,
    ) <= 256,
  );
  const variadicCleanup = dossier("rea_variadic_cleanup_conflict");
  assert.equal(
    has(variadicCleanup, "stack-cleanup").classification,
    "conflict",
  );
  assert.match(
    has(variadicCleanup, "stack-cleanup").evidence[0].detail,
    /requires 0 argument-cleanup/u,
  );
  const variadic = noConflict("rea_variadic_control");
  assert.equal(
    has(variadic, "stack-parameter-read").classification,
    "observation",
  );
  return { checks: checked, check_count: checked.length, scope: report.scope };
}
