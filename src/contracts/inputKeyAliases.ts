import { z } from "zod";
import { withAdvertisedJsonSchema } from "./toolSchemaMetadata.js";

/** Compatibility spellings accepted by named tool contracts. */
const INPUT_KEY_ALIASES = [
  ["address", "procedure"],
  ["query", "pattern"],
] as const;

/** Compatibility keys apply only when they do not collide with named inputs. */
export const inputKeyAliasesFor = (
  schema: z.ZodObject,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    INPUT_KEY_ALIASES.filter(
      ([alias, canonical]) =>
        Object.hasOwn(schema.shape, canonical) &&
        !Object.hasOwn(schema.shape, alias),
    ),
  );

/** Normalize a parsed compatibility request without mutating caller values. */
export const canonicalInputKeys = (
  value: Readonly<Record<string, unknown>>,
  aliases: Readonly<Record<string, string>>,
): Readonly<Record<string, unknown>> => {
  const normalized = { ...value };
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (!Object.hasOwn(value, alias) || Object.hasOwn(value, canonical))
      continue;
    normalized[canonical] = value[alias];
    delete normalized[alias];
  }
  return normalized;
};

/**
 * One contract owns both accepted input spellings and canonical parsed output.
 * Strict alternatives reject a request containing both spellings. JSON Schema
 * input projection advertises those same alternatives to validating MCP hosts.
 */
export const compatibleToolInputSchema = <Schema extends z.ZodObject>(
  schema: Schema,
): z.ZodType<z.output<Schema>> => {
  const aliases = inputKeyAliasesFor(schema);
  if (Object.keys(aliases).length === 0) return schema;
  let shapes: z.ZodRawShape[] = [schema.shape];
  for (const [alias, canonical] of Object.entries(aliases))
    shapes = shapes.flatMap((shape) => {
      const alternative = { ...shape };
      alternative[alias] = alternative[canonical]!;
      delete alternative[canonical];
      return [shape, alternative];
    });
  const accepted = z.union(shapes.map((shape) => z.strictObject(shape)));
  const canonical = z.preprocess((value, context) => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return value;
    const input = Object.fromEntries(Object.entries(value));
    for (const [alias, key] of Object.entries(aliases)) {
      if (Object.hasOwn(input, alias) && Object.hasOwn(input, key)) {
        context.addIssue({
          code: "custom",
          message: `Supply either ${key} or ${alias}, not both`,
        });
        return z.NEVER;
      }
    }
    return canonicalInputKeys(input, aliases);
  }, schema);
  return withAdvertisedJsonSchema(canonical, "input", () => (options) => {
    const projected = accepted["~standard"].jsonSchema.input(options);
    // Existing input presentation owns flattening for hosts that prohibit root
    // unions; keep the exact accepted alternatives here for schema consumers.
    return {
      ...projected,
      type: "object",
      description: [
        schema.description,
        `Supply one spelling for each input: ${Object.entries(aliases)
          .map(([alias, key]) => `${key} or ${alias}`)
          .join("; ")}. Supplying both spellings is invalid.`,
      ]
        .filter((text) => text !== undefined)
        .join(" "),
    };
  });
};
