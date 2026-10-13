import { parseXmlPropertyList } from "../domain/propertyListKeys.js";

export const parseIosDeviceIds = (output: string) => {
  const ids: string[] = [];
  const unparsed: string[] = [];
  for (const line of output.split(/\r?\n/u).filter(Boolean)) {
    if (/^[A-Za-z0-9][A-Za-z0-9-]*$/u.test(line)) ids.push(line);
    else unparsed.push(line);
  }
  return { ids, unparsed };
};

/** Parse installer XML instead of guessing CSV quoting or app type from names. */
export const parseIosApps = (output: string) => {
  const decoded = parseXmlPropertyList(output).value;
  if (!Array.isArray(decoded))
    throw new Error("Installer plist is not an application array");
  const apps: Array<{
    bundle_id: string;
    version: string | null;
    name: string | null;
    path: string | null;
    executable: string | null;
    scope: "user" | "system" | "unknown";
  }> = [];
  let invalidEntries = 0;
  for (const value of decoded as unknown[]) {
    if (value === null || typeof value !== "object") {
      invalidEntries += 1;
      continue;
    }
    const record = value as Record<string, unknown>;
    const text = (key: string) =>
      typeof record[key] === "string" ? (record[key] as string) : null;
    const id = text("CFBundleIdentifier");
    if (id === null || id === "") {
      invalidEntries += 1;
      continue;
    }
    const type = text("ApplicationType");
    apps.push({
      bundle_id: id,
      version: text("CFBundleShortVersionString"),
      name: text("CFBundleDisplayName") ?? text("CFBundleName"),
      path: text("Path"),
      executable: text("CFBundleExecutable"),
      scope:
        type === "User" ? "user" : type === "System" ? "system" : "unknown",
    });
  }
  return { apps, invalidEntries };
};

export const parseIosProcessList = (output: string) => {
  const processes: Array<{ pid: number; name: string; raw: string }> = [];
  const unparsed: string[] = [];
  for (const line of output.split(/\r?\n/u).filter(Boolean)) {
    const match = /^(\d+)\s+(.+)$/u.exec(line);
    const pid = match === null ? NaN : Number(match[1]);
    if (match === null || !Number.isSafeInteger(pid)) {
      unparsed.push(line);
      continue;
    }
    processes.push({ pid, name: match[2]!, raw: line });
  }
  return { processes, unparsed };
};

export const parseIosInfo = (output: string): Map<string, string> => {
  const result = new Map<string, string>();
  for (const line of output.split(/\r?\n/u)) {
    const separator = line.indexOf(": ");
    if (separator > 0)
      result.set(line.slice(0, separator), line.slice(separator + 2));
  }
  return result;
};

/** SSH passes one command string to a remote login shell; quote at that boundary. */
export const quoteIosShell = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

/** Discover rootless/root-hide tool directories without changing the device. */
export const IOS_JAILBREAK_PATH_SCRIPT = String.raw`
PATH=/usr/bin:/bin:/usr/sbin:/sbin
for rea_root in /var/jb /var/containers/Bundle/Application/.jbroot-*; do
  [ -d "$rea_root" ] || continue
  PATH="$PATH:$rea_root/usr/bin:$rea_root/bin:$rea_root/usr/sbin:$rea_root/sbin"
done
export PATH
`.trimEnd();

/** Parse the tab-delimited tool inventory emitted by a jailbreak shell probe. */
export const parseIosRemoteTools = (output: string) => {
  const tools: Array<{
    name: string;
    path: string | null;
    available: boolean;
  }> = [];
  const unparsed: string[] = [];
  for (const line of output.split(/\r?\n/u).filter(Boolean)) {
    const separator = line.indexOf("\t");
    if (separator <= 0) {
      unparsed.push(line);
      continue;
    }
    const name = line.slice(0, separator);
    const path = line.slice(separator + 1).trim() || null;
    tools.push({ name, path, available: path !== null });
  }
  return { tools, unparsed };
};

export const parseIosStopReason = (output: string): string | null =>
  output.match(/stop reason = (.+)/iu)?.[1]?.trim() ?? null;
