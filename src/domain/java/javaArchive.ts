import { createHash } from "node:crypto";
import { z } from "zod";
import { digestSchema } from "../digests.js";
import { jsonValueSchema } from "../jsonValue.js";
import { localPathStringSchema } from "../localPath.js";

/** Bundled class-file reader identity; observed bytecode versions are separate facts. */
export const JAVA_CLASSFILE_PROVIDER_IDENTITY = {
  id: "java-classfile",
  name: "REA Java class-file reader",
  version: "1",
} as const;

/** Caller-supplied decompiler; its observed release is recorded per Evidence. */
export const VINEFLOWER_PROVIDER_IDENTITY = {
  id: "vineflower",
  name: "Vineflower",
  version: null,
} as const;

/** Environment key selecting the caller's Vineflower JAR. */
export const VINEFLOWER_JAR_ENV = "REA_VINEFLOWER_JAR";

/** Annotation element values keep JVMS tags; 64-bit numbers stay decimal text. */
export type JavaAnnotationValue =
  | {
      kind: "constant";
      descriptor: string;
      value: string | number;
    }
  | { kind: "enum"; type: string; name: string }
  | { kind: "class"; descriptor: string }
  | { kind: "annotation"; annotation: JavaAnnotation }
  | { kind: "array"; values: JavaAnnotationValue[] };
export type JavaAnnotation = {
  type: string;
  visibility: "runtime-visible" | "runtime-invisible" | null;
  elements: { name: string; value: JavaAnnotationValue }[];
};

const annotationSchema = z.strictObject({
  type: z.string(),
  visibility: z.enum(["runtime-visible", "runtime-invisible"]).nullable(),
  elements: z.array(
    z.strictObject({ name: z.string(), value: jsonValueSchema }),
  ),
});
const constantSchema = z.union([z.string(), z.number()]).nullable();
/** Selected bytes, classified by content: a ZIP-backed archive or one class file. */
const artifactSchema = z.strictObject({
  path: localPathStringSchema,
  sha256: digestSchema,
  bytes: z.number().int().nonnegative(),
  container: z.enum(["jar", "class"]),
});
const classEntrySchema = z
  .string()
  .min(1)
  .describe(
    "Declared binary class name with dots or slashes, exact archive .class entry path, or inventory entry_id (zip-entry:N). Duplicate paths require entry_id; ambiguous binary names require an exact entry; required for a JAR, omitted for a .class file",
  );

/** Parsed class-file structure; method bodies are measured but not decoded here. */
export const javaClassSchema = z.strictObject({
  name: z.string(),
  major: z.number().int().min(45),
  minor: z.number().int().nonnegative(),
  java_version: z.string(),
  access: z.array(z.string()),
  super_class: z.string().nullable(),
  interfaces: z.array(z.string()),
  source_file: z.string().nullable(),
  signature: z.string().nullable(),
  annotations: z.array(annotationSchema),
  fields: z.array(
    z.strictObject({
      name: z.string(),
      descriptor: z.string(),
      access: z.array(z.string()),
      signature: z.string().nullable(),
      constant_value: constantSchema,
      annotations: z.array(annotationSchema),
    }),
  ),
  methods: z.array(
    z.strictObject({
      name: z.string(),
      descriptor: z.string(),
      access: z.array(z.string()),
      signature: z.string().nullable(),
      code_bytes: z.number().int().nonnegative().nullable(),
      annotations: z.array(annotationSchema),
    }),
  ),
  string_constants: z.array(z.string()),
  referenced_classes: z.array(z.string()),
});

export const inspectJavaArchiveInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute path to a local .jar/.war/.ear ZIP archive or a single .class file",
  ),
  query: z
    .string()
    .optional()
    .describe(
      "Case-sensitive substring filter over binary class names; omitted lists every class",
    ),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(500).default(100),
});

export const javaClassSelectionInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute path to a local JAR or .class file",
  ),
  class_name: classEntrySchema.optional(),
});

const classRowSchema = z.strictObject({
  name: z.string(),
  entry: z.string(),
  entry_id: z.string().nullable(),
  access: z.array(z.string()),
  super_class: z.string().nullable(),
  interfaces: z.array(z.string()),
  major: z.number().int(),
  fields: z.number().int().nonnegative(),
  methods: z.number().int().nonnegative(),
  source_file: z.string().nullable(),
});

