import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ensureGeneratedFile } from "./lib/generated-file.mjs";

const arguments_ = new Set(process.argv.slice(2));
for (const argument of arguments_)
  if (argument !== "--check")
    throw new Error(`Unknown skill metadata option: ${argument}`);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(root, ".agents/skills/reverse-engineer-anything");
const outputRoot = join(root, "skills/reverse-engineer-anything");
const check = arguments_.has("--check");
const current = (
  await readFile(join(sourceRoot, "SKILL.md"), "utf8")
).replaceAll("\r\n", "\n");
const cacheBust = String(Date.now());
const { CATALOG_IDENTITY } = await import(
  `${pathToFileURL(join(root, "dist/catalogIdentity.js")).href}?${cacheBust}`
);
const { PRODUCT_IDENTITY } = await import(
  `${pathToFileURL(join(root, "dist/identity.js")).href}?${cacheBust}`
);
if (/^\s{2}(?:tool_count|catalog_digest):/mu.test(current))
  throw new Error(
    "Catalog metadata belongs in the generated skill, not the authored source",
  );
const versionLine = /^ {2}version: "[^"\r\n]+"$/mu;
if (!versionLine.test(current))
  throw new Error("Missing authored skill version");
const source = current.replace(
  versionLine,
  `$&\n  tool_count: ${String(CATALOG_IDENTITY.counts.mcp_tools)}`,
);
const paths = await filePaths(sourceRoot);
// The authored bundle is installable straight from the repository, so it must
// already name the exact package version it ships with, never `@latest`.
// Release Please updates the pinned SKILL.md command with package.json.
const pinnedSpecifier = PRODUCT_IDENTITY.registrationPackageSpecifier;
const packageName = pinnedSpecifier.slice(0, pinnedSpecifier.lastIndexOf("@"));
const packagePrefix = `${packageName}@`;
// Any `rea-agents@...` specifier, in prose or in a command, must be the pin.
const specifiersIn = (text) =>
  text
    .split(packagePrefix)
    .slice(1)
    .map(
      (rest) =>
        `${packagePrefix}${(/^[^\s`"')\]]*/u.exec(rest)?.[0] ?? "").replace(/[.,;:!?]+$/u, "")}`,
    );
// A bare package name is a reference only where a package runner or install
// command takes a package operand: npm documents that a name without a
// specifier matches whatever version the local project has, so `npx -y
// rea-agents`, `npm exec --package=rea-agents`, `npm exec -- rea-agents`,
// `pnpm dlx`, `yarn dlx`, `bunx` and `npm install rea-agents` all run or
// install an unpinned version. Install commands are held to the same pin as
// runners, since the skill would otherwise have an agent install a floating
// version. Prose that names the package ("the rea-agents package", "npx with
// the rea-agents package") is not a package operand and passes.
const packageCommand =
  /(?:^|[\s`"'(;&|])(?:(npx|pnpx|bunx|bun\s+x)|(npm|pnpm|yarn|bun)(?:\s+-{1,2}[\w-]+(?:=\S+)?)*\s+(?:(exec|x|dlx)|(install|add|i|in|ins|inst|insta|instal|isnt|isnta|isntal|isntall|global\s+add)))(?=\s)([^`\n;&|)]*)/gu;
// Parse quoted words once, before interpreting runner options and operands.
const commandWords = (text) => {
  const words = [];
  let word = "";
  let quote = "";
  let started = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\" && quote !== "'" && index + 1 < text.length) {
      word += text[++index];
      started = true;
    } else if (quote !== "") {
      if (character === quote) quote = "";
      else word += character;
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (/\s/u.test(character)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += character;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
};
const valueOptions = new Set([
  "--cache",
  "--prefix",
  "--registry",
  "--userconfig",
  "--globalconfig",
  "--workspace",
  "-w",
  "--call",
  "-c",
  "--loglevel",
  "--shell",
]);
const packageOperands = (kind, operands) => {
  const runs = kind !== "install";
  const tokens = commandWords(operands);
  const packages = [];
  const positional = [];
  let explicitPackage = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "") continue;
    if (token === "--") {
      positional.push(
        ...(runs
          ? tokens.slice(index + 1, index + 2)
          : tokens.slice(index + 1)),
      );
      break;
    }
    if (token.startsWith("--package=") || token.startsWith("-p=")) {
      packages.push(token.slice(token.indexOf("=") + 1));
      explicitPackage = true;
    } else if (token === "-p" || token === "--package") {
      if (tokens[index + 1] !== undefined) packages.push(tokens[++index]);
      explicitPackage = true;
    } else if (
      valueOptions.has(token) ||
      (kind === "pnpm-runner" && token === "--reporter")
    )
      index += 1;
    else if (token.startsWith("-")) continue;
    else {
      positional.push(token);
      // npm exec parses its options even after the first command word;
      // npx and the other runners pass subsequent arguments to the command.
      if (runs && kind !== "npm-exec") break;
    }
  }
  return runs
    ? explicitPackage
      ? packages
      : positional.slice(0, 1)
    : [...packages, ...positional];
};
const commandPackagesIn = (text) =>
  [...text.replaceAll(/\\\r?\n/gu, " ").matchAll(packageCommand)]
    .flatMap(([command, runner, manager, execVerb, installVerb, operands]) => {
      if (
        manager !== "npm" &&
        installVerb !== undefined &&
        !["install", "i", "add", "global add"].includes(installVerb)
      )
        return [];
      const kind =
        runner === undefined && execVerb === undefined
          ? "install"
          : /(?:^|[\s`"'(;&|])(?:pnpm|pnpx)\s/u.test(command)
            ? "pnpm-runner"
            : runner === undefined && /(?:^|[\s`"'(;&|])npm\s/u.test(command)
              ? "npm-exec"
              : "runner";
      return packageOperands(kind, operands);
    })
    .filter(
      (operand) => operand === packageName || operand.startsWith(packagePrefix),
    );
for (const relativePath of paths) {
  const text = await readFile(join(sourceRoot, relativePath), "utf8");
  for (const specifier of [...specifiersIn(text), ...commandPackagesIn(text)])
    if (specifier !== pinnedSpecifier)
      throw new Error(
        `${relativePath} names ${specifier}; pin the package runner to ${pinnedSpecifier}`,
      );
}
// Rebuild this owned output directory so removed references cannot survive a build.
if (!check) await rm(outputRoot, { recursive: true, force: true });
for (const relativePath of paths) {
  const path = join(outputRoot, relativePath);
  if (!check) await mkdir(dirname(path), { recursive: true });
  await ensureGeneratedFile({
    path,
    source:
      relativePath === "SKILL.md"
        ? source
        : (await readFile(join(sourceRoot, relativePath), "utf8")).replaceAll(
            "\r\n",
            "\n",
          ),
    check,
    generateCommand: "npm run docs:generate",
  });
}
if (
  check &&
  JSON.stringify(await filePaths(outputRoot)) !== JSON.stringify(paths)
)
  throw new Error(
    "Generated skill file inventory drifted; run npm run docs:generate",
  );

async function filePaths(directory, prefix = "") {
  const paths = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory())
      paths.push(
        ...(await filePaths(join(directory, entry.name), relativePath)),
      );
    else if (entry.isFile()) paths.push(relativePath);
    else
      throw new Error(
        `Skill bundle requires regular files or directories: ${relativePath}`,
      );
  }
  return paths;
}
