import type { Readable } from "node:stream";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
} from "../artifacts/ArtifactReader.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { ZipArtifactReader } from "../artifacts/ZipArtifactReader.js";
import type { JavaArchive } from "../domain/java/javaArchive.js";
import { hasZipSignature } from "../domain/zipPackageFormat.js";

/** Resource guards; these bound allocation, not operating-system memory. */
export const JAVA_ARCHIVE_LIMITS = Object.freeze({
  inputBytes: 512 * 1024 * 1024,
  entries: 200_000,
  classBytes: 16 * 1024 * 1024,
  totalClassBytes: 512 * 1024 * 1024,
  metadataBytes: 64 * 1024,
  // Signed JAR manifests list a digest per entry after the main section.
  manifestBytes: 16 * 1024 * 1024,
  metadataFiles: 64,
});

/** The selected bytes are neither a ZIP-backed Java archive nor a class file. */
export class JavaArchiveFormatFailure extends Error {
  override readonly name = "JavaArchiveFormatFailure";
  constructor(
    readonly kind: "unsupported" | "malformed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** A guard stopped work before allocating more than its declared budget. */
export class JavaArchiveResourceFailure extends Error {
  override readonly name = "JavaArchiveResourceFailure";
  constructor(
    readonly boundary: string,
    readonly maximum: number,
    message: string,
  ) {
    super(message);
  }
}

/** Exact selected bytes, admitted once so every later fact describes the same digest. */
export interface JavaInputSnapshot {
  readonly path: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly container: "jar" | "class";
}

/** Reported identity of the exact admitted bytes. */
export const javaArtifactIdentity = (snapshot: JavaInputSnapshot) => ({
  path: snapshot.path,
  sha256: snapshot.sha256,
  bytes: snapshot.bytes.length,
  container: snapshot.container,
});

/** Read and classify by content: class-file magic, else ZIP signature. */
export const admitJavaInput = async (
  path: string,
  signal?: AbortSignal,
): Promise<JavaInputSnapshot> => {
  const { bytes, sha256 } = await readStableArtifact(
    path,
    JAVA_ARCHIVE_LIMITS.inputBytes,
    signal,
  );
  // Universal Mach-O shares this magic; its next word is a small slice count,
  // where a class file carries minor/major versions with major >= 45.
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0xcafebabe)
    if (bytes.readUInt16BE(6) >= 45)
      return { path, bytes, sha256, container: "class" };
    else
      throw new JavaArchiveFormatFailure(
        "unsupported",
        "0xCAFEBABE with a class-file major version below 45 is a universal Mach-O header, not a JVM class file.",
      );
  if (hasZipSignature(bytes)) return { path, bytes, sha256, container: "jar" };
  throw new JavaArchiveFormatFailure(
    "unsupported",
    "Expected a JVM class file (0xCAFEBABE) or a ZIP-backed archive such as a JAR.",
  );
};

const readBounded = async (
  stream: Readable,
  maximum: number,
  entry: string,
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const bytes = chunk as Buffer;
      total += bytes.length;
      if (total > maximum)
        throw new JavaArchiveResourceFailure(
          "entry_bytes",
          maximum,
          `Archive entry ${entry} exceeds ${String(maximum)} decompressed bytes.`,
        );
      chunks.push(bytes);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks, total);
};

/** One open archive view over admitted bytes; closing releases only zip.js state. */
export class JavaArchiveEntries {
  readonly #reader: ZipArtifactReader;
  #entries: ArtifactEntry[] | undefined;
  #classBytes = 0;
  readonly #countedClasses = new Set<string>();

  constructor(snapshot: JavaInputSnapshot) {
    this.#reader = new ZipArtifactReader(snapshot.bytes, "zip");
  }

