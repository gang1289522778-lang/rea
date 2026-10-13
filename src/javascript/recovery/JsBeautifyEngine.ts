import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { createAnalysisExecution } from "../../application/AnalysisProvider.js";
import { normalizeArtifactPath } from "../../artifacts/ArtifactPaths.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import {
  javascriptRecoveryResultSchema,
  type JavaScriptRecoveryInput,
  type JavaScriptRecoveryResult,
} from "../../domain/javascript/javascriptRecovery.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";
import { resolveRecoveryTool, runRecoveryCommand } from "./RecoveryCommand.js";
import type { RecoveryEngine, RecoveryWorkspace } from "./RecoveryEngine.js";
import {
  fingerprintRecoveryFile,
  inventoryRecoveryFiles,
  readRecoveryFile,
  recoveryDigest,
  recoveryInputFailure,
  type RecoveryInputSnapshot,
} from "./RecoveryFiles.js";
import {
  JSBEAUTIFY_LIMITATIONS,
  JSBEAUTIFY_LIMITS,
  JSBEAUTIFY_PROVIDER_IDENTITY,
  JSBEAUTIFY_REPOSITORY,
} from "./JsBeautifyRelease.js";

const OPERATION = "recover_javascript_sources";
const REQUIREMENT =
  "Provide an absolute REA_JSBEAUTIFY_COMMAND pointing to a jsbeautify binary on Linux; no tool is installed by REA. See docs/javascript-recovery.md#jsbeautify.";
const REPARSE_PHASES = ["19.6", "21.5"] as const;
const LEVEL_ARGUMENTS = {
  minimal: [],
  standard: ["--deobfuscate"],
  aggressive: ["--rename-vars"],
} as const satisfies Record<
  JavaScriptRecoveryInput["rewrite_level"],
  readonly string[]
>;

type CommandResult = Awaited<ReturnType<typeof runRecoveryCommand>>;

/** The parse goal of the original file; snapshots of a single input lose its extension. */
const sourceTypeArguments = (path: string): readonly string[] =>
  path.endsWith(".cjs")
    ? ["--source-type", "commonjs"]
    : path.endsWith(".mjs")
      ? ["--source-type", "module"]
      : [];

/** Keep the selected layout where safe, and give every published script a JS extension. */
const moduleName = (source: RecoveryInputSnapshot, single: boolean): string => {
  let name = source.relative_path;
  if (single) {
    const selectedName = basename(source.path);
    try {
      if (normalizeArtifactPath(selectedName) === selectedName)
        name = selectedName;
    } catch {
      // The snapshot already owns a safe fallback for a native-only basename.
    }
  }
  return /\.(?:[cm]?js|jsx)$/i.test(name) ? name : `${name}.js`;
};

