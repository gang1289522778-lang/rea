import {
  javaVersionLabel,
  type JavaAnnotation,
  type JavaAnnotationValue,
  type JavaClass,
} from "../domain/java/javaArchive.js";

/** The bytes are not a well-formed JVM class file within the supported profile. */
export class JavaClassFormatFailure extends Error {
  override readonly name = "JavaClassFormatFailure";
}

/** Expanded text is charged on every pool use before it enters a report. */
export class JavaClassResourceFailure extends Error {
  override readonly name = "JavaClassResourceFailure";
  readonly boundary = "class_report_text_bytes";
  readonly maximum = 16 * 1024 * 1024;
  constructor() {
    super("Expanded class-report text exceeds the 16 MiB JSON text budget.");
  }
}

const CLASS_FLAGS: readonly (readonly [number, string])[] = [
  [0x0001, "public"],
  [0x0010, "final"],
  [0x0020, "super"],
  [0x0200, "interface"],
  [0x0400, "abstract"],
  [0x1000, "synthetic"],
  [0x2000, "annotation"],
  [0x4000, "enum"],
  [0x8000, "module"],
];
const FIELD_FLAGS: readonly (readonly [number, string])[] = [
  [0x0001, "public"],
  [0x0002, "private"],
  [0x0004, "protected"],
  [0x0008, "static"],
  [0x0010, "final"],
  [0x0040, "volatile"],
  [0x0080, "transient"],
  [0x1000, "synthetic"],
  [0x4000, "enum"],
];
const METHOD_FLAGS: readonly (readonly [number, string])[] = [
  [0x0001, "public"],
  [0x0002, "private"],
  [0x0004, "protected"],
  [0x0008, "static"],
  [0x0010, "final"],
  [0x0020, "synchronized"],
  [0x0040, "bridge"],
  [0x0080, "varargs"],
  [0x0100, "native"],
  [0x0400, "abstract"],
  [0x0800, "strict"],
  [0x1000, "synthetic"],
];
/** Nested annotation values deeper than this are malformed for analysis purposes. */
const ANNOTATION_DEPTH = 16;

const flagNames = (
  value: number,
  table: readonly (readonly [number, string])[],
): string[] =>
  table.filter(([bit]) => (value & bit) !== 0).map(([, name]) => name);

type PoolEntry =
  | { readonly tag: 1; readonly text: string }
  | { readonly tag: 3; readonly value: number }
  | { readonly tag: 4; readonly value: number | string }
  | { readonly tag: 5 | 6; readonly value: string }
  | { readonly tag: 7 | 8 | 16 | 19 | 20; readonly index: number }
  | {
      readonly tag: 9 | 10 | 11 | 12 | 17 | 18;
      readonly first: number;
      readonly second: number;
    }
  | { readonly tag: 15; readonly kind: number; readonly index: number };

class ByteCursor {
  #offset = 0;
  constructor(readonly bytes: Uint8Array) {}

  get offset(): number {
    return this.#offset;
  }

  #take(length: number): number {
    const start = this.#offset;
    if (length > this.bytes.length - start)
      throw new JavaClassFormatFailure(
        `Class file is truncated at byte ${String(start)}.`,
      );
    this.#offset += length;
    return start;
  }

  u1(): number {
    return this.bytes[this.#take(1)] ?? 0;
  }

  u2(): number {
    const at = this.#take(2);
    return ((this.bytes[at] ?? 0) << 8) | (this.bytes[at + 1] ?? 0);
  }

  u4(): number {
    const at = this.#take(4);
    return (
      ((this.bytes[at] ?? 0) * 0x1000000 +
        (((this.bytes[at + 1] ?? 0) << 16) |
          ((this.bytes[at + 2] ?? 0) << 8) |
          (this.bytes[at + 3] ?? 0))) >>>
      0
    );
  }

  slice(length: number): Uint8Array {
    const at = this.#take(length);
    return this.bytes.subarray(at, at + length);
  }
}

/**
 * Decode JVMS 4.4.7 modified UTF-8 into UTF-16 code units. Supplementary
 * characters arrive as encoded surrogate halves, which JavaScript strings
 * represent directly; standard 4-byte UTF-8 forms are malformed here.
 */
