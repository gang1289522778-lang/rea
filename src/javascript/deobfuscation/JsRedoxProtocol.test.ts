import { expect, it } from "vitest";

import {
  parseJsRedoxReport,
  validateJsRedoxReport,
} from "./JsRedoxProtocol.js";

it("rejects proof reports containing malformed UTF-8", () => {
  const report = {
    schema: "js-safe-deobfuscate/v1",
    input: "/tmp/source.js",
    input_sha256: "a".repeat(64),
    output_sha256: "b".repeat(64),
    changed: true,
    iterations: 1,
    transforms: {},
    arithmetic_state_proofs: [],
    analysis_source_sha256: "b".repeat(64),
    static_alias_installer_calls: [],
    safe_static_only: true,
    presentation_formatted: false,
    runtime_semantics_preserved_by_design: true,
    note: "x",
  };
  const bytes = Buffer.from(JSON.stringify(report), "utf8");
  const marker = Buffer.from('"note":"x"', "utf8");
  const markerOffset = bytes.indexOf(marker);
  if (markerOffset < 0) throw new Error("fixture marker missing");
  bytes[markerOffset + marker.length - 2] = 0xff;
  expect(() => parseJsRedoxReport(bytes)).toThrowError(
    expect.objectContaining({ _tag: "AnalysisOutputError" }),
  );
});

it.each([
  { safe_static_only: false },
  { presentation_formatted: true },
  { runtime_semantics_preserved_by_design: false },
  { input_sha256: "0".repeat(64) },
  { analysis_source_sha256: "0".repeat(64) },
  { iterations: 2 },
  { changed: false },
])("rejects an invalid proof gate %j", (override) => {
  const report = {
    schema: "js-safe-deobfuscate/v1",
    input: "/tmp/source.js",
    input_sha256: "a".repeat(64),
    output_sha256: "b".repeat(64),
    analysis_source_sha256: "b".repeat(64),
    changed: true,
    iterations: 1,
    transforms: {},
    arithmetic_state_proofs: [],
    static_alias_installer_calls: [],
    safe_static_only: true,
    presentation_formatted: false,
    runtime_semantics_preserved_by_design: true,
    ...override,
  };
  expect(() =>
    validateJsRedoxReport(
      parseJsRedoxReport(Buffer.from(JSON.stringify(report))),
      {
        inputSha256: "a".repeat(64),
        outputSha256: "b".repeat(64),
        changed: true,
        maxIterations: 1,
      },
    ),
  ).toThrowError(expect.objectContaining({ _tag: "AnalysisOutputError" }));
});
