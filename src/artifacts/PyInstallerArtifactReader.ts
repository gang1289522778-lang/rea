import { Readable } from "node:stream";
import { lstat, type FileHandle } from "node:fs/promises";

import { artifactDecompressionBudgetBytes } from "../domain/artifactDecompressionBudget.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import {
  NonRegularFileReadError,
  RegularFileAdmissionFailure,
  openRegularFile,
  sameRegularFileState,
  type StableRegularFileDescriptor,
} from "../filesystem/RegularFile.js";
import {
  ArtifactReaderFailure,
  sameArtifactEntry,
  type ArtifactEntry,
  type ArtifactReader,
} from "./ArtifactReader.js";
import { abortIfNeeded } from "./ArtifactHash.js";
import {
  findPyInstallerCookie,
  readCArchiveToc,
  type CArchiveEntry,
  type PyInstallerCookie,
} from "./pyinstaller/CArchiveLayout.js";
import {
  archiveUsesEncryption,
  cookieFacts,
  projectPyzContainer,
  projectPyzMember,
  projectStoredMember,
  sealMember,
  type PyInstallerMember,
} from "./pyinstaller/CArchiveMembers.js";
import {
  inflateBounded,
  parsePyzArchive,
  type PyzArchive,
} from "./pyinstaller/PyzArchive.js";
import type { PyInstallerFailure } from "./pyinstaller/PyInstallerFailure.js";

interface PyzImage {
  readonly archive: PyzArchive;
  readonly bytes: Buffer;
}

interface LoadedArchive {
  readonly members: readonly PyInstallerMember[];
}

/**
 * Read-only inventory of a PyInstaller CArchive appended to a native executable.
 * Encrypted PYZ entries are reported and not decoded. Code members are not decompiled.
 */
export class PyInstallerArtifactReader implements ArtifactReader {
  readonly format = "pyinstaller" as const;
  #owner: OwnedFileHandle | undefined;
  #source: StableRegularFileDescriptor | undefined;
  #closed = false;
  #loaded: Promise<LoadedArchive> | undefined;
  #budget = 0;
  #charged = 0;
  #facts: readonly string[] = [];
  readonly #members = new Map<string, PyInstallerMember>();
  readonly #openedPyzSizes = new Map<string, number>();

  constructor(
    private readonly path: string,
    source?: StableRegularFileDescriptor,
  ) {
    this.#source = source;
  }

  /** Cookie facts. Empty until entries() has parsed the archive. */
  observedFacts(): readonly string[] {
    return this.#facts;
  }

  async *entries(signal?: AbortSignal): AsyncIterable<ArtifactEntry> {
    const loaded = await this.#load(signal);
    await this.#verifySource();
    this.#members.clear();
    for (const member of loaded.members) {
      abortIfNeeded(signal);
      const sealed = sealMember(member);
      this.#members.set(sealed.entry.adapterKey, sealed);
      yield sealed.entry;
    }
  }

