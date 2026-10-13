import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { expect } from "vitest";

import {
  modeSourceFiles,
  modePackageFiles,
  expectReviewModeEvidence,
} from "../../fixtures/javascriptModuleResolutionModes.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

const execute = promisify(execFile);
const requireFixture = createRequire(import.meta.url);
const compiler = join(
  dirname(requireFixture.resolve("typescript/package.json")),
  "bin",
  "tsc",
);
const ctsSource = [
  'import value from "./runtime-dep";',
  'import { marker } from "cts-package";',
  'export { marker as retainedMarker } from "cts-package";',
  "console.log(JSON.stringify([value, marker]));",
  'void import("cts-package").then(({ marker }) => console.log(marker));',
].join("\n");
const ctsResolutionSource = [
  'import type { ImportOnly } from "cts-package" with { "resolution-mode": "import" };',
  'import type { RequireOnly } from "cts-package" with { "resolution-mode": "require" };',
  "export type { ImportOnly, RequireOnly };",
  'const first: ImportOnly = { source: "import" };',
  'const second: RequireOnly = { source: "require" };',
  "console.log(JSON.stringify([first.source, second.source]));",
].join("\n");
const ctsReexportSource = [
  'export type { ImportOnly as DirectImportOnly } from "cts-package" with { "resolution-mode": "import" };',
  'export type * from "cts-package" with { "resolution-mode": "import" };',
  'export type * as Types from "cts-package" with { "resolution-mode": "import" };',
].join("\n");
const ctsSourceFiles = {
  "cts/package.json": JSON.stringify({ type: "commonjs" }),
  "cts/entry.cts": ctsSource,
  "cts/resolution.cts": ctsResolutionSource,
  "cts/reexport.cts": ctsReexportSource,
  "cts/runtime-dep.js": "module.exports = 42;",
  ...modeSourceFiles,
};
const ctsPackageFiles = {
  "node_modules/cts-package/package.json": JSON.stringify({
    exports: { require: "./actual.cjs", import: "./decoy.mjs" },
  }),
  "node_modules/cts-package/actual.cjs": "exports.marker = 43;",
  "node_modules/cts-package/actual.d.cts":
    'export const marker: number; export interface RequireOnly { source: "require"; }',
  "node_modules/cts-package/decoy.mjs": "export const marker = 99;",
  "node_modules/cts-package/decoy.d.mts":
    'export const marker: number; export interface ImportOnly { source: "import"; } export namespace Shapes { interface ImportOnly { source: "nested-import"; } }',
  ...modePackageFiles,
};

