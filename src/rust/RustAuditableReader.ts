import { deflateSync, inflateSync } from "node:zlib";
import { z } from "zod";
import {
  RUST_AUDITABLE_FORMAT_VERSION,
  type RustAuditableMetadata,
  type RustPackage,
} from "../domain/rust/rustBinary.js";

/** Selected-file admission limit shared with the stable artifact reader. */
export const RUST_BINARY_INPUT_BYTES = 256 * 1024 * 1024;
/** Compressed `.dep-v0` section limit. */
export const RUST_SECTION_BYTES = 1024 * 1024;
/** Inflated JSON may grow by at most this multiple of the section size. */
export const RUST_INFLATE_RATIO = 64;
/** Absolute inflated JSON limit, applied together with the ratio. */
export const RUST_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;
/** Complete normalized report limit. */
export const RUST_OUTPUT_BYTES = 8 * 1024 * 1024;

const JSON_DEPTH = 32;
const packageSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().min(1),
  source: z.string().min(1),
  kind: z.enum(["runtime", "build"]).optional(),
  dependencies: z.array(z.number().int().nonnegative()).optional(),
  root: z.boolean().optional(),
});
const documentVersionSchema = z.object({
  format: z.number().int().nonnegative().optional(),
});
const documentSchema = documentVersionSchema
  .extend({
    format: z.literal(RUST_AUDITABLE_FORMAT_VERSION).optional(),
    packages: z.array(packageSchema),
  })
  .strict();

/** Malformed or unsupported dependency-section bytes. */
export class RustAuditableFormatFailure extends Error {
  constructor(
    readonly kind: "malformed" | "unsupported",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RustAuditableFormatFailure";
  }
}

/** A resource admission limit with explicit semantic units. */
export type RustAuditableConstraint =
  | {
      readonly resource: "memory";
      readonly reported_limits: { readonly maximum_bytes: number };
    }
  | {
      readonly resource: "transport";
      readonly reported_limits: { readonly maximum_output_bytes: number };
    }
  | {
      readonly resource: "capacity";
      readonly reported_limits: { readonly maximum_rustc_hashes: number };
    };

/** Admission refused before retained output or graph expansion. */
export class RustAuditableResourceFailure extends Error {
  constructor(
    readonly constraint: RustAuditableConstraint,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RustAuditableResourceFailure";
  }
}

/** Parsed section payload. Cycles are listed and are not walked. */
export const readAuditableSection = (
  sectionName: RustAuditableMetadata["section_name"],
  fileOffset: number,
  bytes: Buffer,
): RustAuditableMetadata => {
  if (bytes.length === 0)
    throw new RustAuditableFormatFailure(
      "malformed",
      "Dependency section is empty",
    );
  if (bytes.length > RUST_SECTION_BYTES)
    throw new RustAuditableResourceFailure(
      {
        resource: "memory",
        reported_limits: { maximum_bytes: RUST_SECTION_BYTES },
      },
      "Dependency section exceeds the 1 MiB compressed limit",
    );
  const inflated = inflateSection(bytes);
  const document = parseDocument(inflated);
  const packages = normalizePackages(document.packages);
  const root = rootIndex(packages);
  return {
    section_name: sectionName,
    file_offset: fileOffset,
    section_bytes: bytes.length,
    compressed_bytes: bytes.length,
    uncompressed_bytes: inflated.length,
    format_version: document.format ?? null,
    packages,
    root_package_index: root,
    dependency_edges: packages.flatMap((pkg, fromIndex) =>
      pkg.dependencies.map((toIndex) => ({
        from_index: fromIndex,
        to_index: toIndex,
      })),
    ),
    cyclic_dependency_indices: cyclicIndices(packages),
  };
};

const inflateSection = (bytes: Buffer): Buffer => {
  const maximum = Math.min(
    RUST_UNCOMPRESSED_BYTES,
    bytes.length * RUST_INFLATE_RATIO,
  );
  try {
    const inflated = inflateSync(bytes, {
      maxOutputLength: maximum,
      ...(rejectsTrailingJunk() ? { rejectGarbageAfterEnd: true } : {}),
    });
    if (
      !rejectsTrailingJunk() &&
      shortestPrefix(bytes, inflated, maximum) !== bytes.length
    )
      throw new RustAuditableFormatFailure(
        "malformed",
        "Dependency section has bytes after the zlib stream",
      );
    return inflated;
  } catch (cause) {
    if (cause instanceof RustAuditableFormatFailure) throw cause;
    throw inflateFailure(cause, maximum);
  }
};