  async open(entry: ArtifactEntry, signal?: AbortSignal): Promise<Readable> {
    abortIfNeeded(signal);
    const stored = this.#members.get(entry.adapterKey);
    if (stored === undefined || !sameArtifactEntry(entry, stored.entry))
      throw new ArtifactReaderFailure(
        "integrity",
        `PyInstaller entry was not produced by this reader: ${entry.path}`,
      );
    if (entry.kind !== "file")
      throw new ArtifactReaderFailure(
        "format",
        `PyInstaller entry is not a regular file: ${entry.path}`,
      );
    if (entry.encrypted)
      throw new ArtifactReaderFailure(
        "unavailable",
        `PYZ entry is encrypted and was not decoded: ${entry.path}`,
      );
    const read = stored.read;
    if (read === undefined)
      throw new ArtifactReaderFailure(
        "format",
        `PyInstaller entry has no readable bytes: ${entry.path}`,
      );
    await this.#verifySource();
    const bytes = await this.#inflateMember(
      read,
      stored.entry.adapterKey,
      signal,
    );
    await this.#verifySource();
    return Readable.from(bytes);
  }

  provenance(): readonly [] {
    return [];
  }

  async close(): Promise<void> {
    await this.#owner?.close();
    this.#owner = undefined;
    this.#source = undefined;
    this.#closed = true;
    this.#loaded = undefined;
    this.#members.clear();
    this.#openedPyzSizes.clear();
  }

  async #load(signal?: AbortSignal): Promise<LoadedArchive> {
    this.#loaded ??= this.#parse(signal);
    return this.#loaded;
  }

  async #parse(signal?: AbortSignal): Promise<LoadedArchive> {
    const handle = await this.#openHandle(signal);
    await this.#verifySource();
    const size = (await handle.stat()).size;
    this.#budget = artifactDecompressionBudgetBytes(size);
    const cookie = await this.#cookie(handle, size);
    const toc = await this.#toc(handle, cookie);
    for (const entry of toc) this.#charge(entry.uncompressedSize);
    assertMemberRanges(toc, cookie.tocOffset);
    const images = await this.#pyzImages(handle, cookie, toc, signal);
    const magic = firstPythonMagic(images);
    const encrypted = archiveUsesEncryption(toc);
    const members = this.#project(
      toc,
      cookie,
      images,
      magic,
      encrypted,
      signal,
    );
    for (const member of members)
      if (member.read?.kind === "carchive")
        this.#charge(member.read.header?.length ?? 0);
    await this.#verifySource();
    this.#facts = cookieFacts(cookie);
    return { members };
  }

  async #openHandle(signal?: AbortSignal): Promise<FileHandle> {
    if (this.#closed)
      throw new ArtifactReaderFailure(
        "unavailable",
        "PyInstaller archive is closed",
      );
    if (this.#source !== undefined) return this.#source.handle;
    try {
      const handle = await openRegularFile(this.path, {
        symlinks: "reject",
        signal,
      });
      this.#owner = new OwnedFileHandle(handle);
      this.#source = { handle, initial: await handle.stat() };
      return handle;
    } catch (cause: unknown) {
      if (cause instanceof RegularFileAdmissionFailure)
        this.#owner = cause.owner;
      throw openFailure(this.path, cause);
    }
  }

  async #cookie(handle: FileHandle, size: number): Promise<PyInstallerCookie> {
    const found = await findPyInstallerCookie(handle, size);
    if (found === undefined)
      throw new ArtifactReaderFailure(
        "format",
        "PyInstaller CArchive cookie was not found",
      );
    if (!found.ok) throw failure(found.error);
    return found.value;
  }

  async #toc(
    handle: FileHandle,
    cookie: PyInstallerCookie,
  ): Promise<readonly CArchiveEntry[]> {
    const toc = await readCArchiveToc(handle, cookie);
    if (!toc.ok) throw failure(toc.error);
    return toc.value;
  }

  async #pyzImages(
    handle: FileHandle,
    cookie: PyInstallerCookie,
    toc: readonly CArchiveEntry[],
    signal: AbortSignal | undefined,
  ): Promise<ReadonlyMap<string, PyzImage>> {
    const images = new Map<string, PyzImage>();
    for (const entry of toc) {
      if (entry.typeCode !== "z") continue;
      abortIfNeeded(signal);
      const bytes = await this.#readDeclared(
        handle,
        cookie.archiveStart,
        entry,
      );
      const parsed = parsePyzArchive(bytes);
      if (!parsed.ok) throw failure(parsed.error);
      images.set(entry.name, { archive: parsed.value, bytes });
    }
    return images;
  }

  #project(
    toc: readonly CArchiveEntry[],
    cookie: PyInstallerCookie,
    images: ReadonlyMap<string, PyzImage>,
    magic: Buffer | undefined,
    encrypted: boolean,
    signal: AbortSignal | undefined,
  ): PyInstallerMember[] {
    const members: PyInstallerMember[] = [];
    for (const entry of toc) {
      abortIfNeeded(signal);
      const image = images.get(entry.name);
      if (image === undefined) {
        members.push(projectStoredMember(entry, cookie.archiveStart, magic));
        continue;
      }
      members.push(
        projectPyzContainer(
          entry,
          cookie.archiveStart,
          image.archive,
          encrypted,
        ),
      );
      if (image.archive.kind !== "entries") continue;
      for (const item of image.archive.entries)
        members.push(
          projectPyzMember(
            entry,
            item,
            encrypted,
            image.archive.pythonMagic,
            item.namespace || encrypted
              ? undefined
              : image.bytes.subarray(item.offset, item.offset + item.length),
          ),
        );
    }
    return members;
  }

  async #readDeclared(
    handle: FileHandle,
    archiveStart: number,
    entry: CArchiveEntry,
  ): Promise<Buffer> {
    const compressed = await readExact(
      handle,
      archiveStart + entry.offset,
      entry.compressedSize,
    );
    if (entry.compressionFlag === 0) {
      if (compressed.length !== entry.uncompressedSize)
        throw new ArtifactReaderFailure(
          "integrity",
          `Stored CArchive member size disagrees with its table entry: ${entry.name}`,
        );
      return compressed;
    }
    const inflated = await inflateBounded(compressed, entry.uncompressedSize);
    if (!inflated.ok) throw failure(inflated.error);
    if (inflated.value.length !== entry.uncompressedSize)
      throw new ArtifactReaderFailure(
        "integrity",
        `Decompressed CArchive member size disagrees with its table entry: ${entry.name}`,
      );
    return inflated.value;
  }

  async #inflateMember(
    read: NonNullable<PyInstallerMember["read"]>,
    adapterKey: string,
    signal: AbortSignal | undefined,
  ): Promise<Buffer> {
    abortIfNeeded(signal);
    if (read.kind === "pyz") {
      const previousSize = this.#openedPyzSizes.get(adapterKey);
      const remaining =
        previousSize ??
        this.#budget - this.#charged - (read.header?.length ?? 0);
      const inflated = await inflateBounded(read.compressed, remaining);
      if (!inflated.ok) throw failure(inflated.error);
      if (previousSize === undefined) {
        this.#charge(inflated.value.length + (read.header?.length ?? 0));
        this.#openedPyzSizes.set(adapterKey, inflated.value.length);
      }
      abortIfNeeded(signal);
      return read.header === undefined
        ? inflated.value
        : Buffer.concat([read.header, inflated.value]);
    }
    const handle = this.#source?.handle;
    if (handle === undefined)
      throw new ArtifactReaderFailure(
        "unavailable",
        "PyInstaller archive is closed",
      );
    const bytes = await this.#readDeclared(
      handle,
      read.archiveStart,
      read.source,
    );
    abortIfNeeded(signal);
    return read.header === undefined
      ? bytes
      : Buffer.concat([read.header, bytes]);
  }

  async #verifySource(): Promise<void> {
    const source = this.#source;
    if (source === undefined)
      throw new ArtifactReaderFailure(
        "unavailable",
        "PyInstaller archive is closed",
      );
    const [opened, currentPath] = await Promise.all([
      source.handle.stat(),
      lstat(this.path),
    ]);
    if (
      !sameRegularFileState(source.initial, opened) ||
      !sameRegularFileState(source.initial, currentPath)
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `PyInstaller source changed during reading: ${this.path}`,
      );
  }

  #charge(bytes: number): void {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      this.#charged + bytes > this.#budget
    )
      throw new ArtifactReaderFailure(
        "limit",
        `PyInstaller members declare ${String(this.#charged + Math.max(0, bytes))} uncompressed bytes, exceeding the decompression budget`,
      );
    this.#charged += bytes;
  }
}

