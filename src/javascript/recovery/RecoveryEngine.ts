import type {
  ExecutionOptions,
  AnalysisExecution,
} from "../../application/AnalysisProvider.js";
import type { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import type { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import type { JavaScriptRecoveryInput } from "../../domain/javascript/javascriptRecovery.js";
import type {
  OwnedProviderProcessSpawnOptions,
  SpawnedOwnedProviderProcess,
} from "../../process/ProviderProcess.js";
import type { RecoveryInputSnapshot } from "./RecoveryFiles.js";

/** Per-operation resource bounds of one recovery engine. */
export type RecoveryLimits = {
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly outputEntries: number;
  readonly reportBytes: number;
  readonly addressSpaceBytes: number;
  readonly timeoutMs: number;
};

/** Operation deadline carrying the budget it was derived from. */
export type RecoveryDeadline = {
  readonly at: number;
  readonly timeoutMs: number;
};

/** A caller-supplied engine executable and the resource limiter, fingerprinted at resolution. */
export type RecoveryTool = {
  readonly command: string;
  readonly limiter: string;
  readonly sha256: string;
  readonly bytes: number;
};

/** Inject the owned process launcher while retaining production protocol parsing. */
export type RecoveryLauncher = (
  options: OwnedProviderProcessSpawnOptions,
) => Promise<SpawnedOwnedProviderProcess>;

/** Private workspace and exclusively owned output tree for one recovery operation. */
export type RecoveryWorkspace = {
  readonly root: string;
  readonly tree: SafeOutputTree;
  readonly input: JavaScriptRecoveryInput;
  readonly sources: readonly [
    RecoveryInputSnapshot,
    ...RecoveryInputSnapshot[],
  ];
  readonly tool: RecoveryTool;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly launcher: RecoveryLauncher | undefined;
  readonly options: ExecutionOptions | undefined;
  readonly deadline: RecoveryDeadline;
};

/** One caller-supplied recovery engine behind `recover_javascript_sources`. */
export interface RecoveryEngine {
  readonly id: JavaScriptRecoveryInput["engine"];
  readonly limits: RecoveryLimits;
  /** Reject options the engine cannot honour before any workspace exists. */
  validate(input: JavaScriptRecoveryInput): AnalysisInputError | undefined;
  resolve(
    environment: Readonly<Record<string, string | undefined>>,
  ): Promise<RecoveryTool>;
  /** Run, verify and publish into the workspace tree; the provider commits it. */
  execute(workspace: RecoveryWorkspace): Promise<AnalysisExecution>;
}