const createModuleLookupFixture = async () => {
  const root = await createTestTempDirectory("rea-module-lookup-");
  await writeFixtureFiles(root, {
    "package.json": JSON.stringify({
      name: "module-lookup-fixture",
      type: "commonjs",
    }),
    ...ctsPackageFiles,
    ...ctsSourceFiles,
    "esm/entry.mjs": [
      'import "./extensionless";',
      'import "./directory";',
      'import "./explicit.js";',
      'import "./exact.js";',
      'import "./actual.cjs?cache=1";',
      'import fallback from "empty-main";',
      'import "nested-main";',
      'import "file-only";',
      'import "ancestor-empty";',
      'import "ancestor-blocked";',
      'import "ancestor-sub/parser";',
      'import "./.hidden.js";',
      'import "./..pkg.js";',
      'import "./exact.js/.";',
      'import "./exact.js/child/..";',
      'import ".hidden.js";',
      'import "..pkg.js";',
      'import ".";',
      'import "..";',
      "void fallback;",
    ].join("\n"),
    "esm/extensionless.js": "module.exports = 1;",
    "esm/directory/index.js": "module.exports = 2;",
    "esm/explicit.js.js": "module.exports = 3;",
    "esm/exact.js": "module.exports = 4;",
    "esm/actual.cjs": "module.exports = 5;",
    "esm/.hidden.js": "module.exports = 'local hidden';",
    "esm/..pkg.js": "module.exports = 'local dot package';",
    "node_modules/.hidden.js/index.js": "module.exports = 'hidden package';",
    "node_modules/..pkg.js/index.js": "module.exports = 'dot package';",
    "esm/typed.mts": 'import value from "./typed-dep.js"; void value;',
    "esm/typed-dep.ts": "export default 42;",
    "cjs/entry.cjs": [
      'require("./extensionless");',
      'require("./directory");',
      'require("./feature");',
      'require("./feature.cjs");',
      'require("./module-only");',
      'require("./valid-directory");',
      'require("./default-js");',
      'require("./default-json");',
      'require("./default-node");',
      'require("empty-main");',
      'require("nested-main");',
      'require("file-only");',
      'require("ancestor-empty");',
      'require("ancestor-blocked");',
      'require("ancestor-sub/parser");',
      'require(".hidden.js");',
      'require("./.hidden.js");',
      'require(".");',
      'require("..");',
    ].join("\n"),
    "cjs/directory/index.cjs": "module.exports = 6;",
    "cjs/index.js": "module.exports = 'current directory';",
    "index.js": "module.exports = 'parent directory';",
    "cjs/.hidden.js": "module.exports = 'local hidden';",
    "cjs/extensionless.cjs": "module.exports = 1;",
    "cjs/feature.cjs": "module.exports = 2;",
    "cjs/module-only.mjs": "export default 42;",
    "cjs/valid-directory/index.js": "module.exports = 42;",
    "cjs/typed.cts":
      'const value = require("./typed-dep.cjs"); module.exports = value;',
    "cjs/typed-dep.cts": "module.exports = 42;",
    "cjs/default-js.js": "module.exports = 3;",
    "cjs/default-json.json": JSON.stringify({ value: 4 }),
    // Inventory-only placeholder: never pass this path to Node's runtime.
    "cjs/default-node.node": "source-owned opaque native-module placeholder",
    "node_modules/empty-main/package.json": JSON.stringify({ main: "" }),
    "node_modules/empty-main/index.js": "module.exports = 42;",
    "node_modules/nested-main/package.json": JSON.stringify({ main: "sub" }),
    "node_modules/nested-main/sub/package.json": JSON.stringify({
      main: "other",
    }),
    "node_modules/nested-main/sub/other.js": "module.exports = 99;",
    "node_modules/file-only.js": "module.exports = 7;",
    "node_modules/ancestor-empty/index.js": "module.exports = 8;",
    "node_modules/ancestor-blocked/index.js": "module.exports = 9;",
    "node_modules/ancestor-sub/parser.js": "module.exports = 10;",
    "esm/runtime-control.mjs": [
      'const specifiers = ["./extensionless", "./directory", "./explicit.js", "./exact.js", "./actual.cjs?cache=1", "empty-main", "nested-main", "file-only", "ancestor-empty", "ancestor-blocked", "ancestor-sub/parser", "./.hidden.js", "./..pkg.js", "./exact.js/.", "./exact.js/child/..", ".hidden.js", "..pkg.js", ".", ".."];',
      "const results = [];",
      "for (const specifier of specifiers) {",
      "  try { const value = (await import(specifier)).default; results.push({ specifier, ok: true, value }); }",
      "  catch (error) { results.push({ specifier, ok: false, code: error.code }); }",
      "}",
      "console.log(JSON.stringify(results));",
    ].join("\n"),
    "cjs/runtime-control.cjs": [
      'const specifiers = ["./extensionless", "./directory", "./feature", "./feature.cjs", "./module-only", "./valid-directory", "./default-js", "./default-json", "empty-main", "nested-main", "file-only", "ancestor-empty", "ancestor-blocked", "ancestor-sub/parser", ".hidden.js", "./.hidden.js", ".", ".."];',
      "const results = [];",
      "for (const specifier of specifiers) {",
      "  try { const value = require(specifier); results.push({ specifier, ok: true, value }); }",
      "  catch (error) { results.push({ specifier, ok: false, code: error.code }); }",
      "}",
      "console.log(JSON.stringify(results));",
    ].join("\n"),
  });
  for (const directory of ["esm", "cjs"])
    await writeFixtureFiles(root, {
      [`${directory}/node_modules/ancestor-empty/package.json`]: JSON.stringify(
        { main: "" },
      ),
      [`${directory}/node_modules/ancestor-blocked/package.json`]:
        JSON.stringify({ main: "missing" }),
      [`${directory}/node_modules/ancestor-sub/package.json`]: "{}",
    });
  return root;
};

