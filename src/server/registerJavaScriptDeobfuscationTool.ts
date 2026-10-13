import type { Logger } from "pino";

import type { JavaScriptDeobfuscationService } from "../application/javascript/JavaScriptDeobfuscationService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

export const registerJavaScriptDeobfuscationTool = (
  server: EvidenceMcpServer,
  service: JavaScriptDeobfuscationService,
  options: {
    readonly logger: Logger;
    readonly recordEvidence?: EvidenceWriter["recordEvidence"];
    readonly withAdmittedAnalysis?: WithAdmittedAnalysis;
  },
): void => {
  const { logger, recordEvidence, withAdmittedAnalysis } = options;
  const contract = toolContract("deobfuscate_javascript_source");
  const handler = createEvidenceToolHandler(
    server,
    (input, options) => service.deobfuscate(input, options),
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    handler(contract),
  );
};