let trailingJunkRejected: boolean | undefined;

const rejectsTrailingJunk = (): boolean => {
  if (trailingJunkRejected !== undefined) return trailingJunkRejected;
  const trailed = Buffer.concat([
    deflateSync(Buffer.from("a")),
    Buffer.from([0]),
  ]);
  try {
    inflateSync(trailed, { rejectGarbageAfterEnd: true });
    trailingJunkRejected = false;
  } catch (cause) {
    trailingJunkRejected =
      cause instanceof Error &&
      "code" in cause &&
      cause.code === "ERR_TRAILING_JUNK_AFTER_STREAM_END";
  }
  return trailingJunkRejected;
};

const shortestPrefix = (
  input: Buffer,
  output: Buffer,
  maximum: number,
): number => {
  let low = 0;
  let high = input.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (prefixMatches(input.subarray(0, mid), output, maximum)) high = mid;
    else low = mid + 1;
  }
  return high;
};

const prefixMatches = (
  prefix: Buffer,
  output: Buffer,
  maximum: number,
): boolean => {
  try {
    return inflateSync(prefix, { maxOutputLength: maximum }).equals(output);
  } catch {
    return false;
  }
};

const inflateFailure = (cause: unknown, maximum: number): Error => {
  const code =
    cause instanceof Error && "code" in cause ? String(cause.code) : "";
  if (code === "ERR_BUFFER_TOO_LARGE")
    return new RustAuditableResourceFailure(
      { resource: "memory", reported_limits: { maximum_bytes: maximum } },
      "Inflated dependency JSON exceeds the size limit",
    );
  if (
    code === "ERR_TRAILING_JUNK_AFTER_STREAM_END" ||
    code.startsWith("Z_") ||
    code === "ERR_INVALID_ARG_TYPE"
  )
    return new RustAuditableFormatFailure(
      "malformed",
      "Dependency section is not a complete zlib stream",
    );
  return cause instanceof Error ? cause : new Error(String(cause));
};

const parseDocument = (bytes: Buffer): z.infer<typeof documentSchema> => {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new RustAuditableFormatFailure(
      "malformed",
      "Dependency JSON is not valid UTF-8",
      { cause },
    );
  }
  assertDepth(text);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new RustAuditableFormatFailure(
      "malformed",
      "Dependency section JSON is invalid",
      { cause },
    );
  }
  const version = documentVersionSchema.safeParse(value);
  if (!version.success)
    throw new RustAuditableFormatFailure(
      "malformed",
      "Dependency JSON does not match the format schema",
      { cause: version.error },
    );
  if (
    version.data.format !== undefined &&
    version.data.format !== RUST_AUDITABLE_FORMAT_VERSION
  )
    throw new RustAuditableFormatFailure(
      "unsupported",
      `Unsupported cargo-auditable format version ${version.data.format}`,
    );
  admitGraphExpansion(value);
  const parsed = documentSchema.safeParse(value);
  if (!parsed.success)
    throw new RustAuditableFormatFailure(
      "malformed",
      "Dependency JSON does not match the package schema",
      { cause: parsed.error },
    );
  return parsed.data;
};

// These are lower bounds on the required normalized representation, not
// guessed per-object heap sizes. Count source arrays before Zod clones them,
// normalization builds edge objects, or SCC analysis creates reverse edges.
const MIN_PACKAGE_OUTPUT_BYTES = JSON.stringify({
  name: "a",
  version: "a",
  source: "a",
  kind: null,
  dependencies: [],
  root: true,
}).length;
const MIN_EDGE_OUTPUT_BYTES = JSON.stringify({
  from_index: 0,
  to_index: 0,
}).length;
const admitGraphExpansion = (value: unknown): void => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("packages" in value) ||
    !Array.isArray(value.packages)
  )
    return;
  const packages: readonly unknown[] = value.packages;
  let minimumBytes =
    packages.length * MIN_PACKAGE_OUTPUT_BYTES +
    Math.max(0, packages.length - 1);
  let edges = 0;
  const admit = () => {
    const edgeBytes = edges * MIN_EDGE_OUTPUT_BYTES + Math.max(0, edges - 1);
    if (minimumBytes + edgeBytes > RUST_OUTPUT_BYTES)
      throw new RustAuditableResourceFailure(
        {
          resource: "transport",
          reported_limits: { maximum_output_bytes: RUST_OUTPUT_BYTES },
        },
        "Dependency graph exceeds the complete report byte budget before expansion",
      );
  };
  admit();
  for (const pkg of packages) {
    // Shape and index validity remain owned by documentSchema/rootIndex.
    if (
      typeof pkg !== "object" ||
      pkg === null ||
      !("dependencies" in pkg) ||
      !Array.isArray(pkg.dependencies)
    )
      continue;
    const count = pkg.dependencies.length;
    edges += count;
    minimumBytes += Math.max(0, count * 2 - 1);
    admit();
  }
};