/** Allocate the complete output layout before any producer can overwrite a selected input's output. */
const moduleNames = (
  sources: RecoveryWorkspace["sources"],
): readonly string[] => {
  const desired = sources.map((source) =>
    moduleName(source, sources.length === 1),
  );
  const allocated = new Set<string>();
  const overlaps = (left: string, right: string): boolean =>
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`);
  return desired.map((name, index) => {
    let candidate = name;
    let suffix = 0;
    while (
      [...allocated].some((used) => overlaps(used, candidate)) ||
      desired.some(
        (reserved, other) =>
          other !== index &&
          reserved !== candidate &&
          overlaps(reserved, candidate),
      )
    ) {
      suffix += 1;
      candidate = `__rea_recovered_${String(index + 1)}_${String(suffix)}/${basename(name)}`;
    }
    allocated.add(candidate);
    return candidate;
  });
};

/** Validity gate read from jsbeautify's stderr phase log. */
const gate = (run: CommandResult, deobfuscated: boolean) => {
  const reparse = Object.fromEntries(
    REPARSE_PHASES.map((phase) => [
      phase,
      run.stderr.includes(
        `[DEOBFUSCATE] Phase ${phase}: Generated output re-parse succeeded`,
      ),
    ]),
  );
  const passed =
    run.exit_code === 0 &&
    run.signal === null &&
    (!deobfuscated || REPARSE_PHASES.every((phase) => reparse[phase]));
  return { passed, exit_code: run.exit_code, signal: run.signal, reparse };
};

/** Bundler and obfuscator detections from the phase log's `<name> check: detected …` lines. */
const DETECTORS = [
  [/esbuild\/Bun runtime check: detected ([\w.-]+) runtime/, null],
  [/webpack check: detected webpack/, "webpack"],
  [/Turbopack check: detected/, "turbopack"],
  [/Akamai BMP check: detected/, "akamai-bmp"],
  [/Angular check: detected/, "angular"],
] as const;

const detections = (stderr: string): string[] => {
  const found = new Set<string>();
  for (const [pattern, name] of DETECTORS) {
    const match = pattern.exec(stderr);
    const detected = name ?? match?.[1];
    if (match !== null && detected !== undefined) found.add(detected);
  }
  return [...found];
};

/** Keep the phase summary and failures; drop jsbeautify's per-rewrite chatter. */
const phaseLog = (stderr: string): string =>
  stderr
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("[DEOBFUSCATE] Phase") ||
        line.startsWith("[AKAMAI]") ||
        /\b(error|panicked|warning)\b/i.test(line),
    )
    .join("\n");

const executeJsBeautify = async (context: RecoveryWorkspace) => {
  const { root, tree, input, sources, tool, environment, launcher, options } =
    context;
  const signal = options?.signal;
  const command = {
    ...tool,
    providerId: JSBEAUTIFY_PROVIDER_IDENTITY.id,
    name: JSBEAUTIFY_PROVIDER_IDENTITY.name,
    limits: JSBEAUTIFY_LIMITS,
    cwd: root,
    deadline: context.deadline,
    environment,
    ...(signal === undefined ? {} : { signal }),
    ...(launcher === undefined ? {} : { launcher }),
  };
  const banner = await runRecoveryCommand({
    ...command,
    arguments: ["--version"],
  });
  const version = /^jsbeautify (\S+)$/.exec(banner.stdout.trim())?.[1];
  if (banner.exit_code !== 0 || version === undefined) {
    const reason = `jsbeautify --version did not report a version; stdout: ${banner.stdout.trim()}; exit: ${String(banner.exit_code)}`;
    throw new AnalysisCapabilityUnavailableError(
      JSBEAUTIFY_PROVIDER_IDENTITY.id,
      OPERATION,
      `${reason}; stderr: ${banner.stderr}`,
      { userMessage: `${reason}.` },
    );
  }
  let publishedBytes = 0;
  const write = async (path: string, bytes: Buffer) => {
    if (bytes.byteLength > JSBEAUTIFY_LIMITS.outputBytes - publishedBytes)
      throw new AnalysisOutputError(
        OPERATION,
        "Published recovery artifacts exceed the operation-wide output budget",
      );
    const file = await tree.write(
      path,
      Readable.from([bytes]),
      { sha256: recoveryDigest(bytes), bytes: bytes.byteLength },
      signal,
    );
    publishedBytes += file.bytesWritten;
    return {
      path: join(tree.outputRoot, file.relativePath),
      sha256: file.sha256,
      bytes: file.bytesWritten,
    };
  };
  const deobfuscated = input.rewrite_level !== "minimal";
  const names = moduleNames(sources);
  const published: JavaScriptRecoveryResult["source"][] = [];
  const modules: JavaScriptRecoveryResult["modules"] = [];
  const warnings: JavaScriptRecoveryResult["warnings"] = [];
  const runs: Record<string, unknown>[] = [];
  const logs: string[] = [];
  let retainedLogBytes = 0;
  const formats = new Set<string>();
  for (const [sourceIndex, source] of sources.entries()) {
    const snapshot = await readRecoveryFile(
      source.snapshot_path,
      source.bytes,
      signal,
    );
    if (recoveryDigest(snapshot) !== source.sha256)
      throw new AnalysisOutputError(
        OPERATION,
        `The input snapshot changed during recovery: ${source.path}`,
      );
    const { relative_path, ...selected } = source;
    published.push({
      ...selected,
      published_copy: await write(`inputs/${relative_path}`, snapshot),
    });
    const name = names[sourceIndex];
    if (name === undefined)
      throw new AnalysisOutputError(OPERATION, "Missing allocated module name");
    const output = join(root, "modules", name);
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    const argumentsList = [
      source.snapshot_path,
      "--output",
      output,
      "--quiet",
      ...LEVEL_ARGUMENTS[input.rewrite_level],
      ...sourceTypeArguments(source.path),
    ];
    const run = await runRecoveryCommand({
      ...command,
      arguments: argumentsList,
      staging: join(root, "modules"),
    });
    const consumed = await fingerprintRecoveryFile(
      source.snapshot_path,
      source.bytes,
      signal,
    );
    if (consumed.sha256 !== source.sha256 || consumed.bytes !== source.bytes)
      throw new AnalysisOutputError(
        OPERATION,
        `The input snapshot changed during recovery: ${source.path}`,
      );
    await inventoryRecoveryFiles(
      join(root, "modules"),
      JSBEAUTIFY_LIMITS,
      signal,
    );
    const verdict = gate(run, deobfuscated);
    for (const format of detections(run.stderr)) formats.add(format);
    const log = `# ${name}\n${phaseLog(run.stderr)}`;
    const logBytes = Buffer.byteLength(log) + 2;
    if (logBytes > JSBEAUTIFY_LIMITS.reportBytes - retainedLogBytes)
      throw new AnalysisOutputError(
        OPERATION,
        "Combined phase reports exceed the retained diagnostic budget",
      );
    retainedLogBytes += logBytes;
    logs.push(log);
    runs.push({
      module: name,
      input: source.snapshot_path,
      arguments: argumentsList,
      ...verdict,
    });
    if (!verdict.passed) {
      warnings.push({
        filename: name,
        kind: "validity-gate",
        is_error: true,
        message: `jsbeautify exit ${String(run.exit_code)}${run.signal === null ? "" : ` (signal ${run.signal})`}; re-parse ${REPARSE_PHASES.map((phase) => `${phase}=${String(verdict.reparse[phase])}`).join(", ")}; the output was not published`,
      });
      continue;
    }
    modules.push({
      reported_filename: name,
      reported_status: deobfuscated ? "deobfuscated" : "formatted",
      artifact: await write(
        `modules/${name}`,
        await readRecoveryFile(
          output,
          JSBEAUTIFY_LIMITS.outputBytes - publishedBytes,
          signal,
        ),
      ),
      source_map: null,
      provenance: {
        reported_input: source.snapshot_path,
        original_path: source.path,
        original_sha256: source.sha256,
        extraction: "whole-file",
        byte_ranges: [{ start: 0, end: source.bytes }],
        context_byte_ranges: [],
        range_semantics: "half-open-utf8-bytes",
      },
    });
  }
  const [source, ...additionalSources] = published;
  if (source === undefined)
    throw new AnalysisOutputError(OPERATION, "Recovery selected no input");
  const report = await write(
    "reports/phases.log",
    Buffer.from(`${logs.join("\n\n")}\n`),
  );
  const provenance = await write(
    "reports/provenance.json",
    Buffer.from(
      `${JSON.stringify({ engine: "jsbeautify", version, runs }, null, 2)}\n`,
    ),
  );
  const details = {
    source,
    ...(additionalSources.length === 0
      ? {}
      : { additional_sources: additionalSources }),
    engine: {
      id: JSBEAUTIFY_PROVIDER_IDENTITY.id,
      version,
      executable: {
        path: tool.command,
        sha256: tool.sha256,
        bytes: tool.bytes,
      },
      audited_source_revision: `unaudited caller-supplied build of ${JSBEAUTIFY_REPOSITORY}`,
      executed_source_revision: null,
    },
    options: {
      extraction_mode: input.extraction_mode,
      rewrite_level: input.rewrite_level,
    },
    status:
      warnings.length === 0 ? ("complete" as const) : ("partial" as const),
    detected_formats: [...formats],
    reported_safety:
      modules.length === 0
        ? "No output passed the validity gate; no generated output was published"
        : deobfuscated
          ? "Published modules only: rewritten; generated output re-parsed"
          : "Published modules only: formatted; layout verified by jsbeautify",
    reported_strategy: deobfuscated
      ? `jsbeautify ${LEVEL_ARGUMENTS[input.rewrite_level].join(" ")}`
      : "jsbeautify",
    reported_format: "per-file",
    total: sources.length,
    failed: warnings.length,
    modules,
    warnings,
    report,
    provenance,
    analysis_input:
      modules.length === 0
        ? null
        : {
            input_path: join(tree.outputRoot, "modules"),
            format: "directory" as const,
          },
    runtime_equivalence: "unknown" as const,
    limitations: [...JSBEAUTIFY_LIMITATIONS],
  };
  const manifest = await write(
    "manifest.json",
    Buffer.from(`${JSON.stringify(details, null, 2)}\n`),
  );
  return {
    result: javascriptRecoveryResultSchema.parse({ ...details, manifest }),
    banner,
    runs,
    version,
  };
};

