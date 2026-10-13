import { createHash } from "node:crypto";
import { join } from "node:path";
import { Readable } from "node:stream";

import {
  createAnalysisExecution,
  type AnalysisExecution,
} from "../../application/AnalysisProvider.js";
import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import { javascriptDeobfuscationResultSchema } from "../../domain/javascript/javascriptDeobfuscation.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";
import type { ProviderProcessSnapshot } from "../../process/ProviderProcess.js";
import {
  JS_REDOX_LIMITATIONS,
  JS_REDOX_PROVIDER_IDENTITY,
  JS_REDOX_RELEASE,
} from "./JsRedoxRelease.js";
import type { JsRedoxReport } from "./JsRedoxProtocol.js";

export interface JsRedoxEngineIdentity {
  readonly configuredCommand: string;
  readonly command: string;
  readonly sha256: string;
  readonly bytes: number;
}

interface StableBytes {
  readonly bytes: Buffer;
  readonly sha256: string;
}

interface PublishedFiles {
  readonly source: Awaited<ReturnType<typeof writePublished>>;
  readonly output: Awaited<ReturnType<typeof writePublished>>;
  readonly report: Awaited<ReturnType<typeof writePublished>>;
  readonly manifest: Awaited<ReturnType<typeof writePublished>>;
  readonly diagnostics: {
    readonly version: Awaited<ReturnType<typeof publishCommandDiagnostics>>;
    readonly execution: Awaited<ReturnType<typeof publishCommandDiagnostics>>;
  };
}

export const publishJsRedox = async (input: {
  readonly sourcePath: string;
  readonly maxIterations: number;
  readonly tree: SafeOutputTree;
  readonly source: StableBytes;
  readonly output: StableBytes;
  readonly reportFile: StableBytes;
  readonly report: JsRedoxReport;
  readonly engine: JsRedoxEngineIdentity;
  readonly version: string;
  readonly versionRun: ProviderProcessSnapshot;
  readonly executionRun: ProviderProcessSnapshot;
  readonly signal?: AbortSignal;
}): Promise<AnalysisExecution> => {
  const files = await publishFiles(input);
  const result = buildResult(input, files);
  return createAnalysisExecution(
    result,
    { ...JS_REDOX_PROVIDER_IDENTITY, version: input.version },
    {
      rawResult: jsonValueSchema.parse({
        version: files.diagnostics.version,
        execution: files.diagnostics.execution,
      }),
      subject: {
        path: input.sourcePath,
        sha256: input.source.sha256,
        format: "javascript",
      },
      locations: [
        { kind: "artifact-path", path: input.sourcePath },
        { kind: "artifact-path", path: files.output.path },
        { kind: "artifact-path", path: files.report.path },
      ],
      limitations: result.limitations,
    },
  );
};

const publishFiles = async (
  input: Parameters<typeof publishJsRedox>[0],
): Promise<PublishedFiles> => {
  const source = await writePublished(
    input.tree,
    "inputs/source.js",
    input.source.bytes,
    input.signal,
  );
  const output = await writePublished(
    input.tree,
    "deobfuscated/source.js",
    input.output.bytes,
    input.signal,
  );
  const report = await writePublished(
    input.tree,
    "reports/js-redox.json",
    input.reportFile.bytes,
    input.signal,
  );
  const diagnostics = {
    version: await publishCommandDiagnostics(
      input.tree,
      "version",
      input.versionRun,
      input.signal,
    ),
    execution: await publishCommandDiagnostics(
      input.tree,
      "execution",
      input.executionRun,
      input.signal,
    ),
  };
  const manifestBytes = Buffer.from(
    `${JSON.stringify({ ...manifestValue(input, source, output, report), diagnostics }, null, 2)}\n`,
    "utf8",
  );
  const manifest = await writePublished(
    input.tree,
    "manifest.json",
    manifestBytes,
    input.signal,
  );
  return { source, output, report, manifest, diagnostics };
};

