import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  JavaClassSelectionInput,
  InspectJavaArchiveInput,
  JavaArchive,
  JavaClassReport,
  JavaDecompilation,
} from "../../domain/java/javaArchive.js";
import type { Result } from "../../domain/result.js";

/** Replaceable offline JVM artifact readers; none loads or executes target classes. */
export interface JavaArchivePort {
  readonly identities: {
    readonly classFile: ProviderIdentity;
    readonly decompiler: ProviderIdentity;
  };
  /** Retry removal of retained decompiler workspaces. */
  close(): Promise<void>;
  inspectArchive(
    input: InspectJavaArchiveInput,
    options?: ExecutionOptions,
  ): Promise<Result<JavaArchive, AnalysisError>>;
  inspectClass(
    input: JavaClassSelectionInput,
    options?: ExecutionOptions,
  ): Promise<Result<JavaClassReport, AnalysisError>>;
  decompile(
    input: JavaClassSelectionInput,
    options?: ExecutionOptions,
  ): Promise<Result<JavaDecompilation, AnalysisError>>;
}
