import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { canonicalJson } from "../../../../src/domain/comparisonSemantics.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { parseJavaScriptSource } from "../../../../src/domain/javascript/javascriptSourceParser.js";
import { analyzeJavaScriptApplication } from "../../../support/javascriptApplicationScope.js";

type ApplicationAnalysis = ReturnType<
  typeof javascriptApplicationAnalysisResultSchema.parse
>;

const analyzeFiles = async (
  files: ReadonlyMap<string, string>,
): Promise<ApplicationAnalysis> => {
  const root = await createTestTempDirectory("rea-typescript-application-");
  await Promise.all(
    [...files].map(([path, source]) => writeFile(join(root, path), source)),
  );
  const result = await analyzeJavaScriptApplication({
    input_path: root,
    format: "directory",
  });
  if (!result.ok) throw result.error;
  const analysis = javascriptApplicationAnalysisResultSchema.parse(
    result.value.normalized_result,
  );
  return javascriptApplicationAnalysisResultSchema.parse(
    JSON.parse(canonicalJson(analysis, "TypeScript application analysis")),
  );
};

it.each(["types.d.ts", "types.d.mts", "types.d.cts"])(
  "keeps valid ambient declarations complete in %s",
  async (path) => {
    const source = "export const value: number;\n";
    const analysis = await analyzeFiles(new Map([[path, source]]));

    expect(analysis.graph.coverage.status).toBe("complete");
    expect(parseJavaScriptSource(source, path)?.errors).toEqual([]);
  },
);

it("retains the missing-initializer diagnostic for ordinary TypeScript", () => {
  const errors = parseJavaScriptSource(
    "export const value: number;",
    "types.ts",
  )?.errors;
  expect(errors?.map(({ message }) => message)).toContain(
    "Missing initializer in const declaration. (1:26)",
  );
});

it("keeps CommonJS TypeScript angle-bracket assertions complete", async () => {
  const source = "export const value = <number>42;\n";
  const analysis = await analyzeFiles(new Map([["app.cts", source]]));

  expect(analysis.graph.coverage.status).toBe("complete");
  expect(parseJavaScriptSource(source, "app.cts")?.errors).toEqual([]);
});

it("retains exported constant evidence through a type-only satisfies expression", async () => {
  const analysis = await analyzeFiles(
    new Map([["app.ts", 'export const value = "ready" satisfies string;\n']]),
  );

  expect(
    analysis.semantic_graph.nodes.filter(
      ({ kind, properties }) =>
        kind === "literal" && properties.value === "ready",
    ),
  ).toHaveLength(1);
});

it("resolves erased wrappers through the composed application graph", async () => {
  const source = `
    const dependency = require("./dependency.ts")["value" as const] satisfies number;
    export { dependency };
    function render<T>() { return "ready"; }
    export const specialized = render<string> satisfies () => string;
    specialized();
  `;
  const analysis = await analyzeFiles(
    new Map([
      ["app.mts", source],
      ["dependency.ts", "export const value = 1;\n"],
    ]),
  );

  expect(analysis.graph.edges).toContainEqual(
    expect.objectContaining({
      relation: "imports",
      properties: expect.objectContaining({
        specifier: "./dependency.ts",
        imported_path: ["value"],
        resolved_path: "dependency.ts",
        resolution_status: "resolved",
      }),
    }),
  );
  expect(analysis.semantic_graph.relations).toContainEqual(
    expect.objectContaining({ relation: "calls", resolution: "resolved" }),
  );
  expect(
    analysis.graph.nodes.flatMap(({ observations }) => observations),
  ).toContainEqual(
    expect.objectContaining({
      properties: expect.objectContaining({
        semantic_role: "export-return-shapes",
        exported_name: "specialized",
        static_return_shapes: expect.arrayContaining([
          expect.objectContaining({
            value_status: "literal",
            fields: expect.arrayContaining([
              expect.objectContaining({ path: "", value: "ready" }),
            ]),
          }),
        ]),
      }),
    }),
  );
  expect(parseJavaScriptSource(source, "app.mts")?.errors).toEqual([]);
});

