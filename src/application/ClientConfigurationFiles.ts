import { err, ok, type Result } from "../domain/result.js";
import {
  RegularFileCleanupFailure,
  readRegularFileText,
} from "./RegularFileRead.js";
import {
  effectiveClientServer,
  parseClientConfiguration,
  type ClientConfigurationDocument,
  type ClaudeCodeConfigurationSelection,
} from "./ClientConfigurationDocument.js";
import type { SetupClient } from "./SupportedClients.js";
import { clientRegistrationEnvironment } from "./ClientRegistrationEnvironment.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { claudeCodeProjectDirectory } from "./ClaudeCodeProjectDirectory.js";

/** A named source failure that setup can explain without losing the bad path. */
export interface ClientConfigurationFileError {
  readonly kind: "unreadable" | "malformed";
  readonly path: string;
  readonly detail: string;
  readonly cleanupFailure?: RegularFileCleanupFailure;
  readonly registration_scope?: "user" | "local";
  readonly project_directory?: string;
  readonly requested_project_directory?: string;
}

/** Preserve named read failures and distinguish a missing source from an empty file. */
export const readConfigurationText = async (
  path: string,
  resources?: ArtifactResourceScope,
): Promise<Result<string | undefined, ClientConfigurationFileError>> => {
  try {
    return ok(
      await readRegularFileText(
        path,
        resources === undefined ? {} : { resources },
      ),
    );
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return ok(undefined);
    return err({
      kind: "unreadable",
      path,
      detail: `Configuration ${path} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      ...(cause instanceof RegularFileCleanupFailure
        ? { cleanupFailure: cause }
        : {}),
    });
  }
};

/** Read and parse one configuration at its source boundary. */
export const readConfigurationFile = async (
  path: string,
  format: SetupClient["format"],
  resources?: ArtifactResourceScope,
  claudeProjectDirectory?: string,
  options: ClaudeCodeConfigurationSelection = {},
): Promise<
  Result<ClientConfigurationDocument | undefined, ClientConfigurationFileError>
> => {
  const source = await readConfigurationText(path, resources);
  if (!source.ok) return source;
  const content = source.value;
  if (content === undefined) return ok(undefined);
  try {
    return ok(
      parseClientConfiguration(
        content,
        format,
        claudeProjectDirectory,
        options,
      ),
    );
  } catch (cause: unknown) {
    return err({
      kind: "malformed",
      path,
      detail: `Configuration ${path} is malformed: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
};

/** Read every applicable user file; malformed lower-priority files also stop setup. */
export const readClientConfigurationFiles = async (
  client: SetupClient,
  resources?: ArtifactResourceScope,
  options: {
    readonly workspaceDirectory?: string;
    readonly platform?: NodeJS.Platform;
  } = {},
): Promise<
  Result<readonly ClientConfigurationDocument[], ClientConfigurationFileError>
> => {
  const documents: ClientConfigurationDocument[] = [];
  for (const path of client.configPaths ?? [client.configPath]) {
    let projectDirectory = client.claudeProjectDirectory;
    if (
      client.name === "claude_code" &&
      options.workspaceDirectory !== undefined
    ) {
      try {
        projectDirectory = await claudeCodeProjectDirectory(
          options.workspaceDirectory,
          resources,
        );
      } catch (cause: unknown) {
        return err({
          kind:
            cause instanceof Error && "code" in cause
              ? "unreadable"
              : "malformed",
          path,
          requested_project_directory: options.workspaceDirectory,
          detail: `Could not inspect the selected Claude Code project for ${path}: ${cause instanceof Error ? cause.message : String(cause)}. Check project access and Git metadata, then rerun doctor.`,
          ...(cause instanceof RegularFileCleanupFailure
            ? { cleanupFailure: cause }
            : {}),
        });
      }
    }
    const document = await readConfigurationFile(
      path,
      client.format,
      resources,
      projectDirectory,
      {
        mode:
          client.claudeProjectDirectory === undefined ? "effective" : "local",
        platform: options.platform ?? process.platform,
      },
    );
    if (!document.ok)
      return err({
        ...document.error,
        ...(projectDirectory === undefined
          ? {}
          : { project_directory: projectDirectory }),
      });
    if (document.value !== undefined) {
      const selected = document.value;
      const environment = clientRegistrationEnvironment(selected);
      if (!environment.ok)
        return err({
          kind: "malformed",
          path,
          ...(client.name === "claude_code"
            ? {
                registration_scope:
                  selected.serversPath[0] === "projects"
                    ? ("local" as const)
                    : ("user" as const),
                ...(selected.diagnosticProjectDirectory === undefined
                  ? {}
                  : { project_directory: selected.diagnosticProjectDirectory }),
              }
            : {}),
          detail: `Configuration ${path} has an invalid REA server environment: ${environment.error.settings.map(({ setting, constraint }) => `${setting}: ${constraint}`).join("; ")}. Repair this registration before retrying.`,
        });
      documents.push(selected);
    }
  }
  return ok(documents);
};

/** OpenCode merges server objects in file order, replacing arrays and scalar values. */
const mergeConfigurationValue = (previous: unknown, next: unknown): unknown => {
  if (!isObject(previous) || !isObject(next)) return next;
  return Object.fromEntries(
    [...new Set([...Object.keys(previous), ...Object.keys(next)])].map(
      (key) => [
        key,
        Object.hasOwn(next, key)
          ? mergeConfigurationValue(previous[key], next[key])
          : previous[key],
      ],
    ),
  );
};
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Project a client's effective user registration without modifying its source files. */
export const effectiveClientConfiguration = (
  documents: readonly ClientConfigurationDocument[],
): ClientConfigurationDocument | undefined => {
  const last = documents.at(-1);
  if (last === undefined) return undefined;
  if (documents.length === 1) return last;
  const servers: Record<string, unknown> = {};
  for (const document of documents) {
    const names = new Set([
      ...Object.keys(document.legacyServers),
      ...Object.keys(document.servers),
    ]);
    for (const name of names)
      servers[name] = mergeConfigurationValue(
        servers[name],
        effectiveClientServer(document, name),
      );
  }
  return { ...last, servers, legacyServers: {} };
};
