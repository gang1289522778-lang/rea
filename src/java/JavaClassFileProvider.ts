import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { JavaArchivePort } from "../application/java/JavaArchivePort.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import {
  JAVA_CLASSFILE_PROVIDER_IDENTITY,
  javaClassEntryPath,
  javaVersionLabel,
  type InspectJavaArchiveInput,
  type JavaClassSelectionInput,
  type JavaArchive,
  type JavaClass,
  type JavaClassReport,
} from "../domain/java/javaArchive.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  javaArchiveFailure,
  missingJavaClass,
  type JavaOperation,
} from "./JavaArchiveFailures.js";
import {
  admitJavaInput,
  isClassEntry,
  JAVA_ARCHIVE_LIMITS,
  JavaArchiveEntries,
  JavaArchiveResourceFailure,
  javaArtifactIdentity,
  metadataKindFor,
  metadataText,
  parseManifestMainSection,
  type JavaInputSnapshot,
} from "./JavaArchiveReader.js";
import { JavaClassFormatFailure, parseJavaClassFile } from "./JavaClassFile.js";

const NATIVE_LIBRARY = /\.(?:so|dll|dylib|jnilib)$/iu;
const NESTED_ARCHIVE = /\.(?:jar|war|ear|zip)$/iu;
const SIGNATURE_FILE = /^META-INF\/[^/]+\.(?:SF|RSA|DSA|EC)$/iu;
const SHORT_NAME = 2;

const STRUCTURE_LIMITATION =
  "Class facts are parsed from declared class-file structure without executing, loading or verifying bytecode. Method bodies are measured but not decoded; use decompile_java_class for a source representation.";
const HEURISTIC_LIMITATION =
  "name_obfuscation is a naming heuristic over identifiers of two characters or fewer, not proof of obfuscation, of a specific obfuscator, or of string/flow protection. Original names removed by renaming are not recoverable from these bytes.";

const simpleNameIsShort = (binaryName: string): boolean => {
  const simple = binaryName.slice(binaryName.lastIndexOf("/") + 1);
  if (simple === "package-info" || simple === "module-info") return false;
  return simple.split("$").every((part) => part.length <= SHORT_NAME);
};

const memberNameIsShort = (name: string): boolean =>
  name !== "<init>" && name !== "<clinit>" && name.length <= SHORT_NAME;

const packageOf = (binaryName: string): string => {
  const slash = binaryName.lastIndexOf("/");
  return slash < 0 ? "" : binaryName.slice(0, slash).replaceAll("/", ".");
};

/** Format and resource guards apply equally to archives and single class files. */
const guardClassBytes = (bytes: Buffer): void => {
  if (bytes.length > JAVA_ARCHIVE_LIMITS.classBytes)
    throw new JavaArchiveResourceFailure(
      "class_bytes",
      JAVA_ARCHIVE_LIMITS.classBytes,
      `Class file exceeds ${String(JAVA_ARCHIVE_LIMITS.classBytes)} bytes.`,
    );
};

interface ArchiveClassFacts {
  readonly row: JavaArchive["classes"]["rows"][number];
  readonly members: number;
  readonly shortMembers: number;
}

const archiveClassFacts = (
  entry: string,
  parsed: JavaClass,
  entryId: string | null = null,
): ArchiveClassFacts => {
  let members = 0;
  let shortMembers = 0;
  for (const group of [parsed.fields, parsed.methods])
    for (const member of group) {
      if (member.name === "<init>" || member.name === "<clinit>") continue;
      members += 1;
      if (memberNameIsShort(member.name)) shortMembers += 1;
    }
  return {
    row: {
      entry,
      entry_id: entryId,
      name: parsed.name,
      access: parsed.access,
      super_class: parsed.super_class,
      interfaces: parsed.interfaces,
      major: parsed.major,
      fields: parsed.fields.length,
      methods: parsed.methods.length,
      source_file: parsed.source_file,
    },
    members,
    shortMembers,
  };
};

/** In-process class-file and JAR reader without subprocesses, temporary files or a JVM. */
export class JavaClassFileProvider implements Pick<
  JavaArchivePort,
  "inspectArchive" | "inspectClass"
