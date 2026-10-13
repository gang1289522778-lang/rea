import { describe, expect, it } from "vitest";
import { buildClassFile } from "../../tests/fixtures/java/classFile.js";
import {
  JavaClassFormatFailure,
  JavaClassResourceFailure,
  parseJavaClassFile,
} from "./JavaClassFile.js";

describe("parseJavaClassFile", () => {
  it.each([
    { value: Number.NaN, expected: "NaN" },
    { value: Number.POSITIVE_INFINITY, expected: "Infinity" },
    { value: Number.NEGATIVE_INFINITY, expected: "-Infinity" },
    { value: -0, expected: "-0" },
  ])(
    "preserves float $expected in fields, annotations and JSON",
    ({ value, expected }) => {
      const parsed = parseJavaClassFile(
        buildClassFile({
          name: "p/Floats",
          fields: [{ name: "VALUE", descriptor: "F", constant: value }],
          annotations: { "Lp/Marker;": { value } },
        }),
      );
      expect(parsed.fields[0]?.constant_value).toBe(expected);
      expect(parsed.annotations[0]?.elements[0]?.value).toMatchObject({
        kind: "constant",
        descriptor: "F",
        value: expected,
      });
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
    },
  );

  it("bounds repeated string expansion before report serialization", () => {
    const bytes = buildClassFile({
      name: "p/Expansion",
      duplicateStringEntries: { value: "x".repeat(16_000), count: 2000 },
    });
    expect(bytes.length).toBeLessThan(32_000);
    expect(() => parseJavaClassFile(bytes)).toThrow(JavaClassResourceFailure);
  });

  it("rejects Code lengths whose method bytes are missing", () => {
    const bytes = buildClassFile({
      name: "p/TruncatedCode",
      methods: [
        {
          name: "run",
          descriptor: "()V",
          codeBytes: 1,
          declaredCodeBytes: 1000,
        },
      ],
    });
    expect(() => parseJavaClassFile(bytes)).toThrow(JavaClassFormatFailure);
  });

  it("keeps runtime-visible and runtime-invisible annotation provenance", () => {
    const parsed = parseJavaClassFile(
      buildClassFile({
        name: "p/Annotations",
        annotations: { "Lp/Visible;": { value: "visible" } },
        invisibleAnnotations: { "Lp/Invisible;": { value: "invisible" } },
      }),
    );
    expect(parsed.annotations).toMatchObject([
      { type: "Lp/Visible;", visibility: "runtime-visible" },
      { type: "Lp/Invisible;", visibility: "runtime-invisible" },
    ]);
  });

  it("decodes declared structure, literals and annotation values", () => {
    const parsed = parseJavaClassFile(
      buildClassFile({
        name: "com/example/Main",
        superClass: "com/example/Base",
        interfaces: ["java/lang/Runnable"],
        major: 61,
        sourceFile: "Main.java",
        annotations: { "Lcom/example/Marker;": { id: "main" } },
        fields: [
          { name: "WIDE", descriptor: "J", access: 0x19, constant: -2n },
          { name: "NAME", descriptor: "Ljava/lang/String;", constant: "x" },
        ],
        methods: [
          { name: "<init>", descriptor: "()V" },
          { name: "run", descriptor: "()V", access: 0x0401, codeBytes: 7 },
        ],
        strings: ["nul\u0000 and \u{1F600}"],
      }),
    );
    expect(parsed).toMatchObject({
      name: "com/example/Main",
      major: 61,
      java_version: "17",
      access: ["public", "super"],
      super_class: "com/example/Base",
      interfaces: ["java/lang/Runnable"],
      source_file: "Main.java",
      annotations: [
        {
          type: "Lcom/example/Marker;",
          elements: [
            {
              name: "id",
              value: { kind: "constant", descriptor: "s", value: "main" },
            },
          ],
        },
      ],
      fields: [
        {
          name: "WIDE",
          access: ["public", "static", "final"],
          constant_value: "-2",
        },
        { name: "NAME", constant_value: "x" },
      ],
      methods: [
        { name: "<init>", code_bytes: 1 },
        { name: "run", access: ["public", "abstract"], code_bytes: 7 },
      ],
      referenced_classes: ["com/example/Base", "java/lang/Runnable"],
    });
    // Modified UTF-8 NUL and surrogate halves round-trip; ConstantValue strings are pool strings too.
    expect(parsed.string_constants).toEqual(["nul\u0000 and \u{1F600}", "x"]);
  });

  it.each([
    [
      "truncation",
      (bytes: Buffer) => bytes.subarray(0, bytes.length - 1),
      /truncated/u,
    ],
    [
      "trailing bytes",
      (bytes: Buffer) => Buffer.concat([bytes, Buffer.from([0])]),
      /trailing/u,
    ],
    [
      "an unknown constant-pool tag",
      (bytes: Buffer) =>
        Buffer.concat([bytes.subarray(0, 10), Buffer.from([99])]),
      /tag 99/u,
    ],
    [
      "a universal Mach-O header sharing the magic",
      (bytes: Buffer) => Buffer.from([...bytes.subarray(0, 4), 0, 0, 0, 2]),
      /predates JVMS 45/u,
    ],
    [
      "a standard 4-byte UTF-8 sequence",
      (bytes: Buffer) => {
        const marker = Buffer.from("XXXX");
        const at = bytes.indexOf(marker);
        return Buffer.concat([
          bytes.subarray(0, at),
          Buffer.from([0xf0, 0x9f, 0x98, 0x80]),
          bytes.subarray(at + 4),
        ]);
      },
      /modified UTF-8/u,
    ],
  ])("rejects %s", (_name, mutate, message) => {
    const bytes = buildClassFile({ name: "p/A", strings: ["XXXX"] });
    expect(() => parseJavaClassFile(mutate(bytes))).toThrow(
      expect.objectContaining({
        constructor: JavaClassFormatFailure,
        message: expect.stringMatching(message),
      }),
    );
  });
});
