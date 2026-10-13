import type { ArtifactResourceScope } from "../ArtifactResourceScope.js";
import type { ArtifactOccurrence } from "../../domain/artifactGraph.js";

/** Resolved integrity behavior admitted to the artifact scanner. */
export type ArtifactIntegrityPolicy =
  | { readonly mode: "fail" }
  | { readonly mode: "record-and-continue" };

export const STRICT_INTEGRITY_POLICY: ArtifactIntegrityPolicy = {
  mode: "fail",
};

/** Options shared by artifact inventory scans. */
export interface ArtifactInventoryOptions {
  readonly resourceScope: ArtifactResourceScope;
  readonly signal?: AbortSignal | undefined;
  readonly integrity?: ArtifactIntegrityPolicy | undefined;
  readonly environment?: Readonly<NodeJS.ProcessEnv> | undefined;
  /** Admit the current root before payload hashing or native child inventory. */
  readonly admitRootFormat?: (
    format: ArtifactOccurrence["artifact_format"],
  ) => void;
}
