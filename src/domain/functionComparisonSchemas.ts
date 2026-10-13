import { z } from "zod";
import { evidenceSchema } from "./evidence.js";
import { digestSchema } from "./../domain/digests.js";
import { prefixedDigestSchema } from "./../domain/digests.js";

const comparisonStatusSchema = z.enum(["unchanged", "changed", "unknown"]);
export const FUNCTION_DIMENSION_NAMES = [
  "identity",
  "pseudocode",
  "assembly",
  "comments",
  "calls",
  "references",
  "strings_names",
  "cfg",
] as const;
export const functionComparisonDimensionNameSchema = z.enum(
  FUNCTION_DIMENSION_NAMES,
);
const evidenceIdSchema = prefixedDigestSchema("ev");

/** Opt-in address-normalized text views; the eight exact dimensions are unchanged. */
export const NORMALIZED_VIEW_DIMENSIONS = [
  "pseudocode_normalized",
  "assembly_normalized",
] as const;
const normalizedViewDimensionSchema = z.enum(NORMALIZED_VIEW_DIMENSIONS);

/** Recognize one opt-in normalized view name without widening the exact set. */
export const isNormalizedViewDimension = (
  dimension: string,
): dimension is NormalizedViewDimension =>
  NORMALIZED_VIEW_DIMENSIONS.some((name) => name === dimension);

/** Inputs for explicit function-to-function comparison. */
export const functionComparisonInputSchema = z.strictObject({
  left: evidenceSchema,
  right: evidenceSchema,
  include_normalized_views: z
    .boolean()
    .default(false)
    .describe(
      "Opt in to separate address-normalized pseudocode and assembly views beside the eight exact dimensions. Exact dimensions, changes, summary counts, and overall status keep their current meaning. Normalized views replace recognized address-derived identifiers and dossier-corroborated addresses with ordinal placeholders, so normalized equality does not establish that both sides reference the same procedure, data, or label.",
    ),
});

const textDeltaSchema = z.object({
  added_lines: z.number().int().min(0),
  removed_lines: z.number().int().min(0),
  hunks: z.number().int().min(0),
});

const functionDimensionContextShape = {
  dimension: functionComparisonDimensionNameSchema,
  left_count: z.number().int().min(0).nullable(),
  right_count: z.number().int().min(0).nullable(),
  evidence_links: z.array(evidenceIdSchema).min(2),
  limitations: z.array(z.string()),
};

const functionDimensionSchema = z.union([
  z.object({
    ...functionDimensionContextShape,
    status: z.literal("unchanged"),
    left_digest: digestSchema,
    right_digest: digestSchema,
    text_delta: textDeltaSchema.nullable(),
    conclusion_kind: z.literal("derived_relationship"),
  }),
  z.object({
    ...functionDimensionContextShape,
    status: z.literal("changed"),
    left_digest: digestSchema,
    right_digest: digestSchema,
    text_delta: textDeltaSchema.nullable(),
    conclusion_kind: z.enum(["derived_relationship", "contradiction"]),
  }),
  z.object({
    ...functionDimensionContextShape,
    status: z.literal("unknown"),
    left_digest: z.null(),
    right_digest: z.null(),
    text_delta: z.null(),
    conclusion_kind: z.literal("unresolved_branch"),
  }),
]);

/** Counts of what one side's normalization masked and what it deliberately left visible. */
const maskingCountsSchema = z.strictObject({
  address_derived_identifiers: z.number().int().min(0),
  unmasked_address_derived_identifiers: z.number().int().min(0),
  corroborated_addresses: z.number().int().min(0),
  visible_addresses: z.number().int().min(0),
});
const maskingRuleSchema = z.strictObject({
  rule: z.string().min(1),
  description: z.string().min(1),
});
const maskingSchema = z.strictObject({
  policy: z.literal("rea-address-normalized-text-v1"),
  provider_id: z.string().min(1),
  rules: z.array(maskingRuleSchema).min(1),
  left: maskingCountsSchema,
  right: maskingCountsSchema,
});
const normalizedViewContextShape = {
  dimension: normalizedViewDimensionSchema,
  left_digest: digestSchema.nullable(),
  right_digest: digestSchema.nullable(),
  left_count: z.number().int().min(0).nullable(),
  right_count: z.number().int().min(0).nullable(),
  text_delta: textDeltaSchema.nullable(),
  evidence_links: z.array(evidenceIdSchema).min(2),
  masking: maskingSchema.nullable(),
  limitations: z.array(z.string()),
};

/** One opt-in normalized text view; absent masking reports why the view is unknown. */
const normalizedTextViewSchema = z.union([
  z.object({
    ...normalizedViewContextShape,
    status: z.literal("unchanged"),
    masking: maskingSchema,
    conclusion_kind: z.literal("derived_relationship"),
  }),
  z.object({
    ...normalizedViewContextShape,
    status: z.literal("changed"),
    masking: maskingSchema,
    conclusion_kind: z.literal("derived_relationship"),
  }),
  z.object({
    ...normalizedViewContextShape,
    status: z.literal("unknown"),
    left_digest: z.null(),
    right_digest: z.null(),
    left_count: z.null(),
    right_count: z.null(),
    text_delta: z.null(),
    masking: z.null(),
    conclusion_kind: z.literal("unresolved_branch"),
  }),
]);

/** Deterministic opt-in normalized text views beside the exact dimensions. */
export const functionNormalizedViewsSchema = z
  .strictObject({
    policy: z.literal("rea-address-normalized-text-v1"),
    views: z.array(normalizedTextViewSchema).length(2),
    limitations: z.array(z.string()),
  })
  .superRefine((normalizedViews, context) => {
    for (const dimension of NORMALIZED_VIEW_DIMENSIONS) {
      if (
        normalizedViews.views.filter((view) => view.dimension === dimension)
          .length !== 1
      )
        context.addIssue({
          code: "custom",
          message: `Expected exactly one ${dimension} view`,
          path: ["views"],
        });
    }
  });

const functionMatchSchema = z.union([
  z.object({
    status: z.literal("matched"),
    method: z.literal("symbol"),
    left_name: z.string(),
    right_name: z.string(),
  }),
  z.object({
    status: z.enum(["mismatched", "ambiguous"]),
    method: z.literal("explicit"),
    left_name: z.string(),
    right_name: z.string(),
  }),
]);

/** Deterministic dimension-classified function comparison Evidence payload. */
export const functionComparisonResultSchema = z.object({
  status: comparisonStatusSchema,
  function_match: functionMatchSchema,
  left_subject_sha256: digestSchema,
  right_subject_sha256: digestSchema,
  summary: z.object({
    unchanged: z.number().int().min(0),
    changed: z.number().int().min(0),
    unknown: z.number().int().min(0),
  }),
  dimensions: z.array(functionDimensionSchema).length(8),
  changes: z.array(functionDimensionSchema),
  normalized_views: functionNormalizedViewsSchema.optional(),
  limitations: z.array(z.string()),
});

export type FunctionComparisonResult = z.infer<
  typeof functionComparisonResultSchema
>;
export type FunctionDimension = z.infer<typeof functionDimensionSchema>;
export type DimensionName = z.infer<
  typeof functionComparisonDimensionNameSchema
>;
export type NormalizedViewDimension = z.infer<
  typeof normalizedViewDimensionSchema
>;
export type NormalizedTextView = z.infer<typeof normalizedTextViewSchema>;
export type MaskingCounts = z.infer<typeof maskingCountsSchema>;
export type FunctionNormalizedViews = z.infer<
  typeof functionNormalizedViewsSchema
>;
