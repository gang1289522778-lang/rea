import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { JavaScriptAnalysisWorker } from "../../../src/javascript/analysis/JavaScriptAnalysisWorker.js";
import { cleanupOwnedProcessGroup } from "../../../src/process/ProcessOwnership.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { javaScriptWorkerMemoryLimitBytes } from "../../../src/process/JavaScriptWorkerMemoryLimit.js";
import type { JavaScriptArtifactFile } from "../../../src/domain/javascript/javascriptArtifactFiles.js";
import { modeSourceFiles } from "../../fixtures/javascriptModuleResolutionModes.js";

const source = (path: string, value: string): JavaScriptArtifactFile => ({
  path,
  sha256: createHash("sha256").update(value).digest("hex"),
  container_sha256: "1".repeat(64),
  bytes: Buffer.byteLength(value),
  inventory_artifact_id: "fixture-source",
  kind: "javascript",
  unpacked: false,
  text: { included: true, value },
});

/** The Job Object limit the worker requests for its 128 MiB heap budget, if any. */
const processLimit = javaScriptWorkerMemoryLimitBytes(128);

it("reuses one real owned analyzer while retaining distinct source identities and exported returns", async () => {
  const launches: number[] = [];
  const worker = new JavaScriptAnalysisWorker(
    { heapMb: 128, timeoutMs: 30_000 },
    async (request) => {
      const spawned = await spawnOwnedProviderProcess(request);
      const pid = spawned.process.pid;
      if (pid === undefined)
        throw new Error("Owned analyzer has no observed PID");
      launches.push(pid);
      return spawned;
    },
  );
  try {
    const first = source(
      "first.mjs",
      "export function create() { return { observed: 7 }; }",
    );
    const second = source(
      "second.mjs",
      "export function next() { return { observed: 8 }; }",
    );
    for (const [index, file] of [first, second].entries()) {
      const result = await worker.analyze(file, 100);
      if (!result.ok) throw result.error.error;
      expect(result.value.javascript.parse_status).toBe("complete");
      expect(
        result.value.module?.callables[0]?.returnSites[0]?.value,
      ).toMatchObject({
        status: "object",
        properties: [
          { name: "observed", value: { status: "literal", value: index + 7 } },
        ],
      });
      expect(
        result.value.projection?.nodes.every(
          ({ identity }) => identity.artifact_sha256 === file.sha256,
        ),
      ).toBe(true);
      expect(
        result.value.projection?.nodes.some(
          ({ identity }) => identity.module_path === file.path,
        ),
      ).toBe(true);
    }
    for (const path of [
      "cts/inline.cts",
      "cts/same.cts",
      "cts/unresolved.cts",
      "cts/recovered.cts",
    ] as const) {
      const result = await worker.analyze(
        source(path, modeSourceFiles[path]),
        100,
      );
      if (!result.ok) throw result.error.error;
      const links = result.value.module?.moduleLinks;
      expect(result.value.javascript.references).toEqual([]);
      expect(links?.every(({ kind }) => kind === "type-import")).toBe(true);
      if (path === "cts/inline.cts")
        expect(links).toMatchObject([
          {
            importedName: "ImportOnly",
            resolutionMode: "import",
            location: { start: { line: 1 } },
          },
          {
            importedName: "RequireOnly",
            resolutionMode: "require",
            location: { start: { line: 2 } },
          },
          {
            importedName: "Shapes.ImportOnly",
            resolutionMode: "import",
            location: { start: { line: 3 } },
          },
          { importedName: "Types.ImportOnly", specifier: "./reexport.cjs" },
        ]);
      else if (path === "cts/recovered.cts") {
        expect(result.value.javascript.parse_status).toBe("partial");
        expect(links).toMatchObject([
          {
            importedName: "ImportOnly",
            resolutionMode: "import",
            location: { start: { line: 1 } },
          },
        ]);
      } else
        expect(links).toMatchObject([
          { localName: "First", resolutionMode: "import" },
          { localName: "Second", resolutionMode: "require" },
        ]);
    }
    for (const path of ["cts/native.mts", "cts/native-mixed.mts"] as const) {
      const result = await worker.analyze(
        source(path, modeSourceFiles[path]),
        100,
      );
      if (!result.ok) throw result.error.error;
      const bindings = result.value.javascript.electron.native_addon_bindings;
      if (path === "cts/native.mts") {
        expect(bindings).toHaveLength(8);
        expect(bindings.every(({ type_only }) => type_only === true)).toBe(
          true,
        );
      } else {
        expect(bindings).toHaveLength(4);
        expect(
          bindings.filter(({ type_only }) => type_only === true),
        ).toHaveLength(2);
        expect(
          bindings.filter(({ type_only }) => type_only === false),
        ).toHaveLength(2);
      }
    }
    const uncertain = await worker.analyze(
      source("cts/native-default.ts", modeSourceFiles["cts/native-default.ts"]),
      100,
    );
    if (!uncertain.ok) throw uncertain.error.error;
    expect(
      uncertain.value.javascript.electron.native_addon_bindings,
    ).toMatchObject([{ module_kind: "compiler-dependent", type_only: true }]);
    expect(uncertain.value.module?.moduleLinks).toMatchObject([
      { resolutionMode: "compiler-dependent" },
    ]);
    await expectNativeTypeSelections(worker);
    expect(launches).toHaveLength(1);
  } finally {
    await worker.close();
  }
});

