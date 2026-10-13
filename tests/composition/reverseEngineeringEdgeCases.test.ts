import { rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import {
  createArtifact,
  providerSnapshot,
} from "../support/reverseEngineeringCompositionFixtures.js";
import { registerSharedReverseEngineeringEdgeCaseTests } from "../support/reverseEngineeringCompositionEdgeCases.js";

import { expect, it, vi } from "vitest";

import { TestReverseEngineeringService as ReverseEngineeringService } from "../support/reverseEngineeringService.js";
import { AnalysisCapabilityUnavailableError } from "../../src/domain/analysisErrorCore.js";
import { objdumpCommand } from "../../src/objdump/ObjdumpCommand.js";
import { OwnedCommandFailure } from "../../src/process/OwnedCommand.js";
import { REVERSE_ENGINEERING_TOOL_CONTRACTS } from "../../src/contracts/reverseEngineeringToolContracts.js";

registerSharedReverseEngineeringEdgeCaseTests();

it("records objdump architecture support as subjectless provider capability evidence", async () => {
  const { directory, path } = await createArtifact();
  expect(objdumpCommand({ path, operation: "architectures" })).toEqual(["-i"]);
  const service = new ReverseEngineeringService({
    run: async () => ({ stdout: "elf64-x86-64", stderr: "" }),
  });
  try {
    const result = await service.inspectWithObjdump({
      path,
      operation: "architectures",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.subject).toBeNull();
      expect(result.value.parameters).not.toHaveProperty("path");
      expect(result.value.parameters).not.toHaveProperty(
        "artifact_sha256_before",
      );
      expect(result.value.normalized_result).toMatchObject({
        artifact_sha256_after: null,
        artifact_changed: null,
      });
      const contract = REVERSE_ENGINEERING_TOOL_CONTRACTS.find(
        ({ name }) => name === "inspect_with_objdump",
      );
      expect(contract?.outputSchema.safeParse(result.value).success).toBe(true);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["cancellation", "deadline"] as const)(
  "interrupts a pending stat on %s and observes its eventual rejection",
  async (interruption) => {
    const { directory, path } = await createArtifact();
    const controller = new AbortController();
    let rejectStat: ((cause: Error) => void) | undefined;
    let announceStat: (() => void) | undefined;
    const statStarted = new Promise<void>((resolve) => {
      announceStat = resolve;
    });
    const service = new ReverseEngineeringService({
      stat: async () => {
        announceStat?.();
        return await new Promise<Stats>((_resolve, reject) => {
          rejectStat = reject;
        });
      },
      run: async () => ({ stdout: "", stderr: "" }),
    });

    try {
      if (interruption === "deadline") vi.useFakeTimers();
      const resultPromise = service.inspectWithObjdump(
        { path, operation: "file_headers" },
        { signal: controller.signal },
      );
      await statStarted;
      if (interruption === "cancellation") controller.abort();
      else await vi.advanceTimersByTimeAsync(120_000);
      await expect(resultPromise).resolves.toMatchObject({
        ok: false,
        error: {
          _tag:
            interruption === "cancellation"
              ? "AnalysisCancelledError"
              : "AnalysisTimeoutError",
        },
      });
      rejectStat?.(new Error("late stat failure"));
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("drains an active provider operation before service shutdown resolves", async () => {
  const { directory, path } = await createArtifact();
  let signal: AbortSignal | undefined;
  let releaseRun: (() => void) | undefined;
  let runStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    runStarted = resolve;
  });
  const service = new ReverseEngineeringService({
    run: async (_command, _args, options) => {
      signal = options?.signal;
      runStarted?.();
      await new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      return { stdout: "finished", stderr: "" };
    },
  });

  try {
    const operation = service.executeRizinCommand({ path, command: "iI" });
    await started;
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    expect(signal?.aborted).toBe(true);
    expect(closed).toBe(false);
    releaseRun?.();
    await closing;
    expect(closed).toBe(true);
    await operation;
  } finally {
    releaseRun?.();
    await rm(directory, { recursive: true, force: true });
  }
});

it("cancels after operation admission and before starting the artifact digest", async () => {
  const { directory, path } = await createArtifact();
  let reads = 0;
  const signal = {
    get aborted() {
      reads += 1;
      return reads > 1;
    },
    addEventListener() {},
    removeEventListener() {},
    throwIfAborted() {},
    onabort: null,
    reason: undefined,
    dispatchEvent: () => true,
  } as AbortSignal;
  let digestStarted = false;
  const service = new ReverseEngineeringService({
    digest: async () => {
      digestStarted = true;
      return "a".repeat(64);
    },
  });

  try {
    const result = await service.inspectWithObjdump(
      { path, operation: "file_headers" },
      { signal },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    expect(reads).toBe(2);
    expect(digestStarted).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("preserves raw retained byte counts when output text replaces invalid UTF-8", async () => {
  const { directory, path } = await createArtifact();
  const snapshot = providerSnapshot({
    stdout: { text: "�", bytes: 1, observedBytes: 1, invalidUtf8: true },
    stderr: { text: "�", bytes: 2, observedBytes: 2, invalidUtf8: true },
    exitCode: 7,
  });
  const service = new ReverseEngineeringService({
    runOwned: async () => {
      throw new OwnedCommandFailure(
        "cancelled",
        "Command was cancelled after output capture",
        snapshot,
      );
    },
  });

  try {
    const result = await service.executeRizinCommand({ path, command: "iI" });
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCancelledError",
        capturedOutput: {
          stdout: "�",
          stderr: "�",
          stdout_bytes: 1,
          stderr_bytes: 2,
        },
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("preserves the provider remediation when owned process preparation fails", async () => {
  const { directory, path } = await createArtifact();
  const remediation = new AnalysisCapabilityUnavailableError(
    "rizin",
    "execute_rizin_command",
    "Rizin needs permission to inspect this process",
    { userMessage: "Grant process inspection permission, then retry." },
  );
  const service = new ReverseEngineeringService({
    runOwned: async () => {
      throw new OwnedCommandFailure(
        "process",
        "Could not prepare process ownership",
        null,
        null,
        { cause: remediation },
      );
    },
  });

  try {
    const result = await service.executeRizinCommand({ path, command: "iI" });
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCapabilityUnavailableError",
        providerId: "rizin",
        reason: remediation.reason,
        userMessage: remediation.userMessage,
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  ["normal exit", providerSnapshot(), "complete", 0, false],
  [
    "non-zero exit",
    providerSnapshot({ exitCode: 7, diagnosticTruncated: true }),
    "complete",
    7,
    true,
  ],
  [
    "signal termination",
    providerSnapshot({
      exitCode: null,
      signal: "SIGSEGV",
      diagnosticTruncated: true,
    }),
    "unknown",
    null,
    true,
  ],
  [
    "signal termination with a numeric exit snapshot",
    providerSnapshot({ exitCode: 7, signal: "SIGSEGV" }),
    "unknown",
    null,
    false,
  ],
  [
    "signal termination without truncation",
    providerSnapshot({ exitCode: null, signal: "SIGTERM" }),
    "unknown",
    null,
    false,
  ],
  [
    "unknown exit status",
    providerSnapshot({ exitCode: null }),
    "unknown",
    null,
    false,
  ],
] as const)(
  "maps an owned command %s into provider Evidence",
  async (_name, snapshot, completion, exitCode, outputTruncated) => {
    const { directory, path } = await createArtifact();
    const runOwned = vi.fn(async () => snapshot);
    const service = new ReverseEngineeringService({
      runOwned,
      environment: { REA_RIZIN_COMMAND: "rizin-test" },
    });

    try {
      const result = await service.executeRizinCommand({ path, command: "iI" });
      expect(runOwned).toHaveBeenCalledOnce();
      expect(runOwned).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "rizin-test",
          arguments: expect.arrayContaining(["-q", "-c", "iI"]),
          expectedCommand: null,
          env: expect.objectContaining({ REA_RIZIN_COMMAND: "rizin-test" }),
          hostEnvironment: {},
        }),
        {
          timeoutMs: 120_000,
          diagnosticBytes: 16 * 1024 * 1024,
          acceptNonZeroExit: true,
        },
        { signal: expect.any(AbortSignal) },
      );
      expect(result).toMatchObject({
        ok: true,
        value: {
          raw_result: {
            stdout: "captured owned output",
            completion_status: completion,
            exit_code: exitCode,
            output_truncated: outputTruncated,
          },
        },
      });
      if (!result.ok) throw new Error("Expected provider Evidence");
      expect(result.value.parameters).toMatchObject({
        command: "iI",
        provider_executable: "rizin-test",
        command_arguments: expect.arrayContaining(["-q", "-c", "iI"]),
      });
      expect(result.value.locations).toContainEqual({
        kind: "artifact-path",
        path,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("preserves a provider timeout when cancellation arrives during the final digest", async () => {
  const { directory, path } = await createArtifact();
  const controller = new AbortController();
  let digests = 0;
  const service = new ReverseEngineeringService({
    digest: async () => {
      digests += 1;
      if (digests === 2) controller.abort();
      return "a".repeat(64);
    },
    run: async () => {
      throw Object.assign(new Error("provider timed out"), {
        stdout: "partial timeout output",
        stderr: "timeout diagnostic",
        code: "ETIMEDOUT",
        signal: null,
        killed: true,
      });
    },
  });

  try {
    const result = await service.executeRizinCommand(
      { path, command: "iI" },
      { signal: controller.signal },
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisTimeoutError",
        capturedOutput: {
          stdout: "partial timeout output",
          stderr: "timeout diagnostic",
        },
        partialObservation: {
          raw_result: {
            stdout: "partial timeout output",
            completion_status: "unknown",
          },
          limitations: expect.arrayContaining([
            expect.stringContaining("AnalysisTimeoutError"),
          ]),
        },
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("classifies E2BIG as a provider command resource constraint", async () => {
  const { directory, path } = await createArtifact();
  const service = new ReverseEngineeringService({
    runOwned: async () => {
      throw new OwnedCommandFailure(
        "process",
        "Command launch failed.",
        null,
        null,
        {
          cause: Object.assign(new Error("argument list too long"), {
            code: "E2BIG",
          }),
        },
      );
    },
  });

  try {
    const result = await service.executeRizinCommand({ path, command: "iI" });
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisResourceConstraintError",
        resource: "transport",
        operation: "execute_rizin_command",
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not claim provider completion or a final digest while owned cleanup is incomplete", async () => {
  const { directory, path } = await createArtifact();
  const service = new ReverseEngineeringService({
    runOwned: async () => {
      throw new OwnedCommandFailure(
        "process",
        "Owned process cleanup remains incomplete.",
        providerSnapshot({ exitCode: 0 }),
        "descendant remains active",
        undefined,
        ["run-id", "pid:42"],
      );
    },
  });

  try {
    const result = await service.executeRizinCommand({ path, command: "iI" });
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisOutputError",
        partialObservation: {
          raw_result: {
            exit_code: 0,
            completion_status: "unknown",
            artifact_sha256_after: null,
            artifact_changed: null,
          },
          limitations: expect.arrayContaining([
            expect.stringContaining("owned provider cleanup is incomplete"),
          ]),
        },
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("records an explicit loss marker when provider bytes are invalid UTF-8", async () => {
  const { directory, path } = await createArtifact();
  const service = new ReverseEngineeringService({
    runOwned: async () =>
      providerSnapshot({
        stdout: {
          text: "captured � output",
          bytes: 17,
          observedBytes: 17,
          invalidUtf8: true,
        },
      }),
  });

  try {
    const result = await service.executeRizinCommand({ path, command: "iI" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        raw_result: { stdout: "captured � output" },
      });
      expect(result.value.limitations).toContain(
        "Captured stdout bytes contain invalid or incomplete UTF-8; replacement characters in the text capture do not preserve the original bytes.",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