/** Archive inventory with paged class rows; heuristics are labeled separately from observations. */
export const javaArchiveSchema = z.strictObject({
  artifact: artifactSchema,
  manifest: z
    .strictObject({
      attributes: z.array(
        z.strictObject({ name: z.string(), value: z.string() }),
      ),
      main_class: z.string().nullable(),
    })
    .nullable(),
  metadata_files: z.array(
    z.strictObject({
      entry: z.string(),
      kind: z.enum([
        "forge-mcmod-info",
        "forge-mods-toml",
        "fabric-mod-json",
        "quilt-mod-json",
        "bukkit-plugin-yml",
        "bungee-plugin-yml",
        "velocity-plugin-json",
        "spring-boot-layers",
        "service-provider",
      ]),
      text: z.string().nullable(),
      truncated: z.boolean(),
    }),
  ),
  entries: z.strictObject({
    total: z.number().int().nonnegative(),
    classes: z.number().int().nonnegative(),
    resources: z.number().int().nonnegative(),
    directories: z.number().int().nonnegative(),
    encrypted: z.number().int().nonnegative(),
    native_libraries: z.array(z.string()),
    nested_archives: z.array(z.string()),
    signature_files: z.array(z.string()),
  }),
  bytecode_versions: z.array(
    z.strictObject({
      major: z.number().int(),
      java_version: z.string(),
      classes: z.number().int().positive(),
    }),
  ),
  packages: z.array(
    z.strictObject({
      name: z.string(),
      classes: z.number().int().positive(),
      short_name_classes: z.number().int().nonnegative(),
    }),
  ),
  name_obfuscation: z.strictObject({
    basis: z.literal("heuristic"),
    assessment: z.enum(["likely", "not-indicated", "insufficient-data"]),
    short_class_names: z.number().int().nonnegative(),
    short_member_names: z.number().int().nonnegative(),
    member_names: z.number().int().nonnegative(),
    signals: z.array(z.string()),
  }),
  classes: z.strictObject({
    query: z.string().nullable(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    total_matching: z.number().int().nonnegative(),
    next_offset: z.number().int().nonnegative().nullable(),
    rows: z.array(classRowSchema),
  }),
  malformed_classes: z.array(
    z.strictObject({ entry: z.string(), reason: z.string() }),
  ),
  limitations: z.array(z.string()),
});

/** One parsed class plus its sibling nested-class entries in the same archive. */
export const javaClassReportSchema = z.strictObject({
  artifact: artifactSchema,
  entry: z.string().nullable(),
  entry_id: z.string().nullable(),
  class: javaClassSchema,
  nested_class_entries: z.array(z.string()),
  limitations: z.array(z.string()),
});

/** Decompiled representation and the exact engine bytes and arguments that produced it. */
export const javaDecompilationSchema = z
  .strictObject({
    artifact: artifactSchema,
    class_name: z.string(),
    entry_id: z.string().nullable(),
    entries: z.array(z.string()).min(1),
    source: z.strictObject({
      representation: z.literal("decompiled-java"),
      text: z.string(),
      sha256: digestSchema,
    }),
    tool_profile: z.strictObject({
      engine: z.literal("vineflower"),
      jar_path: localPathStringSchema,
      jar_sha256: digestSchema,
      implementation_version: z.string().nullable(),
      java_executable: z.string(),
      arguments: z.array(z.string()),
      timeout_ms: z.number().int().positive(),
    }),
    target_execution: z.literal("not-performed"),
    limitations: z.array(z.string()),
  })
  .superRefine((value, context) => {
    if (
      createHash("sha256").update(value.source.text, "utf8").digest("hex") !==
      value.source.sha256
    )
      context.addIssue({
        code: "custom",
        path: ["source", "sha256"],
        message: "Decompiled source digest does not match its UTF-8 text.",
      });
  });

export type JavaClass = z.infer<typeof javaClassSchema>;
export type JavaArchive = z.infer<typeof javaArchiveSchema>;
export type JavaClassReport = z.infer<typeof javaClassReportSchema>;
export type JavaDecompilation = z.infer<typeof javaDecompilationSchema>;
export type InspectJavaArchiveInput = z.infer<
  typeof inspectJavaArchiveInputSchema
>;
export type JavaClassSelectionInput = z.infer<
  typeof javaClassSelectionInputSchema
>;

/** Release names for JVMS 4.1 major versions; minor versions are reported separately. */
export const javaVersionLabel = (major: number): string => {
  if (major >= 49) return String(major - 44);
  return major === 48
    ? "1.4"
    : major === 47
      ? "1.3"
      : major === 46
        ? "1.2"
        : "1.1";
};

/** Archive entry path for a binary class name; dots and slashes are equivalent separators. */
export const javaClassEntryPath = (className: string): string =>
  `${className.replace(/\.class$/u, "").replaceAll(".", "/")}.class`;
