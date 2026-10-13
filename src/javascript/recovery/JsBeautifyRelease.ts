import type { RecoveryLimits } from "./RecoveryEngine.js";

/** Catalog identity; Evidence replaces version with the observed `--version` banner. */
export const JSBEAUTIFY_PROVIDER_IDENTITY = {
  id: "jsbeautify",
  name: "jsbeautify",
  version: "unverified",
} as const;

export const JSBEAUTIFY_REPOSITORY =
  "https://github.com/coleleavitt/jsbeautify";

/**
 * Per-operation bounds. jsbeautify builds before 9949993 reserve a worker
 * stack of 2 KiB per input byte regardless of the address-space limit: a
 * 2.4 MB esbuild bundle peaks at 0.33 GB RSS yet aborts below 3 GiB, so the
 * ceiling is 8 GiB. Later builds cap the stack at a quarter of the limit. Deobfuscation logs one line
 * per rewrite on stderr (5 MB for that bundle), hence the 64 MiB stream bound.
 */
export const JSBEAUTIFY_LIMITS = {
  inputBytes: 64 * 1024 * 1024,
  outputBytes: 256 * 1024 * 1024,
  outputEntries: 10000,
  reportBytes: 64 * 1024 * 1024,
  addressSpaceBytes: 8 * 1024 * 1024 * 1024,
  timeoutMs: 300000,
} as const satisfies RecoveryLimits;

/** Public limitations for per-file jsbeautify recovery. */
export const JSBEAUTIFY_LIMITATIONS = [
  "Real jsbeautify CLI/MCP compatibility remains unverified; current adapter regressions use controlled stand-ins.",
  "Recovered sources are derived artifacts; recovered names are heuristic guesses and runtime equivalence is not established.",
  "jsbeautify rewrites each selected file separately; modules are not split, so each module's byte range is its whole input file.",
  "A file is published only when jsbeautify exits 0 and, for deobfuscation, both of its generated-output re-parse checks (phases 19.6 and 21.5) report success. Re-parsing proves syntax, not behaviour.",
  "Classic scripts keep their top-level names (jsbeautify --source-type auto); .cjs inputs are parsed as CommonJS and .mjs inputs as modules.",
  "The caller-supplied binary is identified by path, SHA-256 and version banner only; REA does not audit or pin its source.",
  "Linux adapter: one worker per file, 8 GiB address-space ceiling, 300-second deadline for the whole operation, 64 MiB total input, 256 MiB output, 10000 output entries and 64 MiB per diagnostic stream.",
] as const;
