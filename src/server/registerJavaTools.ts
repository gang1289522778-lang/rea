import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { JavaArchiveService } from "../application/java/JavaArchiveService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Bind each named Java contract to its shared workflow and session Evidence ledger. */
export const registerJavaTools = (
  server: EvidenceMcpServer,
  service: JavaArchiveService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  for (const [name, run] of [
    ["inspect_java_archive", service.inspectArchive.bind(service)],
    ["inspect_java_class", service.inspectClass.bind(service)],
    ["decompile_java_class", service.decompile.bind(service)],
  ] as const) {
    const contract = toolContract(name);
    const handler = createEvidenceToolHandler(
      server,
      run,
      logger,
      recordEvidence,
      withAdmittedAnalysis,
    );
    server.registerTool(
      contract.name,
      toolRegistrationOptions(contract),
      handler(contract),
    );
  }
};
