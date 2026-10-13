import {
  javascriptRecoveryInputSchema,
  javascriptRecoveryResultSchema,
} from "../../domain/javascript/javascriptRecovery.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import type { ToolContract } from "../toolContractTypes.js";

/** Derived script artifacts from optional upstream recovery adapters. */
export const JAVASCRIPT_RECOVERY_TOOL_CONTRACTS = [
  {
    name: "recover_javascript_sources",
    ...toolContractMetadata("recover_javascript_sources"),
    kind: "application",
    description:
      "Recover readable modules from local UTF-8 JavaScript scripts/bundles into an absent directory with a caller-supplied engine. engine wakaru (default): Wakaru ^1.13.0 (verified with 1.14.0) on Linux x64 unpacks modules; structural splitting may fall back to one module; one worker, 1 GiB address-space ceiling, 120-second deadline, 64 MiB total input, 128 MiB output, 10000 entries and 8 MiB per diagnostic/report stream. engine jsbeautify: jsbeautify on Linux rewrites each file whole (rewrite_level minimal formats, standard deobfuscates, aggressive also infers local names) and publishes only files whose generated output re-parses; 8 GiB address-space ceiling, 300-second deadline, 256 MiB output, 64 MiB per diagnostic stream. Use additional_paths for related chunks; each input retains its own snapshot and provenance. Returns original/derived digests, byte ranges, source maps, warnings and analysis_input inline. Original names and runtime equivalence remain unknown. No application code execution. Requires util-linux prlimit.",
    inputSchema: javascriptRecoveryInputSchema,
    outputSchema: evidenceResultOf(javascriptRecoveryResultSchema),
    examples: [
      {
        title: "Recover a captured production bundle",
        input: {
          path: "/tmp/web-scripts/app.js",
          output_directory: "/tmp/recovered-app",
        },
      },
      {
        title: "Deobfuscate an esbuild bundle with jsbeautify",
        input: {
          path: "/tmp/app/dist/electron-main/main.cjs",
          output_directory: "/tmp/recovered-main",
          engine: "jsbeautify",
        },
      },
      {
        title: "Recover a code-split bundle together",
        input: {
          path: "/tmp/web-scripts/main.js",
          additional_paths: [
            "/tmp/web-scripts/runtime.js",
            "/tmp/web-scripts/shared.js",
            "/tmp/web-scripts/checkout.chunk.js",
          ],
          output_directory: "/tmp/recovered-chunks",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