const expectCtsRuntime = async (root: string): Promise<void> => {
  const emitted = await createTestTempDirectory("rea-cts-module-output-");
  await writeFixtureFiles(emitted, {
    ...ctsPackageFiles,
    "package.json": JSON.stringify({ type: "commonjs" }),
  });
  await execute(
    process.execPath,
    [
      compiler,
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--skipLibCheck",
      "--allowJs",
      "--rootDir",
      join(root, "cts"),
      "--outDir",
      emitted,
      join(root, "cts/entry.cts"),
      join(root, "cts/resolution.cts"),
      join(root, "cts/reexport.cts"),
      join(root, "cts/inline.cts"),
      join(root, "cts/script.ts"),
      join(root, "cts/same.cts"),
      join(root, "cts/native.mts"),
      join(root, "cts/native-default.cts"),
      join(root, "cts/native-default.mts"),
      join(root, "cts/native-default.ts"),
      join(root, "cts/native-mixed.mts"),
      join(root, "cts/native-inline-only.mts"),
      join(root, "cts/native-import-equals.cts"),
      join(root, "cts/native-import-equals.mts"),
      join(root, "cts/native-indexed.mts"),
      join(root, "cts/native-commented-omission.cts"),
      join(root, "cts/native-nested.d.cts"),
      join(root, "cts/native-export-equals.cts"),
      join(root, "cts/native-export-type-equals.cts"),
      join(root, "cts/runtime-dep.js"),
    ],
    { cwd: root, timeout: 10_000 },
  );
  const mixedOutput = await readFile(join(emitted, "native-mixed.mjs"), "utf8");
  expect(mixedOutput).toContain("NativeMode as runtimeNative");
  expect(mixedOutput).toContain("NativeMode as runtimeNativeExport");
  expect(mixedOutput).not.toContain("NativeType");
  expect(
    await readFile(join(emitted, "native-inline-only.mjs"), "utf8"),
  ).not.toContain("native-mixed/addon.node");
  await execute(
    process.execPath,
    [
      compiler,
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--skipLibCheck",
      "--verbatimModuleSyntax",
      "--outDir",
      join(emitted, "verbatim"),
      join(root, "cts/native-inline-only.mts"),
    ],
    { cwd: root, timeout: 10_000 },
  );
  const verbatim = await readFile(
    join(emitted, "verbatim/native-inline-only.mjs"),
    "utf8",
  );
  expect(verbatim).toContain('import {} from "native-mixed/addon.node";');
  expect(verbatim).toContain('export {} from "native-mixed/addon.node";');
  const ctsControl = await execute(process.execPath, ["entry.cjs"], {
    cwd: emitted,
    timeout: 5_000,
  });
  expect(ctsControl.stdout.trim().split("\n")).toEqual(["[42,43]", "99"]);
  const resolution = await execute(process.execPath, ["resolution.cjs"], {
    cwd: emitted,
    timeout: 5_000,
  });
  expect(JSON.parse(resolution.stdout)).toEqual(["import", "require"]);
  for (const [file, expected] of [
    ["inline.cjs", ["import", "require", "nested-import", "import"]],
    ["native.mjs", ["require", "import", "require", "import", "import"]],
    ["native-default.cjs", "require"],
    ["native-default.mjs", "import"],
    ["native-default.js", "require"],
    ["native-import-equals.cjs", "require"],
    ["native-import-equals.mjs", "require"],
    ["native-indexed.mjs", Array.from({ length: 12 }, () => "import")],
    ["native-export-type-equals.cjs", "require"],
  ] as const) {
    const result = await execute(process.execPath, [file], {
      cwd: emitted,
      timeout: 5_000,
    });
    expect(JSON.parse(result.stdout)).toEqual(expected);
  }
  expect(
    createRequire(join(emitted, "native.mjs")).resolve(
      "native-mode/addon.node",
    ),
  ).toBe(join(emitted, "node_modules/native-mode/require.node"));
  const nativeImport = await execute(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'console.log(import.meta.resolve("native-mode/addon.node"))',
    ],
    { cwd: emitted, timeout: 5_000 },
  );
  expect(fileURLToPath(nativeImport.stdout.trim())).toBe(
    join(emitted, "node_modules/native-mode/import.node"),
  );
  await expect(
    execute(
      process.execPath,
      [
        compiler,
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--skipLibCheck",
        "--noEmit",
        join(root, "cts/unresolved.cts"),
      ],
      { cwd: root, timeout: 10_000 },
    ),
  ).rejects.toMatchObject({
    code: 1,
    stdout: expect.stringContaining("TS2307"),
  });
};