it("reports an actual startup deadline and closes its owned resources before subsequent analysis", async () => {
  const file = source("app.mjs", "export const observed = 7;");
  const expired = new JavaScriptAnalysisWorker({ heapMb: 128, timeoutMs: 1 });
  try {
    const result = await expired.analyze(file, 100);
    if (result.ok)
      throw new Error(
        "A one-millisecond fresh process deadline unexpectedly completed",
      );
    expect(result.error.error).toMatchObject({
      _tag: "AnalysisTimeoutError",
      timeoutMs: 1,
    });
  } finally {
    await expired.close();
  }
  const next = new JavaScriptAnalysisWorker({ heapMb: 128, timeoutMs: 30_000 });
  try {
    const result = await next.analyze(file, 100);
    if (!result.ok) throw result.error.error;
    expect(result.value.javascript.parse_status).toBe("complete");
  } finally {
    await next.close();
  }
});

it("preserves a failed owned cleanup retry when the next caller cancels before acquisition", async () => {
  const controller = new AbortController();
  let releaseAllowed = false;
  let cleanupAttempts = 0;
  const worker = new JavaScriptAnalysisWorker(
    { heapMb: 128, timeoutMs: 30_000 },
    async (request) => {
      const launched = await spawnOwnedProviderProcess(request);
      return {
        ...launched,
        async cleanup() {
          cleanupAttempts += 1;
          if (!releaseAllowed) {
            if (cleanupAttempts > 1) controller.abort();
            throw new Error("Fixture owned cleanup is unavailable");
          }
          return launched.cleanup === undefined
            ? cleanupOwnedProcessGroup(launched.ownership)
            : launched.cleanup();
        },
      };
    },
  );
  const next = new JavaScriptAnalysisWorker({ heapMb: 128, timeoutMs: 30_000 });
  try {
    const file = source("app.mjs", "export const observed = 7;");
    const first = await worker.analyze(file, 100);
    if (!first.ok) throw first.error.error;
    const closing = worker.close();
    await expect(closing).rejects.toBeInstanceOf(ProviderCleanupError);
    await expect(closing).rejects.toMatchObject({
      cause: { message: "Fixture owned cleanup is unavailable" },
    });
    const interrupted = await next.analyze(file, 100, controller.signal);
    if (interrupted.ok)
      throw new Error("Unreleased ownership must block subsequent analysis");
    expect(controller.signal.aborted).toBe(true);
    expect(projectAnalysisError(interrupted.error.error)).toMatchObject({
      code: "cleanup_incomplete",
    });
    releaseAllowed = true;
    await worker.close();
    const recovered = await next.analyze(file, 100);
    if (!recovered.ok) throw recovered.error.error;
    expect(recovered.value.javascript.parse_status).toBe("complete");
  } finally {
    releaseAllowed = true;
    await worker.close();
    await next.close();
  }
});

// The handshake mirrors the real server: only Node.js reports an enforced V8 heap limit.
const resourceFailureWorker = (heapLimit: string) =>
  new JavaScriptAnalysisWorker({ heapMb: 128, timeoutMs: 30_000 }, (request) =>
    spawnOwnedProviderProcess({
      ...request,
      arguments: [
        "-e",
        `const heap = ${heapLimit};
process.stdout.write(JSON.stringify({ kind: "ready", heap_limit_bytes: heap }) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).once("line", (line) => {
  const { id } = JSON.parse(line);
  process.stdout.write(JSON.stringify({ kind: "failure", id, reason: "resource", resource: "memory", limits: null, message: "fixture" }) + "\\n");
});`,
      ],
    }),
  );

it("reports the worker heap limit only when the runtime enforces V8 heap flags", async () => {
  const worker = resourceFailureWorker(
    'process.versions.bun === undefined ? require("node:v8").getHeapStatistics().heap_size_limit : null',
  );
  try {
    const result = await worker.analyze(
      source("app.mjs", "export const observed = 7;"),
      100,
    );
    if (result.ok) throw new Error("expected a reported resource failure");
    expect(result.error.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
      reportedLimits:
        process.versions.bun === undefined
          ? {
              worker_old_space_mb: 128,
              worker_heap_limit_bytes: expect.any(Number),
              worker_timeout_ms: 30_000,
            }
          : {
              worker_heap_limit_bytes: null,
              ...(processLimit === null
                ? {}
                : { worker_process_memory_limit_bytes: processLimit }),
              worker_timeout_ms: 30_000,
            },
    });
  } finally {
    await worker.close();
  }
});