const decodeModifiedUtf8 = (bytes: Uint8Array): string => {
  const units: number[] = [];
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index] ?? 0;
    if (first !== 0 && first < 0x80) {
      units.push(first);
      index += 1;
      continue;
    }
    const second = bytes[index + 1];
    if (
      (first & 0xe0) === 0xc0 &&
      second !== undefined &&
      (second & 0xc0) === 0x80
    ) {
      units.push(((first & 0x1f) << 6) | (second & 0x3f));
      index += 2;
      continue;
    }
    const third = bytes[index + 2];
    if (
      (first & 0xf0) === 0xe0 &&
      second !== undefined &&
      third !== undefined &&
      (second & 0xc0) === 0x80 &&
      (third & 0xc0) === 0x80
    ) {
      units.push(
        ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f),
      );
      index += 3;
      continue;
    }
    throw new JavaClassFormatFailure(
      `Constant-pool text has invalid modified UTF-8 at byte ${String(index)}.`,
    );
  }
  let text = "";
  for (let start = 0; start < units.length; start += 8192)
    text += String.fromCharCode(...units.slice(start, start + 8192));
  return text;
};

/** Preserve legal IEEE special values and signed zero through JSON Evidence. */
const jsonSafeFloatingLiteral = (value: number): number | string =>
  Object.is(value, -0) ? "-0" : Number.isFinite(value) ? value : String(value);

const readPool = (cursor: ByteCursor): (PoolEntry | undefined)[] => {
  const count = cursor.u2();
  if (count === 0)
    throw new JavaClassFormatFailure("Constant pool count must be positive.");
  const pool: (PoolEntry | undefined)[] = [undefined];
  while (pool.length < count) {
    const tag = cursor.u1();
    switch (tag) {
      case 1:
        pool.push({ tag, text: decodeModifiedUtf8(cursor.slice(cursor.u2())) });
        break;
      case 3:
        pool.push({ tag, value: cursor.u4() | 0 });
        break;
      case 4: {
        const view = new DataView(new ArrayBuffer(4));
        view.setUint32(0, cursor.u4());
        pool.push({ tag, value: jsonSafeFloatingLiteral(view.getFloat32(0)) });
        break;
      }
      case 5:
      case 6: {
        const view = new DataView(new ArrayBuffer(8));
        view.setUint32(0, cursor.u4());
        view.setUint32(4, cursor.u4());
        // 64-bit constants stay textual to retain integer precision and IEEE specials.
        const value =
          tag === 5
            ? view.getBigInt64(0).toString()
            : String(jsonSafeFloatingLiteral(view.getFloat64(0)));
        pool.push({ tag, value }, undefined);
        break;
      }
      case 7:
      case 8:
      case 16:
      case 19:
      case 20:
        pool.push({ tag, index: cursor.u2() });
        break;
      case 9:
      case 10:
      case 11:
      case 12:
      case 17:
      case 18:
        pool.push({ tag, first: cursor.u2(), second: cursor.u2() });
        break;
      case 15:
        pool.push({ tag, kind: cursor.u1(), index: cursor.u2() });
        break;
      default:
        throw new JavaClassFormatFailure(
          `Unsupported constant-pool tag ${String(tag)} at entry ${String(pool.length)}.`,
        );
    }
  }
  if (pool.length !== count)
    throw new JavaClassFormatFailure(
      "A 64-bit constant overruns the declared constant-pool count.",
    );
  return pool;
};

class ConstantPool {
  #reportTextBytes = 0;
  readonly #textCosts = new Map<number, number>();
  constructor(readonly entries: readonly (PoolEntry | undefined)[]) {}

