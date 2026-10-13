export const JS_REDOX_RELEASE = {
  version: "0.1.0",
  revision: "cfb9bc0788d326e6020568b298aa48135eb323d1",
  repository: "https://github.com/codeandsolder/js-redox",
} as const;

export const JS_REDOX_PROVIDER_IDENTITY = {
  id: "js-redox",
  name: "js-redox deobfuscate-safe",
  version: JS_REDOX_RELEASE.version,
} as const;

export const JS_REDOX_LIMITS = {
  inputBytes: 64 * 1024 * 1024,
  outputBytes: 64 * 1024 * 1024,
  reportBytes: 8 * 1024 * 1024,
  executableBytes: 128 * 1024 * 1024,
  diagnosticBytes: 8 * 1024 * 1024,
  addressSpaceBytes: 1024 * 1024 * 1024,
  cpuSeconds: 120,
  timeoutMs: 120000,
} as const;

export const JS_REDOX_LIMITATIONS = [
  "Only proof-gated static rewrites are applied. Regions whose proof preconditions do not hold remain unchanged.",
  "The target JavaScript is never executed. The runtime-semantics-preserved-by-design claim applies to the unformatted safe-deobfuscation output contract, not arbitrary later formatting or edits.",
  "Recovered readability does not establish original source text, identifier names, source maps, runtime inputs or complete deobfuscation.",
  "Initial adapter verification is Linux x64. The owned worker receives a single-thread hint and per-process 1 GiB virtual address-space, 120 CPU-second and 120-second shared launch-deadline limits, plus 64 MiB input/output and 8 MiB diagnostic/report stream bounds. This adapter does not impose an aggregate process-count or cgroup memory limit.",
] as const;
