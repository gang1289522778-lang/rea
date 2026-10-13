import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { expect, it, vi } from "vitest";

import type {
  OwnedProviderProcessSpawnOptions,
  ProviderProcessLaunch,
  ProviderProcessSupervisor,
} from "../../src/process/ProviderProcess.js";
import {
  retirePrototypePublicClient,
  verifyGhidraPrototypeDiagnostics,
} from "../../scripts/verify-ghidra-prototype-diagnostics.mjs";
import { waitForExit } from "../support/process/processFixture.js";

const control = vi.hoisted(() => ({
  child: undefined as ChildProcess | undefined,
  supervisor: undefined as ProviderProcessSupervisor | undefined,
  workspace: undefined as string | undefined,
  allowCleanup: false,
}));

// Inject a hung producer and an unavailable ownership observation, while retaining
// the actual supervisor, child streams, assembly build, and workspace lifecycle.
vi.mock("../../dist/process/ProviderProcess.js", async () => {
  const actual = await import("../../src/process/ProviderProcess.js");
  return {
    spawnOwnedProviderProcess: async (
      options: OwnedProviderProcessSpawnOptions,
    ) => {
      const project = options.arguments[0];
      if (project === undefined) throw new Error("Missing producer project");
      control.workspace = dirname(project);
      const child = spawn(
        process.execPath,
        [
          "-e",
          "process.stdin.on('data', chunk => process.stdout.write(chunk)); process.stdout.write('ready');",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      control.child = child;
      if (child.stdout === null) throw new Error("Missing child output");
      await once(child.stdout, "data");
      return {
        process: child,
        ownership: {
          runId: options.runId,
          leaderPid: child.pid,
          processGroupId: child.pid,
          expectedParentPid: process.pid,
        },
      };
    },
    ProviderProcessSupervisor: class extends actual.ProviderProcessSupervisor {
      constructor(launch: ProviderProcessLaunch) {
        super(launch);
        control.supervisor = this;
      }

      override waitForExit(timeoutMs: number): Promise<boolean> {
        return super.waitForExit(Math.min(timeoutMs, 50));
      }
    },
  };
});

vi.mock("../../dist/process/ProcessOwnership.js", () => ({
  cleanupOwnedProcessGroup: () => {
    if (!control.allowCleanup)
      return Promise.resolve({
        cleaned: false,
        reason: "observation unavailable",
      });
    control.child?.kill("SIGTERM");
    return Promise.resolve({ cleaned: true });
  },
}));

it.runIf(process.platform === "linux" && process.arch === "x64")(
  "retains a failed cleanup's project and supervision so ownership can be retried",
  async () => {
    const previousRunId = process.env.REA_PROCESS_RUN_ID;
    try {
      const failure: unknown = await verifyGhidraPrototypeDiagnostics({
        installation: { analyzeHeadlessPath: "controlled-test-producer" },
      }).catch((cause: unknown) => cause);
      const { child, workspace, supervisor } = control;
      if (
        child === undefined ||
        workspace === undefined ||
        supervisor === undefined
      )
        throw new Error("Producer control was not launched");

      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      await expect(access(workspace)).resolves.toBeUndefined();
      expect(failure).toMatchObject({
        cleanupFailure: "observation unavailable",
        cleanupOwner: supervisor,
        resources: expect.arrayContaining([workspace]),
        cause: expect.objectContaining({
          message: "Prototype producer probe exceeded its headless deadline",
        }),
      });
      child.stdin?.write("still-owned");
      await expect
        .poll(() => supervisor.snapshot().stdout.text)
        .toContain("still-owned");

      control.allowCleanup = true;
      expect(await supervisor.stop()).toEqual({ status: "verified-cleanup" });
      expect(await waitForExit(child, 1_000)).toBe(true);
    } finally {
      control.allowCleanup = true;
      await control.supervisor?.stop();
      if (control.child !== undefined) {
        control.child.kill("SIGKILL");
        await waitForExit(control.child, 1_000);
      }
      if (control.workspace !== undefined)
        await rm(control.workspace, { recursive: true, force: true });
      if (previousRunId === undefined) delete process.env.REA_PROCESS_RUN_ID;
      else process.env.REA_PROCESS_RUN_ID = previousRunId;
    }
  },
);

it("keeps the public cleanup client and workspace after incomplete binary close, then retries", async () => {
  const workspace = await mkdtemp(
    join(tmpdir(), "rea-public-prototype-cleanup-"),
  );
  const primaryFailure = new Error("analysis failed");
  const cleanupFailure = new Error("provider cleanup incomplete");
  const client = {
    callTool: vi
      .fn()
      .mockRejectedValueOnce(cleanupFailure)
      .mockResolvedValue({
        content: [{ type: "text", text: JSON.stringify({ result: null }) }],
      }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const onCleanupComplete = vi.fn(async () => {
    await rm(workspace, { recursive: true, force: true });
  });
  try {
    const failure = await retirePrototypePublicClient({
      client,
      opened: true,
      workspace,
      primaryFailure,
      onCleanupComplete,
    }).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({
      cause: primaryFailure,
      cleanupFailure,
      resources: [workspace],
      cleanupOwner: { stop: expect.any(Function) },
    });
    expect(client.close).not.toHaveBeenCalled();
    expect(onCleanupComplete).not.toHaveBeenCalled();
    await expect(access(workspace)).resolves.toBeUndefined();
    const retained = failure as { cleanupOwner: { stop(): Promise<void> } };
    await retained.cleanupOwner.stop();
    expect(client.callTool).toHaveBeenCalledTimes(2);
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(onCleanupComplete).toHaveBeenCalledTimes(1);
    await expect(access(workspace)).rejects.toThrow();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

it("retries failed transport close without repeating successful provider cleanup", async () => {
  const client = {
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: JSON.stringify({ result: null }) }],
    }),
    close: vi
      .fn()
      .mockRejectedValueOnce(new Error("transport still owned"))
      .mockResolvedValue(undefined),
  };
  const onCleanupComplete = vi.fn().mockResolvedValue(undefined);
  const failure = await retirePrototypePublicClient({
    client,
    opened: true,
    workspace: "/owned/prototype",
    onCleanupComplete,
  }).catch((cause: unknown) => cause);
  expect(onCleanupComplete).not.toHaveBeenCalled();
  const retained = failure as { cleanupOwner: { stop(): Promise<void> } };
  await retained.cleanupOwner.stop();
  expect(client.callTool).toHaveBeenCalledTimes(1);
  expect(client.close).toHaveBeenCalledTimes(2);
  expect(onCleanupComplete).toHaveBeenCalledTimes(1);
});
