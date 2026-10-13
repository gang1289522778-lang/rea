import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { AnalysisArtifactChangedError } from "../../../src/domain/analysisErrorCore.js";

import { readMachoFileUuidEntries } from "../../../src/application/DebugCompanionAdmission.js";
import { stageGhidraDebugCompanion } from "../../../src/ghidra/GhidraDebugCompanion.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const stagingFixture = async () => {
  const root = await createTestTempDirectory("rea-dsym-staging-");
  const bytes = Buffer.from("caller-selected DWARF member bytes");
  const runtime = join(root, "private-runtime");
  await mkdir(runtime);
  const memberPath = join(root, "original-member");
  await writeFile(memberPath, bytes, { mode: 0o640 });
  return {
    bytes,
    runtime,
    snapshot: join(runtime, "snapshot-name"),
    stagedBundle: join(runtime, "snapshot-name.dSYM"),
    stagedMember: join(
      runtime,
      "snapshot-name.dSYM",
      "Contents",
      "Resources",
      "DWARF",
      "snapshot-name",
    ),
    companion: {
      sourcePath: join(root, "caller.dSYM"),
      memberPath,
      memberSha256: createHash("sha256").update(bytes).digest("hex"),
      memberSizeBytes: bytes.length,
      uuid: "11111111-2222-3333-4444-555555555555",
    },
  };
};

it("stages verified bytes under the snapshot name with private permissions and source provenance", async () => {
  const fixture = await stagingFixture();
  const sourceBefore = await stat(fixture.companion.memberPath);
  expect(
    await stageGhidraDebugCompanion(
      fixture.companion,
      fixture.runtime,
      fixture.snapshot,
    ),
  ).toEqual({
    dsym: {
      source_path: fixture.companion.sourcePath,
      member_sha256: fixture.companion.memberSha256,
      uuid: fixture.companion.uuid,
      staged_member: fixture.stagedMember,
    },
  });
  expect(await readFile(fixture.stagedMember)).toEqual(fixture.bytes);
  expect(await readFile(fixture.companion.memberPath)).toEqual(fixture.bytes);
  if (process.platform !== "win32") {
    expect((await stat(fixture.stagedMember)).mode & 0o777).toBe(0o600);
    expect((await stat(fixture.companion.memberPath)).mode).toBe(
      sourceBefore.mode,
    );
  }
});

it("rejects a changed digest and removes the partial staged bundle while preserving source bytes", async () => {
  const fixture = await stagingFixture();
  await expect(
    stageGhidraDebugCompanion(
      { ...fixture.companion, memberSha256: "0".repeat(64) },
      fixture.runtime,
      fixture.snapshot,
    ),
  ).rejects.toThrow("dSYM member digest mismatch");
  await expect(access(fixture.stagedBundle)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readdir(fixture.runtime)).toEqual([]);
  expect(await readFile(fixture.companion.memberPath)).toEqual(fixture.bytes);
});

it("bounds a grown member by its admitted size and cleans the staged copy", async () => {
  const fixture = await stagingFixture();
  await expect(
    stageGhidraDebugCompanion(
      { ...fixture.companion, memberSizeBytes: fixture.bytes.length - 1 },
      fixture.runtime,
      fixture.snapshot,
    ),
  ).rejects.toThrow("grew beyond its admitted size");
  expect(await readdir(fixture.runtime)).toEqual([]);
  expect(await readFile(fixture.companion.memberPath)).toEqual(fixture.bytes);
});

