import { z } from "incur";
import type { Logger } from "pino";

import { JavaScriptDeobfuscationService } from "../application/javascript/JavaScriptDeobfuscationService.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { createJavaScriptDeobfuscationProvider } from "../composition/javascriptDeobfuscation.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { withCommandCancellation } from "./commandCancellation.js";
import type { CliInstance } from "./types.js";

export const registerJavaScriptDeobfuscationCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  const service = new JavaScriptDeobfuscationService(
    createJavaScriptDeobfuscationProvider(environment),
  );
  cli.command(CLI_COMMANDS.deobfuscateJavaScriptSource, {
    description:
      "Proof-gated static JavaScript deobfuscation with exact provenance",
    args: z.object({
      path: z
        .string()
        .describe("Absolute UTF-8 JavaScript input; never executed"),
      outputDirectory: z.string().describe("Absolute absent output directory"),
    }),
    options: z.object({
      maxIterations: z
        .number()
        .int()
        .min(1)
        .max(64)
        .optional()
        .describe("Maximum proof-gated optimization iterations (1–64)"),
    }),
    run: ({ args, options }) =>
      withCommandCancellation(async (signal) => {
        try {
          return await logCliCommand(
            logger,
            CLI_COMMANDS.deobfuscateJavaScriptSource,
            async () => {
              const result = await service.deobfuscate(
                {
                  path: args.path,
                  output_directory: args.outputDirectory,
                  ...(options.maxIterations === undefined
                    ? {}
                    : { max_iterations: options.maxIterations }),
                },
                { signal },
              );
              return result.ok
                ? result.value
                : projectAnalysisError(result.error);
            },
          );
        } finally {
          await service.close();
        }
      }),
  });
};
