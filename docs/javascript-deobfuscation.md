# Proof-gated JavaScript deobfuscation

`deobfuscate_javascript_source` / `deobfuscate-javascript-source` applies
conservative static rewrites to one explicitly selected UTF-8 JavaScript file.
It is intended for captured, bundled or obfuscated scripts where readability can
be improved without executing target code.

This capability is distinct from [JavaScript source recovery](javascript-recovery.md).
Wakaru extracts and rewrites module structure; js-redox instead emits one
semantics-preserving-by-design transformed file plus a proof report describing
which rewrite classes actually fired. REA keeps the contracts separate rather
than pretending those results have the same meaning.

## Caller-supplied engine

The adapter currently verifies js-redox `deobfuscate-safe` **0.1.0** on Linux
x64. Set `REA_JS_REDOX_COMMAND` to an absolute path to that executable. The
private runtime filesystem must permit execution: set `TMPDIR` to a writable
exec-capable filesystem when the host's default temporary directory is mounted
`noexec`. REA checks executable access to its fingerprinted snapshot before
launching it and reports this missing prerequisite as a capability error.

The adapter uses util-linux `prlimit` (default `/usr/bin/prlimit`; override with
absolute `REA_JAVASCRIPT_PRLIMIT_COMMAND`). REA installs neither tool and checks
the configuration only when deobfuscation is requested.

The audited source revision is
`cfb9bc0788d326e6020568b298aa48135eb323d1` from
`codeandsolder/js-redox`. The result separately records the caller-supplied
executable's configured path, canonical resolved path and SHA-256. REA rechecks the configured selection before publication, including symlink retargeting. `executed_source_revision` remains `null`:
the version string and executable hash identify the bytes REA ran but do not
prove which source tree produced them.

The audited revision adds only the standard `--version` surface required for
producer admission; it does not alter deobfuscation semantics.

## Build js-redox

Build the audited source with Rust 1.99:

```sh
git clone https://github.com/codeandsolder/js-redox.git
cd js-redox
git checkout cfb9bc0788d326e6020568b298aa48135eb323d1
cargo +1.99.0 build --release -p jsvm-lift --bin deobfuscate-safe
export REA_JS_REDOX_COMMAND="$PWD/target/release/deobfuscate-safe"
```

`deobfuscate-safe --version` must report `jsvm-lift 0.1.0`.

## Deobfuscate and analyze

```sh
rea deobfuscate-javascript-source /tmp/web-scripts/app.js /tmp/deobfuscated-app --json
rea analyze-javascript-application /tmp/deobfuscated-app/deobfuscated --json
```

MCP input:

```json
{
  "path": "/tmp/web-scripts/app.js",
  "output_directory": "/tmp/deobfuscated-app",
  "max_iterations": 16
}
```

The output directory must be absent and absolute. REA takes a stable snapshot of
the selected input in a private workspace, fingerprints the engine, executes the
worker under its owned-process boundary, validates the machine-readable proof
report against the exact input and output digests, rechecks the original and
engine bytes, and only then commits an exclusively owned output tree. Failure
rolls the tree back.

Published contents:

- `inputs/source.js`: exact original source snapshot.
- `deobfuscated/source.js`: the proof-gated unformatted output.
- `reports/js-redox.json`: exact `js-safe-deobfuscate/v1` producer report.
- `manifest.json`: source, output, report, engine and option identities.
- `diagnostics/`: retained version and transformation stdout/stderr. Evidence
  includes file paths, hashes, retained and observed byte counts, exit status
  and truncation state; diagnostic text stays in these files.

The inline result summarizes transform counts, iteration count, arithmetic-state
proof count, static alias-installer proof counts, and the report's safety flags.
The complete producer report remains available as an artifact instead of being
expanded into the MCP response.

## Semantics and limits

REA deliberately does **not** pass js-redox `--format-output`. The admitted
report must say `safe_static_only: true`, `presentation_formatted: false` and
`runtime_semantics_preserved_by_design: true`; its input, output and analysis
source digests must match the bytes REA observed. A rewrite whose proof
preconditions do not hold stays unchanged.

That contract does not mean the output is original source. It does not recover
original identifier names, source maps or runtime inputs, and it does not claim
complete deobfuscation. It says only that the emitted unformatted rewrite was
produced by js-redox's fail-closed static transform set under the validated
report contract. Target JavaScript is never executed.

The current adapter gives the owned worker a single-thread hint plus per-process
1 GiB virtual-address-space and 120 CPU-second limits. The version probe and
transform share one 120-second launch deadline. Input and transformed output are
limited to 64 MiB each; the report and diagnostic streams are limited to 8 MiB.
There is no aggregate process-count or cgroup memory limit. Other host platforms
are not claimed by this adapter.
