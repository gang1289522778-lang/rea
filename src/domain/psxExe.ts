import { err, ok, type Result } from "./result.js";

/** Exact signature shared by target resolution and artifact inventory. */
export const hasPsxExeSignature = (bytes: Buffer): boolean =>
  bytes.subarray(0, 8).equals(Buffer.from("PS-X EXE", "ascii"));

/** Little-endian PS-X EXE declarations; these do not describe runtime overlays. */
export interface PsxExeHeader {
  readonly entryPoint: number;
  readonly globalPointer: number;
  readonly loadAddress: number;
  readonly payloadSize: number;
  readonly dataAddress: number;
  readonly dataSize: number;
  readonly bssAddress: number;
  readonly bssSize: number;
  readonly stackBase: number;
  readonly stackOffset: number;
}

/** Parse the complete header while checking extents against the original file. */
export const parsePsxExeHeader = (
  bytes: Buffer,
  fileSize: number,
): Result<PsxExeHeader, string> => {
  if (bytes.length < 0x800 || !hasPsxExeSignature(bytes))
    return err("truncated or invalid PS-X EXE header");
  const header: PsxExeHeader = {
    entryPoint: bytes.readUInt32LE(0x10),
    globalPointer: bytes.readUInt32LE(0x14),
    loadAddress: bytes.readUInt32LE(0x18),
    payloadSize: bytes.readUInt32LE(0x1c),
    dataAddress: bytes.readUInt32LE(0x20),
    dataSize: bytes.readUInt32LE(0x24),
    bssAddress: bytes.readUInt32LE(0x28),
    bssSize: bytes.readUInt32LE(0x2c),
    stackBase: bytes.readUInt32LE(0x30),
    stackOffset: bytes.readUInt32LE(0x34),
  };
  if (
    !Number.isSafeInteger(fileSize) ||
    header.payloadSize === 0 ||
    0x800 + header.payloadSize > fileSize
  )
    return err("PS-X EXE payload is empty or extends beyond the file");
  // PS-X EXEs are 2048-byte sectors: retain at most the final sector's padding.
  const maximumSourceBytes =
    Math.ceil((0x800 + header.payloadSize) / 0x800) * 0x800;
  if (fileSize > maximumSourceBytes)
    return err(
      "PS-X EXE source exceeds the declared payload and final 2048-byte sector padding",
    );
  const end = header.loadAddress + header.payloadSize;
  if (
    end > 0x100000000 ||
    header.bssAddress + header.bssSize > 0x100000000 ||
    (header.stackBase !== 0 &&
      header.stackBase + header.stackOffset > 0xffffffff)
  )
    return err("PS-X EXE address range exceeds the 32-bit address space");
  if (
    header.entryPoint % 4 !== 0 ||
    header.loadAddress % 4 !== 0 ||
    header.entryPoint < header.loadAddress ||
    header.entryPoint + 4 > end
  )
    return err(
      "PS-X EXE entry must be aligned and lie inside the aligned loaded payload",
    );
  // This loader models original PlayStation main RAM, including its cached and uncached aliases.
  const ramRange = (address: number, size: number): boolean => {
    const base =
      address >= 0xa0000000
        ? 0xa0000000
        : address >= 0x80000000
          ? 0x80000000
          : 0;
    return address - base < 0x200000 && address - base + size <= 0x200000;
  };
  if (
    !ramRange(header.loadAddress, header.payloadSize) ||
    (header.bssSize !== 0 && !ramRange(header.bssAddress, header.bssSize))
  )
    return err(
      "PS-X EXE load and BSS ranges must fit original PlayStation 2 MiB main RAM",
    );
  // Cached and uncached addresses can name the same physical RAM.
  const physicalLoad = header.loadAddress % 0x20000000;
  const physicalBss = header.bssAddress % 0x20000000;
  if (
    header.bssSize !== 0 &&
    physicalBss < physicalLoad + header.payloadSize &&
    physicalBss + header.bssSize > physicalLoad
  )
    return err("PS-X EXE BSS overlaps the loaded payload through a RAM alias");
  return ok(header);
};