const expectCtsModuleLookup = (
  graph: Awaited<ReturnType<typeof analyzeJavaScriptDirectory>>["graph"],
): void => {
  const sourceDigest = createHash("sha256").update(ctsSource).digest("hex");
  for (const [kind, specifier, path] of [
    ["import", "./runtime-dep", "cts/runtime-dep.js"],
    ["import", "cts-package", "node_modules/cts-package/actual.cjs"],
    ["re-export", "cts-package", "node_modules/cts-package/actual.cjs"],
  ] as const) {
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        relation: "imports",
        properties: expect.objectContaining({
          module_link_kind: kind,
          specifier,
          resolved_path: path,
          resolution_status: "resolved",
        }),
        evidence: expect.objectContaining({
          artifact: expect.objectContaining({ sha256: sourceDigest }),
          location: expect.objectContaining({
            available: true,
            value: expect.objectContaining({ source: "cts/entry.cts" }),
          }),
        }),
      }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        relation: "imports",
        properties: expect.objectContaining({
          kind: "static-import",
          specifier,
          resolved_path: path,
        }),
        evidence: expect.objectContaining({
          artifact: expect.objectContaining({ sha256: sourceDigest }),
        }),
      }),
    );
  }
  expect(graph.edges).toContainEqual(
    expect.objectContaining({
      relation: "imports",
      properties: expect.objectContaining({
        kind: "dynamic-import",
        specifier: "cts-package",
        resolved_path: "node_modules/cts-package/decoy.mjs",
      }),
      evidence: expect.objectContaining({
        artifact: expect.objectContaining({ sha256: sourceDigest }),
      }),
    }),
  );
  expect(
    graph.nodes.flatMap(({ observations }) => observations),
  ).toContainEqual(
    expect.objectContaining({
      properties: expect.objectContaining({
        semantic_role: "source-module",
        path: "cts/entry.cts",
        module_format: "commonjs",
      }),
    }),
  );
};

type RuntimeControlResult = {
  readonly specifier: string;
  readonly ok: boolean;
  readonly code?: string;
  readonly value?: unknown;
};

