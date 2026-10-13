import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

/** Encode JVMS 4.4.7 modified UTF-8 (NUL and supplementary characters as surrogates). */
const modifiedUtf8 = (text: string): number[] => {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit !== 0 && unit < 0x80) bytes.push(unit);
    else if (unit < 0x800) bytes.push(0xc0 | (unit >> 6), 0x80 | (unit & 0x3f));
    else
      bytes.push(
        0xe0 | (unit >> 12),
        0x80 | ((unit >> 6) & 0x3f),
        0x80 | (unit & 0x3f),
      );
  }
  return bytes;
};

const u2 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
const u4 = (value: number) => [
  (value >>> 24) & 0xff,
  (value >> 16) & 0xff,
  (value >> 8) & 0xff,
  value & 0xff,
];

class PoolBuilder {
  readonly bytes: number[] = [];
  count = 1;
  readonly #keys = new Map<string, number>();

  #add(key: string, entry: number[], slots = 1): number {
    const existing = this.#keys.get(key);
    if (existing !== undefined) return existing;
    const index = this.count;
    this.bytes.push(...entry);
    this.count += slots;
    this.#keys.set(key, index);
    return index;
  }

  utf8(text: string): number {
    const encoded = modifiedUtf8(text);
    return this.#add(`u:${text}`, [1, ...u2(encoded.length), ...encoded]);
  }

  classRef(name: string): number {
    return this.#add(`c:${name}`, [7, ...u2(this.utf8(name))]);
  }

  string(text: string, duplicate = false): number {
    return this.#add(duplicate ? `s:${text}:${this.count}` : `s:${text}`, [
      8,
      ...u2(this.utf8(text)),
    ]);
  }

  integer(value: number): number {
    return this.#add(`i:${String(value)}`, [3, ...u4(value)]);
  }

  float(value: number): number {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value);
    return this.#add(`f:${Object.is(value, -0) ? "-0" : String(value)}`, [
      4,
      ...new Uint8Array(view.buffer),
    ]);
  }

  long(value: bigint): number {
    const view = new DataView(new ArrayBuffer(8));
    view.setBigInt64(0, value);
    return this.#add(
      `j:${value.toString()}`,
      [5, ...new Uint8Array(view.buffer)],
      2,
    );
  }
}

/** Declarative class description for deterministic class-file bytes. */
export interface ClassFixture {
  readonly name: string;
  readonly superClass?: string | null;
  readonly interfaces?: readonly string[];
  readonly major?: number;
  readonly access?: number;
  readonly sourceFile?: string;
  /** String and float-valued class annotations: type descriptor -> element values. */
  readonly annotations?: Readonly<
    Record<string, Readonly<Record<string, string | number>>>
  >;
  readonly invisibleAnnotations?: Readonly<
    Record<string, Readonly<Record<string, string | number>>>
  >;
  readonly duplicateStringEntries?: {
    readonly value: string;
    readonly count: number;
  };
  readonly fields?: readonly {
    readonly name: string;
    readonly descriptor: string;
    readonly access?: number;
    readonly constant?: number | bigint | string;
  }[];
  readonly methods?: readonly {
    readonly name: string;
    readonly descriptor: string;
    readonly access?: number;
    readonly codeBytes?: number;
    readonly declaredCodeBytes?: number;
  }[];
  readonly strings?: readonly string[];
}