> {
  readonly identity = JAVA_CLASSFILE_PROVIDER_IDENTITY;

  async inspectArchive(
    input: InspectJavaArchiveInput,
    options?: ExecutionOptions,
  ): Promise<Result<JavaArchive, AnalysisError>> {
    return this.#run("inspect_java_archive", input.path, options, (snapshot) =>
      snapshot.container === "class"
        ? this.#singleClassArchive(snapshot, input)
        : this.#archive(snapshot, input, options?.signal),
    );
  }

  async inspectClass(
    input: JavaClassSelectionInput,
    options?: ExecutionOptions,
  ): Promise<Result<JavaClassReport, AnalysisError>> {
    return this.#run(
      "inspect_java_class",
      input.path,
      options,
      async (snapshot) => {
        const selected = await selectJavaClass(
          "inspect_java_class",
          snapshot,
          input.class_name,
          options?.signal,
        );
        return {
          artifact: javaArtifactIdentity(snapshot),
          entry: selected.entry,
          entry_id: selected.entryId,
          class: selected.parsed,
          nested_class_entries: selected.nested.map(({ entry }) => entry),
          limitations: [STRUCTURE_LIMITATION],
        };
      },
    );
  }

  async #run<T>(
    operation: JavaOperation,
    path: string,
    options: ExecutionOptions | undefined,
    work: (snapshot: JavaInputSnapshot) => Promise<T> | T,
  ): Promise<Result<T, AnalysisError>> {
    try {
      const snapshot = await admitJavaInput(path, options?.signal);
      const value = await work(snapshot);
      options?.signal?.throwIfAborted();
      return ok(value);
    } catch (cause: unknown) {
      return err(
        javaArchiveFailure(
          operation,
          this.identity.id,
          cause,
          path,
          options?.signal,
        ),
      );
    }
  }

  #singleClassArchive(
    snapshot: JavaInputSnapshot,
    input: InspectJavaArchiveInput,
  ): JavaArchive {
    guardClassBytes(snapshot.bytes);
    const parsed = parseJavaClassFile(snapshot.bytes);
    return summarize(
      snapshot,
      input,
      [archiveClassFacts(snapshot.path, parsed)],
      {
        manifest: null,
        metadata_files: [],
        entries: {
          total: 1,
          classes: 1,
          resources: 0,
          directories: 0,
          encrypted: 0,
          native_libraries: [],
          nested_archives: [],
          signature_files: [],
        },
        malformed_classes: [],
      },
    );
  }

  async #archive(
    snapshot: JavaInputSnapshot,
    input: InspectJavaArchiveInput,
    signal?: AbortSignal,
  ): Promise<JavaArchive> {
    const archive = new JavaArchiveEntries(snapshot);
    try {
      const entries = await archive.list(signal);
      const counts: JavaArchive["entries"] = {
        total: entries.length,
        classes: 0,
        resources: 0,
        directories: 0,
        encrypted: 0,
        native_libraries: [],
        nested_archives: [],
        signature_files: [],
      };
      let manifest: JavaArchive["manifest"] = null;
      const metadata: JavaArchive["metadata_files"] = [];
      let omittedMetadata = 0;
      const classes: ArchiveClassFacts[] = [];
      const malformed: JavaArchive["malformed_classes"] = [];
      for (const entry of entries) {
        signal?.throwIfAborted();
        if (entry.encrypted) counts.encrypted += 1;
        if (entry.kind === "directory") {
          counts.directories += 1;
          continue;
        }
        if (isClassEntry(entry)) {
          counts.classes += 1;
          try {
            const bytes = await archive.read(
              entry,
              JAVA_ARCHIVE_LIMITS.classBytes,
              signal,
            );
            classes.push(
              archiveClassFacts(
                entry.path,
                parseJavaClassFile(bytes),
                entry.adapterKey,
              ),
            );
          } catch (cause: unknown) {
            if (!(cause instanceof JavaClassFormatFailure)) throw cause;
            malformed.push({ entry: entry.path, reason: cause.message });
          }
          continue;
        }
        counts.resources += 1;
        if (NATIVE_LIBRARY.test(entry.path))
          counts.native_libraries.push(entry.path);
        if (NESTED_ARCHIVE.test(entry.path))
          counts.nested_archives.push(entry.path);
        if (SIGNATURE_FILE.test(entry.path))
          counts.signature_files.push(entry.path);
        if (entry.kind !== "file" || entry.encrypted) continue;
        if (entry.path.toUpperCase() === "META-INF/MANIFEST.MF")
          manifest = parseManifestMainSection(
            await archive.read(
              entry,
              JAVA_ARCHIVE_LIMITS.manifestBytes,
              signal,
            ),
          );
        const kind = metadataKindFor(entry.path);
        if (kind !== undefined) {
          if (metadata.length >= JAVA_ARCHIVE_LIMITS.metadataFiles) {
            omittedMetadata += 1;
            continue;
          }
          const bytes = await archive.readPrefix(
            entry,
            JAVA_ARCHIVE_LIMITS.metadataBytes + 1,
            signal,
          );
          metadata.push({
            entry: entry.path,
            kind,
            ...metadataText(bytes, entry.declaredSize),
          });
        }
      }
      const report = summarize(snapshot, input, classes, {
        manifest,
        metadata_files: metadata,
        entries: counts,
        malformed_classes: malformed,
      });
      if (omittedMetadata > 0)
        report.limitations.push(
          `${String(omittedMetadata)} recognized metadata descriptors were omitted after the ${String(JAVA_ARCHIVE_LIMITS.metadataFiles)}-file resource limit; metadata_files is incomplete.`,
        );
      return report;
    } finally {
      await archive.close();
    }
  }
}

