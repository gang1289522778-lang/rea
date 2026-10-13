import { z } from "zod";
import { isAbsolute } from "node:path";

/**
 * A caller-owned, pre-imported Ghidra project that REA opens with `-process`
 * instead of importing the target again. This lets the import and
 * auto-analysis cost be paid once, outside the provider startup deadline, and
 * reused by later sessions.
 *
 * The headless open selects the fixed project name `rea-project`, so
 * `projectPath` must hold `rea-project.grez` or `rea-project.rep`. REA works on
 * an owned copy and never writes the caller's project directory.
 */
export interface GhidraExistingProject {
  /** Directory holding the pre-imported project as `rea-project.grez` or `rea-project.rep`. */
  readonly projectPath: string;
  /** Imported program name selected with `-process`. */
  readonly programName: string;
}

export const ghidraExistingProjectPathSchema = z
  .string()
  .min(1)
  .refine(isAbsolute, "REA_GHIDRA_EXISTING_PROJECT must be absolute");

export const ghidraExistingProgramNameSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value.trim() === value,
    "REA_GHIDRA_EXISTING_PROGRAM must not have leading or trailing whitespace",
  );
