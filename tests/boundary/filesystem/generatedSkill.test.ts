import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const exec = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const authored =
  '---\nname: reverse-engineer-anything\nmetadata:\n  version: "33"\n---\n\n# Instructions\n\nInspect the caller-selected artifact.\n';

async function fixture(eol = "\n") {
  const root = await createTestTempDirectory("rea-generated-skill-");
  for (const path of [
    "scripts/generate-skill-metadata.mjs",
    "scripts/lib/generated-file.mjs",
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await copyFile(join(repositoryRoot, path), join(root, path));
  }
  const sourceRoot = join(root, ".agents/skills/reverse-engineer-anything");
  const outputRoot = join(root, "skills/reverse-engineer-anything");
  await mkdir(join(sourceRoot, "references"), { recursive: true });
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "package.json"), '{"type":"module"}\n');
  await writeFile(
    join(root, "dist/identity.js"),
    'export const PRODUCT_IDENTITY = { packageSpecifier: "rea-agents@latest", registrationPackageSpecifier: "rea-agents@6.2.0" };\n',
  );
  await writeFile(join(sourceRoot, "SKILL.md"), authored.replaceAll("\n", eol));
  await writeFile(
    join(sourceRoot, "references/guide.md"),
    `# Guide${eol}Preserve evidence.${eol}`,
  );
  const identity = async (count: number, digest: string) =>
    writeFile(
      join(root, "dist/catalogIdentity.js"),
      `export const CATALOG_IDENTITY = ${JSON.stringify({ counts: { mcp_tools: count }, digests: { combined_sha256: digest } })};\n`,
    );
  await identity(139, "a".repeat(64));
  const generate = (...args: string[]) =>
    exec(
      process.execPath,
      [join(root, "scripts/generate-skill-metadata.mjs"), ...args],
      { cwd: root },
    );
  return { sourceRoot, outputRoot, identity, generate };
}

it.each(["\n", "\r\n"])(
  "generates revision-specific metadata without rewriting authored instructions (%j)",
  async (eol) => {
    const f = await fixture(eol);
    await f.generate();
    const first = await readFile(join(f.outputRoot, "SKILL.md"), "utf8");
    expect(first).not.toContain("catalog_digest:");
    expect(first).toContain("tool_count: 139");
    expect(
      first.replace(/^ {2}(?:tool_count|catalog_digest):[^\n]*\n/gmu, ""),
    ).toBe(authored);
    expect(
      await readFile(join(f.outputRoot, "references/guide.md"), "utf8"),
    ).toBe("# Guide\nPreserve evidence.\n");
    await f.identity(139, "b".repeat(64));
    await f.generate();
    expect(await readFile(join(f.outputRoot, "SKILL.md"), "utf8")).toBe(first);
    await f.identity(140, "b".repeat(64));
    await expect(f.generate("--check")).rejects.toMatchObject({
      stderr: expect.stringContaining("missing or stale"),
    });
    await f.generate();
    expect(await readFile(join(f.outputRoot, "SKILL.md"), "utf8")).toContain(
      "tool_count: 140",
    );
    expect(await readFile(join(f.sourceRoot, "SKILL.md"), "utf8")).toBe(
      authored.replaceAll("\n", eol),
    );
    expect(
      await readFile(join(f.sourceRoot, "references/guide.md"), "utf8"),
    ).toBe(`# Guide${eol}Preserve evidence.${eol}`);
    await expect(f.generate("--check")).resolves.toMatchObject({ stderr: "" });
  },
);