const summarize = (
  snapshot: JavaInputSnapshot,
  input: InspectJavaArchiveInput,
  classes: readonly ArchiveClassFacts[],
  observed: Pick<
    JavaArchive,
    "manifest" | "metadata_files" | "entries" | "malformed_classes"
  >,
): JavaArchive => {
  const versions = new Map<number, number>();
  const packages = new Map<string, { classes: number; short: number }>();
  let shortClasses = 0;
  let members = 0;
  let shortMembers = 0;
  for (const facts of classes) {
    const parsed = facts.row;
    versions.set(parsed.major, (versions.get(parsed.major) ?? 0) + 1);
    const shortClass = simpleNameIsShort(parsed.name);
    if (shortClass) shortClasses += 1;
    const name = packageOf(parsed.name);
    const row = packages.get(name) ?? { classes: 0, short: 0 };
    row.classes += 1;
    if (shortClass) row.short += 1;
    packages.set(name, row);
    members += facts.members;
    shortMembers += facts.shortMembers;
  }
  const limitations = [STRUCTURE_LIMITATION, HEURISTIC_LIMITATION];
  const packageRows = [...packages.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, row]) => ({
      name,
      classes: row.classes,
      short_name_classes: row.short,
    }));
  const rows = classes
    .filter(({ row }) =>
      input.query === undefined
        ? true
        : row.name.includes(input.query.replaceAll(".", "/")),
    )
    .sort((left, right) =>
      left.row.name < right.row.name
        ? -1
        : left.row.name > right.row.name
          ? 1
          : 0,
    );
  const page = rows.slice(input.offset, input.offset + input.limit);
  const signals: string[] = [];
  if (classes.length > 0)
    signals.push(
      `${String(shortClasses)} of ${String(classes.length)} classes have simple names of at most ${String(SHORT_NAME)} characters.`,
    );
  if (members > 0)
    signals.push(
      `${String(shortMembers)} of ${String(members)} fields and methods have names of at most ${String(SHORT_NAME)} characters.`,
    );
  const ratio = (part: number, whole: number) =>
    whole === 0 ? 0 : part / whole;
  return {
    artifact: javaArtifactIdentity(snapshot),
    ...observed,
    bytecode_versions: [...versions.entries()]
      .sort(([left], [right]) => left - right)
      .map(([major, count]) => ({
        major,
        java_version: javaVersionLabel(major),
        classes: count,
      })),
    packages: packageRows,
    name_obfuscation: {
      basis: "heuristic",
      assessment:
        classes.length < 5 && members < 20
          ? "insufficient-data"
          : ratio(shortClasses, classes.length) >= 0.5 ||
              ratio(shortMembers, members) >= 0.5
            ? "likely"
            : "not-indicated",
      short_class_names: shortClasses,
      short_member_names: shortMembers,
      member_names: members,
      signals,
    },
    classes: {
      query: input.query ?? null,
      offset: input.offset,
      limit: input.limit,
      total_matching: rows.length,
      next_offset:
        input.offset + page.length < rows.length
          ? input.offset + page.length
          : null,
      rows: page.map(({ row }) => row),
    },
    limitations,
  };
};

/** A selected class with the nested-class entries a decompiler needs alongside it. */
export interface SelectedJavaClass {
  readonly entryId: string | null;
  readonly entry: string | null;
  readonly parsed: JavaClass;
  readonly bytes: Buffer;
  readonly nested: readonly {
    readonly entry: string;
    readonly bytes: Buffer;
  }[];
}