  /** Enumerate central-directory occurrences once, bounded by entry count. */
  async list(signal?: AbortSignal): Promise<readonly ArtifactEntry[]> {
    if (this.#entries !== undefined) return this.#entries;
    const entries: ArtifactEntry[] = [];
    try {
      for await (const entry of this.#reader.entries(signal)) {
        if (entries.length >= JAVA_ARCHIVE_LIMITS.entries)
          throw new JavaArchiveResourceFailure(
            "entries",
            JAVA_ARCHIVE_LIMITS.entries,
            `Archive has more than ${String(JAVA_ARCHIVE_LIMITS.entries)} entries.`,
          );
        entries.push(entry);
      }
    } catch (cause: unknown) {
      if (cause instanceof ArtifactReaderFailure && cause.reason === "format")
        throw new JavaArchiveFormatFailure("malformed", cause.message, {
          cause,
        });
      throw cause;
    }
    this.#entries = entries;
    return entries;
  }

  /** Read one entry; each stable class occurrence contributes once to the total. */
  async read(
    entry: ArtifactEntry,
    maximum: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const bytes = await readBounded(
      await this.#reader.open(entry, signal),
      maximum,
      entry.path,
    );
    if (
      entry.path.endsWith(".class") &&
      !this.#countedClasses.has(entry.adapterKey)
    ) {
      this.#classBytes += bytes.length;
      if (this.#classBytes > JAVA_ARCHIVE_LIMITS.totalClassBytes)
        throw new JavaArchiveResourceFailure(
          "total_class_bytes",
          JAVA_ARCHIVE_LIMITS.totalClassBytes,
          `Decompressed class bytes exceed ${String(JAVA_ARCHIVE_LIMITS.totalClassBytes)} bytes.`,
        );
      this.#countedClasses.add(entry.adapterKey);
    }
    return bytes;
  }

  /** Acquire only a bounded descriptor prefix, then cancel the unread stream. */
  async readPrefix(
    entry: ArtifactEntry,
    maximum: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const stream = await this.#reader.open(entry, signal);
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of stream) {
        signal?.throwIfAborted();
        const bytes = chunk as Buffer;
        const retained = bytes.subarray(0, maximum - total);
        chunks.push(retained);
        total += retained.length;
        if (total === maximum) break;
      }
    } finally {
      stream.destroy();
    }
    return Buffer.concat(chunks, total);
  }

  close(): Promise<void> {
    return this.#reader.close();
  }
}

/** Regular, unencrypted class-file occurrences. */
export const isClassEntry = (entry: ArtifactEntry): boolean =>
  entry.kind === "file" && !entry.encrypted && entry.path.endsWith(".class");

type MetadataKind = JavaArchive["metadata_files"][number]["kind"];

/** Recognized framework descriptors by exact archive path. */
export const metadataKindFor = (path: string): MetadataKind | undefined => {
  switch (path) {
    case "mcmod.info":
      return "forge-mcmod-info";
    case "META-INF/mods.toml":
    case "META-INF/neoforge.mods.toml":
      return "forge-mods-toml";
    case "fabric.mod.json":
      return "fabric-mod-json";
    case "quilt.mod.json":
      return "quilt-mod-json";
    case "plugin.yml":
    case "paper-plugin.yml":
      return "bukkit-plugin-yml";
    case "bungee.yml":
      return "bungee-plugin-yml";
    case "velocity-plugin.json":
      return "velocity-plugin-json";
    case "BOOT-INF/layers.idx":
      return "spring-boot-layers";
    default:
      return /^META-INF\/services\/[^/]+$/u.test(path)
        ? "service-provider"
        : undefined;
  }
};

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/** Decode a bounded descriptor prefix; non-UTF-8 text is unknown rather than guessed. */
export const metadataText = (
  bytes: Buffer,
  declaredSize: number | null,
): { text: string | null; truncated: boolean } => {
  const truncated =
    bytes.length > JAVA_ARCHIVE_LIMITS.metadataBytes ||
    (declaredSize ?? 0) > JAVA_ARCHIVE_LIMITS.metadataBytes;
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, JAVA_ARCHIVE_LIMITS.metadataBytes),
        { stream: truncated },
      ),
      truncated,
    };
  } catch {
    return { text: null, truncated };
  }
};

/** Parse the JAR manifest main section (JAR File Specification, 72-byte continuations). */
export const parseManifestMainSection = (
  bytes: Buffer,
): NonNullable<JavaArchive["manifest"]> => {
  // The manifest's 72-byte wrapping may split a UTF-8 character. Unfold
  // physical bytes before asking the UTF-8 decoder to interpret a header.
  const lines: Buffer[][] = [];
  for (let start = 0; start < bytes.length;) {
    let end = start;
    while (end < bytes.length && bytes[end] !== 10 && bytes[end] !== 13)
      end += 1;
    const line = bytes.subarray(start, end);
    start = end + (bytes[end] === 13 && bytes[end + 1] === 10 ? 2 : 1);
    if (line.length === 0) break;
    if (line[0] === 32 && lines.length > 0)
      lines.at(-1)!.push(line.subarray(1));
    else lines.push([line]);
  }
  const attributes: { name: string; value: string }[] = [];
  for (const chunks of lines) {
    let line: string;
    try {
      line = STRICT_UTF8.decode(Buffer.concat(chunks));
    } catch (cause: unknown) {
      throw new JavaArchiveFormatFailure(
        "malformed",
        "META-INF/MANIFEST.MF is not valid UTF-8.",
        { cause },
      );
    }
    const separator = line.indexOf(": ");
    if (separator <= 0)
      throw new JavaArchiveFormatFailure(
        "malformed",
        `META-INF/MANIFEST.MF has a malformed header line: ${JSON.stringify(line.slice(0, 80))}.`,
      );
    attributes.push({
      name: line.slice(0, separator),
      value: line.slice(separator + 2),
    });
  }
  return {
    attributes,
    main_class:
      attributes.find(({ name }) => name.toLowerCase() === "main-class")
        ?.value ?? null,
  };
};
