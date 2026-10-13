import { join } from "node:path";
import { createAnalysisExecution } from "../../application/AnalysisProvider.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";
import { runRecoveryCommand } from "./RecoveryCommand.js";
import type { RecoveryEngine, RecoveryWorkspace } from "./RecoveryEngine.js";
import {
  fingerprintRecoveryFile,
  inventoryRecoveryFiles,
  readRecoveryFile,
} from "./RecoveryFiles.js";
import { resolveWakaruCommand } from "./WakaruCommand.js";
import { parseWakaruReports } from "./WakaruReport.js";
import { publishWakaruArtifacts } from "./WakaruPublication.js";
import { WAKARU_LIMITS, WAKARU_PROVIDER_IDENTITY } from "./WakaruRelease.js";
import { admitWakaruVersion } from "./WakaruVersion.js";

const OPERATION = "recover_javascript_sources";
const MODES = {
  structural: "strict",
  heuristic: "auto",
  inspection: "inspect",
} as const;

/** Consume the pinned producer representation in a private workspace. */
const executeWakaruRecovery = async (context: RecoveryWorkspace) => {
  const { root, input, sources, tool, environment, launcher, options } =
    context;
  const staging = join(root, "modules");
  const commandContext = {
    ...tool,
    providerId: WAKARU_PROVIDER_IDENTITY.id,
    name: WAKARU_PROVIDER_IDENTITY.name,
    limits: WAKARU_LIMITS,
    cwd: root,
    deadline: context.deadline,
    environment: environment,
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
    ...(launcher === undefined ? {} : { launcher: launcher }),
  };
  const version = await runRecoveryCommand({
    ...commandContext,
    arguments: ["--version"],
  });
  const admitted =
    version.exit_code === 0
      ? admitWakaruVersion(version.stdout.trim())
      : undefined;
  if (admitted === undefined || admitted.status === "unsupported") {
    // The message names the mismatch; the reason also keeps the tool's stderr.
    const mismatch = `${admitted?.message ?? `Wakaru --version failed; reported version: ${version.stdout.trim()}`}; exit: ${String(version.exit_code)}`;
    throw new AnalysisCapabilityUnavailableError(
      "wakaru",
      OPERATION,
      `${mismatch}; stderr: ${version.stderr}`,
      { userMessage: `${mismatch}.` },
    );
  }
  const run = await runRecoveryCommand({
    ...commandContext,
    staging,
    arguments: [
      ...sources.map((source) => source.snapshot_path),
      `--unpack=${MODES[input.extraction_mode]}`,
      `--level=${input.rewrite_level}`,
      "--provenance",
      "--emit-source-map",
      "--json",
      "-o",
      staging,
    ],
  });
  const files = await inventoryRecoveryFiles(
    staging,
    WAKARU_LIMITS,
    options?.signal,
  );
  const snapshots = new Map<string, Buffer>();
  for (const source of sources)
    snapshots.set(
      source.snapshot_path,
      await readRecoveryFile(
        source.snapshot_path,
        source.bytes,
        options?.signal,
      ),
    );
  const parsed = await parseWakaruReports({
    execution: run,
    provenancePath: join(staging, "provenance.json"),
    snapshots,
    files,
  });
  return { version, admitted, run, parsed };
};

/** Publish validated recovery and retain exact source and engine bindings. */
const prepareWakaruExecution = async (context: RecoveryWorkspace) => {
  const { root, tree, input, sources, tool, options } = context;
  const [source] = sources;
  const staging = join(root, "modules");
  const { version, admitted, run, parsed } =
    await executeWakaruRecovery(context);
  const result = await publishWakaruArtifacts({
    tree,
    staging,
    input,
    sources,
    tool,
    admitted,
    parsed,
    execution: run,
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
  });
  for (const selected of sources) {
    const current = await fingerprintRecoveryFile(
      selected.path,
      WAKARU_LIMITS.inputBytes,
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
        WAKARU_LIMITS.outputBytes,
        options?.signal,
      )
    ).sha256 !== tool.sha256
  )
    throw new AnalysisOutputError(
      OPERATION,
      "Configured engine bytes changed during recovery",
    );
  return createAnalysisExecution(
    result,
    { ...WAKARU_PROVIDER_IDENTITY, version: admitted.version },
    {
      rawResult: jsonValueSchema.parse({
        version,
        execution: run,
        report: parsed.report,
        provenance: parsed.provenance,
      }),
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

/** Wakaru module unpacking: structural, heuristic or inspection extraction. */
export const wakaruEngine: RecoveryEngine = {
  id: "wakaru",
  limits: WAKARU_LIMITS,
  validate: () => undefined,
  resolve: resolveWakaruCommand,
  execute: prepareWakaruExecution,
};
