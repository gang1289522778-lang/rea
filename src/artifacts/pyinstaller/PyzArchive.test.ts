import { deflateSync } from "node:zlib";
import { expect, it } from "vitest";

import { inflateBounded, parsePyzArchive } from "./PyzArchive.js";
import { PYTHON_39_MAGIC, pyzArchive } from "./CArchive.fixture.js";

it("lists modules from a supported PYZ and leaves an unknown magic opaque", () => {
  const body = Buffer.from("module");
  const parsed = parsePyzArchive(
    pyzArchive({
      magic: PYTHON_39_MAGIC,
      modules: [{ name: "json.decoder", typeCode: 0, body }],
    }),
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok || parsed.value.kind !== "entries") return;
  expect(parsed.value.pythonVersion).toBe("3.9");
  expect(parsed.value.entries).toMatchObject([
    { name: "json.decoder", typeCode: 0, package: false },
  ]);

  const opaque = parsePyzArchive(
    pyzArchive({
      magic: Buffer.alloc(4),
      modules: [{ name: "json.decoder", typeCode: 0, body }],
    }),
  );
  expect(opaque.ok).toBe(true);
  if (!opaque.ok || opaque.value.kind !== "opaque") return;
  expect(opaque.value.limitation).toContain("left opaque");
});

it("leaves a PYZ opaque when the table uses an unsupported marshal type", () => {
  const image = pyzArchive({
    magic: PYTHON_39_MAGIC,
    modules: [],
    toc: Buffer.from([0x4e]),
  });
  const parsed = parsePyzArchive(image);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok || parsed.value.kind !== "opaque") return;
  expect(parsed.value.limitation).toContain("left opaque");
  expect(parsed.value.pythonMagic).toEqual(PYTHON_39_MAGIC);
});

it("reports an entry that extends outside the PYZ as an integrity error", () => {
  const image = pyzArchive({
    magic: PYTHON_39_MAGIC,
    modules: [{ name: "missing", typeCode: 0, body: Buffer.from("x") }],
  });
  image.writeInt32LE(100_000, image.length - 4);
  const parsed = parsePyzArchive(image);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.error.reason).toBe("integrity");
});

it("stops a zlib stream that expands past the supplied output bound", async () => {
  const inflated = await inflateBounded(
    deflateSync(Buffer.from("hello world hello world")),
    4,
  );
  expect(inflated.ok).toBe(false);
  if (inflated.ok) return;
  expect(inflated.error.reason).toBe("limit");
});
