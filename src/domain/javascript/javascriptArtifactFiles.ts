import type { JavaScriptSourceSelection } from "./javascriptSourceSelection.js";

/** Relevant file categories projected from the complete artifact inventory. */
export type JavaScriptArtifactFileKind =
  | "package-json"
  | "json"
  | "javascript"
  | "html"
  | "source-map"
  | "native-addon";

/** One content-addressed local artifact file and its text availability. */
export interface JavaScriptArtifactFile {
  readonly path: string;
  readonly container_sha256: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly inventory_artifact_id: string;
  readonly kind: JavaScriptArtifactFileKind;
  readonly unpacked: boolean;
  readonly text:
    | { readonly included: true; readonly value: string }
    | {
        readonly included: false;
        readonly reason:
          | "not-applicable"
          | "invalid-utf8"
          | "outside-analysis-scope";
      };
}

/** One filesystem-backed ASAR nested beneath a directory input. */
export interface JavaScriptArtifactContainer {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly inventory_artifact_id: string;
}

/** Deterministic relevant-file projection plus explicit omissions. */
export interface JavaScriptArtifactFileSet {
  readonly files: readonly JavaScriptArtifactFile[];
  readonly containers: readonly JavaScriptArtifactContainer[];
  readonly text_bytes_read: number;
  readonly invalid_utf8_files: number;
  readonly source_selection?: JavaScriptSourceSelection;
}

/** Source suffixes admitted by the JavaScript artifact acquisition boundary. */
export const isJavaScriptSourcePath = (path: string): boolean =>
  /\.(?:cjs|cts|mjs|mts|js|jsx|ts|tsx)$/iu.test(path);

/** Relevant path roles admitted by JavaScript artifact acquisition. */
export const classifyJavaScriptArtifactFilePath = (
  path: string,
): JavaScriptArtifactFileKind | undefined => {
  const lower = path.toLowerCase();
  if (lower === "package.json" || lower.endsWith("/package.json"))
    return "package-json";
  if (lower.endsWith(".json")) return "json";
  if (isJavaScriptSourcePath(path)) return "javascript";
  if (/\.html?$/u.test(lower)) return "html";
  if (lower.endsWith(".map")) return "source-map";
  if (lower.endsWith(".node")) return "native-addon";
  return undefined;
};
