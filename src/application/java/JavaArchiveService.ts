import { isAbsolute } from "node:path";
import type { z } from "zod";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { JavaArchivePort } from "./JavaArchivePort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import {
  javaClassSelectionInputSchema,
  inspectJavaArchiveInputSchema,
  javaArchiveSchema,
  javaClassReportSchema,
  javaDecompilationSchema,
} from "../../domain/java/javaArchive.js";
import { err, ok, type Result } from "../../domain/result.js";

type Operation =
  | "inspect_java_archive"
  | "inspect_java_class"
  | "decompile_java_class";
type Report = {
  [key: string]: JsonValue;
  artifact: { path: string; sha256: string; container: "jar" | "class" };
  limitations: string[];
};

/** Shared exact input validation and artifact-bound Evidence for CLI and MCP. */
export class JavaArchiveService {
  constructor(readonly provider: JavaArchivePort) {}

  /** Join provider cleanup during shutdown or an explicit retry. */
  close(): Promise<void> {
    return this.provider.close();
  }

  inspectArchive(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return this.#run(
      "inspect_java_archive",
      inspectJavaArchiveInputSchema,
      javaArchiveSchema,
      rawInput,
      options,
      (input) => this.provider.inspectArchive(input, options),
      () => ({ provider: this.provider.identities.classFile, derived: false }),
    );
  }

  inspectClass(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return this.#run(
      "inspect_java_class",
      javaClassSelectionInputSchema,
      javaClassReportSchema,
      rawInput,
      options,
      (input) => this.provider.inspectClass(input, options),
      () => ({ provider: this.provider.identities.classFile, derived: false }),
    );
  }

  decompile(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return this.#run(
      "decompile_java_class",
      javaClassSelectionInputSchema,
      javaDecompilationSchema,
      rawInput,
      options,
      (input) => this.provider.decompile(input, options),
      (report) => ({
        provider: {
          ...this.provider.identities.decompiler,
          version: report.tool_profile.implementation_version,
        },
        derived: true,
      }),
    );
  }

  async #run<
    InputSchema extends z.ZodType<{ path: string }>,
    OutputSchema extends z.ZodType<Report>,
  >(
    operation: Operation,
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    rawInput: unknown,
    options: ExecutionOptions | undefined,
    inspect: (
      input: z.output<InputSchema>,
    ) => Promise<Result<unknown, AnalysisError>>,
    producer: (report: z.output<OutputSchema>) => {
      provider: { id: string; name: string; version: string | null };
      derived: boolean;
    },
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const input = inputSchema.safeParse(rawInput);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(operation, input.error.issues, rawInput, {
          cause: input.error,
        }),
      );
    if (!isAbsolute(input.data.path))
      return err(
        new AnalysisInputError(operation, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected an absolute filesystem path on this host.",
          },
        ]),
      );
    const inspected = await inspect(input.data);
    if (!inspected.ok) return inspected;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const report = outputSchema.safeParse(inspected.value);
    if (!report.success || report.data.artifact.path !== input.data.path)
      return err(
        new AnalysisOutputError(
          operation,
          "Java reader returned malformed data or changed the selected artifact identity.",
          report.success ? undefined : { cause: report.error },
        ),
      );
    const value = report.data;
    const { provider, derived } = producer(value);
    return ok(
      createEvidence(
        {
          path: value.artifact.path,
          sha256: value.artifact.sha256,
          // A JAR is a ZIP container; a lone class file has no dedicated subject format.
          format: value.artifact.container === "jar" ? "zip" : "file",
        },
        provider,
        {
          operation,
          parameters: input.data,
          result: value,
          confidence: derived ? "derived" : "observed",
          limitations: value.limitations,
          locations: [{ kind: "artifact-path", path: value.artifact.path }],
        },
      ),
    );
  }
}
