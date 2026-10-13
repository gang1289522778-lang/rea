import { z } from "zod";
import { digestSchema } from "../digests.js";
import { localPathStringSchema } from "../localPath.js";

export const RUST_AUDITABLE_FORMAT_VERSION = 1;

const index = z.number().int().nonnegative();
const rustcHash = z.string().regex(/^[0-9a-f]{40}$/u);

/** One embedded package, with omitted kind and root preserved as null and false. */
export const rustPackageSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().min(1),
  source: z.string().min(1),
  kind: z.enum(["runtime", "build"]).nullable(),
  dependencies: z.array(index),
  root: z.boolean(),
});

const dependencyEdgeSchema = z.strictObject({
  from_index: index,
  to_index: index,
});

/** zlib JSON from one `.dep-v0` section, in the section's package order. */
export const rustAuditableMetadataSchema = z.strictObject({
  section_name: z.enum([".dep-v0", "__DATA,.dep-v0"]),
  file_offset: index,
  section_bytes: z.number().int().positive(),
  compressed_bytes: z.number().int().positive(),
  uncompressed_bytes: z.number().int().positive(),
  format_version: z.literal(RUST_AUDITABLE_FORMAT_VERSION).nullable(),
  packages: z.array(rustPackageSchema),
  root_package_index: index.nullable(),
  dependency_edges: z.array(dependencyEdgeSchema),
  cyclic_dependency_indices: z.array(index),
});

/** Inferred compiler id from read-only `/rustc/<40-hex>/` paths. */
export const rustcCommitSchema = z.strictObject({
  evidence_kind: z.literal("inferred"),
  hashes: z
    .array(
      z.strictObject({
        hash: rustcHash,
        file_offset: index,
      }),
    )
    .min(1),
});

/** One explicit local executable or library, independent of a disassembler target. */
export const inspectRustBinaryInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute filesystem path to the selected executable or library",
  ),
});

/** Bounded cargo-auditable observation. A missing section is null, not an empty dependency list. */
export const rustBinarySchema = z
  .strictObject({
    artifact: z.strictObject({
      path: localPathStringSchema,
      sha256: digestSchema,
      bytes: index,
    }),
    format: z.enum(["elf", "pe", "macho"]),
    architecture: z.string(),
    bits: z.union([z.literal(32), z.literal(64)]),
    byte_order: z.enum(["little", "big"]),
    auditable_metadata: rustAuditableMetadataSchema.nullable(),
    rustc_commit: rustcCommitSchema.nullable(),
    limitations: z.array(z.string()),
  })
  .superRefine((report, context) => {
    const metadata = report.auditable_metadata;
    if (metadata !== null) {
      checkSection(report.artifact.bytes, metadata, context);
      checkPackages(metadata, context);
    }
    checkRustc(report.artifact.bytes, report.rustc_commit, context);
  });

export type RustPackage = z.infer<typeof rustPackageSchema>;
export type RustAuditableMetadata = z.infer<typeof rustAuditableMetadataSchema>;
export type RustBinary = z.infer<typeof rustBinarySchema>;
export type InspectRustBinaryInput = z.infer<
  typeof inspectRustBinaryInputSchema
>;

const issue = (
  context: z.RefinementCtx,
  path: (string | number)[],
  message: string,
): void => {
  context.addIssue({ code: "custom", path, message });
};

const inside = (fileBytes: number, offset: number, size: number): boolean =>
  offset <= fileBytes && size <= fileBytes - offset;

const checkSection = (
  fileBytes: number,
  metadata: RustAuditableMetadata,
  context: z.RefinementCtx,
): void => {
  if (
    !inside(fileBytes, metadata.file_offset, metadata.section_bytes) ||
    metadata.compressed_bytes !== metadata.section_bytes
  )
    issue(
      context,
      ["auditable_metadata", "file_offset"],
      "Dependency section range is outside the selected artifact or disagrees with its compressed size.",
    );
};

const checkPackages = (
  metadata: RustAuditableMetadata,
  context: z.RefinementCtx,
): void => {
  const roots: number[] = [];
  const edgesByPackage = new Map<
    number,
    z.infer<typeof dependencyEdgeSchema>[]
  >();
  for (const [position, edge] of metadata.dependency_edges.entries()) {
    if (
      edge.from_index >= metadata.packages.length ||
      edge.to_index >= metadata.packages.length
    ) {
      issue(
        context,
        ["auditable_metadata", "dependency_edges", position],
        "Dependency edge index is outside the package list.",
      );
      continue;
    }
    const grouped = edgesByPackage.get(edge.from_index);
    if (grouped === undefined) edgesByPackage.set(edge.from_index, [edge]);
    else grouped.push(edge);
  }
  for (const [packageIndex, pkg] of metadata.packages.entries()) {
    if (pkg.root) roots.push(packageIndex);
    const edges = edgesByPackage.get(packageIndex) ?? [];
    if (
      edges.length !== pkg.dependencies.length ||
      edges.some((edge, index) => edge.to_index !== pkg.dependencies[index])
    )
      issue(
        context,
        ["auditable_metadata", "dependency_edges"],
        "Dependency edges do not match package dependency indices.",
      );
    if (pkg.dependencies.some((target) => target >= metadata.packages.length))
      issue(
        context,
        ["auditable_metadata", "packages", packageIndex, "dependencies"],
        "Dependency index is outside the package list.",
      );
  }
  const root = metadata.root_package_index;
  if (
    root === null ? roots.length !== 0 : roots.length !== 1 || roots[0] !== root
  )
    issue(
      context,
      ["auditable_metadata", "root_package_index"],
      "Root package index does not match packages marked root.",
    );
  for (const [
    position,
    cyclic,
  ] of metadata.cyclic_dependency_indices.entries()) {
    const previous = metadata.cyclic_dependency_indices[position - 1];
    if (
      cyclic >= metadata.packages.length ||
      (previous !== undefined && cyclic <= previous)
    )
      issue(
        context,
        ["auditable_metadata", "cyclic_dependency_indices", position],
        "Cyclic dependency indices must be unique, sorted, and inside the package list.",
      );
  }
};

const checkRustc = (
  fileBytes: number,
  commit: RustBinary["rustc_commit"],
  context: z.RefinementCtx,
): void => {
  if (commit === null) return;
  const seen = new Set<string>();
  for (const [position, entry] of commit.hashes.entries()) {
    if (seen.has(entry.hash) || !inside(fileBytes, entry.file_offset, 48))
      issue(
        context,
        ["rustc_commit", "hashes", position],
        "rustc path hash is duplicated or its file offset is outside the artifact.",
      );
    seen.add(entry.hash);
  }
};