it("applies TypeScript .mts ambiguity rules while retaining unambiguous generics", () => {
  expect(
    parseJavaScriptSource(
      "export const identity = <T,>(value: T) => value;",
      "app.mts",
    )?.errors,
  ).toEqual([]);
  expect(
    parseJavaScriptSource(
      "export const identity = <T>(value: T) => value;",
      "app.mts",
    )?.errors.map(({ reasonCode }) => reasonCode),
  ).toContain("ReservedArrowTypeParam");
  expect(parseJavaScriptSource("const value = <Widget />;", "app.mts")).toBe(
    null,
  );
});

it("keeps import-equals dependencies for values and none for erased declarations", async () => {
  const analysis = await analyzeFiles(
    new Map([
      ["package.json", '{"type":"commonjs"}'],
      ["dep.cjs", "module.exports = 42;\n"],
      ["other-dep.cjs", "module.exports = 43;\n"],
      [
        "main.cts",
        'import value = require("./dep.cjs");\nconsole.log(value);\n',
      ],
      [
        "type.cts",
        'import type erased = require("./other-dep.cjs");\nlet value: typeof erased | undefined;\nconsole.log(value);\n',
      ],
      [
        "alias.cts",
        "import ns = Internal.Namespace;\nlet value: ns.Thing | undefined;\nconsole.log(value);\n",
      ],
      [
        "esm.mts",
        'import value = require("./dep.cjs");\nconsole.log(value);\n',
      ],
    ]),
  );

  expect(analysis.graph.coverage.status).toBe("complete");

  const imports = analysis.graph.edges.filter(
    ({ relation }) => relation === "imports",
  );
  const valueLinks = imports.filter(
    ({ properties }) => properties.specifier === "./dep.cjs",
  );
  expect(valueLinks).toHaveLength(4);
  for (const path of ["main.cts", "esm.mts"]) {
    const edges = valueLinks.filter(
      ({ evidence: { location } }) =>
        location.available &&
        location.value.kind === "source-range" &&
        location.value.source === path,
    );
    expect(edges).toHaveLength(2);
    expect(
      edges.filter(({ properties }) => properties.kind === "require"),
    ).toHaveLength(1);
    expect(
      edges.filter(
        ({ properties }) => properties.module_link_kind === "require",
      ),
    ).toHaveLength(1);
    for (const edge of edges)
      expect(edge.evidence).toMatchObject({
        location: {
          available: true,
          value: {
            kind: "source-range",
            source: path,
            start: { line: 1, column: 0 },
            end: { line: 1, column: 36 },
          },
        },
      });
  }

  for (const edge of valueLinks)
    expect(edge.properties.resolved_path).toBe("dep.cjs");
  expect(
    valueLinks.filter(
      ({ properties }) => properties.resolution_status === "resolved",
    ),
  ).toHaveLength(2);

  expect(
    imports.filter(
      ({ properties }) => properties.specifier === "./other-dep.cjs",
    ),
  ).toHaveLength(0);
  expect(
    imports.filter(
      ({ properties }) =>
        typeof properties.specifier === "string" &&
        properties.specifier.startsWith("Internal"),
    ),
  ).toHaveLength(0);

  const moduleFormat = (path: string) =>
    analysis.graph.nodes
      .flatMap(({ observations }) => observations)
      .find(
        (observation) =>
          observation.properties.semantic_role === "source-module" &&
          observation.properties.path === path,
      )?.properties.module_format;
  expect(moduleFormat("main.cts")).toBe("commonjs");
  expect(moduleFormat("type.cts")).toBe("commonjs");
  expect(moduleFormat("alias.cts")).toBe("commonjs");
  expect(moduleFormat("esm.mts")).toBe("esm");
});
