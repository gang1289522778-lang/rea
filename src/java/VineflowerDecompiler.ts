import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import type { JavaArchivePort } from "../application/java/JavaArchivePort.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import type {
  AnalysisCapturedOutput,
  AnalysisError,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  javaDecompilationSchema,
  VINEFLOWER_JAR_ENV,
  VINEFLOWER_PROVIDER_IDENTITY,
  type JavaClassSelectionInput,
  type JavaDecompilation,
} from "../domain/java/javaArchive.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import type { ProviderProcessSupervisor } from "../process/ProviderProcess.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { javaArchiveFailure } from "./JavaArchiveFailures.js";
import {
  admitJavaInput,
  JavaArchiveEntries,
  type JavaInputSnapshot,
  javaArtifactIdentity,
  parseManifestMainSection,
} from "./JavaArchiveReader.js";
import {
  selectJavaClass,
  type SelectedJavaClass,
} from "./JavaClassFileProvider.js";

type Launcher = NonNullable<Parameters<typeof runOwnedCommand>[2]>["launcher"];
type RuntimeRoot = Pick<PrivateRuntimeRoot, "path" | "close">;

const OPERATION = "decompile_java_class";
/** Engine and process bounds; these are not operating-system memory limits. */
export const VINEFLOWER_LIMITS = Object.freeze({
  engineBytes: 64 * 1024 * 1024,
  timeoutMs: 180_000,
  diagnosticBytes: 8 * 1024 * 1024,
  sourceBytes: 32 * 1024 * 1024,
});

/**
 * Archive names are untrusted. Only plain relative segments may become
 * private-root paths, so a crafted entry cannot write outside that root.
 */
const privateRelativeEntry = (artifact: string, entry: string): string => {
  const segments = entry.split("/");
  if (
    entry.includes("\\") ||
    entry.includes("\0") ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        /^[A-Za-z]:/u.test(segment),
    )
  )
    throw new AnalysisUnsupportedTargetError(
      OPERATION,
      artifact,
      `Archive entry ${JSON.stringify(entry)} is not a plain relative class path and cannot be staged for decompilation.`,
    );
  return join(...segments);
};

const LIMITATIONS = [
  "Decompiled Java is a reconstructed representation, not original source. Names removed by renaming obfuscation stay as found in the bytecode; local variable names, comments and formatting are synthesized.",
  "The selected class and its nested-class entries are decompiled with the complete selected archive as library context. Classes outside that archive (for example a game or framework the target is compiled against) are unresolved, which can weaken inferred types.",
  "No target code is loaded or executed. Vineflower is a trusted caller-supplied JAR run by the selected Java runtime; SHA-256 identifies its bytes, not publisher authenticity.",
];

const capabilityUnavailable = (reason: string) =>
  new AnalysisCapabilityUnavailableError(
    VINEFLOWER_PROVIDER_IDENTITY.id,
    OPERATION,
    reason,
    {
      userMessage: `${reason} Set ${VINEFLOWER_JAR_ENV} to the absolute path of a caller-supplied Vineflower JAR and provide Java 17+ via JAVA_HOME or PATH. REA does not download or install either. inspect_java_archive and inspect_java_class need neither.`,
    },
  );

const capturedOutputOf = (
  failure: OwnedCommandFailure,
): AnalysisCapturedOutput | undefined =>
  failure.snapshot === null
    ? undefined
    : {
        stdout: failure.snapshot.stdout.text,
        stderr: failure.snapshot.stderr.text,
        truncated: failure.snapshot.diagnosticTruncated ?? false,
      };

