import { copyArtifactEntry, type ArtifactEntry } from "../ArtifactReader.js";
import type { CArchiveEntry, PyInstallerCookie } from "./CArchiveLayout.js";
import type { PyzArchive, PyzEntry } from "./PyzArchive.js";
import {
  RECONSTRUCTED_PYTHON_HEADER_LIMITATION,
  reconstructedPycHeader,
} from "./PythonBytecode.js";
import { formatPythonCookieVersion } from "./PythonBytecode.js";

const CRYPTO_KEY_NAME = "pyimod00_crypto_key";

/** Stable entry descriptions and bounded read plans; expanded member bytes are never retained. */
export interface PyInstallerMember {
  readonly entry: ArtifactEntry;
  readonly read:
    | {
        readonly kind: "carchive";
        readonly archiveStart: number;
        readonly source: CArchiveEntry;
        readonly header: Buffer | undefined;
      }
    | {
        readonly kind: "pyz";
        readonly compressed: Buffer;
        readonly header: Buffer | undefined;
      }
    | undefined;
}

/** Facts observed from the cookie. The root occurrence records them. */
export const cookieFacts = (cookie: PyInstallerCookie): readonly string[] => [
  `PyInstaller CArchive layout ${cookie.layout}.`,
  `Python version ${formatPythonCookieVersion(cookie.pythonVersion)}.`,
  cookie.pythonLibrary === null
    ? "Python library is unknown."
    : `Python library ${cookie.pythonLibrary}.`,
];

export const archiveUsesEncryption = (
  entries: readonly CArchiveEntry[],
): boolean => entries.some((entry) => entry.name === CRYPTO_KEY_NAME);

export const projectStoredMember = (
  entry: CArchiveEntry,
  archiveStart: number,
  pythonMagic: Buffer | undefined,
): PyInstallerMember => {
  const header =
    pythonMagic !== undefined && isBytecodeType(entry.typeCode)
      ? reconstructedPycHeader(pythonMagic)
      : undefined;
  const named = canonicalMemberName(entry.name);
  const symlink = entry.typeCode === "n";
  const limitations = memberLimitations(entry.typeCode, entry.compressionFlag);
  limitations.push(...originalNameLimitation(named.original));
  if (symlink) limitations.push("PyInstaller symlink target was not read.");
  if (header !== undefined)
    limitations.push(RECONSTRUCTED_PYTHON_HEADER_LIMITATION);
  const declaredSize = entry.uncompressedSize;
  return {
    entry: fileEntry({
      path: named.path,
      kind: symlink ? "symlink" : "file",
      declaredSize,
      compressedSize: entry.compressedSize,
      byteOffset: sourceByteOffset(
        archiveStart + entry.offset,
        declaredSize,
        entry.compressedSize,
      ),
      limitations,
      adapterKey: `carchive:${entry.name}`,
    }),
    read: {
      kind: "carchive",
      archiveStart,
      source: entry,
      header,
    },
  };
};

export const projectPyzContainer = (
  entry: CArchiveEntry,
  archiveStart: number,
  archive: PyzArchive,
  encrypted: boolean,
): PyInstallerMember => {
  const named = canonicalMemberName(entry.name);
  const byteOffset = sourceByteOffset(
    archiveStart + entry.offset,
    entry.uncompressedSize,
    entry.compressedSize,
  );
  const limitations = [
    ...memberLimitations(entry.typeCode, entry.compressionFlag),
    ...originalNameLimitation(named.original),
  ];
  if (archive.kind === "opaque")
    return {
      entry: fileEntry({
        path: named.path,
        declaredSize: entry.uncompressedSize,
        compressedSize: entry.compressedSize,
        byteOffset,
        encrypted,
        limitations: [
          ...limitations,
          archive.limitation,
          ...(encrypted
            ? ["PYZ entries are encrypted and were not decoded."]
            : []),
        ],
        adapterKey: `carchive:${entry.name}`,
      }),
      read: {
        kind: "carchive",
        archiveStart,
        source: entry,
        header: undefined,
      },
    };
  return {
    entry: {
      path: named.path,
      kind: "directory",
      declaredSize: entry.uncompressedSize,
      compressedSize: entry.compressedSize,
      executable: false,
      encrypted: false,
      byteOffset,
      declaredSha256: null,
      unpacked: false,
      limitations: [
        ...limitations,
        `PyInstaller PYZ sha256 ${archive.sha256}.`,
        ...(encrypted
          ? ["PYZ entries are encrypted and were not decoded."]
          : []),
      ],
      adapterKey: `carchive:${entry.name}`,
    },
    read: undefined,
  };
};

