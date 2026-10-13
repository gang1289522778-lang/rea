import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { IosDeviceAnalysisService } from "../application/ios/IosDeviceAnalysisService.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { Logger } from "pino";
import { createContractToolHandler } from "./contractToolHandler.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";

/** Bind iOS device handlers to their exact named contracts. */
export const registerIosTools = (
  server: EvidenceMcpServer,
  service: IosDeviceAnalysisService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const handler = createContractToolHandler(
    server,
    service,
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  for (const contract of [
    toolContract("inspect_ios_toolchain"),
    toolContract("list_ios_devices"),
    toolContract("inspect_ios_device"),
    toolContract("list_ios_apps"),
    toolContract("list_ios_processes"),
    toolContract("inspect_ios_process"),
    toolContract("read_ios_log"),
    toolContract("pull_ios_file"),
    toolContract("run_ios_command"),
    toolContract("inspect_ios_runtime"),
    toolContract("attach_ios_debugserver"),
    toolContract("run_ios_lldb_command"),
    toolContract("run_ios_frida_script"),
    toolContract("dump_ios_process_memory"),
  ] as const) {
    server.registerTool(
      contract.name,
      toolRegistrationOptions(contract),
      handler(contract),
    );
  }
};