const commandFailure = (failure: OwnedCommandFailure): AnalysisError => {
  const capturedOutput = capturedOutputOf(failure);
  const options = {
    cause: failure,
    ...(capturedOutput === undefined ? {} : { capturedOutput }),
  };
  if (failure.cleanupFailure !== null)
    return new ProviderCleanupError(
      VINEFLOWER_PROVIDER_IDENTITY.id,
      failure.resources,
      { reason: failure.cleanupFailure, previous_error: failure.message },
      { operation: OPERATION, cause: failure },
    );
  if (failure.reason === "cancelled")
    return new AnalysisCancelledError(OPERATION, options);
  if (failure.reason === "timeout")
    return new AnalysisTimeoutError(
      OPERATION,
      VINEFLOWER_LIMITS.timeoutMs,
      options,
    );
  if (failure.reason === "output-limit")
    return new AnalysisResourceConstraintError(
      OPERATION,
      "memory",
      `Vineflower diagnostics exceeded ${String(VINEFLOWER_LIMITS.diagnosticBytes)} bytes.`,
      { diagnostic_bytes: VINEFLOWER_LIMITS.diagnosticBytes },
      options,
    );
  return new AnalysisCapabilityUnavailableError(
    VINEFLOWER_PROVIDER_IDENTITY.id,
    OPERATION,
    failure.message,
    {
      ...options,
      userMessage:
        "Java could not run the configured Vineflower JAR. Check JAVA_HOME or java on PATH (Java 17+) and the JAR; inspect retained diagnostics.",
    },
  );
};

/** Run a caller-supplied Vineflower JAR against private copies of exactly selected bytes. */
export class VineflowerDecompiler implements Pick<
  JavaArchivePort,
  "decompile"