/** Build a structurally valid class file; method bodies are `return` padding only. */
export const buildClassFile = (fixture: ClassFixture): Buffer => {
  const pool = new PoolBuilder();
  const thisClass = pool.classRef(fixture.name);
  const superClass =
    fixture.superClass === null
      ? 0
      : pool.classRef(fixture.superClass ?? "java/lang/Object");
  const interfaces = (fixture.interfaces ?? []).map((name) =>
    pool.classRef(name),
  );
  for (const text of fixture.strings ?? []) pool.string(text);
  if (fixture.duplicateStringEntries !== undefined)
    for (
      let index = 0;
      index < fixture.duplicateStringEntries.count;
      index += 1
    )
      pool.string(fixture.duplicateStringEntries.value, true);
  const fields = (fixture.fields ?? []).map((field) => {
    const attributes: number[] = [];
    if (field.constant !== undefined) {
      const index =
        typeof field.constant === "string"
          ? pool.string(field.constant)
          : typeof field.constant === "bigint"
            ? pool.long(field.constant)
            : field.descriptor === "F"
              ? pool.float(field.constant)
              : pool.integer(field.constant);
      attributes.push(
        ...u2(pool.utf8("ConstantValue")),
        ...u4(2),
        ...u2(index),
      );
    }
    return [
      ...u2(field.access ?? 0x0001),
      ...u2(pool.utf8(field.name)),
      ...u2(pool.utf8(field.descriptor)),
      ...u2(attributes.length === 0 ? 0 : 1),
      ...attributes,
    ];
  });
  const methods = (fixture.methods ?? []).map((method) => {
    const code = Array.from({ length: method.codeBytes ?? 1 }, () => 0xb1);
    const body = [
      ...u2(1),
      ...u2(1),
      ...u4(method.declaredCodeBytes ?? code.length),
      ...code,
      ...u2(0),
      ...u2(0),
    ];
    return [
      ...u2(method.access ?? 0x0001),
      ...u2(pool.utf8(method.name)),
      ...u2(pool.utf8(method.descriptor)),
      ...u2(1),
      ...u2(pool.utf8("Code")),
      ...u4(body.length),
      ...body,
    ];
  });
  const classAttributes: number[][] = [];
  if (fixture.sourceFile !== undefined)
    classAttributes.push([
      ...u2(pool.utf8("SourceFile")),
      ...u4(2),
      ...u2(pool.utf8(fixture.sourceFile)),
    ]);
  for (const [attribute, values] of [
    ["RuntimeVisibleAnnotations", fixture.annotations],
    ["RuntimeInvisibleAnnotations", fixture.invisibleAnnotations],
  ] as const) {
    const annotations = Object.entries(values ?? {});
    if (annotations.length === 0) continue;
    const body = [...u2(annotations.length)];
    for (const [type, elements] of annotations) {
      body.push(...u2(pool.utf8(type)), ...u2(Object.keys(elements).length));
      for (const [name, value] of Object.entries(elements))
        body.push(
          ...u2(pool.utf8(name)),
          (typeof value === "number" ? "F" : "s").charCodeAt(0),
          ...u2(
            typeof value === "number" ? pool.float(value) : pool.utf8(value),
          ),
        );
    }
    classAttributes.push([
      ...u2(pool.utf8(attribute)),
      ...u4(body.length),
      ...body,
    ]);
  }
  return Buffer.from([
    ...u4(0xcafebabe),
    ...u2(0),
    ...u2(fixture.major ?? 52),
    ...u2(pool.count),
    ...pool.bytes,
    ...u2(fixture.access ?? 0x0021),
    ...u2(thisClass),
    ...u2(superClass),
    ...u2(interfaces.length),
    ...interfaces.flatMap(u2),
    ...u2(fields.length),
    ...fields.flat(),
    ...u2(methods.length),
    ...methods.flat(),
    ...u2(classAttributes.length),
    ...classAttributes.flat(),
  ]);
};

/** Write named entries into an in-memory ZIP archive in the given order. */
export const buildJar = async (
  entries: readonly (readonly [string, Uint8Array | string])[],
): Promise<Buffer> => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (const [name, content] of entries)
    await writer.add(
      name,
      new Uint8ArrayReader(
        typeof content === "string" ? Buffer.from(content, "utf8") : content,
      ),
    );
  return Buffer.from(await writer.close());
};

/** A small renamed-identifier mod beside an unobfuscated library, as ProGuard leaves it. */
export const createObfuscatedModJar = (): Promise<Buffer> => {
  const obfuscated = ["a", "b", "c", "d", "e", "f"].map(
    (name) =>
      [
        `com/example/mod/${name}.class`,
        buildClassFile({
          name: `com/example/mod/${name}`,
          fields: [{ name: "a", descriptor: "I" }],
          methods: [
            { name: "<init>", descriptor: "()V" },
            { name: "a", descriptor: "()V" },
            { name: "b", descriptor: "(Ljava/lang/String;)Z" },
          ],
          strings: [`token-${name}`],
        }),
      ] as const,
  );
  return buildJar([
    [
      "META-INF/MANIFEST.MF",
      "Manifest-Version: 1.0\r\nMain-Class: com.exam\r\n ple.mod.Main\r\n\r\nName: x\r\nIgnored: yes\r\n",
    ],
    ["mcmod.info", '[{"modid":"examplemod","version":"1.0"}]'],
    [
      "com/example/mod/Main.class",
      buildClassFile({
        name: "com/example/mod/Main",
        major: 50,
        sourceFile: "Main.java",
        annotations: {
          "Lnet/minecraftforge/fml/common/Mod;": {
            modid: "examplemod",
            version: "1.0",
          },
        },
        fields: [
          {
            name: "VERSION",
            descriptor: "Ljava/lang/String;",
            access: 0x19,
            constant: "1.0",
          },
          { name: "SEED", descriptor: "J", access: 0x19, constant: -2n },
        ],
        methods: [
          { name: "preInit", descriptor: "()V", access: 0x09, codeBytes: 3 },
        ],
        strings: ["Example \u{1F600}\u0000 loaded"],
      }),
    ],
    [
      "com/example/mod/Main$Inner.class",
      buildClassFile({ name: "com/example/mod/Main$Inner" }),
    ],
    ...obfuscated,
    [
      "org/library/Helper.class",
      buildClassFile({
        name: "org/library/Helper",
        interfaces: ["java/lang/Runnable"],
        methods: [{ name: "run", descriptor: "()V" }],
      }),
    ],
    ["native/linux-x86-64/libhelper.so", "\u007fELF"],
    [
      "org/library/broken.class",
      Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52, 0]),
    ],
  ]);
};
