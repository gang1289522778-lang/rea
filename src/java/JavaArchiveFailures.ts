import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import {
  JavaClassFormatFailure,
  JavaClassResourceFailure,
} from "./JavaClassFile.js";
import {
  JAVA_ARCHIVE_LIMITS,
  JavaArchiveFormatFailure,
  JavaArchiveResourceFailure,
} from "./JavaArchiveReader.js";

/** Caller-visible operations sharing one admission and parsing boundary. */
export type JavaOperation =
  | "inspect_java_archive"
  | "inspect_java_class"
  | "decompile_java_class";

/** A selected class is absent; the inventory tool is the recovery path. */
export const missingJavaClass = (
  operation: JavaOperation,
  className: string,
): AnalysisInputError =>
  new AnalysisInputError(operation, undefined, [
    {
      path: ["class_name"],
      reason: "invalid_value",
      message: `Class ${className} is not a regular class entry in the selected archive. List names with inspect_java_archive and its query filter.`,
    },
  ]);

/** Map reader, parser and filesystem failures to typed errors without partial success. */
export const javaArchiveFailure = (
  operation: JavaOperation,
  providerId: string,
  cause: unknown,
  path: string,
  signal?: AbortSignal,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (
    signal?.aborted === true ||
    (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled")
  )
    return new AnalysisCancelledError(operation, { cause });
  if (
    cause instanceof JavaArchiveResourceFailure ||
    cause instanceof JavaClassResourceFailure
  )
    return new AnalysisResourceConstraintError(
      operation,
      "memory",
      `Selected artifact ${path}: ${cause.message}`,
      { boundary: cause.boundary, maximum: cause.maximum },
      { cause },
    );
  if (cause instanceof JavaArchiveFormatFailure && cause.kind === "unsupported")
    return new AnalysisUnsupportedTargetError(operation, path, cause.message, {
      cause,
    });
  if (
    cause instanceof JavaArchiveFormatFailure ||
    cause instanceof JavaClassFormatFailure ||
    (cause instanceof ArtifactReaderFailure && cause.reason === "format")
  )
    return new AnalysisInputError(operation, { cause }, [
      {
        path: ["path"],
        reason: "invalid_format",
        message: `Selected artifact ${path}: ${cause.message}`,
      },
    ]);
  if (cause instanceof ArtifactReaderFailure) {
    if (cause.reason === "integrity")
      return new AnalysisArtifactChangedError(operation, path, cause.message, {
        cause,
      });
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        operation,
        cause.resourceLimit === undefined ? "file-size" : "memory",
        cause.message,
        cause.resourceLimit === undefined
          ? { maximum_input_bytes: JAVA_ARCHIVE_LIMITS.inputBytes }
          : { ...cause.resourceLimit },
        { cause },
      );
    if (cause.reason === "path")
      return new AnalysisInputError(operation, { cause }, [
        { path: ["path"], reason: "invalid_format", message: cause.message },
      ]);
    if (cause.reason === "unavailable")
      return new AnalysisUnsupportedTargetError(
        operation,
        path,
        cause.message,
        {
          cause,
        },
      );
  }
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(operation, path, cause.code, {
        cause,
      });
    if (
      ["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"].includes(
        String(cause.code),
      )
    )
      return new AnalysisInputError(operation, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected artifact could not be read (${String(cause.code)}): ${path}.`,
        },
      ]);
  }
  return new ProviderAdapterError(providerId, operation, {
    cause,
    diagnostics: {
      path,
      reason: cause instanceof Error ? cause.message : String(cause),
    },
  });
};
