import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CATALOG_IDENTITY } from "../dist/catalogIdentity.js";

import { exec } from "./lib/verify-package-core.mjs";
import { verifyPackedBridge } from "./verify-packed-bridge.mjs";

/** Create a tarball and assert production packaging constraints. */
export async function verifyPackagePack({ root, workspace }) {
  const packDirectory = join(workspace, "pack");
  await mkdir(packDirectory);
  const tarball = join(
    packDirectory,
    (
      await exec(
        "npm",
        ["pack", "--silent", "--pack-destination", packDirectory],
        {
          cwd: root,
        },
      )
    ).stdout.trim(),
  );
  const packedFiles = (await exec("tar", ["-tf", tarball])).stdout.split("\n");
  const packedManifest = JSON.parse(
    (await exec("tar", ["-xOf", tarball, "package/package.json"])).stdout,
  );
  if (
    packedManifest.scripts?.postinstall !== undefined ||
    packedManifest.dependencies?.["node-pty"] !== undefined ||
    packedManifest.dependencies?.["@lydell/node-pty"] !== "1.1.0"
  )
    throw new Error("package retained a lifecycle-dependent PTY installation");
  if (
    packedManifest.bin?.rea !== "scripts/rea.mjs" ||
    packedManifest.bin?.["rea-agents"] !== "scripts/rea.mjs"
  )
    throw new Error("package did not expose both rea command entry points");
  if (packedManifest.mcpName !== "io.github.morluto/rea")
    throw new Error("package did not retain its MCP Registry ownership marker");
  if (packedFiles.some((path) => path.startsWith("package/.agents/")))
    throw new Error(
      "package included authored skill sources instead of only the generated bundle",
    );
  if (packedFiles.some((path) => path.startsWith("package/src/")))
    throw new Error(
      "Packaged runtime must not masquerade as a source checkout",
    );
  if (packedFiles.some((path) => path.startsWith("package/.cache/")))
    throw new Error("package included development cache or test metadata");
  const skill = (
    await exec("tar", [
      "-xOf",
      tarball,
      "package/skills/reverse-engineer-anything/SKILL.md",
    ])
  ).stdout;
  if (
    !skill.includes(
      `  tool_count: ${String(CATALOG_IDENTITY.counts.mcp_tools)}\n`,
    ) ||
    skill.includes("  catalog_digest:")
  )
    throw new Error(
      "packaged skill metadata did not match the catalog shipped in the package",
    );
  for (const path of [
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
  ]) {
    const manifest = JSON.parse(
      (await exec("tar", ["-xOf", tarball, `package/${path}`])).stdout,
    );
    if (
      manifest.version !== packedManifest.version ||
      manifest.skills !== "./skills" ||
      manifest.mcpServers?.rea?.command !== "node" ||
      (path.startsWith(".codex") && manifest.mcpServers?.rea?.cwd !== ".") ||
      JSON.stringify(manifest.mcpServers?.rea?.args) !==
        JSON.stringify([
          `${path.startsWith(".claude") ? "${CLAUDE_PLUGIN_ROOT}/" : "./"}scripts/plugin-mcp-launcher.mjs`,
          `${packedManifest.name}@${packedManifest.version}`,
        ])
    )
      throw new Error(
        `Packaged plugin ${path} does not match the exact runtime and canonical skill release`,
      );
  }
  for (const path of [
    "scripts/plugin-mcp-launcher.mjs",
    "scripts/lib/packageRunnerCommand.mjs",
  ])
    if (!packedFiles.includes(`package/${path}`))
      throw new Error(
        `Packaged plugin launcher dependency is missing: ${path}`,
      );
  if (
    skill.includes(`${packedManifest.name}@latest`) ||
    !skill.includes(`${packedManifest.name}@${packedManifest.version}`)
  )
    throw new Error(
      "Packaged plugin skill recovery is not pinned to the shipped runtime",
    );
  if (
    packedFiles.some(
      (path) => path.includes("__pycache__") || path.endsWith(".pyc"),
    )
  ) {
    throw new Error("package contained generated Python bytecode");
  }
  await verifyPackedBridge({ workspace, tarball, packedFiles });
  return { tarball };
}
