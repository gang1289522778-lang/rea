import { createPackage } from "@electron/asar";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { buildBinary } from "plist";

import { writeOrderedZip } from "../../../fixtures/artifactEntryOrder.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { parseBinaryTarget } from "../../../../src/application/BinaryTargetResolver.js";
import { inesFixture } from "../../../fixtures/ines.js";
import { nativeAotPeFixture } from "../../../fixtures/nativeaotPe.js";
import { ArtifactProvider } from "../../../../src/artifacts/ArtifactProvider.js";
import { artifactExtractionExecutionSchema } from "../../../../src/contracts/artifactToolContracts.js";
import { artifactExtractionResultSchema } from "../../../../src/domain/artifactGraph.js";
import type { BinaryTarget } from "../../../../src/domain/binaryTargetTypes.js";

it.each(["plist", "pe"] as const)(
  "extracts current iNES bytes after a non-extractable %s target is replaced",
  async (format) => {
    const root = await createTestTempDirectory("rea-extract-current-");
    const path = join(root, "source.bin");
    await writeFile(
      path,
      format === "plist" ? buildBinary({ value: "old" }) : nativeAotPeFixture(),
    );
    const target = await parseBinaryTarget(path);
    if (!target.ok) throw target.error;
    expect(target.value.format).toBe(format);
    const client = new ArtifactProvider(process.env).createClient(target.value);
    const bytes = inesFixture({
      trainer: true,
      trailing: Buffer.from("tail"),
    });
    await writeFile(path, bytes);
    const output = join(root, "output");
    const result = await client.execute(
      "extract_artifact",
      artifactExtractionExecutionSchema.parse({ output_root: output }),
    );
    if (!result.ok) throw result.error;
    const extracted = artifactExtractionResultSchema.parse(result.value.result);
    expect(extracted.manifest.root_format).toBe("ines");
    const paths = [
      "header.bin",
      "trainer.bin",
      "prg/000.bin",
      "prg/001.bin",
      "chr/000.bin",
      "trailing.bin",
    ];
    expect(extracted.artifacts).toHaveLength(paths.length);
    expect(
      Buffer.concat(
        await Promise.all(paths.map((part) => readFile(join(output, part)))),
      ),
    ).toEqual(bytes);
    await client.close();
  },
);

describe("artifact extraction format support", () => {
  it.each(["zip", "asar", "hap", "hsp", "app"] as const)(
    "extracts the scanned %s after an active iNES path is replaced",
    async (format) => {
      const root = await createTestTempDirectory("rea-extract-replaced-");
      const path = join(root, `source.${format}`);
      await writeFile(path, inesFixture());
      const target = await parseBinaryTarget(path);
      if (!target.ok) throw target.error;
      expect(target.value.format).toBe("ines");
      const client = new ArtifactProvider(process.env).createClient(
        target.value,
      );
      if (format !== "asar") {
        await writeOrderedZip(path, ["payload.txt"]);
      } else {
        const source = join(root, "source");
        await mkdir(source);
        await writeFile(join(source, "payload.txt"), "evidence\n");
        await createPackage(source, path);
      }
      const output = join(root, "output");
      const result = await client.execute(
        "extract_artifact",
        artifactExtractionExecutionSchema.parse({ output_root: output }),
      );
      if (!result.ok) throw result.error;
      const extracted = artifactExtractionResultSchema.parse(
        result.value.result,
      );
      expect(extracted.manifest.root_format).toBe(
        format === "app" ? "app-pack" : format,
      );
      expect(
        extracted.artifacts.map(({ relative_path }) => relative_path),
      ).toEqual(["payload.txt"]);
      expect(await readFile(join(output, "payload.txt"), "utf8")).toBe(
        "evidence\n",
      );
    },
  );

  it("refuses a scanned non-container instead of selecting a stale reader", async () => {
    const root = await createTestTempDirectory("rea-extract-replaced-file-");
    const path = join(root, "source.bin");
    await writeFile(path, inesFixture());
    const target = await parseBinaryTarget(path);
    if (!target.ok) throw target.error;
    const client = new ArtifactProvider(process.env).createClient(target.value);
    await writeFile(path, "ordinary replacement bytes");
    const output = join(root, "output");
    expect(
      await client.execute(
        "extract_artifact",
        artifactExtractionExecutionSchema.parse({ output_root: output }),
      ),
    ).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisUnsupportedTargetError",
        reason: expect.stringContaining(
          "Artifact format has no extraction reader:",
        ),
      },
    });
    await expect(access(output)).rejects.toThrow();
  });

  it("refuses a currently unsupported format before child inventory or output", async () => {
    const root = await createTestTempDirectory("rea-extract-format-");
    const image = join(root, "Image.dmg");
    const bytes = Buffer.alloc(512);
    bytes.write("koly", 0, "ascii");
    await writeFile(image, bytes);
    const alias = join(root, "Alias.dmg");
    await symlink(image, alias);
    const output = join(root, "output");
    const extract = (signal?: AbortSignal) =>
      new ArtifactProvider(process.env)
        .createClient(archiveTarget(alias, "dmg"))
        .execute(
          "extract_artifact",
          artifactExtractionExecutionSchema.parse({ output_root: output }),
          signal === undefined ? undefined : { signal },
        );
    expect(await extract()).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisUnsupportedTargetError",
        operation: "extract_artifact",
        path: alias,
        reason: "Artifact format has no extraction reader: dmg",
      },
    });
    const controller = new AbortController();
    controller.abort();
    expect(await extract(controller.signal)).toMatchObject({
      ok: false,
      error: { _tag: "ArtifactOperationError", reason: "cancelled" },
    });
    await expect(access(output)).rejects.toThrow();
  });

  it.each(["zip", "hap", "hsp", "app-pack"] as const)(
    "extracts the ZIP-backed %s package family that inventory already supports",
    async (format) => {
      const root = await createTestTempDirectory("rea-extract-zip-family-");
      const archive = join(
        root,
        `Payload.${format === "app-pack" ? "app" : format}`,
      );
      await writeOrderedZip(archive, ["payload.txt"]);
      const result = await new ArtifactProvider(process.env)
        .createClient(archiveTarget(archive, format))
        .execute(
          "extract_artifact",
          artifactExtractionExecutionSchema.parse({
            output_root: join(root, "output"),
          }),
        );
      if (!result.ok) throw result.error;
      const extracted = artifactExtractionResultSchema.parse(
        result.value.result,
      );
      expect(
        extracted.artifacts.map(({ relative_path }) => relative_path),
      ).toEqual(["payload.txt"]);
    },
  );
});

const archiveTarget = (
  path: string,
  format: Extract<BinaryTarget, { kind: "archive" }>["format"],
): BinaryTarget => ({
  path,
  sourcePath: path,
  sha256: "0".repeat(64),
  kind: "archive",
  format,
});