  #entry(index: number, what: string): PoolEntry {
    const entry = this.entries[index];
    if (entry === undefined)
      throw new JavaClassFormatFailure(
        `${what} refers to invalid constant-pool entry ${String(index)}.`,
      );
    return entry;
  }

  utf8(index: number, what: string): string {
    const entry = this.#entry(index, what);
    if (entry.tag !== 1)
      throw new JavaClassFormatFailure(
        `${what} entry ${String(index)} is not UTF-8 text.`,
      );
    let cost = this.#textCosts.get(index);
    if (cost === undefined) {
      // JSON escaping can expand one code unit sixfold. Cache the exact encoded
      // cost for each UTF-8 pool entry, but charge every reference independently.
      cost = Buffer.byteLength(JSON.stringify(entry.text), "utf8");
      this.#textCosts.set(index, cost);
    }
    this.#reportTextBytes += cost;
    if (this.#reportTextBytes > 16 * 1024 * 1024)
      throw new JavaClassResourceFailure();
    return entry.text;
  }

  className(index: number, what: string): string {
    const entry = this.#entry(index, what);
    if (entry.tag !== 7)
      throw new JavaClassFormatFailure(
        `${what} entry ${String(index)} is not a class reference.`,
      );
    return this.utf8(entry.index, what);
  }

  constantValue(index: number): string | number {
    const entry = this.#entry(index, "ConstantValue");
    switch (entry.tag) {
      case 3:
      case 4:
      case 5:
      case 6:
        return entry.value;
      case 8:
        return this.utf8(entry.index, "ConstantValue string");
      default:
        throw new JavaClassFormatFailure(
          `ConstantValue entry ${String(index)} is not a literal.`,
        );
    }
  }
}

const readAnnotationValue = (
  cursor: ByteCursor,
  pool: ConstantPool,
  depth: number,
): JavaAnnotationValue => {
  if (depth > ANNOTATION_DEPTH)
    throw new JavaClassFormatFailure("Annotation values nest too deeply.");
  const tag = String.fromCharCode(cursor.u1());
  switch (tag) {
    case "B":
    case "C":
    case "D":
    case "F":
    case "I":
    case "J":
    case "S":
    case "Z": {
      const value = pool.constantValue(cursor.u2());
      return { kind: "constant", descriptor: tag, value };
    }
    case "s":
      return {
        kind: "constant",
        descriptor: "s",
        value: pool.utf8(cursor.u2(), "Annotation string"),
      };
    case "e":
      return {
        kind: "enum",
        type: pool.utf8(cursor.u2(), "Annotation enum type"),
        name: pool.utf8(cursor.u2(), "Annotation enum constant"),
      };
    case "c":
      return {
        kind: "class",
        descriptor: pool.utf8(cursor.u2(), "Annotation class"),
      };
    case "@":
      return {
        kind: "annotation",
        annotation: readAnnotation(cursor, pool, depth + 1),
      };
    case "[": {
      const count = cursor.u2();
      const values: JavaAnnotationValue[] = [];
      for (let index = 0; index < count; index += 1)
        values.push(readAnnotationValue(cursor, pool, depth + 1));
      return { kind: "array", values };
    }
    default:
      throw new JavaClassFormatFailure(
        `Unsupported annotation element tag ${JSON.stringify(tag)}.`,
      );
  }
};

const readAnnotation = (
  cursor: ByteCursor,
  pool: ConstantPool,
  depth: number,
  visibility: JavaAnnotation["visibility"] = null,
): JavaAnnotation => {
  const type = pool.utf8(cursor.u2(), "Annotation type");
  const count = cursor.u2();
  const elements: JavaAnnotation["elements"] = [];
  for (let index = 0; index < count; index += 1)
    elements.push({
      name: pool.utf8(cursor.u2(), "Annotation element name"),
      value: readAnnotationValue(cursor, pool, depth),
    });
  return { type, visibility, elements };
};

interface ParsedAttributes {
  annotations: JavaAnnotation[];
  sourceFile: string | null;
  signature: string | null;
  constantValue: string | number | null;
  codeBytes: number | null;
}

