import { z } from "zod";
import { digestSchema } from "../digests.js";
import { analyzeJavaScriptApplicationInputSchema } from "./javascriptApplicationAnalysis.js";
import { localPathStringSchema } from "../localPath.js";

export const javascriptDeobfuscationInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute path to one UTF-8 JavaScript file; never executed",
  ),
  output_directory: localPathStringSchema.describe(
    "Absolute absent output directory; parent must exist",
  ),
  max_iterations: z.number().int().min(1).max(64).default(16),
});

const fileSchema = z.strictObject({
  path: z.string().min(1),
  sha256: digestSchema,
  bytes: z.number().int().nonnegative(),
});

const commandDiagnosticsSchema = z.strictObject({
  exit_code: z.number().int().nullable(),
  exit_signal: z.string().nullable(),
  truncated: z.boolean(),
  stdout: fileSchema.extend({ observed_bytes: z.number().int().nonnegative() }),
  stderr: fileSchema.extend({ observed_bytes: z.number().int().nonnegative() }),
});

export const javascriptDeobfuscationResultSchema = z.strictObject({
  source: fileSchema.extend({
    published_copy: fileSchema,
  }),
  engine: z.strictObject({
    id: z.literal("js-redox"),
    version: z.string().min(1),
    executable: fileSchema.extend({
      resolved_path: localPathStringSchema.optional(),
    }),
    audited_source_revision: z.string().min(1),
    executed_source_revision: z.null(),
  }),
  options: z.strictObject({
    max_iterations:
      javascriptDeobfuscationInputSchema.shape.max_iterations.removeDefault(),
  }),
  status: z.enum(["changed", "unchanged"]),
  output: fileSchema,
  report: fileSchema,
  manifest: fileSchema,
  diagnostics: z
    .strictObject({
      version: commandDiagnosticsSchema,
      execution: commandDiagnosticsSchema,
    })
    .optional(),
  proof: z.strictObject({
    schema: z.literal("js-safe-deobfuscate/v1"),
    iterations: z.number().int().nonnegative(),
    transforms: z.record(z.string(), z.number().int().nonnegative()),
    arithmetic_state_proofs: z.number().int().nonnegative(),
    static_alias_installer_calls: z.strictObject({
      total: z.number().int().nonnegative(),
      forwarding_installer_proven: z.number().int().nonnegative(),
      semantics_proven: z.number().int().nonnegative(),
    }),
    analysis_source_sha256: digestSchema,
    safe_static_only: z.literal(true),
    presentation_formatted: z.literal(false),
    runtime_semantics_preserved_by_design: z.literal(true),
  }),
  analysis_input: z.strictObject({
    input_path: analyzeJavaScriptApplicationInputSchema.shape.input_path,
    format: z.literal("directory"),
  }),
  runtime_execution: z.literal("not-performed"),
  limitations: z.array(z.string()),
});

export type JavaScriptDeobfuscationInput = z.output<
  typeof javascriptDeobfuscationInputSchema
>;
export type JavaScriptDeobfuscationResult = z.output<
  typeof javascriptDeobfuscationResultSchema
>;
