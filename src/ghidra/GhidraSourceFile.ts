import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
} from "../domain/analysisErrorCore.js";

/** Reopen an admitted provider source without losing change/permission semantics. */
export const openGhidraSource = async (path: string): Promise<FileHandle> => {
  try {
    // A path replaced by a FIFO must not block startup before its type is checked.
    return await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (cause: unknown) {
    const code =
      cause instanceof Error && "code" in cause ? cause.code : undefined;
    if (code === "EACCES" || code === "EPERM")
      throw new AnalysisAccessDeniedError("open_binary", path, code, { cause });
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP")
      throw new AnalysisArtifactChangedError(
        "open_binary",
        path,
        `The selected Ghidra source could not be opened (${code})`,
        { cause },
      );
    throw cause;
  }
};