const assertDepth = (text: string): void => {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      if (depth > JSON_DEPTH)
        throw new RustAuditableFormatFailure(
          "malformed",
          "Dependency JSON nesting exceeds 32 levels",
        );
    } else if ((char === "}" || char === "]") && depth > 0) depth -= 1;
  }
};

const normalizePackages = (
  packages: z.infer<typeof documentSchema>["packages"],
): RustPackage[] =>
  packages.map((pkg) => ({
    name: pkg.name,
    version: pkg.version,
    source: pkg.source,
    kind: pkg.kind ?? null,
    dependencies: pkg.dependencies ?? [],
    root: pkg.root ?? false,
  }));

const rootIndex = (packages: readonly RustPackage[]): number | null => {
  const roots = packages.flatMap((pkg, index) => (pkg.root ? [index] : []));
  if (roots.length > 1)
    throw new RustAuditableFormatFailure(
      "malformed",
      "Dependency JSON declares more than one root package",
    );
  for (const [index, pkg] of packages.entries()) {
    const outside = pkg.dependencies.find(
      (target) => target >= packages.length,
    );
    if (outside !== undefined)
      throw new RustAuditableFormatFailure(
        "malformed",
        `Dependency index ${String(outside)} from package ${String(index)} is outside the package list`,
      );
  }
  return roots[0] ?? null;
};

interface WalkFrame {
  readonly index: number;
  edge: number;
}

/** Indices in an SCC larger than one node, or in a one-node self-loop. */
const cyclicIndices = (packages: readonly RustPackage[]): number[] => {
  const edges = packages.map((pkg) => pkg.dependencies);
  const order = postorder(edges);
  const reversed = reversedEdges(edges);
  const seen = new Uint8Array(edges.length);
  const cyclic = new Set<number>();
  for (let cursor = order.length - 1; cursor >= 0; cursor -= 1) {
    const start = order[cursor];
    if (start === undefined || seen[start] === 1) continue;
    const component = componentFrom(start, reversed, seen);
    if (componentInCycle(component, edges))
      for (const index of component) cyclic.add(index);
  }
  return [...cyclic].sort((left, right) => left - right);
};

const postorder = (edges: readonly (readonly number[])[]): number[] => {
  const seen = new Uint8Array(edges.length);
  const order: number[] = [];
  for (let start = 0; start < edges.length; start += 1) {
    if (seen[start] === 1) continue;
    const stack: WalkFrame[] = [{ index: start, edge: 0 }];
    seen[start] = 1;
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;
      const next = edges[frame.index]?.[frame.edge];
      if (next === undefined) {
        stack.pop();
        order.push(frame.index);
        continue;
      }
      frame.edge += 1;
      if (seen[next] === 0) {
        seen[next] = 1;
        stack.push({ index: next, edge: 0 });
      }
    }
  }
  return order;
};

const reversedEdges = (edges: readonly (readonly number[])[]): number[][] => {
  const reversed = Array.from({ length: edges.length }, () => [] as number[]);
  for (let from = 0; from < edges.length; from += 1)
    for (const to of edges[from] ?? []) reversed[to]?.push(from);
  return reversed;
};

const componentFrom = (
  start: number,
  reversed: readonly (readonly number[])[],
  seen: Uint8Array,
): number[] => {
  const component: number[] = [];
  const stack = [start];
  seen[start] = 1;
  while (stack.length > 0) {
    const index = stack.pop();
    if (index === undefined) break;
    component.push(index);
    for (const next of reversed[index] ?? []) {
      if (seen[next] === 0) {
        seen[next] = 1;
        stack.push(next);
      }
    }
  }
  return component;
};

const componentInCycle = (
  component: readonly number[],
  edges: readonly (readonly number[])[],
): boolean => {
  if (component.length > 1) return true;
  const only = component[0];
  return only !== undefined && (edges[only]?.includes(only) ?? false);
};