const readAttributes = (
  cursor: ByteCursor,
  pool: ConstantPool,
  owner: string,
): ParsedAttributes => {
  const parsed: ParsedAttributes = {
    annotations: [],
    sourceFile: null,
    signature: null,
    constantValue: null,
    codeBytes: null,
  };
  const count = cursor.u2();
  for (let index = 0; index < count; index += 1) {
    const name = pool.utf8(cursor.u2(), `${owner} attribute name`);
    const body = new ByteCursor(cursor.slice(cursor.u4()));
    switch (name) {
      case "RuntimeVisibleAnnotations":
      case "RuntimeInvisibleAnnotations": {
        const annotations = body.u2();
        for (let item = 0; item < annotations; item += 1)
          parsed.annotations.push(
            readAnnotation(
              body,
              pool,
              0,
              name === "RuntimeVisibleAnnotations"
                ? "runtime-visible"
                : "runtime-invisible",
            ),
          );
        break;
      }
      case "SourceFile":
        parsed.sourceFile = pool.utf8(body.u2(), "SourceFile");
        break;
      case "Signature":
        parsed.signature = pool.utf8(body.u2(), "Signature");
        break;
      case "ConstantValue":
        parsed.constantValue = pool.constantValue(body.u2());
        break;
      case "Code":
        body.u2();
        body.u2();
        parsed.codeBytes = body.u4();
        body.slice(parsed.codeBytes);
        // Verify the Code structure without interpreting instructions.
        body.slice(body.u2() * 8);
        for (
          let attributes = body.u2(), item = 0;
          item < attributes;
          item += 1
        ) {
          pool.utf8(body.u2(), "Code attribute name");
          body.slice(body.u4());
        }
        if (body.offset !== body.bytes.length)
          throw new JavaClassFormatFailure(
            "Code attribute has trailing bytes.",
          );
        break;
      default:
        break;
    }
  }
  return parsed;
};

/** Parse one class file's declared structure; method bodies are measured, not decoded. */
export const parseJavaClassFile = (bytes: Uint8Array): JavaClass => {
  const cursor = new ByteCursor(bytes);
  if (cursor.u4() !== 0xcafebabe)
    throw new JavaClassFormatFailure("Missing 0xCAFEBABE class-file magic.");
  const minor = cursor.u2();
  const major = cursor.u2();
  if (major < 45)
    throw new JavaClassFormatFailure(
      `Class-file major version ${String(major)} predates JVMS 45.`,
    );
  const pool = new ConstantPool(readPool(cursor));
  const access = cursor.u2();
  const name = pool.className(cursor.u2(), "this_class");
  const superIndex = cursor.u2();
  const superClass =
    superIndex === 0 ? null : pool.className(superIndex, "super_class");
  const interfaces: string[] = [];
  for (let count = cursor.u2(), index = 0; index < count; index += 1)
    interfaces.push(pool.className(cursor.u2(), "interfaces"));
  const fields: JavaClass["fields"] = [];
  for (let count = cursor.u2(), index = 0; index < count; index += 1) {
    const fieldAccess = cursor.u2();
    const fieldName = pool.utf8(cursor.u2(), "Field name");
    const descriptor = pool.utf8(cursor.u2(), "Field descriptor");
    const attributes = readAttributes(cursor, pool, "Field");
    fields.push({
      name: fieldName,
      descriptor,
      access: flagNames(fieldAccess, FIELD_FLAGS),
      signature: attributes.signature,
      constant_value: attributes.constantValue,
      annotations: attributes.annotations,
    });
  }
  const methods: JavaClass["methods"] = [];
  for (let count = cursor.u2(), index = 0; index < count; index += 1) {
    const methodAccess = cursor.u2();
    const methodName = pool.utf8(cursor.u2(), "Method name");
    const descriptor = pool.utf8(cursor.u2(), "Method descriptor");
    const attributes = readAttributes(cursor, pool, "Method");
    methods.push({
      name: methodName,
      descriptor,
      access: flagNames(methodAccess, METHOD_FLAGS),
      signature: attributes.signature,
      code_bytes: attributes.codeBytes,
      annotations: attributes.annotations,
    });
  }
  const attributes = readAttributes(cursor, pool, "Class");
  if (cursor.offset !== bytes.length)
    throw new JavaClassFormatFailure(
      `Class file has ${String(bytes.length - cursor.offset)} trailing bytes.`,
    );
  const strings: string[] = [];
  const referenced = new Set<string>();
  for (const entry of pool.entries) {
    if (entry?.tag === 8) strings.push(pool.utf8(entry.index, "String"));
    if (entry?.tag === 7) {
      const referencedName = pool.utf8(entry.index, "Class");
      if (referencedName !== name) referenced.add(referencedName);
    }
  }
  return {
    name,
    major,
    minor,
    java_version: javaVersionLabel(major),
    access: flagNames(access, CLASS_FLAGS),
    super_class: superClass,
    interfaces,
    source_file: attributes.sourceFile,
    signature: attributes.signature,
    annotations: attributes.annotations,
    fields,
    methods,
    string_constants: strings,
    referenced_classes: [...referenced],
  };
};