const firstPythonMagic = (
  images: ReadonlyMap<string, PyzImage>,
): Buffer | undefined => {
  for (const image of images.values())
    if (image.archive.pythonMagic !== undefined)
      return image.archive.pythonMagic;
  return undefined;
};

const assertMemberRanges = (
  entries: readonly CArchiveEntry[],
  tocOffset: number,
): void => {
  for (const entry of entries)
    if (
      entry.compressionFlag === 0 &&
      entry.compressedSize !== entry.uncompressedSize
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `Stored CArchive member size disagrees with its table entry: ${entry.name}`,
      );
  const ranges = entries
    .filter((entry) => entry.compressedSize > 0)
    .map((entry) => ({
      name: entry.name,
      start: entry.offset,
      end: entry.offset + entry.compressedSize,
    }))
    .sort((left, right) => left.start - right.start);
  let occupied = 0;
  for (const range of ranges) {
    if (
      !Number.isSafeInteger(range.end) ||
      range.end > tocOffset ||
      range.start < occupied
    )
      throw new ArtifactReaderFailure(
        "integrity",
        `CArchive member extends outside the archive or overlaps another member: ${range.name}`,
      );
    occupied = range.end;
  }
  for (const entry of entries)
    if (entry.offset > tocOffset)
      throw new ArtifactReaderFailure(
        "format",
        `CArchive member offset is outside the archive: ${entry.name}`,
      );
};

const readExact = async (
  handle: FileHandle,
  position: number,
  size: number,
): Promise<Buffer> => {
  if (
    !Number.isSafeInteger(position) ||
    !Number.isSafeInteger(size) ||
    size < 0
  )
    throw new ArtifactReaderFailure(
      "format",
      "CArchive member range is invalid",
    );
  const bytes = Buffer.alloc(size);
  const read = await handle.read(bytes, 0, size, position);
  if (read.bytesRead !== size)
    throw new ArtifactReaderFailure(
      "format",
      "CArchive member extends outside the file",
    );
  return bytes;
};

const failure = (error: PyInstallerFailure): ArtifactReaderFailure =>
  new ArtifactReaderFailure(error.reason, error.message);

const openFailure = (path: string, cause: unknown): ArtifactReaderFailure => {
  if (cause instanceof ArtifactReaderFailure) return cause;
  if (cause instanceof RegularFileAdmissionFailure)
    return ArtifactReaderFailure.withCleanup(
      cause.cause instanceof NonRegularFileReadError
        ? new ArtifactReaderFailure(
            "format",
            `PyInstaller source is not a regular file: ${path}`,
            { cause: cause.cause },
          )
        : cause.cause,
      ArtifactReaderFailure.cleanupObservation(cause.cleanupCause, path),
    );
  if (cause instanceof NonRegularFileReadError)
    return new ArtifactReaderFailure(
      "format",
      `PyInstaller source is not a regular file: ${path}`,
      { cause },
    );
  return new ArtifactReaderFailure(
    "io",
    "PyInstaller archive could not be opened",
    {
      cause,
    },
  );
};
