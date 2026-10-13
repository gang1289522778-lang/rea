import { isAbsolute } from "node:path";

import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  javascriptDeobfuscationInputSchema,
  javascriptDeobfuscationResultSchema,
} from "../../domain/javascript/javascriptDeobfuscation.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { jsonObjectSchema } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { JavaScriptDeobfuscationPort } from "./JavaScriptDeobfuscationPort.js";

const OPERATION = "deobfuscate_javascript_source";

/** Shared CLI/MCP validation and Evidence for proof-gated JavaScript rewriting. */
export class JavaScriptDeobfuscationService {
  constructor(readonly provider: JavaScriptDeobfuscationPort) {}

  close(): Promise<void> {
    return this.provider.close?.() ?? Promise.resolve();
  }

  async deobfuscate(
    input: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted === true)
      return err(new AnalysisCancelledError(OPERATION));
    const parsed = javascriptDeobfuscationInputSchema.safeParse(input);
    if (!parsed.success)
      return err(
        analysisInputErrorFromIssues(OPERATION, parsed.error.issues, input, {
          cause: parsed.error,
        }),
      );
    const invalidPaths = (["path", "output_directory"] as const).filter(
      (field) => !isAbsolute(parsed.data[field]),
    );
    if (invalidPaths.length > 0)
      return err(
        new AnalysisInputError(
          OPERATION,
          undefined,
          invalidPaths.map((field) => ({
            path: [field],
            reason: "invalid_format",
            message: `${field} must be an absolute filesystem path on this host.`,
          })),
        ),
      );
    const execution = await this.provider.deobfuscate(parsed.data, options);
    if (!execution.ok) return execution;
    const result = javascriptDeobfuscationResultSchema.safeParse(
      execution.value.result,
    );
    if (!result.success || execution.value.subject === null)
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Deobfuscation did not return a valid result bound to the original source",
        ),
      );
    if (
      result.data.source.path !== parsed.data.path ||
      execution.value.subject.path !== result.data.source.path ||
      execution.value.subject.sha256 !== result.data.source.sha256 ||
      result.data.options.max_iterations !== parsed.data.max_iterations ||
      result.data.proof.iterations > parsed.data.max_iterations ||
      result.data.proof.analysis_source_sha256 !== result.data.output.sha256 ||
      execution.value.provider.id !== result.data.engine.id ||
      execution.value.provider.version !== result.data.engine.version
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Deobfuscation source, engine identity, or iteration bound disagrees with its Evidence binding",
        ),
      );
    return ok(
      createEvidence(execution.value.subject, execution.value.provider, {
        operation: OPERATION,
        parameters: jsonObjectSchema.parse(parsed.data),
        result: jsonObjectSchema.parse(result.data),
        ...(execution.value.rawResult === null
          ? {}
          : { rawResult: execution.value.rawResult }),
        locations: execution.value.locations,
        limitations: execution.value.limitations,
        confidence: "derived",
        authority: "shipped-artifact",
      }),
    );
  }
}
