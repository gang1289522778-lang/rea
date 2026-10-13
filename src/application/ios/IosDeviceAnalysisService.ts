import type { ExecutionOptions } from "../AnalysisProvider.js";
import { executeProviderOperation } from "../ProviderOperationExecution.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { Evidence } from "../../domain/evidence.js";
import {
  iosRequestSchema,
  type IosOperation,
} from "../../domain/ios/iosDeviceAnalysis.js";
import type { Result } from "../../domain/result.js";
import type { IosDeviceAnalysisPort } from "./IosDeviceAnalysisPort.js";

/** Shared CLI/MCP admission and Evidence composition for iOS devices. */
export class IosDeviceAnalysisService {
  constructor(readonly provider: IosDeviceAnalysisPort) {}

  async execute(
    operation: IosOperation,
    input: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return executeProviderOperation(
      operation,
      input,
      options,
      iosRequestSchema,
      this.provider,
      "observed",
    );
  }
}