it("rejects a worker heap report that contradicts the launching runtime", async () => {
  const worker = resourceFailureWorker(
    "process.versions.bun === undefined ? null : 1",
  );
  try {
    const result = await worker.analyze(
      source("app.mjs", "export const observed = 7;"),
      100,
    );
    if (result.ok) throw new Error("expected a handshake failure");
    expect(result.error.error._tag).toBe("AnalysisOutputError");
  } finally {
    await worker.close();
  }
});

// The launcher runs a real child without a job limit, so any artifact can run
// it, and its handle reports the notification an owned Windows job records
// before exit. Bun exits 3 (panic) or 1 (exception) at a reached job limit.
it.each([true, false])(
  "classifies a worker exit by the job memory notification (reached: %s)",
  async (reached) => {
    const worker = new JavaScriptAnalysisWorker(
      { heapMb: 128, timeoutMs: 30_000 },
      async ({ memoryLimitBytes, ...request }) => {
        expect(memoryLimitBytes).toBe(processLimit ?? undefined);
        const spawned = await spawnOwnedProviderProcess({
          ...request,
          arguments: [
            "-e",
            `const heap = process.versions.bun === undefined ? require("node:v8").getHeapStatistics().heap_size_limit : null;
process.stdout.write(JSON.stringify({ kind: "ready", heap_limit_bytes: heap }) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).once("line", () => {
  process.stderr.write("panic: out of memory");
  process.exit(3);
});`,
          ],
        });
        let exited = false;
        spawned.process.once("exit", () => {
          exited = true;
        });
        Object.defineProperty(spawned.process, "memoryLimitReached", {
          get: () => reached && exited,
        });
        return spawned;
      },
    );
    try {
      const result = await worker.analyze(
        source("app.mjs", "export const observed = 7;"),
        100,
      );
      if (result.ok) throw new Error("expected the worker to fail");
      expect(result.error.error).toMatchObject(
        reached
          ? {
              _tag: "AnalysisResourceConstraintError",
              resource: "memory",
              reason: expect.stringContaining("process memory limit"),
              reportedLimits:
                processLimit === null
                  ? expect.not.objectContaining({
                      worker_process_memory_limit_bytes: expect.anything(),
                    })
                  : { worker_process_memory_limit_bytes: processLimit },
              capturedOutput: { stderr: "panic: out of memory" },
            }
          : {
              _tag: "ProviderAdapterError",
              diagnostics: { exit_code: 3 },
            },
      );
    } finally {
      await worker.close();
    }
  },
);

