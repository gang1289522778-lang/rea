import {
  javascriptDeobfuscationInputSchema,
  javascriptDeobfuscationResultSchema,
} from "../../domain/javascript/javascriptDeobfuscation.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import type { ToolContract } from "../toolContractTypes.js";

export const JAVASCRIPT_DEOBFUSCATION_TOOL_CONTRACTS = [
  {
    name: "deobfuscate_javascript_source",
    ...toolContractMetadata("deobfuscate_javascript_source"),
    kind: "application",
    description:
      "Safely simplify one local UTF-8 JavaScript file with caller-supplied js-redox deobfuscate-safe 0.1.0 on Linux x64. Publishes the exact input, proof-gated transformed source, validated js-safe-deobfuscate/v1 report and manifest into an absent output directory. Target JavaScript is never executed; unproven rewrites remain unchanged. Requires util-linux prlimit and a writable exec-capable TMPDIR (noexec mounts are unsupported); per-process 1 GiB address-space and 120 CPU-second limits, one shared 120-second launch deadline, 64 MiB input/output and 8 MiB diagnostic/report streams; no aggregate process-count limit is claimed.",
    inputSchema: javascriptDeobfuscationInputSchema,
    outputSchema: evidenceResultOf(javascriptDeobfuscationResultSchema),
    examples: [
      {
        title: "Safely simplify a captured script",
        input: {
          path: "/tmp/web-scripts/app.js",
          output_directory: "/tmp/deobfuscated-app",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
