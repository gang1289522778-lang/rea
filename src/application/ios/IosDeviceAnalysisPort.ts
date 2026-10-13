import type {
  AnalysisExecution,
  ExecutionOptions,
  ProviderAvailability,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { IosRequest } from "../../domain/ios/iosDeviceAnalysis.js";
import type { Result } from "../../domain/result.js";

/** iOS acquisition boundary over libimobiledevice and a caller-authorized SSH tunnel. */
export interface IosDeviceAnalysisPort {
  inspectAvailability(signal?: AbortSignal): Promise<ProviderAvailability>;
  close(): Promise<void>;
  execute(
    request: IosRequest,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
}