const expectNodeRuntimeControls = (
  esmOutput: string,
  cjsOutput: string,
): void => {
  const esmResults = JSON.parse(esmOutput) as RuntimeControlResult[];
  const cjsResults = JSON.parse(cjsOutput) as RuntimeControlResult[];
  expect(esmResults).toEqual([
    {
      specifier: "./extensionless",
      ok: false,
      code: "ERR_MODULE_NOT_FOUND",
    },
    {
      specifier: "./directory",
      ok: false,
      code: "ERR_UNSUPPORTED_DIR_IMPORT",
    },
    {
      specifier: "./explicit.js",
      ok: false,
      code: "ERR_MODULE_NOT_FOUND",
    },
    { specifier: "./exact.js", ok: true, value: 4 },
    { specifier: "./actual.cjs?cache=1", ok: true, value: 5 },
    { specifier: "empty-main", ok: true, value: 42 },
    { specifier: "nested-main", ok: false, code: "ERR_MODULE_NOT_FOUND" },
    { specifier: "file-only", ok: false, code: "ERR_MODULE_NOT_FOUND" },
    { specifier: "ancestor-empty", ok: false, code: "ERR_MODULE_NOT_FOUND" },
    {
      specifier: "ancestor-blocked",
      ok: false,
      code: "ERR_MODULE_NOT_FOUND",
    },
    {
      specifier: "ancestor-sub/parser",
      ok: false,
      code: "ERR_MODULE_NOT_FOUND",
    },
    { specifier: "./.hidden.js", ok: true, value: "local hidden" },
    { specifier: "./..pkg.js", ok: true, value: "local dot package" },
    {
      specifier: "./exact.js/.",
      ok: false,
      code: "ERR_UNSUPPORTED_DIR_IMPORT",
    },
    {
      specifier: "./exact.js/child/..",
      ok: false,
      code: "ERR_UNSUPPORTED_DIR_IMPORT",
    },
    {
      specifier: ".hidden.js",
      ok: false,
      code: "ERR_INVALID_MODULE_SPECIFIER",
    },
    {
      specifier: "..pkg.js",
      ok: false,
      code: "ERR_INVALID_MODULE_SPECIFIER",
    },
    { specifier: ".", ok: false, code: "ERR_UNSUPPORTED_DIR_IMPORT" },
    { specifier: "..", ok: false, code: "ERR_UNSUPPORTED_DIR_IMPORT" },
  ]);
  expect(cjsResults).toEqual([
    {
      specifier: "./extensionless",
      ok: false,
      code: "MODULE_NOT_FOUND",
    },
    {
      specifier: "./directory",
      ok: false,
      code: "MODULE_NOT_FOUND",
    },
    {
      specifier: "./feature",
      ok: false,
      code: "MODULE_NOT_FOUND",
    },
    { specifier: "./feature.cjs", ok: true, value: 2 },
    { specifier: "./module-only", ok: false, code: "MODULE_NOT_FOUND" },
    { specifier: "./valid-directory", ok: true, value: 42 },
    { specifier: "./default-js", ok: true, value: 3 },
    { specifier: "./default-json", ok: true, value: { value: 4 } },
    { specifier: "empty-main", ok: true, value: 42 },
    { specifier: "nested-main", ok: false, code: "MODULE_NOT_FOUND" },
    { specifier: "file-only", ok: true, value: 7 },
    { specifier: "ancestor-empty", ok: true, value: 8 },
    { specifier: "ancestor-blocked", ok: false, code: "MODULE_NOT_FOUND" },
    { specifier: "ancestor-sub/parser", ok: true, value: 10 },
    { specifier: ".hidden.js", ok: true, value: "hidden package" },
    { specifier: "./.hidden.js", ok: true, value: "local hidden" },
    { specifier: ".", ok: true, value: "current directory" },
    { specifier: "..", ok: true, value: "parent directory" },
  ]);
};

const expectErasedCtsDependencies = (
  graph: Awaited<ReturnType<typeof analyzeJavaScriptDirectory>>["graph"],
): void => {
  for (const [path, text, count, names] of [
    [
      "cts/resolution.cts",
      ctsResolutionSource,
      4,
      ["ImportOnly", "RequireOnly"],
    ],
    [
      "cts/reexport.cts",
      ctsReexportSource,
      3,
      ["*", "DirectImportOnly", "Types"],
    ],
  ] as const) {
    const observations = graph.nodes.flatMap(
      ({ observations }) => observations,
    );
    expect(observations).toContainEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          semantic_role: "source-module",
          path,
          import_relationships: 0,
          type_relationships: count,
          export_relationships: 0,
          export_names: [],
          type_export_names: names,
        }),
        evidence: expect.objectContaining({
          artifact: expect.objectContaining({
            sha256: createHash("sha256").update(text).digest("hex"),
          }),
        }),
      }),
    );
    expect(
      graph.edges.filter(
        ({ relation, evidence }) =>
          (relation === "imports" || relation === "loads") &&
          evidence.location.available &&
          evidence.location.value.kind === "source-range" &&
          evidence.location.value.source === path,
      ),
    ).toEqual([]);
  }
};

