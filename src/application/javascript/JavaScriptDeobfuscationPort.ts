import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { JavaScriptDeobfuscationInput } from "../../domain/javascript/javascriptDeobfuscation.js";
import type { Result } from "../../domain/result.js";
import type {
  AnalysisExecution,
  ExecutionOptions,
} from "../AnalysisProvider.js";

/** Typed boundary for proof-gated JavaScript rewriting without exposing engine protocol. */
export interface JavaScriptDeobfuscationPort {
  close?(): Promise<void>;
  deobfuscate(
    input: JavaScriptDeobfuscationInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>>;
}
