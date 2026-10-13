/**
 * Shared single-`*` pattern-key matching for package `exports` and `imports`
 * maps. Node tries pattern keys only after an exact key misses, ordered by
 * descending prefix length before the `*`, then descending suffix length; the
 * first key whose prefix and suffix enclose the request captures the enclosed
 * substring, which is substituted for `*` in the selected target string.
 */

/** A matching pattern key and the substring it captured from the request. */
export interface MatchedPackagePatternKey {
  readonly key: string;
  readonly capture: string;
}

/** True when a map key is a pattern key: it contains exactly one `*`. */
export const isSingleStarPatternKey = (key: string): boolean =>
  key.includes("*") && key.split("*").length === 2;

/**
 * Match one request against pattern keys in Node's pattern-key order. A star
 * in a request is literal captured text; trailing slash exports still match
 * on supported Node runtimes. Imports reject their invalid names upstream. The capture
 * must consume at least one character, as in Node's `(.+)` pattern match.
 */
export const matchPackagePatternKey = (
  keys: readonly string[],
  request: string,
): MatchedPackagePatternKey | null => {
  const patterns: { key: string; prefix: string; suffix: string }[] = [];
  for (const key of keys) {
    if (!isSingleStarPatternKey(key)) continue;
    const parts = key.split("*");
    patterns.push({ key, prefix: parts[0] ?? "", suffix: parts[1] ?? "" });
  }
  patterns.sort(
    (x, y) =>
      y.prefix.length - x.prefix.length || y.suffix.length - x.suffix.length,
  );
  for (const { key, prefix, suffix } of patterns) {
    if (!request.startsWith(prefix) || !request.endsWith(suffix)) continue;
    if (request.length <= prefix.length + suffix.length) continue;
    return {
      key,
      capture: request.slice(prefix.length, request.length - suffix.length),
    };
  }
  return null;
};
