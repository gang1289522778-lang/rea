import { existsSync, statSync } from "node:fs";
import { resolve, win32 } from "node:path";

/** Resolve Windows provider paths and bare names before native launch. */
export const resolveWindowsProviderExecutable = (
  executable: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): string => {
  const root = win32.parse(executable).root;
  if (/^[A-Za-z]:[\\/]/u.test(root) || root.startsWith("\\\\"))
    return executable;
  if (root !== "" || executable.includes("/") || executable.includes("\\"))
    return resolve(executable);

  const pathValue = environment.PATH ?? environment.Path ?? environment.path;
  if (pathValue === undefined) return executable;
  const pathEntries = pathValue.split(";");
  const explicitExtension = win32.extname(executable).toLowerCase();
  if (explicitExtension !== "" && ![".com", ".exe"].includes(explicitExtension))
    return executable;
  const extensions =
    explicitExtension !== ""
      ? [""]
      : (environment.PATHEXT ?? environment.PathExt ?? ".COM;.EXE")
          .split(";")
          .filter((extension) =>
            [".com", ".exe"].includes(extension.toLowerCase()),
          );

  for (const entry of pathEntries) {
    if (entry.length === 0) continue;
    for (const extension of extensions) {
      const candidate = resolve(entry, `${executable}${extension}`);
      // The captured PATH is Windows-formatted even when this resolver is unit-tested elsewhere.
      try {
        if (existsSync(candidate) && statSync(candidate).isFile())
          return candidate;
      } catch {
        // An inaccessible PATH entry is equivalent to a missing candidate.
      }
    }
  }
  return executable;
};
