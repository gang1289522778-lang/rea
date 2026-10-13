import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CATALOG_IDENTITY } from "../dist/catalogIdentity.js";

import { exec } from "./lib/verify-package-core.mjs";
import { verifyPackedBridge } from "./verify-packed-bridge.mjs";

/** Create a tarball and assert production packaging constraints. */
export async function verifyPackagePack({ root, workspace }) {
  const packDirectory = join(workspace, "pack");
  await mkdir(packDirectory);
  const packArguments = [
    "pack",
    "--silent",
    "--pack-destination",
    packDirectory,
  ];
  const pack = await (process.platform === "win32" &&
  typeof process.env.npm_execpath === "string"
    ? exec(process.execPath, [process.env.npm_execpath, ...packArguments], {
        cwd: root,
      })
    : exec("npm", packArguments, { cwd: root }));
  const tarball = join(packDirectory, pack.stdout.trim());
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
    packedManifest.bin?.["rea-agents"] !== "scripts/rea.mjs" ||
    packedManifest.bin?.["rea-gui"] !== "windows-gui/rea-gui.mjs"
  )
    throw new Error(
      "package did not expose the expected REA command entry points",
    );
  if (packedManifest.mcpName !== "io.github.morluto/rea")
    throw new Error("package did not retain its MCP Registry ownership marker");
  if (
    !packedFiles.includes("package/windows-gui/rea-gui.mjs") ||
    !packedFiles.includes("package/windows-gui/rea-gui.ps1")
  )
    throw new Error("package did not include the Windows desktop GUI");
  if (packedFiles.some((path) => path.startsWith("package/.agents/")))
    throw new Error(
      "package included authored skill sources instead of only the generated bundle",
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
