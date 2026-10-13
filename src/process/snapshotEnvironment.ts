import { environmentKeyIdentity } from "../config/environmentKey.js";

/** Snapshot caller-selected variables using Node child-process key semantics. */
export const snapshotEnvironment = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform = process.platform,
): Readonly<NodeJS.ProcessEnv> => {
  if (platform !== "win32") return Object.freeze({ ...environment });
  const snapshot: NodeJS.ProcessEnv = {};
  // Node sorts keys lexicographically and forwards the first case-insensitive
  // match on Windows. Canonical keys also make subsequent lookups deterministic.
  for (const key of Object.keys(environment).sort()) {
    const canonicalKey = environmentKeyIdentity(key, platform);
    if (!Object.hasOwn(snapshot, canonicalKey))
      snapshot[canonicalKey] = environment[key];
  }
  return Object.freeze(snapshot);
};
