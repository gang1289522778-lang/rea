import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  canonicalInputKeys,
  compatibleToolInputSchema,
  inputKeyAliasesFor,
} from "./inputKeyAliases.js";

const procedureInput = z.strictObject({
  procedure: z.string(),
  document: z.string().optional(),
});
const searchInput = z.strictObject({
  pattern: z.string().min(1),
  mode: z.enum(["literal", "regex"]).default("literal"),
});

describe("named compatible input contracts", () => {
  it("uses compatibility spellings only when they do not collide with existing keys", () => {
    expect(inputKeyAliasesFor(procedureInput)).toEqual({
      address: "procedure",
    });
    expect(inputKeyAliasesFor(searchInput)).toEqual({ query: "pattern" });
    expect(
      inputKeyAliasesFor(
        z.strictObject({ procedure: z.string(), address: z.string() }),
      ),
    ).toEqual({});
  });
  it("preserves caller values and normalizes one parsed representation", () => {
    const caller = {
      address: "0x401000",
      document: "Caller & exact % document",
    };
    expect(canonicalInputKeys(caller, { address: "procedure" })).toEqual({
      procedure: caller.address,
      document: caller.document,
    });
    expect(caller).toEqual({
      address: "0x401000",
      document: "Caller & exact % document",
    });
  });
  it("advertises and parses both accepted spellings while rejecting ambiguity", () => {
    const schema = compatibleToolInputSchema(procedureInput);
    const projected = schema["~standard"].jsonSchema.input({
      target: "draft-2020-12",
    });
    const validate = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile(projected);
    for (const value of [{ procedure: "main" }, { address: "main" }]) {
      expect(validate(value)).toBe(true);
      expect(schema.parse(value)).toEqual({ procedure: "main" });
    }
    for (const value of [
      { procedure: "main", address: "main" },
      { address: 1 },
      ["address"],
    ]) {
      expect(validate(value)).toBe(false);
      expect(schema.safeParse(value).success).toBe(false);
    }
    expect(projected).toMatchObject({
      type: "object",
      anyOf: [
        expect.objectContaining({
          properties: expect.objectContaining({
            procedure: expect.any(Object),
          }),
        }),
        expect.objectContaining({
          properties: expect.objectContaining({ address: expect.any(Object) }),
        }),
      ],
    });
  });
  it("retains canonical value checks, defaults and cross-field refinements", () => {
    const search = compatibleToolInputSchema(searchInput);
    expect(search.parse({ query: "ACCESS" })).toEqual({
      pattern: "ACCESS",
      mode: "literal",
    });
    expect(search.safeParse({ query: "" }).success).toBe(false);
    const annotations = compatibleToolInputSchema(
      procedureInput
        .extend({ comment: z.string().optional() })
        .refine((value) => value.comment !== undefined),
    );
    expect(annotations.safeParse({ address: "main" }).success).toBe(false);
    expect(annotations.parse({ address: "main", comment: "exact" })).toEqual({
      procedure: "main",
      comment: "exact",
    });
  });
  it("parses canonical field transforms exactly once for each spelling", () => {
    const schema = compatibleToolInputSchema(
      z.strictObject({
        procedure: z.string().transform((value) => `${value}!`),
      }),
    );
    expect(schema.parse({ procedure: "main" })).toEqual({ procedure: "main!" });
    expect(schema.parse({ address: "main" })).toEqual({ procedure: "main!" });
  });
  it("does not wrap contracts without compatible keys", () => {
    const original = z.strictObject({ name: z.string() });
    expect(compatibleToolInputSchema(original)).toBe(original);
  });
});
