import { createHash } from "node:crypto";
import { readFile, writeFile, unlink, symlink } from "node:fs/promises";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const args = process.argv.slice(2);
const mode = process.env.REA_DEOBFUSCATION_FIXTURE_MODE ?? "normal";
if (mode === "slow-both")
  await new Promise((resolve) => setTimeout(resolve, 600));
if (mode === "nonzero") {
  console.log("fixture stdout diagnostic");
  console.error("fixture stderr diagnostic");
  process.exit(23);
}
if (args.includes("--version")) {
  console.log(mode === "wrong-version" ? "jsvm-lift 9.9.9" : "jsvm-lift 0.1.0");
  if (mode === "replace-version-snapshot")
    await writeFile(
      process.env.REA_DEOBFUSCATION_PRIVATE_ENGINE,
      "replaced executable",
    );
} else {
  const input = args[0];
  const output = args[1];
  const reportPath = args[args.indexOf("--report") + 1];
  const maximum = Number(args[args.indexOf("--max-iterations") + 1]);
  const source = await readFile(input);
  const transformed =
    mode === "invalid-output-utf8"
      ? Buffer.from([0xff])
      : Buffer.from(
          source
            .toString("utf8")
            .replace('table[0] + " " + table[1]', '"hello world"'),
        );
  await writeFile(output, transformed);
  const outputDigest = sha256(transformed);
  const report = {
    schema: "js-safe-deobfuscate/v1",
    input,
    input_sha256: sha256(source),
    output_sha256: mode === "bad-digest" ? "0".repeat(64) : outputDigest,
    changed: !source.equals(transformed),
    iterations: Math.min(2, maximum),
    transforms: { static_array_lookup: 2, constant_fold: 1 },
    arithmetic_state_proofs: [],
    analysis_source_sha256: outputDigest,
    static_alias_installer_calls: [],
    safe_static_only: true,
    presentation_formatted: false,
    runtime_semantics_preserved_by_design: true,
  };
  Object.assign(
    report,
    {
      "bad-input-digest": { input_sha256: "0".repeat(64) },
      "bad-analysis-digest": { analysis_source_sha256: "0".repeat(64) },
      "bad-iterations": { iterations: maximum + 1 },
      "bad-changed": { changed: source.equals(transformed) },
      "unsafe-static": { safe_static_only: false },
      formatted: { presentation_formatted: true },
      "unsafe-semantics": { runtime_semantics_preserved_by_design: false },
    }[mode] ?? {},
  );
  if (mode === "large-diagnostics")
    process.stdout.write("x".repeat(6 * 1024 * 1024));
  if (mode === "engine-retarget") {
    await unlink(process.env.REA_DEOBFUSCATION_ENGINE_LINK);
    await symlink(
      process.env.REA_DEOBFUSCATION_ENGINE_REPLACEMENT,
      process.env.REA_DEOBFUSCATION_ENGINE_LINK,
    );
  }
  await writeFile(reportPath, JSON.stringify(report));
}
