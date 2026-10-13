import { z } from "incur";
import { resolve } from "node:path";
import type { Logger } from "pino";
import { createJavaArchiveService } from "../composition/java.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** Resolve caller paths and run JVM artifact inspection through the shared workflow. */
export const registerJavaCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<NodeJS.ProcessEnv>,
): void => {
  const service = createJavaArchiveService(environment);
  const path = z.string().describe("Local JAR or .class file");
  cli.command(CLI_COMMANDS.inspectJavaArchive, {
    description:
      "Inventory a JAR or class file: manifest, mod descriptors, packages and class rows",
    args: z.object({ path }),
    options: z.object({
      query: z
        .string()
        .optional()
        .describe("Case-sensitive substring of binary class names"),
      offset: z.number().optional().describe("First class row (default 0)"),
      limit: z
        .number()
        .optional()
        .describe("Class rows per page (default 100)"),
    }),
    run: ({ args, options }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectJavaArchive, async () => {
          const result = await service.inspectArchive(
            {
              path: resolve(args.path),
              ...(options.query === undefined ? {} : { query: options.query }),
              ...(options.offset === undefined
                ? {}
                : { offset: options.offset }),
              ...(options.limit === undefined ? {} : { limit: options.limit }),
            },
            { signal },
          );
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
  cli.command(CLI_COMMANDS.inspectJavaClass, {
    description:
      "Parse one class: members, annotations, string literals and references",
    args: z.object({
      path,
      class_name: z
        .string()
        .optional()
        .describe(
          "Binary name, exact .class path, or inventory entry_id; required for an archive",
        ),
    }),
    run: ({ args }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.inspectJavaClass, async () => {
          const result = await service.inspectClass(
            {
              path: resolve(args.path),
              ...(args.class_name === undefined
                ? {}
                : { class_name: args.class_name }),
            },
            { signal },
          );
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
  cli.command(CLI_COMMANDS.decompileJavaClass, {
    description:
      "Decompile one class to Java source with caller-supplied Vineflower (REA_VINEFLOWER_JAR)",
    args: z.object({
      path,
      class_name: z
        .string()
        .optional()
        .describe(
          "Binary name, exact .class path, or inventory entry_id; required for an archive",
        ),
    }),
    run: ({ args }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.decompileJavaClass, async () => {
          const result = await service.decompile(
            {
              path: resolve(args.path),
              ...(args.class_name === undefined
                ? {}
                : { class_name: args.class_name }),
            },
            { signal },
          );
          try {
            await service.close();
          } catch (cause) {
            // The operation already owns the original failure and cleanup paths.
            // A shutdown retry must not replace that richer typed projection.
            if (result.ok) throw cause;
          }
          return result.ok ? result.value : projectAnalysisError(result.error);
        }),
      ),
  });
};