cliTest.for(["CLI", "stdio MCP"] as const)(
  "matches Node module lookup for ESM and CommonJS through %s",
  async (surface, { cli }) => {
    const root = await createModuleLookupFixture();
    await expectCtsRuntime(root);
    const [esmControl, cjsControl] = await Promise.all([
      execute(process.execPath, ["esm/runtime-control.mjs"], {
        cwd: root,
        timeout: 5_000,
      }),
      execute(process.execPath, ["cjs/runtime-control.cjs"], {
        cwd: root,
        timeout: 5_000,
      }),
    ]);
    expectNodeRuntimeControls(esmControl.stdout, cjsControl.stdout);

    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    const expectations = [
      ["import", "./extensionless", null, "not-found"],
      ["import", "./directory", null, "not-found"],
      ["import", "./explicit.js", null, "not-found"],
      ["import", "./exact.js", "esm/exact.js", "resolved"],
      ["import", "./actual.cjs?cache=1", "esm/actual.cjs", "resolved"],
      ["import", "./typed-dep.js", "esm/typed-dep.ts", "resolved"],
      ["import", "empty-main", "node_modules/empty-main/index.js", "resolved"],
      ["import", "nested-main", null, "not-found"],
      ["import", "file-only", null, "external"],
      ["import", "ancestor-empty", null, "not-found"],
      ["import", "ancestor-blocked", null, "not-found"],
      ["import", "ancestor-sub/parser", null, "not-found"],
      ["import", "./.hidden.js", "esm/.hidden.js", "resolved"],
      ["import", "./..pkg.js", "esm/..pkg.js", "resolved"],
      ["import", ".hidden.js", null, "rejected"],
      ["import", "..pkg.js", null, "rejected"],
      ["import", ".", null, "not-found"],
      ["import", "..", null, "not-found"],
      ["import", "./exact.js/.", null, "not-found"],
      ["import", "./exact.js/child/..", null, "not-found"],
      ["require", "./extensionless", null, "not-found"],
      ["require", "./directory", null, "not-found"],
      ["require", "./feature", null, "not-found"],
      ["require", "./feature.cjs", "cjs/feature.cjs", "resolved"],
      ["require", "./module-only", null, "not-found"],
      [
        "require",
        "./valid-directory",
        "cjs/valid-directory/index.js",
        "resolved",
      ],
      ["require", "./typed-dep.cjs", "cjs/typed-dep.cts", "resolved"],
      ["require", "./default-js", "cjs/default-js.js", "resolved"],
      ["require", "./default-json", "cjs/default-json.json", "resolved"],
      ["require", "./default-node", "cjs/default-node.node", "resolved"],
      ["require", "empty-main", "node_modules/empty-main/index.js", "resolved"],
      ["require", "nested-main", null, "not-found"],
      ["require", "file-only", "node_modules/file-only.js", "resolved"],
      [
        "require",
        "ancestor-empty",
        "node_modules/ancestor-empty/index.js",
        "resolved",
      ],
      ["require", "ancestor-blocked", null, "not-found"],
      [
        "require",
        "ancestor-sub/parser",
        "node_modules/ancestor-sub/parser.js",
        "resolved",
      ],
      ["require", ".hidden.js", "node_modules/.hidden.js/index.js", "resolved"],
      ["require", "./.hidden.js", "cjs/.hidden.js", "resolved"],
      ["require", ".", "cjs/index.js", "resolved"],
      ["require", "..", "index.js", "resolved"],
    ] as const;

    for (const [kind, specifier, resolvedPath, status] of expectations) {
      const matchingProperties = graph.edges
        .filter((edge) => edge.relation === "imports")
        .map((edge) => edge.properties)
        .filter(
          (properties) =>
            "module_link_kind" in properties &&
            properties.module_link_kind === kind &&
            properties.specifier === specifier,
        );
      expect(matchingProperties).toContainEqual(
        expect.objectContaining({
          module_link_kind: kind,
          specifier,
          resolved_path: resolvedPath,
          resolution_status: status,
        }),
      );
    }
    expectCtsModuleLookup(graph);
    expectErasedCtsDependencies(graph);
    expectReviewModeEvidence(graph);
  },
);