it("rejects missing, stale, and extra packaged references and removes deleted source files on rebuild", async () => {
  const f = await fixture();
  await f.generate();
  const guide = join(f.outputRoot, "references/guide.md");
  await rm(guide);
  await expect(f.generate("--check")).rejects.toMatchObject({
    stderr: expect.stringContaining("guide.md is missing or stale"),
  });
  await f.generate();
  await writeFile(guide, "modified reference\n");
  await expect(f.generate("--check")).rejects.toMatchObject({
    stderr: expect.stringContaining("guide.md is missing or stale"),
  });
  await f.generate();
  await writeFile(
    join(f.outputRoot, "references/removed.md"),
    "obsolete instructions\n",
  );
  await expect(f.generate("--check")).rejects.toMatchObject({
    stderr: expect.stringContaining("file inventory drifted"),
  });
  await rm(join(f.sourceRoot, "references/guide.md"));
  await f.generate();
  await expect(readFile(guide)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    readFile(join(f.outputRoot, "references/removed.md")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await f.generate("--check");
});

it("keeps an authored command pinned to the packaged version", async () => {
  const f = await fixture();
  await writeFile(
    join(f.sourceRoot, "SKILL.md"),
    authored.replace(
      "Inspect the caller-selected artifact.",
      "Run `npx -y rea-agents@6.2.0 doctor --json` first.",
    ),
  );
  await f.generate();
  const generated = await readFile(join(f.outputRoot, "SKILL.md"), "utf8");
  expect(generated).toContain("npx -y rea-agents@6.2.0 doctor --json");
  expect(generated).not.toContain("@latest");
  await f.generate("--check");
});

it.each([
  ["SKILL.md", "npx -y rea-agents@latest doctor", "rea-agents@latest"],
  ["SKILL.md", "npx -y rea-agents@6.1.0 doctor", "rea-agents@6.1.0"],
  [
    "references/guide.md",
    "npx -y rea-agents@latest doctor",
    "rea-agents@latest",
  ],
  ["SKILL.md", "npx -y rea-agents doctor", "rea-agents"],
  ["SKILL.md", "npx --yes rea-agents doctor", "rea-agents"],
  ["references/guide.md", "npm exec --package=rea-agents -- rea", "rea-agents"],
  ["SKILL.md", "npm exec -p rea-agents rea doctor", "rea-agents"],
  ["SKILL.md", "npm exec -- rea-agents doctor", "rea-agents"],
  ["SKILL.md", "npm exec --package=rea-agents@next -- rea", "rea-agents@next"],
  ["SKILL.md", "pnpm dlx rea-agents doctor", "rea-agents"],
  ["SKILL.md", "yarn dlx rea-agents doctor", "rea-agents"],
  ["SKILL.md", "bunx rea-agents doctor", "rea-agents"],
  ["SKILL.md", "npm install --global rea-agents", "rea-agents"],
  ["SKILL.md", "npm in rea-agents", "rea-agents"],
  ["SKILL.md", "npm isntall rea-agents", "rea-agents"],
  [
    "SKILL.md",
    "pnpm dlx --reporter append-only rea-agents doctor",
    "rea-agents",
  ],
  ["SKILL.md", "npm install -- rea-agents", "rea-agents"],
  ["SKILL.md", "npm add -- other-package rea-agents", "rea-agents"],
  ["SKILL.md", "npm exec rea --package=rea-agents", "rea-agents"],
  ["SKILL.md", "npx -p=rea-agents rea", "rea-agents"],
  ["SKILL.md", "npx --cache ./cache rea-agents doctor", "rea-agents"],
  [
    "SKILL.md",
    'npx --cache "./cache with spaces" rea-agents doctor',
    "rea-agents",
  ],
  ["SKILL.md", "npx -p=rea-agents@6.2.0. rea", "rea-agents@6.2.0."],
])(
  "rejects an unpinned package reference in authored %s (%s)",
  async (relativePath, command, specifier) => {
    const f = await fixture();
    const path = join(f.sourceRoot, relativePath);
    await writeFile(
      path,
      `${await readFile(path, "utf8")}Run \`${command}\`.\n`,
    );
    await expect(f.generate()).rejects.toMatchObject({
      stderr: expect.stringContaining(
        `${relativePath} names ${specifier}; pin the package runner to rea-agents@6.2.0`,
      ),
    });
  },
);

it.each([
  "Run `npx -y rea-agents@6.2.0 doctor --json`.",
  "Use rea-agents@6.2.0.",
  "Run `pnpm dlx --reporter append-only rea-agents@6.2.0 doctor`.",
  "Install `npm in rea-agents@6.2.0`.",
  "Use rea-agents@6.2.0, then inspect the target.",
  "Run `npm exec rea --package=rea-agents@6.2.0`.",
  'Run `npx --cache "./cache with spaces" -p=rea-agents@6.2.0 rea doctor`.',
  "Install `npm install -- rea-agents@6.2.0`.",
  "Run `npm exec --package=rea-agents@6.2.0 -- rea doctor`.",
  "```bash\nbunx rea-agents@6.2.0 doctor\n```",
  "Install `npm install --global rea-agents@6.2.0` when allowed.",
  "The rea-agents package ships the `rea` CLI; use npx with the rea-agents package only when allowed.",
])("accepts a pinned or prose package mention: %s", async (line) => {
  const f = await fixture();
  const path = join(f.sourceRoot, "references/guide.md");
  await writeFile(path, `${await readFile(path, "utf8")}${line}\n`);
  await f.generate();
  await f.generate("--check");
});

it("rejects catalog-dependent metadata in the authored source", async () => {
  const f = await fixture();
  await writeFile(
    join(f.sourceRoot, "SKILL.md"),
    authored.replace('  version: "33"', '  version: "33"\n  tool_count: 139'),
  );
  await expect(f.generate()).rejects.toMatchObject({
    stderr: expect.stringContaining(
      "Catalog metadata belongs in the generated skill",
    ),
  });
});
