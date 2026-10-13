/**
 * Exact and pattern package-private import-alias lookup. Node resolves `#`
 * specifiers against the importer's enclosing package `imports` map; this
 * module owns the specifier and key rules. Exact keys win over pattern keys;
 * pattern keys containing exactly one `*` match concrete specifiers and
 * capture their enclosed substring for target substitution. Condition, array,
 * and null target selection stay with the shared package-target machinery.
 * Recursive `#` targets and external-package targets remain explicit unknowns.
 */

import { matchPackagePatternKey } from "./javascriptPackagePatternKeys.js";

/** How one `#` specifier participates in import-alias lookup. */
export type PackageImportSpecifierClassification =
  | { readonly kind: "invalid" }
  | { readonly kind: "exact"; readonly key: string };

/** Outcome of looking up one `#` key in a package `imports` object. */
export type PackageImportExactLookup =
  | { readonly kind: "undefined-map" }
  | {
      readonly kind: "missing-key";
      readonly declared: readonly string[];
    }
  | {
      readonly kind: "pattern-unresolved";
      readonly declared: readonly string[];
    }
  | {
      readonly kind: "pattern-found";
      readonly target: unknown;
      readonly capture: string;
      readonly declared: readonly string[];
    }
  | {
      readonly kind: "found";
      readonly target: unknown;
      readonly declared: readonly string[];
    };

/** How a selected string target is interpreted for package-private imports. */
export type PackageImportTargetClassification =
  | { readonly kind: "relative"; readonly target: string }
  | { readonly kind: "invalid"; readonly target: string }
  | { readonly kind: "recursive"; readonly target: string }
  | { readonly kind: "external-package"; readonly target: string };

/**
 * Classify a `#` module specifier before any package-scope walk.
 * `#` and names ending in `/` are invalid. A literal `*` in the specifier
 * participates as captured text; other keys, including `#/…`, participate in
 * exact and pattern lookup.
 */
export const classifyPackageImportSpecifier = (
  specifier: string,
): PackageImportSpecifierClassification => {
  if (specifier === "#" || specifier.endsWith("/")) return { kind: "invalid" };
  return { kind: "exact", key: specifier };
};

/** True when an `imports` key is a pattern rather than an exact alias. */
export const isPackageImportPatternKey = (key: string): boolean =>
  key.includes("*") || key.endsWith("/");

/**
 * Look up one `#` key in a package `imports` value. An exact key hit wins
 * over pattern keys. Without an exact hit, single-`*` pattern keys are tried
 * in Node's pattern-key order and a match returns the pattern target with its
 * captured substring. Keys without a `#` prefix participate too: real Node
 * 22, 24, and 26 follow `imports: {"*": "./safe.js"}` for `#foo`, so the
 * prefix is not a precondition for matching. A miss is reported as missing
 * when every declared key is also exact; if the map contains pattern keys,
 * the miss stays pattern-unresolved rather than claiming the specifier is
 * undefined.
 */
export const lookupExactPackageImport = (
  imports: unknown,
  key: string,
): PackageImportExactLookup => {
  if (typeof imports !== "object" || imports === null || Array.isArray(imports))
    return { kind: "undefined-map" };
  const declared = Object.keys(imports);
  if (Object.hasOwn(imports, key) && !isPackageImportPatternKey(key))
    return {
      kind: "found",
      target: Reflect.get(imports, key),
      declared,
    };
  const pattern = matchPackagePatternKey(
    declared.filter(isPackageImportPatternKey),
    key,
  );
  if (pattern !== null)
    return {
      kind: "pattern-found",
      target: Reflect.get(imports, pattern.key),
      capture: pattern.capture,
      declared,
    };
  return declared.some(isPackageImportPatternKey)
    ? { kind: "pattern-unresolved", declared }
    : { kind: "missing-key", declared };
};

/**
 * Classify a selected string import target. Only package-local `./` paths are
 * resolved as files; recursive `#` aliases and bare packages stay unknown.
 * Parent-relative, absolute, and URL targets are invalid, allowing array
 * selection to skip them before choosing a package-local fallback.
 */
export const classifyPackageImportTargetString = (
  target: string,
): PackageImportTargetClassification => {
  if (target.startsWith("./")) return { kind: "relative", target };
  if (
    target.startsWith("../") ||
    target.startsWith("/") ||
    URL.canParse(target)
  )
    return { kind: "invalid", target };
  if (target.startsWith("#")) return { kind: "recursive", target };
  return { kind: "external-package", target };
};