const manifestValue = (
  input: Parameters<typeof publishJsRedox>[0],
  source: PublishedFiles["source"],
  output: PublishedFiles["output"],
  report: PublishedFiles["report"],
) => ({
  schema: "rea-js-redox-publication/v1",
  source: {
    path: input.sourcePath,
    sha256: input.source.sha256,
    bytes: input.source.bytes.length,
    published_path: source.path,
  },
  output: {
    path: output.path,
    sha256: input.output.sha256,
    bytes: input.output.bytes.length,
  },
  report: {
    path: report.path,
    sha256: input.reportFile.sha256,
    bytes: input.reportFile.bytes.length,
  },
  engine: {
    path: input.engine.configuredCommand,
    resolved_path: input.engine.command,
    sha256: input.engine.sha256,
    bytes: input.engine.bytes,
    version: input.version,
    audited_source_revision: JS_REDOX_RELEASE.revision,
    executed_source_revision: null,
  },
  options: { max_iterations: input.maxIterations },
});

const buildResult = (
  input: Parameters<typeof publishJsRedox>[0],
  files: PublishedFiles,
) => {
  const aliases = input.report.static_alias_installer_calls;
  return javascriptDeobfuscationResultSchema.parse({
    source: {
      path: input.sourcePath,
      sha256: input.source.sha256,
      bytes: input.source.bytes.length,
      published_copy: files.source,
    },
    engine: {
      id: JS_REDOX_PROVIDER_IDENTITY.id,
      version: input.version,
      executable: {
        path: input.engine.configuredCommand,
        resolved_path: input.engine.command,
        sha256: input.engine.sha256,
        bytes: input.engine.bytes,
      },
      audited_source_revision: JS_REDOX_RELEASE.revision,
      executed_source_revision: null,
    },
    options: { max_iterations: input.maxIterations },
    status:
      input.output.sha256 === input.source.sha256 ? "unchanged" : "changed",
    output: files.output,
    report: files.report,
    manifest: files.manifest,
    diagnostics: files.diagnostics,
    proof: {
      schema: input.report.schema,
      iterations: input.report.iterations,
      transforms: input.report.transforms,
      arithmetic_state_proofs: input.report.arithmetic_state_proofs.length,
      static_alias_installer_calls: {
        total: aliases.length,
        forwarding_installer_proven: aliases.filter(
          ({ forwarding_installer_proven }) => forwarding_installer_proven,
        ).length,
        semantics_proven: aliases.filter(
          ({ semantics_proven }) => semantics_proven,
        ).length,
      },
      analysis_source_sha256: input.report.analysis_source_sha256,
      safe_static_only: input.report.safe_static_only,
      presentation_formatted: input.report.presentation_formatted,
      runtime_semantics_preserved_by_design:
        input.report.runtime_semantics_preserved_by_design,
    },
    analysis_input: {
      input_path: join(input.tree.outputRoot, "deobfuscated"),
      format: "directory",
    },
    runtime_execution: "not-performed",
    limitations: [...JS_REDOX_LIMITATIONS],
  });
};

const publishCommandDiagnostics = async (
  tree: SafeOutputTree,
  name: "version" | "execution",
  snapshot: ProviderProcessSnapshot,
  signal?: AbortSignal,
) => ({
  exit_code: snapshot.exitCode ?? null,
  exit_signal: snapshot.signal ?? null,
  truncated: snapshot.diagnosticTruncated ?? false,
  stdout: {
    ...(await writePublished(
      tree,
      `diagnostics/${name}.stdout.txt`,
      Buffer.from(snapshot.stdout.text),
      signal,
    )),
    observed_bytes: snapshot.stdout.observedBytes,
  },
  stderr: {
    ...(await writePublished(
      tree,
      `diagnostics/${name}.stderr.txt`,
      Buffer.from(snapshot.stderr.text),
      signal,
    )),
    observed_bytes: snapshot.stderr.observedBytes,
  },
});

const writePublished = async (
  tree: SafeOutputTree,
  relativePath: string,
  bytes: Buffer,
  signal?: AbortSignal,
) => {
  const written = await tree.write(
    relativePath,
    Readable.from([bytes]),
    { sha256: sha256(bytes), bytes: bytes.length },
    signal,
  );
  return {
    path: join(tree.outputRoot, written.relativePath),
    sha256: written.sha256,
    bytes: written.bytesWritten,
  };
};

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
