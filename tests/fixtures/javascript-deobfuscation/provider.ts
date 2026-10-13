import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

import { JavaScriptDeobfuscationService } from "../../../src/application/javascript/JavaScriptDeobfuscationService.js";
import { createJavaScriptDeobfuscationProvider } from "../../../src/composition/javascriptDeobfuscation.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { createTestTempDirectory } from "../temporaryDirectory.js";
import { readLinuxResourceLimits } from "../../../src/process/LinuxResourceLimits.js";
import { JS_REDOX_LIMITS } from "../../../src/javascript/deobfuscation/JsRedoxRelease.js";

/** Exercise the production provider boundary while replacing only the external producer bytes. */
export const deobfuscationFixture = async (
  mode = "normal",
  source = 'const table = ["hello", "world"];\nconsole.log(table[0] + " " + table[1]);\n',
  environment: Readonly<NodeJS.ProcessEnv> = {},
) => {
  const root = await createTestTempDirectory("rea-js-redox-fixture-");
  const path = join(root, "selected.js");
  await writeFile(path, source);
  const command = join(root, "fixture-js-redox");
  await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const launches: { cwd: string | undefined; pid: number | undefined }[] = [];
  const engineSnapshots: { path: string; bytes: Buffer }[] = [];
  const provider = createJavaScriptDeobfuscationProvider(
    { ...process.env, REA_JS_REDOX_COMMAND: command, ...environment },
    async (options) => {
      const separator = options.arguments.indexOf("--");
      const enginePath = options.arguments[separator + 1];
      if (enginePath === undefined)
        throw new Error("js-redox fixture launch omitted engine path");
      expect(options.command).toBe(
        environment.REA_JAVASCRIPT_PRLIMIT_COMMAND ?? "/usr/bin/prlimit",
      );
      const limits = await readLinuxResourceLimits({
        address_space_bytes: JS_REDOX_LIMITS.addressSpaceBytes,
        file_bytes: JS_REDOX_LIMITS.outputBytes,
        cpu_seconds: JS_REDOX_LIMITS.cpuSeconds,
      });
      expect(options.arguments.slice(0, separator + 1)).toEqual([
        `--as=${limits.address_space_bytes}`,
        `--fsize=${limits.file_bytes}`,
        "--core=0",
        `--cpu=${limits.cpu_seconds}`,
        "--",
      ]);
      const phase = options.arguments.slice(separator + 2).includes("--version")
        ? "version"
        : "transform";
      expect(enginePath).toBe(join(options.cwd!, `deobfuscate-safe-${phase}`));
      engineSnapshots.push({
        path: enginePath,
        bytes: await readFile(enginePath),
      });
      const start = separator + 2;
      const child = await spawnOwnedProviderProcess({
        ...options,
        command: process.execPath,
        expectedCommand: process.execPath,
        arguments: [
          fileURLToPath(new URL("./producer.mjs", import.meta.url)),
          ...options.arguments.slice(start),
        ],
        env: {
          ...options.env,
          REA_DEOBFUSCATION_FIXTURE_MODE: mode,
          REA_DEOBFUSCATION_PRIVATE_ENGINE: enginePath,
        },
      });
      launches.push({ cwd: options.cwd, pid: child.process.pid });
      return child;
    },
  );
  return {
    provider,
    service: new JavaScriptDeobfuscationService(provider),
    path,
    output: join(root, "output"),
    command,
    launches,
    engineSnapshots,
  };
};

export const assertDeobfuscationCleanup = async (
  launches: Awaited<ReturnType<typeof deobfuscationFixture>>["launches"],
): Promise<void> => {
  for (const launch of launches) {
    const pid = launch.pid;
    if (pid !== undefined)
      expect(() => process.kill(-pid, 0)).toThrowError(
        expect.objectContaining({ code: "ESRCH" }),
      );
    if (launch.cwd !== undefined)
      await expect(access(launch.cwd)).rejects.toMatchObject({
        code: "ENOENT",
      });
  }
};
