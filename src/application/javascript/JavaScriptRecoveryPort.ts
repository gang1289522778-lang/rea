import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { JavaScriptRecoveryInput } from "../../domain/javascript/javascriptRecovery.js";
import type { Result } from "../../domain/result.js";
import type {
  AnalysisExecution,
  ExecutionOptions,
} from "../AnalysisProvider.js";

/** Typed boundary for upstream source recovery without exposing its protocol. */
export interface JavaScriptRecoveryPort {
  /** Engine IDs offered by this port; omission preserves unknown support. */
  readonly engines?: readonly JavaScriptRecoveryInput["engine"][];
  close?(): Promise<void>;
  recover(
    input: JavaScriptRecoveryInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
}
