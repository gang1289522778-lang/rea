import { expect, it } from "vitest";
import {
  artifactInventoryOutputSchema,
  artifactInventoryResultSchema,
} from "./artifactGraph.js";
import { jsonValueSchema } from "./jsonValue.js";

const digest = "a".repeat(64);
const inventory = {
  manifest: {
    manifest_id: `agm_${digest}`,
    root_artifact_id: `art_${digest}`,
    root_sha256: digest,
    root_format: "zip",
    graph_sha256: digest,
    node_count: 1,
    occurrence_count: 1,
    edge_count: 0,
  },
  nodes: [
    {
      artifact_id: `art_${digest}`,
      format: "zip",
      sha256: digest,
      size: 22,
      media_type: null,
      architecture: null,
      content_state: "materialized",
      limitations: [],
    },
  ],
  occurrences: [
    {
      occurrence_id: `occ_${digest}`,
      artifact_id: `art_${digest}`,
      parent_occurrence_id: null,
      logical_path: ".",
      entry_kind: "file",
      artifact_kind: "container",
      artifact_format: "zip",
      declared_size: 22,
      compressed_size: null,
      executable: false,
      encrypted: false,
      hash_status: "verified",
      source_location: null,
      limitations: [],
    },
  ],
  edges: [],
  provenance: [],
  integrity_contradictions: [],
  limitations: [],
  coverage_status: "complete",
};

it("keeps absent container facts absent in JSON-safe inventory output", () => {
  const output = artifactInventoryOutputSchema.parse(inventory);
  expect(Object.hasOwn(output, "ines")).toBe(false);
  expect(jsonValueSchema.safeParse(output).success).toBe(true);
  expect(
    artifactInventoryOutputSchema.safeParse({ ...inventory, ines: undefined })
      .success,
  ).toBe(false);
});

it("keeps historical coverage omission separate from current output requirements", () => {
  const { coverage_status: _coverage, ...historical } = inventory;
  const imported = artifactInventoryResultSchema.parse(historical);
  expect(Object.hasOwn(imported, "coverage_status")).toBe(false);
  expect(artifactInventoryOutputSchema.safeParse(historical).success).toBe(
    false,
  );
});
