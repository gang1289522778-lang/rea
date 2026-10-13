import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Synthetic measurement directories exercise the comparator CLI, not providers.
const observation = (kind) => ({
  evidence_id: `ev_${kind}`,
  parent_evidence_id: "ev_parent",
  limitations: ["saved bytes only"],
  kind,
  view:
    kind === "summary"
      ? { kind }
      : { kind, facet: "http-uris", offset: 0, limit: 2 },
  coverage: { examined: 2, total: 3, next_offset: 2, exhausted: false },
  unknowns: ["unrecorded traffic"],
});
const fixture = (delivery, artifact) => ({
  summary: {
    artifact,
    delivery,
    provider_search_path_sha256: "a".repeat(64),
    calls: [],
  },
  answer: {
    capture: { coverage: "complete", capture_start: null },
    http_request_uris_first2: [
      "http://example.test/one",
      "http://example.test/two",
    ],
    delivery_observations:
      delivery === "summary"
        ? [observation("summary"), observation("pcap")]
        : [
            {
              evidence_id: "ev_complete",
              limitations: ["saved bytes only"],
              coverage: "complete",
            },
          ],
  },
});
function compare(left, right) {
  const root = mkdtempSync(join(tmpdir(), "rea-compare-test-"));
  try {
    const directories = ["left", "right"].map((side) => join(root, side));
    for (const [index, value] of [left, right].entries()) {
      mkdirSync(directories[index]);
      for (const name of ["summary", "answer"])
        writeFileSync(
          join(directories[index], `${name}.json`),
          JSON.stringify(value[name]),
        );
    }
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("compare.mjs", import.meta.url)),
        "--left",
        directories[0],
        "--right",
        directories[1],
      ],
      { encoding: "utf8" },
    );
    assert.ifError(result.error);
    assert.equal(result.stderr, "");
    return { status: result.status, report: JSON.parse(result.stdout) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const artifact of [
  "wireshark-http.cap",
  "wireshark-http_redirects.pcapng",
]) {
  test(`${artifact}: repeated modes ignore only receipt IDs`, () => {
    for (const delivery of ["complete", "summary"]) {
      const left = fixture(delivery, artifact);
      const right = structuredClone(left);
      for (const value of right.answer.delivery_observations) {
        value.evidence_id += "_second";
        if (Object.hasOwn(value, "parent_evidence_id"))
          value.parent_evidence_id += "_second";
      }
      const { status, report } = compare(left, right);
      assert.equal(status, 0);
      assert.equal(report.facts_match, true);
      assert.deepEqual(
        report.preserved_run_specific_values.map((value) => value.value),
        [left.answer.delivery_observations, right.answer.delivery_observations],
      );
    }
  });

  test(`${artifact}: repeated modes reject stable observation changes`, () => {
    for (const delivery of ["complete", "summary"]) {
      const left = fixture(delivery, artifact);
      const mutations = [
        (values) => values[0].limitations.push("new limitation"),
        (values) => {
          values[0].coverage = "partial";
        },
        (values) => {
          delete values[0].coverage;
        },
      ];
      if (delivery === "summary")
        mutations.push(
          (values) => {
            values[1].view.offset = 1;
          },
          (values) => {
            values[1].coverage.next_offset = null;
          },
          (values) => values[1].unknowns.push("extra unknown"),
          (values) => values.reverse(),
        );
      for (const mutate of mutations) {
        const right = structuredClone(left);
        mutate(right.answer.delivery_observations);
        const { status, report } = compare(left, right);
        assert.equal(status, 1);
        assert.equal(report.settings_match, true);
        assert.equal(report.facts_match, false);
        assert.deepEqual(report.fact_differences, ["delivery_observations"]);
      }
    }
  });

  test(`${artifact}: different modes preserve their different receipt scopes`, () => {
    const left = fixture("complete", artifact);
    const right = fixture("summary", artifact);
    const { status, report } = compare(left, right);
    assert.equal(status, 0);
    assert.equal(report.facts_match, true);
    assert.deepEqual(
      report.preserved_run_specific_values.map((value) => value.value),
      [left.answer.delivery_observations, right.answer.delivery_observations],
    );
    right.answer.capture.coverage = "partial";
    assert.equal(compare(left, right).report.facts_match, false);
  });
}
