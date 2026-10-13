import { describe, expect, it } from "vitest";
import { parseExecutableHeader } from "./binaryTarget.js";
import { parsePsxExeHeader } from "./psxExe.js";

const fixture = (): Buffer => {
  const bytes = Buffer.alloc(4096);
  bytes.write("PS-X EXE");
  bytes.writeUInt32LE(0x80010010, 0x10);
  bytes.writeUInt32LE(0x80010000, 0x18);
  bytes.writeUInt32LE(2048, 0x1c);
  bytes.writeUInt32LE(0x801fff00, 0x30);
  bytes.writeUInt32LE(0xf0, 0x34);
  return bytes;
};

describe("PS-X EXE declarations", () => {
  it("recognizes content without a filename and preserves distinct load, entry and stack fields", () => {
    const result = parseExecutableHeader(fixture(), "arm64");
    if (!result.ok) throw new Error(result.error);
    expect(result.value).toMatchObject({
      format: "psx-exe",
      architecture: "mips",
      psx: {
        loadAddress: 0x80010000,
        entryPoint: 0x80010010,
        payloadSize: 2048,
        stackBase: 0x801fff00,
        stackOffset: 0xf0,
      },
    });
  });
  it("rejects BSS that aliases initialized payload through KSEG1", () => {
    const bytes = fixture();
    bytes.writeUInt32LE(0xa0010010, 0x28);
    bytes.writeUInt32LE(64, 0x2c);
    expect(parsePsxExeHeader(bytes, bytes.length).ok).toBe(false);
  });
  it("checks full file size independently from header probe size", () => {
    const bytes = fixture().subarray(0, 2048);
    expect(parsePsxExeHeader(bytes, 4096).ok).toBe(true);
    expect(parsePsxExeHeader(bytes, 4095).ok).toBe(false);
    expect(parsePsxExeHeader(bytes.subarray(0, 2047), 4096).ok).toBe(false);
  });
  it.each([
    [0x1c, 0],
    [0x1c, 0xffffffff],
    [0x18, 0xfffffff0],
    [0x10, 0x80010001],
    [0x10, 0x80010800],
    [0x18, 0x1f800000],
    [0x34, 0xffffffff],
  ])("rejects invalid field at %i", (offset, value) => {
    const bytes = fixture();
    bytes.writeUInt32LE(value, offset);
    expect(parsePsxExeHeader(bytes, bytes.length).ok).toBe(false);
  });
  it("rejects overlapping BSS and retains a valid disjoint BSS declaration", () => {
    const bytes = fixture();
    bytes.writeUInt32LE(0x80010010, 0x28);
    bytes.writeUInt32LE(64, 0x2c);
    expect(parsePsxExeHeader(bytes, bytes.length).ok).toBe(false);
    bytes.writeUInt32LE(0x80010800, 0x28);
    const result = parsePsxExeHeader(bytes, bytes.length);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.bssSize).toBe(64);
  });
});

it("rejects high-bit signature aliases in both parsers and inventory", () => {
  const bytes = fixture();
  Buffer.from("d0d3add8a0c5d8c5", "hex").copy(bytes);
  expect(parsePsxExeHeader(bytes, bytes.length).ok).toBe(false);
  expect(parseExecutableHeader(bytes, "arm64").ok).toBe(false);
});
it("retains PS-X identity in artifact inventory and bounds unused trailing sectors", () => {
  const bytes = fixture();
  expect(parsePsxExeHeader(bytes, 4097).ok).toBe(false);
  bytes.writeUInt32LE(1025, 0x1c);
  expect(parsePsxExeHeader(bytes, 4096).ok).toBe(true);
  expect(parsePsxExeHeader(bytes, 4097).ok).toBe(false);
  expect(parsePsxExeHeader(bytes, 0x100000000).ok).toBe(false);
});

it.each([1, 2, 3, 1025])(
  "rejects an entry shorter than one instruction with payload %i",
  (payload) => {
    const bytes = fixture();
    bytes.writeUInt32LE(payload, 0x1c);
    bytes.writeUInt32LE(0x80010000 + (payload === 1025 ? 1024 : 0), 0x10);
    expect(parsePsxExeHeader(bytes, bytes.length).ok).toBe(false);
  },
);