const expectNativeTypeSelections = async (
  worker: JavaScriptAnalysisWorker,
): Promise<void> => {
  const importEquals = await worker.analyze(
    source(
      "cts/native-import-equals.cts",
      modeSourceFiles["cts/native-import-equals.cts"],
    ),
    100,
  );
  if (!importEquals.ok) throw importEquals.error.error;
  expect(
    importEquals.value.javascript.electron.native_addon_bindings,
  ).toMatchObject([
    { module_kind: "require", type_only: true, namespace_access: true },
  ]);
  const esmEquals = await worker.analyze(
    source(
      "cts/native-import-equals.mts",
      modeSourceFiles["cts/native-import-equals.mts"],
    ),
    100,
  );
  if (!esmEquals.ok) throw esmEquals.error.error;
  expect(esmEquals.value.module?.moduleLinks).toMatchObject([
    { resolutionMode: "require", kind: "type-import" },
  ]);
  const indexed = await worker.analyze(
    source("cts/native-indexed.mts", modeSourceFiles["cts/native-indexed.mts"]),
    100,
  );
  if (!indexed.ok) throw indexed.error.error;
  expect(
    indexed.value.javascript.electron.native_addon_bindings.map(
      ({ members, namespace_access, dynamic_member_access, type_only }) => [
        members,
        namespace_access,
        dynamic_member_access,
        type_only,
      ],
    ),
  ).toEqual([
    [["NativeMode"], false, false, true],
    [["Native.Mode"], false, false, true],
    [[""], false, false, true],
    [["NativeMode"], false, false, true],
    [["Native.Mode"], false, false, true],
    [[""], false, false, true],
    [[], false, true, true],
    [["NativeMode"], false, false, true],
    [["-1"], false, false, true],
    [["0"], false, false, true],
    [["-1"], false, false, true],
    [["-1", "NativeMode"], false, false, true],
  ]);
  expect(
    indexed.value.module?.moduleLinks.map(({ importedName }) => importedName),
  ).toEqual([
    "NativeMode",
    "Native.Mode",
    "",
    "NativeMode",
    "Native.Mode",
    "",
    null,
    "NativeMode",
    "-1",
    "0",
    "-1",
    "(NativeMode | -1)",
  ]);
  for (const [text, count] of [
    [
      'import type { NativeMode } from "native-mode/addon.node" with { "resolution-mode": "import", type: "json" };',
      1,
    ],
    [
      'import type { NativeMode } from "native-mode/addon.node" with { "resolution-mode": "import", "resolution-mode": "require" };',
      1,
    ],
    [
      'type Native = import("native-mode/addon.node", {with: {"resolution-mode": "import", type: "json"}}).NativeMode;',
      1,
    ],
    [modeSourceFiles["cts/native-empty-attributes.cts"], 1],
    [modeSourceFiles["cts/native-empty-reexport.cts"], 1],
    [modeSourceFiles["cts/native-empty-namespace.cts"], 1],
    [modeSourceFiles["cts/native-empty-commented.cts"], 1],
    [modeSourceFiles["cts/native-nested-empty.d.cts"], 3],
    [modeSourceFiles["cts/native-value-selector.mts"], 1],
    [modeSourceFiles["cts/native-value-export-selector.mts"], 1],
  ] as const) {
    const result = await worker.analyze(source("invalid.cts", text), 100);
    if (!result.ok) throw result.error.error;
    if (
      text === modeSourceFiles["cts/native-value-selector.mts"] ||
      text === modeSourceFiles["cts/native-value-export-selector.mts"]
    )
      expect(result.value.javascript.references).toMatchObject([
        { resolutionMode: "compiler-dependent" },
      ]);
    expect(
      result.value.javascript.electron.native_addon_bindings.map(
        ({ module_kind }) => module_kind,
      ),
    ).toEqual(Array.from({ length: count }, () => "compiler-dependent"));
  }
  const omitted = await worker.analyze(
    source("omitted.cts", modeSourceFiles["cts/native-commented-omission.cts"]),
    100,
  );
  if (!omitted.ok) throw omitted.error.error;
  expect(omitted.value.module?.moduleLinks).toMatchObject([
    { resolutionMode: "require", importedName: "NativeMode" },
  ]);
  const nested = await worker.analyze(
    source("nested.d.cts", modeSourceFiles["cts/native-nested.d.cts"]),
    100,
  );
  if (!nested.ok) throw nested.error.error;
  expect(
    nested.value.module?.moduleLinks.map(
      ({ resolutionMode }) => resolutionMode,
    ),
  ).toEqual(["require", "require", "require"]);
  await expectNativeTypeIndexAlternatives(worker);
};

const expectNativeTypeIndexAlternatives = async (
  worker: JavaScriptAnalysisWorker,
): Promise<void> => {
  const dynamic = await worker.analyze(
    source(
      "dynamic.mts",
      'type Native = (typeof import("native-mode/addon.node"))[`Native${string}`];',
    ),
    100,
  );
  if (!dynamic.ok) throw dynamic.error.error;
  expect(dynamic.value.javascript.electron.native_addon_bindings).toMatchObject(
    [{ members: [], dynamic_member_access: true }],
  );
  const segments = await worker.analyze(
    source(
      "segments.mts",
      [
        'type Nested = import("native-mode/addon.node").A.B;',
        'type Literal = (typeof import("native-mode/addon.node"))["A.B"];',
        'type Union = (typeof import("native-mode/addon.node"))["A" | "B"]["C" | "D"];',
        'type Partial = (typeof import("native-mode/addon.node"))["A" | string];',
      ].join("\n"),
    ),
    100,
  );
  if (!segments.ok) throw segments.error.error;
  expect(
    segments.value.javascript.electron.native_addon_bindings,
  ).toMatchObject([
    { members: ["A"], dynamic_member_access: false },
    { members: ["A.B"], dynamic_member_access: false },
    { members: ["A", "B"], dynamic_member_access: false },
    { members: ["A"], dynamic_member_access: true },
  ]);
  expect(segments.value.module?.moduleLinks).toMatchObject([
    { importedName: "A.B", importedSelection: [["A"], ["B"]] },
    { importedName: "A.B", importedSelection: [["A.B"]] },
    {
      importedName: "(A | B).(C | D)",
      importedSelection: [
        ["A", "B"],
        ["C", "D"],
      ],
      dynamicMemberAccess: false,
    },
    {
      importedName: "A",
      importedSelection: [["A"]],
      dynamicMemberAccess: true,
    },
  ]);
};
