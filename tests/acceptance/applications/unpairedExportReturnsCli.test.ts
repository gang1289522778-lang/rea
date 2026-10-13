import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";

import { javaScriptExportShapeComparisonResultSchema } from "../../../src/domain/javascript/javascriptExportShapeComparisonSchemas.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { analyzeJavaScriptApplication } from "../../support/javascriptApplicationScope.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const comparisonEnvelope = z.object({
  normalized_result: javaScriptExportShapeComparisonResultSchema,
});

cliTest.for(["CLI", "stdio MCP"] as const)(
  "retains every unpaired export return location through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-unpaired-export-returns-");
    const sources = {
      two: 'export function run(flag) {\n  if (flag) return { kind: "r" };\n  return { kind: "s" };\n}',
      one: 'export function run() { return { kind: "r" }; }',
      none: "export function run() {}",
      otherNone: "export function run() { void 0; }",
      other: 'export function run() { return { kind: "t" }; }',
    };
    const versions = await Promise.all(
      Object.entries(sources).map(async ([name, source]) => {
        const directory = join(root, name);
        await mkdir(directory);
        await writeFile(join(directory, "mod.mjs"), source);
        const analyzed = await analyzeJavaScriptApplication({
          input_path: directory,
          format: "directory",
        });
        if (!analyzed.ok) throw analyzed.error;
        return [name, analyzed.value] as const;
      }),
    );
    const evidence = Object.fromEntries(versions);
    const mcp = surface === "stdio MCP" ? await connectLocalToolsMcp() : null;
    for (const [left, right, leftCount, rightCount] of [
      ["two", "none", 2, 0],
      ["one", "none", 1, 0],
      ["none", "two", 0, 2],
      ["none", "one", 0, 1],
      ["two", "other", 2, 1],
      ["none", "otherNone", 0, 0],
    ] as const) {
      const input = {
        left: evidence[left],
        right: evidence[right],
        left_module_path: "mod.mjs",
        left_export_name: "run",
        right_module_path: "mod.mjs",
        right_export_name: "run",
      };
      let document: unknown;
      if (mcp !== null) {
        const response = await mcp.call(
          "compare_javascript_export_shapes",
          input,
        );
        expect(response.isError, JSON.stringify(response)).not.toBe(true);
        document = response.structuredContent;
      } else {
        const inputPath = join(root, "comparison.json");
        await writeFile(inputPath, JSON.stringify(input));
        const response = await cli.run({
          arguments: ["compare-javascript-export-shapes", inputPath, "--json"],
          environment: { REA_LOG_LEVEL: "silent" },
        });
        expect(response.exitCode, response.stderr).toBe(0);
        document = response.json;
      }
      const result = comparisonEnvelope.parse(document).normalized_result;
      expect(result.left.status).toBe("selected");
      expect(result.right.status).toBe("selected");
      expect(result.coverage).toMatchObject({
        paired_variants: 0,
        unpaired_left_variants: leftCount,
        unpaired_right_variants: rightCount,
        omitted_changes: 0,
      });
      const count = Math.max(1, leftCount + rightCount);
      expect(result.summary).toEqual({
        added: 0,
        removed: 0,
        changed: 0,
        unknown: count,
      });
      expect(result.changes).toHaveLength(count);
      expect(result.property_inventories).toHaveLength(leftCount + rightCount);
      for (const inventory of result.property_inventories) {
        expect(inventory.paired).toBe(false);
        expect(inventory.properties).toContain("/kind");
        expect(result.changes).toContainEqual(
          expect.objectContaining({
            status: "unknown",
            path: "",
            presence: { left: "unknown-coverage", right: "unknown-coverage" },
            left_source_range:
              inventory.side === "left" ? inventory.source_range : null,
            right_source_range:
              inventory.side === "right" ? inventory.source_range : null,
          }),
        );
      }
      for (const [side, version] of [
        ["left", left],
        ["right", right],
      ] as const)
        if (version === "two")
          expect(
            result.changes
              .map(
                (change) =>
                  change[
                    side === "left" ? "left_source_range" : "right_source_range"
                  ]?.start.line,
              )
              .filter((line) => line !== undefined)
              .sort(),
          ).toEqual([2, 3]);
      if (leftCount + rightCount === 0)
        expect(result.changes[0]).toMatchObject({
          status: "unknown",
          left_source_range: null,
          right_source_range: null,
        });
    }
  },
);
