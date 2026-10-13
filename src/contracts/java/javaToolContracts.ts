import {
  javaClassSelectionInputSchema,
  inspectJavaArchiveInputSchema,
  javaArchiveSchema,
  javaClassReportSchema,
  javaDecompilationSchema,
} from "../../domain/java/javaArchive.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";

/** JVM bytecode artifacts, independent of the APK/DEX lane and active native targets. */
export const JAVA_TOOL_CONTRACTS = [
  {
    name: "inspect_java_archive",
    ...toolContractMetadata("inspect_java_archive"),
    kind: "artifact-provider",
    description:
      "Inventory an explicit local JAR (or other ZIP-backed JVM archive) or single .class file with REA's bundled class-file reader. Returns exact byte SHA-256, the manifest main section, framework descriptors (Forge mcmod.info/mods.toml, Fabric, Quilt, Bukkit, Velocity, Spring Boot, service providers) as text, entry counts, native libraries, nested archives, signature files, bytecode versions, per-package class counts and a stable name-sorted page of class rows (super class, interfaces, member counts, SourceFile). query filters binary class names by case-sensitive substring; follow classes.next_offset for more rows. name_obfuscation is a labeled heuristic over identifiers of at most two characters, not proof of a specific obfuscator. Requires no Java runtime; never loads, verifies or runs target bytecode, writes no files and accesses no network. For APK/DEX use the Android tools.",
    inputSchema: inspectJavaArchiveInputSchema,
    outputSchema: evidenceResultOf(javaArchiveSchema),
    examples: [
      {
        title: "Inventory a Minecraft mod JAR",
        input: { path: "/artifacts/mod.jar", offset: 0, limit: 100 },
      },
      {
        title: "Find classes in one package",
        input: {
          path: "/artifacts/app.jar",
          query: "com/example/net/",
          offset: 0,
          limit: 100,
        },
      },
    ],
  },
  {
    name: "inspect_java_class",
    ...toolContractMetadata("inspect_java_class"),
    kind: "artifact-provider",
    description:
      "Parse one exact class from an explicit local JAR (class_name in dotted or slash binary form, required) or a single .class file (class_name optional; it must match). Returns access flags, super class, interfaces, generic signatures, class/field/method annotations with element values, fields with JVM descriptors and ConstantValue literals, methods with descriptors and code length, every constant-pool string literal, referenced classes and sibling nested-class entries. String literals stay readable under renaming obfuscation and often reveal behavior. Uses REA's bundled reader without a Java runtime; method bodies are measured, not decoded or run. Use decompile_java_class for source.",
    inputSchema: javaClassSelectionInputSchema,
    outputSchema: evidenceResultOf(javaClassReportSchema),
    examples: [
      {
        title: "Inspect an obfuscated class",
        input: {
          path: "/artifacts/mod.jar",
          class_name: "io.github.example.mod.a",
        },
      },
    ],
  },
  {
    name: "decompile_java_class",
    ...toolContractMetadata("decompile_java_class"),
    kind: "artifact-provider",
    description:
      "Decompile one exact class (with its nested classes) from an explicit local JAR or .class file to Java source using a caller-supplied Vineflower JAR (absolute REA_VINEFLOWER_JAR) and Java 17+ (JAVA_HOME or PATH). The complete selected archive is library context. Returns the complete source with its SHA-256, the exact staged entries, the engine JAR SHA-256 and observed Implementation-Version, and Vineflower's not-decompiled marker count. Decompiled source is a derived representation: renamed identifiers stay as found and local names are synthesized. Works on private copies; the target's classes are never loaded or run. No installation or network access.",
    inputSchema: javaClassSelectionInputSchema,
    outputSchema: evidenceResultOf(javaDecompilationSchema),
    examples: [
      {
        title: "Decompile a mod entry class",
        input: {
          path: "/artifacts/mod.jar",
          class_name: "io.github.example.mod.Main",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
