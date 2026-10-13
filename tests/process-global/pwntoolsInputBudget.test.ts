import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  onTestFinished,
} from "vitest";
import { AnalysisInputError } from "../../src/domain/analysisErrorCore.js";
import { PwntoolsLayoutProvider } from "../../src/native/pwntools/PwntoolsLayoutProvider.js";
import { prepareProcessOwnershipInspection } from "../../src/process/ProcessOwnershipObservation.js";
import { spawnOwnedProviderProcess } from "../../src/process/ProviderProcess.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../support/workspace/workspaceFixture.js";

const supported = process.platform !== "win32";
const platform = Object.getOwnPropertyDescriptor(process, "platform");
const architecture = Object.getOwnPropertyDescriptor(process, "arch");
beforeAll(() => (supported ? prepareProcessOwnershipInspection() : undefined));
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "linux" });
  Object.defineProperty(process, "arch", { value: "x64" });
});
afterEach(() => {
  if (platform !== undefined)
    Object.defineProperty(process, "platform", platform);
  if (architecture !== undefined)
    Object.defineProperty(process, "arch", architecture);
});

it.skipIf(!supported)(
  "enforces default and configured read budgets before decoder launch",
  async () => {
    const { root } = await createTestWorkspace("rea-pwntools-input-budget-");
    onTestFinished(() => removeTestWorkspace(root));
    const files = new Map<number, string>();
    for (const size of [33, 65]) {
      const path = join(root, `artifact-${size}MiB`);
      const handle = await open(path, "w");
      try {
        await handle.truncate(size * 1024 * 1024);
      } finally {
        await handle.close();
      }
      files.set(size, path);
    }
    let launches = 0;
    const snapshotSizes: number[] = [];
    const createProvider = (limit?: string) =>
      new PwntoolsLayoutProvider(
        {
          REA_PWNTOOLS_PYTHON: process.execPath,
          ...(limit === undefined
            ? {}
            : { REA_PWNTOOLS_MAX_INPUT_BYTES: limit }),
        },
        async (options) => {
          launches++;
          snapshotSizes.push(
            (await stat(join(options.cwd!, "object.snapshot"))).size,
          );
          return spawnOwnedProviderProcess({
            ...options,
            command: process.execPath,
            arguments: ["-e", "process.exit(0)"],
          });
        },
      );
    const defaultProvider = createProvider();
    const overrideProvider = createProvider(String(64 * 1024 * 1024));
    onTestFinished(async () => {
      await defaultProvider.close();
      await overrideProvider.close();
    });
    const expectCapacityFailure = (
      result: Awaited<ReturnType<PwntoolsLayoutProvider["inspect"]>>,
      limit: number,
    ) => {
      if (result.ok) throw new Error("expected configured capacity rejection");
      expect(result.error).toBeInstanceOf(AnalysisInputError);
      if (!(result.error instanceof AnalysisInputError)) throw result.error;
      expect(result.error.issues[0]).toMatchObject({
        reason: "out_of_range",
        message: expect.stringContaining(
          `Selected artifact exceeds ${limit} bytes`,
        ),
      });
    };
    expectCapacityFailure(
      await defaultProvider.inspect({ path: files.get(33)! }),
      32 * 1024 * 1024,
    );
    expect(launches).toBe(0);
    // The recording producer intentionally omits a decoder reply. Reaching this
    // launch proves the selected 33 MiB snapshot crossed the owning read boundary.
    expect((await overrideProvider.inspect({ path: files.get(33)! })).ok).toBe(
      false,
    );
    expect(launches).toBe(1);
    expect(snapshotSizes).toEqual([33 * 1024 * 1024]);
    expectCapacityFailure(
      await overrideProvider.inspect({ path: files.get(65)! }),
      64 * 1024 * 1024,
    );
    expect(launches).toBe(1);
  },
);