export const projectPyzMember = (
  container: CArchiveEntry,
  item: PyzEntry,
  encrypted: boolean,
  pythonMagic: Buffer | undefined,
  compressed: Buffer | undefined,
): PyInstallerMember => {
  const located = pyzMemberLocation(
    canonicalMemberName(container.name).path,
    item,
  );
  if (item.namespace)
    return {
      entry: {
        path: located.path,
        kind: "directory",
        declaredSize: 0,
        compressedSize: 0,
        executable: false,
        encrypted: false,
        byteOffset: null,
        declaredSha256: null,
        unpacked: false,
        limitations: [
          "PyInstaller PYZ type 3.",
          "Namespace package has no bytecode.",
          ...originalNameLimitation(located.original),
        ],
        adapterKey: `pyz:${located.path}`,
      },
      read: undefined,
    };
  const header =
    !encrypted &&
    pythonMagic !== undefined &&
    (item.typeCode === 0 || item.typeCode === 1)
      ? reconstructedPycHeader(pythonMagic)
      : undefined;
  const limitations = [
    `PyInstaller PYZ type ${String(item.typeCode)}.`,
    "PyInstaller compression flag 1.",
  ];
  if (encrypted)
    limitations.push("PYZ entry is encrypted and was not decoded.");
  if (header !== undefined)
    limitations.push(RECONSTRUCTED_PYTHON_HEADER_LIMITATION);
  limitations.push(
    "PYZ tables declare compressed lengths; the uncompressed size is unknown until decoding.",
    ...originalNameLimitation(located.original),
  );
  return {
    entry: fileEntry({
      path: located.path,
      declaredSize: null,
      compressedSize: item.length,
      byteOffset: null,
      encrypted,
      limitations,
      adapterKey: `pyz:${located.path}`,
    }),
    read:
      compressed === undefined
        ? undefined
        : { kind: "pyz", compressed, header },
  };
};

/**
 * CArchive and PYZ data names treat `\` as a separator. The logical path is
 * canonical; the stored spelling is kept when that conversion changes it.
 * `source_location` is an offset plus declared size, so a compressed member
 * publishes a file span only when that size is the physical extent. Otherwise
 * the span stays unknown, as ZIP does for compressed entries.
 */
const canonicalMemberName = (
  storedName: string,
): { readonly path: string; readonly original: string | undefined } => {
  const path = storedName.replaceAll("\\", "/");
  return { path, original: path === storedName ? undefined : storedName };
};

const originalNameLimitation = (original: string | undefined): string[] =>
  original === undefined
    ? []
    : [`Stored PyInstaller member name: ${JSON.stringify(original)}.`];

const sourceByteOffset = (
  absoluteOffset: number,
  declaredSize: number,
  physicalLength: number,
): number | null => (declaredSize === physicalLength ? absoluteOffset : null);

const pyzMemberLocation = (
  container: string,
  item: PyzEntry,
): { readonly path: string; readonly original: string | undefined } => {
  // Type 2 names are resource paths, not dotted module names.
  if (item.typeCode === 2) {
    const named = canonicalMemberName(item.name);
    return { path: `${container}/${named.path}`, original: named.original };
  }
  const dotted = item.name.replaceAll(".", "/");
  if (item.namespace)
    return { path: `${container}/${dotted}`, original: undefined };
  if (item.package)
    return { path: `${container}/${dotted}/__init__.pyc`, original: undefined };
  return { path: `${container}/${dotted}.pyc`, original: undefined };
};

const isBytecodeType = (typeCode: string): boolean =>
  typeCode === "s" || typeCode === "m" || typeCode === "M";

const memberLimitations = (
  typeCode: string,
  compressionFlag: number,
): string[] => [
  `PyInstaller type code ${typeCode}.`,
  `PyInstaller compression flag ${String(compressionFlag)}.`,
];

const fileEntry = (input: {
  readonly path: string;
  readonly declaredSize: number | null;
  readonly compressedSize: number;
  readonly byteOffset: number | null;
  readonly limitations: readonly string[];
  readonly adapterKey: string;
  readonly encrypted?: boolean;
  readonly kind?: "file" | "symlink";
}): ArtifactEntry => ({
  path: input.path,
  kind: input.kind ?? "file",
  declaredSize: input.declaredSize,
  compressedSize: input.compressedSize,
  executable: false,
  encrypted: input.encrypted === true,
  byteOffset: input.byteOffset,
  declaredSha256: null,
  unpacked: false,
  limitations: input.limitations,
  adapterKey: input.adapterKey,
});

/** Stable entry stored for a later open(). */
export const sealMember = (member: PyInstallerMember): PyInstallerMember => ({
  ...member,
  entry: copyArtifactEntry(member.entry),
});
