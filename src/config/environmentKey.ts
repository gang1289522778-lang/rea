/** Environment-variable identity used by Node's Windows child-process boundary. */
export const environmentKeyIdentity = (
  name: string,
  platform: NodeJS.Platform,
): string => (platform === "win32" ? name.toUpperCase() : name);

/** Return the source-spelled key selected by the platform's variable identity. */
export const environmentKey = (
  environment: Readonly<Record<string, unknown>>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined => {
  if (platform !== "win32")
    return Object.hasOwn(environment, name) ? name : undefined;
  const identity = environmentKeyIdentity(name, platform);
  // Node forwards the first lexicographic spelling when Windows keys collide.
  return Object.keys(environment)
    .sort()
    .find((key) => environmentKeyIdentity(key, platform) === identity);
};