/** Run, publish, then prove the originals and the engine did not change meanwhile. */
const prepareJsBeautifyExecution = async (context: RecoveryWorkspace) => {
  const { sources, tool, options } = context;
  const { result, banner, runs, version } = await executeJsBeautify(context);
  for (const selected of sources) {
    const current = await fingerprintRecoveryFile(
      selected.path,
      JSBEAUTIFY_LIMITS.inputBytes,
      options?.signal,
    );
    if (current.sha256 !== selected.sha256 || current.bytes !== selected.bytes)
      throw new AnalysisOutputError(
        OPERATION,
        `Original input changed during recovery: ${selected.path}`,
      );
  }
  if (
    (
      await fingerprintRecoveryFile(
        tool.command,
        JSBEAUTIFY_LIMITS.outputBytes,
        options?.signal,
      )
    ).sha256 !== tool.sha256
  )
    throw new AnalysisOutputError(
      OPERATION,
      "Configured engine bytes changed during recovery",
    );
  const [source] = sources;
  return createAnalysisExecution(
    result,
    { ...JSBEAUTIFY_PROVIDER_IDENTITY, version },
    {
      rawResult: jsonValueSchema.parse({ version: banner, runs }),
      subject: {
        path: source.path,
        sha256: source.sha256,
        format: "javascript",
      },
      locations: [
        ...sources.map((selected) => ({
          kind: "artifact-path" as const,
          path: selected.path,
        })),
        ...result.modules.map((module) => ({
          kind: "artifact-path" as const,
          path: module.artifact.path,
        })),
      ],
      limitations: result.limitations,
    },
  );
};

/** jsbeautify: per-file formatting or deobfuscation behind a re-parse gate. */
export const jsbeautifyEngine: RecoveryEngine = {
  id: "jsbeautify",
  limits: JSBEAUTIFY_LIMITS,
  validate: (input) =>
    input.extraction_mode === "structural"
      ? undefined
      : recoveryInputFailure(
          "extraction_mode",
          "jsbeautify recovers each selected file whole; only extraction_mode structural applies",
        ),
  resolve: (environment) =>
    resolveRecoveryTool(environment, {
      id: JSBEAUTIFY_PROVIDER_IDENTITY.id,
      name: JSBEAUTIFY_PROVIDER_IDENTITY.name,
      configured: environment.REA_JSBEAUTIFY_COMMAND,
      supported: process.platform === "linux",
      requirement: REQUIREMENT,
      limits: JSBEAUTIFY_LIMITS,
    }),
  execute: prepareJsBeautifyExecution,
};