> {
  readonly identity = VINEFLOWER_PROVIDER_IDENTITY;
  readonly #pendingRoots = new Set<RuntimeRoot>();
  readonly #pendingProcesses = new Map<
    RuntimeRoot,
    ProviderProcessSupervisor
  >();

  constructor(
    readonly environment: Readonly<NodeJS.ProcessEnv> = process.env,
    readonly launcher?: Launcher,
    readonly createRuntime: () => Promise<RuntimeRoot> = () =>
      PrivateRuntimeRoot.create({ prefix: "rea-vineflower-" }),
  ) {}

  /** Retry retained cleanup without discarding roots that still cannot be removed. */
  async close(): Promise<void> {
    const failures: { path: string; reason: string }[] = [];
    for (const [root, owner] of this.#pendingProcesses) {
      try {
        const stopped = await owner.stop();
        if (stopped.status === "incomplete") {
          failures.push({ path: root.path, reason: stopped.reason });
          continue;
        }
        this.#pendingProcesses.delete(root);
      } catch (cause) {
        failures.push({
          path: root.path,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    for (const root of this.#pendingRoots) {
      if (this.#pendingProcesses.has(root)) continue;
      try {
        await root.close();
        this.#pendingRoots.delete(root);
      } catch (cause: unknown) {
        failures.push({
          path: root.path,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    if (failures.length > 0)
      throw new ProviderCleanupError(
        VINEFLOWER_PROVIDER_IDENTITY.id,
        failures.map(({ path }) => path),
        { failures },
        { operation: OPERATION },
      );
  }

  async decompile(
    input: JavaClassSelectionInput,
    options?: ExecutionOptions,
  ): Promise<Result<JavaDecompilation, AnalysisError>> {
    const signal = options?.signal;
    let root: RuntimeRoot | undefined;
    let result: Result<JavaDecompilation, AnalysisError>;
    try {
      signal?.throwIfAborted();
      await this.close();
      const engine = await resolveEngine(this.environment, signal);
      const snapshot = await admitJavaInput(input.path, signal);
      const selected = await selectJavaClass(
        OPERATION,
        snapshot,
        input.class_name,
        signal,
      );
      root = await this.createRuntime();
      result = ok(
        await this.#decompileIn(root, engine, snapshot, selected, signal),
      );
    } catch (cause: unknown) {
      result = err(
        javaArchiveFailure(
          OPERATION,
          VINEFLOWER_PROVIDER_IDENTITY.id,
          cause,
          input.path,
          signal,
        ),
      );
    }
    if (root !== undefined && !this.#pendingProcesses.has(root))
      try {
        await root.close();
      } catch (cause: unknown) {
        this.#pendingRoots.add(root);
        result = err(
          new ProviderCleanupError(
            VINEFLOWER_PROVIDER_IDENTITY.id,
            [root.path],
            {
              reason: cause instanceof Error ? cause.message : String(cause),
              previous_error: result.ok
                ? null
                : projectAnalysisError(result.error),
            },
            { operation: OPERATION, cause },
          ),
        );
      }
    return result;
  }

  /** Stage exact bytes in the private root, run the engine and read its source. */
  async #decompileIn(
    root: RuntimeRoot,
    engine: ResolvedEngine,
    snapshot: JavaInputSnapshot,
    selected: SelectedJavaClass,
    signal?: AbortSignal,
  ): Promise<JavaDecompilation> {
    const write = async (relative: string, bytes: Buffer) => {
      const path = join(root.path, relative);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, bytes, {
        flag: "wx",
        mode: 0o400,
        ...(signal === undefined ? {} : { signal }),
      });
      return path;
    };
    const engineCopy = await write("engine.jar", engine.bytes);
    const primary = selected.entry ?? `${selected.parsed.name}.class`;
    const inputs = [
      { entry: primary, bytes: selected.bytes },
      ...selected.nested,
    ];
    for (const item of inputs)
      await write(
        join("input", privateRelativeEntry(snapshot.path, item.entry)),
        item.bytes,
      );
    const library =
      snapshot.container === "jar"
        ? await write("library.jar", snapshot.bytes)
        : undefined;
    await mkdir(join(root.path, "output"), { mode: 0o700 });
    const args = [
      "-jar",
      engineCopy,
      "-dgs=1",
      "-log=WARN",
      ...(library === undefined ? [] : [`-e=${library}`]),
      join(root.path, "input"),
      join(root.path, "output"),
    ];
    await this.#run(engine.java, args, root, signal);
    const executed = await readStableArtifact(
      engineCopy,
      VINEFLOWER_LIMITS.engineBytes,
      signal,
    );
    if (executed.sha256 !== engine.sha256)
      throw new AnalysisOutputError(
        OPERATION,
        "Private Vineflower engine bytes changed during decompilation.",
      );
    const source = await readSource(
      join(root.path, "output", `${primary.slice(0, -".class".length)}.java`),
      selected.parsed.name,
      signal,
    );
    return javaDecompilationSchema.parse({
      artifact: javaArtifactIdentity(snapshot),
      class_name: selected.parsed.name,
      entry_id: selected.entryId,
      entries: inputs.map(({ entry }) => entry),
      source: {
        representation: "decompiled-java",
        text: source,
        sha256: createHash("sha256").update(source, "utf8").digest("hex"),
      },
      tool_profile: {
        engine: "vineflower",
        jar_path: engine.jarPath,
        jar_sha256: engine.sha256,
        implementation_version: engine.implementationVersion,
        java_executable: engine.java,
        arguments: args.map((argument) =>
          argument.replace(root.path, "<private-root>"),
        ),
        timeout_ms: VINEFLOWER_LIMITS.timeoutMs,
      },
      target_execution: "not-performed",
      limitations: [
        ...LIMITATIONS,
        "Generated source may contain decompiler failure comments; the provider does not infer a failed-member count from arbitrary source text.",
      ],
    });
  }

  async #run(
    java: string,
    args: readonly string[],
    root: RuntimeRoot,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await runOwnedCommand(
        {
          command: java,
          arguments: args,
          cwd: root.path,
          expectedCommand: java,
          runId: `rea-vineflower-${randomUUID()}`,
          hostEnvironment: { ...this.environment },
        },
        {
          timeoutMs: VINEFLOWER_LIMITS.timeoutMs,
          diagnosticBytes: VINEFLOWER_LIMITS.diagnosticBytes,
        },
        {
          ...(signal === undefined ? {} : { signal }),
          ...(this.launcher === undefined ? {} : { launcher: this.launcher }),
        },
      );
    } catch (cause: unknown) {
      if (cause instanceof OwnedCommandFailure) {
        if (cause.cleanupOwner !== undefined) {
          this.#pendingProcesses.set(root, cause.cleanupOwner);
          this.#pendingRoots.add(root);
        }
        throw commandFailure(cause);
      }
      throw cause;
    }
  }
}

/** The configured engine's exact bytes, observed release and Java launcher. */
interface ResolvedEngine {
  readonly jarPath: string;
  readonly java: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly implementationVersion: string | null;
}

/** Resolve configuration before touching the target; absence is a capability gap. */
const resolveEngine = async (
  environment: Readonly<NodeJS.ProcessEnv>,
  signal?: AbortSignal,
): Promise<ResolvedEngine> => {
  const jarPath = environment[VINEFLOWER_JAR_ENV] ?? "";
  if (!isAbsolute(jarPath))
    throw capabilityUnavailable(
      `${VINEFLOWER_JAR_ENV} must name an absolute Vineflower JAR path.`,
    );
  const javaHome = environment.JAVA_HOME;
  if (javaHome !== undefined && !isAbsolute(javaHome))
    throw capabilityUnavailable(
      "JAVA_HOME must select a Java runtime by absolute path; omit it to use java on PATH.",
    );
  const executable = process.platform === "win32" ? "java.exe" : "java";
  let engine: Awaited<ReturnType<typeof readStableArtifact>>;
  try {
    engine = await readStableArtifact(
      jarPath,
      VINEFLOWER_LIMITS.engineBytes,
      signal,
    );
  } catch (cause: unknown) {
    if (signal?.aborted === true) throw cause;
    throw capabilityUnavailable(
      `Cannot read ${VINEFLOWER_JAR_ENV} ${jarPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return {
    jarPath,
    java:
      javaHome === undefined ? executable : join(javaHome, "bin", executable),
    bytes: engine.bytes,
    sha256: engine.sha256,
    implementationVersion: await engineVersion(jarPath, engine, signal),
  };
};

/** Generated source must exist and be UTF-8; otherwise the run produced nothing usable. */
const readSource = async (
  path: string,
  className: string,
  signal?: AbortSignal,
): Promise<string> => {
  try {
    const bytes = await readStableArtifact(
      path,
      VINEFLOWER_LIMITS.sourceBytes,
      signal,
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.bytes);
  } catch (cause: unknown) {
    if (signal?.aborted === true) throw cause;
    throw new AnalysisOutputError(
      OPERATION,
      `Vineflower produced no readable source for ${className}.`,
      { cause },
    );
  }
};

/** Observed engine release from its manifest; absence stays unknown. */
const engineVersion = async (
  path: string,
  engine: { readonly bytes: Buffer; readonly sha256: string },
  signal?: AbortSignal,
): Promise<string | null> => {
  const archive = new JavaArchiveEntries({
    path,
    bytes: engine.bytes,
    sha256: engine.sha256,
    container: "jar",
  });
  try {
    const manifest = (await archive.list(signal)).find(
      (entry) =>
        entry.kind === "file" &&
        entry.path.toUpperCase() === "META-INF/MANIFEST.MF",
    );
    if (manifest === undefined) return null;
    const attributes = parseManifestMainSection(
      await archive.read(manifest, 1024 * 1024, signal),
    ).attributes;
    return (
      attributes.find(
        ({ name }) => name.toLowerCase() === "implementation-version",
      )?.value ?? null
    );
  } catch (cause: unknown) {
    if (signal?.aborted === true) throw cause;
    throw capabilityUnavailable(
      `${VINEFLOWER_JAR_ENV} ${path} is not a readable JAR: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  } finally {
    await archive.close();
  }
};
