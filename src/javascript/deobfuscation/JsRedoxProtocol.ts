import { TextDecoder } from "node:util";

import { z } from "zod";

import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";

const OPERATION = "deobfuscate_javascript_source";

export const jsRedoxReportSchema = z
  .object({
    schema: z.literal("js-safe-deobfuscate/v1"),
    input: z.string(),
    input_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    output_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    changed: z.boolean(),
    iterations: z.number().int().nonnegative(),
    transforms: z.record(z.string(), z.number().int().nonnegative()),
    arithmetic_state_proofs: z.array(z.unknown()),
    analysis_source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    static_alias_installer_calls: z.array(
      z
        .object({
          forwarding_installer_proven: z.boolean(),
          semantics_proven: z.boolean(),
        })
        .passthrough(),
    ),
    safe_static_only: z.literal(true),
    presentation_formatted: z.literal(false),
    runtime_semantics_preserved_by_design: z.literal(true),
  })
  .passthrough();

export type JsRedoxReport = z.output<typeof jsRedoxReportSchema>;

export const parseJsRedoxVersion = (stdout: string): string | null => {
  const match = /^jsvm-lift\s+(\d+\.\d+\.\d+)\s*$/.exec(stdout);
  return match?.[1] ?? null;
};

export const parseJsRedoxReport = (bytes: Buffer): JsRedoxReport => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return jsRedoxReportSchema.parse(JSON.parse(text));
  } catch (cause: unknown) {
    throw new AnalysisOutputError(
      OPERATION,
      `js-redox returned an incompatible proof report: ${failureMessage(cause)}`,
      { cause },
    );
  }
};

export const validateJsRedoxReport = (
  report: JsRedoxReport,
  expected: {
    readonly inputSha256: string;
    readonly outputSha256: string;
    readonly changed: boolean;
    readonly maxIterations: number;
  },
): void => {
  if (
    report.input_sha256 !== expected.inputSha256 ||
    report.output_sha256 !== expected.outputSha256 ||
    report.analysis_source_sha256 !== expected.outputSha256 ||
    report.changed !== expected.changed ||
    report.iterations > expected.maxIterations
  )
    throw new AnalysisOutputError(
      OPERATION,
      "js-redox proof report disagrees with the exact input, output, or configured iteration bound.",
    );
};

const failureMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
