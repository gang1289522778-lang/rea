import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { ArtifactProvider } from "../../../../src/artifacts/ArtifactProvider.js";
import { ArtifactReaderFailure } from "../../../../src/artifacts/ArtifactReader.js";
import {
  CPU,
  fatImage,
  machoImage,
} from "../../../../src/artifacts/apple/MachoImage.fixture.js";
import { parseBinaryTarget } from "../../../../src/application/BinaryTargetResolver.js";
import { artifactExtractionExecutionSchema } from "../../../../src/contracts/artifactToolContracts.js";

const sliceReader = vi.hoisted(() => ({
  reached: vi.fn(),
  failure: null as unknown,
}));

vi.mock("../../../../src/artifacts/MachOSliceArtifactReader.js", () => ({
  MachOSliceArtifactReader: class {
    async *entries() {
      sliceReader.reached();
      yield* [];
      throw sliceReader.failure;
    }

    close() {
      return Promise.resolve();
    }

    provenance() {
      return [];
    }
  },
}));

it("routes universal Mach-O extraction through slice inventory", async () => {
  sliceReader.reached.mockClear();
  sliceReader.failure = new ArtifactReaderFailure(
    "unavailable",
    "fixture reached universal slice inventory",
  );
  const root = await createTestTempDirectory("rea-extract-universal-");
  const image = join(root, "Universal");
  await writeFile(
    image,
    fatImage([
      { cpu: CPU.arm64, bytes: machoImage({ cpu: CPU.arm64 }) },
      { cpu: CPU.x86_64, bytes: machoImage({ cpu: CPU.x86_64 }) },
    ]),
  );
  const target = await parseBinaryTarget(image);
  if (!target.ok) throw target.error;
  expect(target.value.format).toBe("mach-o-universal");
  const output = join(root, "output");
  const result = await new ArtifactProvider(process.env)
    .createClient(target.value)
    .execute(
      "extract_artifact",
      artifactExtractionExecutionSchema.parse({ output_root: output }),
    );

  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "ArtifactOperationError",
      reason: "unavailable",
      detail: "fixture reached universal slice inventory",
    },
  });
  expect(sliceReader.reached).toHaveBeenCalledOnce();
  await expect(access(output)).rejects.toThrow();
});