/** Resolve one class by exact entry path; a lone .class file must match any requested name. */
export const selectJavaClass = async (
  operation: JavaOperation,
  snapshot: JavaInputSnapshot,
  className: string | undefined,
  signal?: AbortSignal,
): Promise<SelectedJavaClass> => {
  if (snapshot.container === "class") {
    guardClassBytes(snapshot.bytes);
    const parsed = parseJavaClassFile(snapshot.bytes);
    if (
      className !== undefined &&
      javaClassEntryPath(className) !== javaClassEntryPath(parsed.name)
    )
      throw new AnalysisInputError(operation, undefined, [
        {
          path: ["class_name"],
          reason: "invalid_value",
          message: `The selected class file declares ${parsed.name}, not ${className}. Omit class_name for a single class file.`,
        },
      ]);
    return {
      entry: null,
      entryId: null,
      parsed,
      bytes: snapshot.bytes,
      nested: [],
    };
  }
  if (className === undefined)
    throw new AnalysisInputError(operation, undefined, [
      {
        path: ["class_name"],
        reason: "missing_argument",
        message:
          "class_name is required for an archive. List names with inspect_java_archive.",
      },
    ]);
  const archive = new JavaArchiveEntries(snapshot);
  try {
    const entries = (await archive.list(signal)).filter(isClassEntry);
    const exact = /^zip-entry:[0-9]+$/u.test(className)
      ? entries.filter((entry) => entry.adapterKey === className)
      : className.endsWith(".class")
        ? entries.filter((entry) => entry.path === className)
        : [];
    if (className.startsWith("zip-entry:") && exact.length === 0)
      throw missingJavaClass(operation, className);
    if (exact.length > 1)
      throw new AnalysisInputError(operation, undefined, [
        {
          path: ["class_name"],
          reason: "invalid_value",
          message: `Archive entry ${className} is duplicated; select the unique entry_id returned by inspect_java_archive.`,
        },
      ]);
    let selected:
      | { entry: (typeof entries)[number]; bytes: Buffer; parsed: JavaClass }
      | undefined;
    if (exact.length === 1) {
      const entry = exact[0]!;
      const bytes = await archive.read(
        entry,
        JAVA_ARCHIVE_LIMITS.classBytes,
        signal,
      );
      selected = { entry, bytes, parsed: parseJavaClassFile(bytes) };
    } else {
      const wanted = javaClassEntryPath(className).slice(0, -".class".length);
      for (const entry of entries) {
        signal?.throwIfAborted();
        const bytes = await archive.read(
          entry,
          JAVA_ARCHIVE_LIMITS.classBytes,
          signal,
        );
        let parsed: JavaClass;
        try {
          parsed = parseJavaClassFile(bytes);
        } catch (cause) {
          if (cause instanceof JavaClassFormatFailure) {
            // A malformed matching coordinate is not proof of absence.
            if (
              entry.path === `${wanted}.class` ||
              entry.path === `BOOT-INF/classes/${wanted}.class` ||
              entry.path === `WEB-INF/classes/${wanted}.class` ||
              (/^META-INF\/versions\/[0-9]+\//u.test(entry.path) &&
                entry.path.replace(/^META-INF\/versions\/[0-9]+\//u, "") ===
                  `${wanted}.class`)
            )
              throw cause;
            continue;
          }
          throw cause;
        }
        if (parsed.name !== wanted) continue;
        if (selected !== undefined)
          throw new AnalysisInputError(operation, undefined, [
            {
              path: ["class_name"],
              reason: "invalid_value",
              message: `Binary name ${className} occurs at ${selected.entry.path} and ${entry.path}; select an exact .class entry or unique entry_id from inspect_java_archive.`,
            },
          ]);
        selected = { entry, bytes, parsed };
      }
    }
    if (selected === undefined) throw missingJavaClass(operation, className);
    const { entry, bytes, parsed } = selected;
    const nestedPrefix = `${entry.path.slice(0, -".class".length)}$`;
    const nested = [];
    for (const candidate of entries)
      if (candidate.path.startsWith(nestedPrefix))
        nested.push({
          entry: candidate.path,
          bytes: await archive.read(
            candidate,
            JAVA_ARCHIVE_LIMITS.classBytes,
            signal,
          ),
        });
    return {
      entry: entry.path,
      entryId: entry.adapterKey,
      parsed,
      bytes,
      nested,
    };
  } finally {
    await archive.close();
  }
};