it("cleans partial staging after cancellation without changing the selected member", async () => {
  const fixture = await stagingFixture();
  const controller = new AbortController();
  controller.abort(new Error("cancel dSYM staging"));
  await expect(
    stageGhidraDebugCompanion(
      fixture.companion,
      fixture.runtime,
      fixture.snapshot,
      { signal: controller.signal },
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(await readdir(fixture.runtime)).toEqual([]);
  expect(await readFile(fixture.companion.memberPath)).toEqual(fixture.bytes);
});

it("reads a UUID after a sparse command span above the former allocation ceiling", async () => {
  const root = await createTestTempDirectory("rea-dsym-sparse-commands-");
  const path = join(root, "large-command-image");
  const commandBytes = 200 * 1024 * 1024;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x01000007, 4);
  header.writeUInt32LE(2, 16);
  header.writeUInt32LE(commandBytes, 20);
  header.writeUInt32LE(0x77777777, 32); // An opaque command body is skipped.
  header.writeUInt32LE(commandBytes - 24, 36);
  const uuid = Buffer.alloc(24);
  uuid.writeUInt32LE(0x1b, 0);
  uuid.writeUInt32LE(24, 4);
  Buffer.from("11111111222233334444555555555555", "hex").copy(uuid, 8);
  const handle = await open(path, "wx+");
  try {
    await handle.truncate(32 + commandBytes);
    await handle.write(header, 0, header.length, 0);
    await handle.write(uuid, 0, uuid.length, 32 + commandBytes - uuid.length);
    expect(await readMachoFileUuidEntries(handle, 32 + commandBytes)).toEqual({
      ok: true,
      value: [
        { cpuType: 0x01000007, uuid: "11111111-2222-3333-4444-555555555555" },
      ],
    });
  } finally {
    await handle.close();
  }
});

it("classifies a disappeared admitted member and removes the staging bundle", async () => {
  const fixture = await stagingFixture();
  await rm(fixture.companion.memberPath);
  await expect(
    stageGhidraDebugCompanion(
      fixture.companion,
      fixture.runtime,
      fixture.snapshot,
    ),
  ).rejects.toBeInstanceOf(AnalysisArtifactChangedError);
  expect(await readdir(fixture.runtime)).toEqual([]);
});

it.each([
  {
    name: "table overlap",
    offset: 8,
    alignment: 0,
    subtype: 0,
    reason: "invalid slice range",
  },
  {
    name: "misalignment",
    offset: 33,
    alignment: 4,
    subtype: 0,
    reason: "not aligned",
  },
  {
    name: "CPU identity disagreement",
    offset: 32,
    alignment: 0,
    subtype: 1,
    reason: "CPU type/subtype disagrees",
  },
])(
  "rejects a FAT member with $name through the format owner",
  async ({ offset, alignment, subtype, reason }) => {
    const root = await createTestTempDirectory("rea-dsym-fat-owner-");
    const path = join(root, "member");
    const bytes = Buffer.alloc(128);
    bytes.writeUInt32BE(0xcafebabe, 0);
    bytes.writeUInt32BE(1, 4);
    bytes.writeUInt32BE(0x01000007, 8);
    bytes.writeUInt32BE(subtype, 12);
    bytes.writeUInt32BE(offset, 16);
    bytes.writeUInt32BE(56, 20);
    bytes.writeUInt32BE(alignment, 24);
    // The overlapping case must be refused before any thin-header interpretation.
    if (offset >= 28) {
      bytes.writeUInt32LE(0xfeedfacf, offset);
      bytes.writeUInt32LE(0x01000007, offset + 4);
      bytes.writeUInt32LE(1, offset + 16);
      bytes.writeUInt32LE(24, offset + 20);
      bytes.writeUInt32LE(0x1b, offset + 32);
      bytes.writeUInt32LE(24, offset + 36);
      Buffer.from("11111111222233334444555555555555", "hex").copy(
        bytes,
        offset + 40,
      );
    }
    await writeFile(path, bytes);
    const handle = await open(path, "r");
    try {
      expect(
        await readMachoFileUuidEntries(handle, bytes.length),
      ).toMatchObject({
        ok: false,
        error: {
          kind: "invalid-image",
          reason: expect.stringContaining(reason),
        },
      });
    } finally {
      await handle.close();
    }
  },
);
