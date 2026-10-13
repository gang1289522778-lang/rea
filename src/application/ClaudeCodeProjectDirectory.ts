import { realpath, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { SetupClient } from "./SupportedClients.js";
import { dirname, join, resolve } from "node:path";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { withRegularFile } from "./RegularFileRead.js";
import { readBoundedFileBytes } from "../process/BoundedFileBytes.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";

/** Resolve a writable local scope once, before selecting any transaction. */
export const claudeCodeLocalClients = async (
  clients: readonly SetupClient[],
  workspaceDirectory: string,
  resources: ArtifactResourceScope,
): Promise<readonly SetupClient[]> => {
  let claudeProjectDirectory: string;
  try {
    claudeProjectDirectory = await claudeCodeProjectDirectory(
      workspaceDirectory,
      resources,
    );
  } catch (cause: unknown) {
    throw new AnalysisInputError(
      "Claude Code local registration",
      {
        cause,
        userMessage: `Cannot resolve Claude Code project ${workspaceDirectory}. Select an existing, readable directory and repair its Git metadata before retrying.`,
      },
      [
        {
          path: ["project"],
          reason: "invalid_value",
          message:
            "Select an existing readable project directory with valid Git metadata.",
        },
      ],
    );
  }
  return clients
    .filter(({ name }) => name === "claude_code")
    .map((client) => ({ ...client, claudeProjectDirectory }));
};

/** Claude Code keys private project state by the physical enclosing Git root, or cwd. */
export const claudeCodeProjectDirectory = async (
  workspaceDirectory: string,
  resources?: ArtifactResourceScope,
): Promise<string> => {
  let directory = await realpath(resolve(workspaceDirectory));
  if (!(await stat(directory)).isDirectory())
    throw new TypeError("Claude Code project must be an existing directory");
  const workspace = directory;
  for (;;) {
    let marker: Stats | undefined;
    try {
      marker = await stat(join(directory, ".git"));
    } catch (cause: unknown) {
      if (
        !(cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      )
        throw cause;
    }
    if (marker?.isDirectory()) return directory;
    if (marker?.isFile()) return gitFileProjectDirectory(directory, resources);
    if (marker !== undefined)
      throw new TypeError(
        "Claude Code project Git marker is not a directory or worktree file",
      );
    const parent = dirname(directory);
    if (parent === directory) return workspace;
    directory = parent;
  }
};

const gitFileProjectDirectory = async (
  directory: string,
  resources?: ArtifactResourceScope,
): Promise<string> => {
  const pointer = await readGitPath(join(directory, ".git"), resources);
  if (!pointer.startsWith("gitdir: ") || pointer.length === 8)
    throw new TypeError("Invalid Claude Code project Git directory pointer");
  const gitDirectory = resolve(directory, pointer.slice(8));
  if (!(await stat(gitDirectory)).isDirectory())
    throw new TypeError(
      "Claude Code project Git directory pointer does not identify a directory",
    );
  let common: string;
  try {
    common = await readGitPath(join(gitDirectory, "commondir"), resources);
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      // Ordinary separate Git directories and submodules have no commondir.
      // Linked worktree administration directories carry a gitdir backlink.
      try {
        await stat(join(gitDirectory, "gitdir"));
      } catch (backlinkCause: unknown) {
        if (
          backlinkCause instanceof Error &&
          "code" in backlinkCause &&
          backlinkCause.code === "ENOENT"
        )
          return directory;
        throw backlinkCause;
      }
      throw new TypeError(
        "Claude Code linked worktree is missing its common Git directory metadata",
      );
    }
    throw cause;
  }
  // Claude Code shares private project state with the original checkout.
  const commonDirectory = await realpath(resolve(gitDirectory, common));
  if (!(await stat(commonDirectory)).isDirectory())
    throw new TypeError(
      "Claude Code project common Git directory does not identify a directory",
    );
  return dirname(commonDirectory);
};

/** Bound Git path metadata before allocating; the reader retains failed-close ownership. */
const readGitPath = (
  path: string,
  resources?: ArtifactResourceScope,
): Promise<string> =>
  withRegularFile(
    path,
    async (handle, stats) => {
      const maximumBytes = 128 * 1024;
      if (stats.size > maximumBytes)
        throw new RangeError(
          "Claude Code project Git path metadata exceeds 128 KiB",
        );
      const bytes = await readBoundedFileBytes(
        handle,
        maximumBytes,
        undefined,
        stats.size,
      );
      if (bytes === undefined || bytes.length !== stats.size)
        throw new TypeError("Truncated Claude Code project Git path metadata");
      const value = new TextDecoder("utf-8", { fatal: true })
        .decode(bytes)
        .replace(/\r?\n$/u, "");
      if (value.length === 0 || /[\r\n\0]/u.test(value))
        throw new TypeError("Invalid Claude Code project Git path metadata");
      return value;
    },
    resources === undefined ? {} : { resources },
  );
