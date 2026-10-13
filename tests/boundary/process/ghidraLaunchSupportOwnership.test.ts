import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const pidsSchema = z.object({
  probe: z.number().int().positive(),
  descendant: z.number().int().positive(),
});

describe.skipIf(process.platform !== "win32")(
  "LaunchSupport Windows owner exit",
  () => {
    it.each(["-envvars", "-vmargs"])(
      "releases the %s probe tree when the REA owner exits abruptly",
      async (mode) => {
        const root = await createTestTempDirectory("rea-ghidra-probe-owner-");
        const probePath = join(root, "probe.cjs");
        const ownerPath = join(root, "owner.mjs");
        // Node stands in for LaunchSupport only. Both process generations use
        // real Windows processes and the production Job Object implementation.
        await writeFile(
          probePath,
          `
const { spawn } = require("node:child_process");
if (process.argv.at(-1) !== ${JSON.stringify(mode)}) {
  process.stdout.write("GHIDRA_MAXMEM=512m\\n");
} else {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true, stdio: "ignore",
  });
  child.once("spawn", () => {
    process.stdout.write(JSON.stringify({ probe: process.pid, descendant: child.pid }) + "\\n");
  });
  setInterval(() => {}, 1000);
}
`,
          "utf8",
        );
        const launchUrl = new URL(
          "../../../dist/ghidra/GhidraJavaLaunch.js",
          import.meta.url,
        ).href;
        const processUrl = new URL(
          "../../../dist/process/ProviderProcess.js",
          import.meta.url,
        ).href;
        await writeFile(
          ownerPath,
          `
import { ghidraJavaLaunch } from ${JSON.stringify(launchUrl)};
import { spawnOwnedProviderProcess } from ${JSON.stringify(processUrl)};
await ghidraJavaLaunch({
  platform: "win32", analyzeHeadlessPath: ${JSON.stringify(join(root, "support", "analyzeHeadless.bat"))},
  javaHome: ${JSON.stringify(root)}, homeRoot: ${JSON.stringify(root)},
  configRoot: ${JSON.stringify(root)}, cacheRoot: ${JSON.stringify(root)}, tempRoot: ${JSON.stringify(root)},
  arguments: [], environment: process.env, runId: "owner-exit-test", timeoutMs: 15000, onStderr: () => {},
  spawnProbe: async (options) => {
    const launched = await spawnOwnedProviderProcess({
      ...options, command: process.execPath, expectedCommand: process.execPath,
      arguments: [${JSON.stringify(probePath)}, ...options.arguments],
    });
    if (options.arguments.at(-1) === ${JSON.stringify(mode)}) {
      let output = "";
      launched.process.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes("\\n")) process.send(JSON.parse(output.trim()));
      });
    }
    return launched;
  },
});
`,
          "utf8",
        );
        const owner = spawn(process.execPath, [ownerPath], {
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        let stderr = "";
        owner.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        const exited = once(owner, "close");
        onTestFinished(async () => {
          if (owner.exitCode === null && owner.signalCode === null)
            owner.kill();
          await exited;
        });
        const ready = new Promise<z.infer<typeof pidsSchema>>(
          (resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error(`Probe readiness timed out: ${stderr}`)),
              10000,
            );
            owner.once("message", (message: unknown) => {
              clearTimeout(timer);
              const parsed = pidsSchema.safeParse(message);
              if (parsed.success) resolve(parsed.data);
              else reject(parsed.error);
            });
            owner.once("error", (error) => {
              clearTimeout(timer);
              reject(error);
            });
            owner.once("close", () => {
              clearTimeout(timer);
              reject(
                new Error(`Owner exited before probe readiness: ${stderr}`),
              );
            });
          },
        );
        const pids = await ready;
        expect(() => process.kill(pids.probe, 0)).not.toThrow();
        expect(() => process.kill(pids.descendant, 0)).not.toThrow();
        expect(owner.kill()).toBe(true);
        await exited;
        await vi.waitFor(
          () => {
            expect(() => process.kill(pids.probe, 0)).toThrow();
            expect(() => process.kill(pids.descendant, 0)).toThrow();
          },
          { timeout: 5000 },
        );
      },
    );
  },
);
