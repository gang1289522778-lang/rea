import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { TestReverseEngineeringService as ReverseEngineeringService } from "../support/reverseEngineeringService.js";

type PromiseOutcome<Value> =
  | { readonly status: "fulfilled"; readonly value: Value }
  | { readonly status: "rejected"; readonly reason: unknown }
  | { readonly status: "timeout" };

const settleWithin = async <Value>(
  promise: Promise<Value>,
  timeoutMs: number,
): Promise<PromiseOutcome<Value>> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        (value): PromiseOutcome<Value> => ({ status: "fulfilled", value }),
        (reason: unknown): PromiseOutcome<Value> => ({
          status: "rejected",
          reason,
        }),
      ),
      new Promise<PromiseOutcome<Value>>((resolve) => {
        timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const processIsRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return !(
      cause instanceof Error &&
      "code" in cause &&
      cause.code === "ESRCH"
    );
  }
};

const waitForProcessExit = async (
  pid: number,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !processIsRunning(pid);
};

const killProcessAndWait = async (
  pid: number,
  timeoutMs: number,
): Promise<boolean> => {
  try {
    process.kill(pid, "SIGKILL");
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH"))
      throw cause;
  }
  return waitForProcessExit(pid, timeoutMs);
};

it("uses stoppable process mode for caller-selected provider commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-rizin-stoppable-"));
  const path = join(directory, "fixture.bin");
  await writeFile(path, "fixture");
  let received: Record<string, unknown> | undefined;
  const service = new ReverseEngineeringService({
    run: async (_command, _args, options) => {
      received = options as Record<string, unknown>;
      return { stdout: "", stderr: "" };
    },
  });

  try {
    await service.executeRizinCommand({ path, command: "iI" });
    expect(received?.stopSignal).toBe("SIGTERM");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")(
  "waits for a cancelled Rizin process to exit before returning",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-rizin-cancel-settle-"));
    const path = join(directory, "fixture.bin");
    const descendantStartedMarker = join(directory, "descendant-started");
    const descendantPidMarker = join(directory, "descendant-pid");
    const descendantMarker = join(directory, "descendant-finished");
    const provider = join(directory, "slow-rizin.mjs");
    const descendantScript = [
      "const fs = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      "fs.writeFileSync(process.env.REA_TEST_DESCENDANT_STARTED, 'started');",
      "setTimeout(() => fs.writeFileSync(process.env.REA_TEST_DESCENDANT, 'finished'), 500);",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    await writeFile(path, "before");
    await writeFile(
      provider,
      `#!${process.execPath}
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
process.stdout.write("provider output before cancellation");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { env: process.env, stdio: "ignore" });
writeFileSync(process.env.REA_TEST_DESCENDANT_PID, String(child.pid));
setInterval(() => {}, 1000);
`,
    );
    await chmod(provider, 0o755);
    const controller = new AbortController();
    const service = new ReverseEngineeringService({
      environment: {
        REA_RIZIN_COMMAND: provider,
        REA_TEST_ARTIFACT: path,
        REA_TEST_DESCENDANT_STARTED: descendantStartedMarker,
        REA_TEST_DESCENDANT_PID: descendantPidMarker,
        REA_TEST_DESCENDANT: descendantMarker,
      },
    });

    let pending: ReturnType<typeof service.executeRizinCommand> | undefined;
    let descendantPid: number | undefined;
    try {
      pending = service.executeRizinCommand(
        { path, command: "sleep" },
        { signal: controller.signal },
      );
      let descendantStarted = false;
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const pidText = await readFile(descendantPidMarker, "utf8").catch(
          () => "",
        );
        const parsedPid = Number(pidText);
        if (Number.isSafeInteger(parsedPid) && parsedPid > 0)
          descendantPid = parsedPid;
        descendantStarted = await readFile(descendantStartedMarker).then(
          () => true,
          () => false,
        );
        if (descendantPid !== undefined && descendantStarted) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      expect(descendantStarted).toBe(true);
      expect(descendantPid).toBeDefined();
      controller.abort();

      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error._tag).toBe("AnalysisCancelledError");
        expect(result.error.cleanup).toBeUndefined();
        expect(result.error.capturedOutput).toMatchObject({
          stdout: "provider output before cancellation",
          stderr: "",
          truncated: false,
          exit_code: null,
          signal: "SIGKILL",
        });
        expect(result.error.cause).toBeInstanceOf(Error);
        expect(result.error.partialObservation).toMatchObject({
          raw_result: {
            stdout: "provider output before cancellation",
            completion_status: "unknown",
          },
        });
      }
      expect(await readFile(path, "utf8")).toBe("before");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 600));
      await expect(readFile(descendantMarker)).rejects.toMatchObject({
        code: "ENOENT",
      });
      if (descendantPid !== undefined)
        expect(await waitForProcessExit(descendantPid, 2_000)).toBe(true);
    } finally {
      controller.abort();
      try {
        if (pending !== undefined) {
          let outcome = await settleWithin(pending, 7_000);
          if (outcome.status === "timeout") {
            if (descendantPid !== undefined)
              expect(await killProcessAndWait(descendantPid, 2_000)).toBe(true);
            outcome = await settleWithin(pending, 3_000);
          }
          if (outcome.status === "timeout")
            throw new Error(
              "Rizin cancellation did not settle within its cleanup deadline",
            );
          if (outcome.status === "rejected") throw outcome.reason;
        }
      } finally {
        try {
          let cleanup = await settleWithin(service.close(), 7_000);
          if (cleanup.status === "timeout") {
            if (descendantPid !== undefined)
              expect(await killProcessAndWait(descendantPid, 2_000)).toBe(true);
            cleanup = await settleWithin(service.close(), 3_000);
          }
          if (cleanup.status === "timeout")
            throw new Error(
              "Reverse-engineering service cleanup did not settle within its deadline",
            );
          if (cleanup.status === "rejected") throw cleanup.reason;
        } finally {
          try {
            if (descendantPid !== undefined && processIsRunning(descendantPid))
              expect(await killProcessAndWait(descendantPid, 2_000)).toBe(true);
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        }
      }
    }
  },
);
