import { once } from "node:events";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import type { WindowsNativeAuthority } from "./WindowsNativeLoader.js";
import {
  quoteWindowsProcessArgument,
  WindowsOwnedProcess,
} from "./WindowsOwnedProcess.js";

describe("Windows process argument representation", () => {
  it.each([
    ["", '""'],
    ["plain", '"plain"'],
    ["two words", '"two words"'],
    ['embedded"quote', '"embedded\\"quote"'],
    ["D:\\folder\\", '"D:\\folder\\\\"'],
    ['slash\\"quote', '"slash\\\\\\"quote"'],
  ])("quotes %j without changing its CRT argument", (input, expected) => {
    expect(quoteWindowsProcessArgument(input)).toBe(expected);
  });

  it("rejects NUL before crossing the native boundary", () => {
    expect(() => quoteWindowsProcessArgument("a\0b")).toThrow("NUL");
  });
});

const LIMIT = 704 * 1024 * 1024;
const settledPoll = {
  stdout: Buffer.alloc(0),
  stderr: Buffer.from("allocation failed"),
  stdoutEnded: true,
  stderrEnded: true,
  exitCode: 3,
  activeProcesses: 0,
};

/** Native authority double that records calls and replays exact poll observations. */
const authority = (
  options: {
    readonly jobMemoryLimit?: true;
    readonly polls?: readonly unknown[];
    readonly appliedLimit?: (requested: unknown) => unknown;
  } = {},
) => {
  const calls: { operation: string; arguments_: readonly unknown[] }[] = [];
  const polls = [...(options.polls ?? [])];
  const native: WindowsNativeAuthority = {
    inspection: {
      abiVersion: 1,
      nodeApiVersion: 8,
      architecture: "x64",
      filesystem: {
        requestedPath: "C:\\probe",
        finalPath: "C:\\probe",
        filesystem: "NTFS",
        volumeSerial: "0".repeat(16),
        fileId: "0".repeat(32),
        size: 0,
        directory: true,
      },
      privateDacl: true,
      atomicJobAssignment: true,
      killOnOwnerClose: true,
      protocolStdin: true,
      ...(options.jobMemoryLimit === undefined ? {} : { jobMemoryLimit: true }),
    },
    call: (operation, arguments_) => {
      calls.push({ operation, arguments_ });
      if (operation === "process_spawn")
        return {
          pid: 42,
          handle: {},
          jobAssigned: true,
          killOnOwnerClose: true,
          ...(arguments_.length === 6
            ? {
                jobMemoryLimitBytes: (
                  options.appliedLimit ?? ((value) => value)
                )(arguments_[5]),
              }
            : {}),
        };
      if (operation === "process_poll") {
        const observed = polls.shift();
        if (observed instanceof Error) throw observed;
        return observed;
      }
      if (operation === "process_terminate") {
        polls.splice(
          0,
          polls.length,
          options.jobMemoryLimit === true
            ? {
                ...settledPoll,
                memoryLimitReached: false,
                peakJobMemoryBytes: 0,
              }
            : settledPoll,
        );
        return true;
      }
      if (operation === "process_close") return null;
      throw new Error(`Unmodeled native operation ${operation}`);
    },
  };
  return { native, calls };
};

const launch = (
  native: WindowsNativeAuthority,
  memoryLimitBytes?: number,
): WindowsOwnedProcess =>
  new WindowsOwnedProcess(
    "C:\\runtime\\bun.exe",
    ["worker.js"],
    "C:\\work",
    {},
    false,
    {
      authority: native,
      ...(memoryLimitBytes === undefined ? {} : { memoryLimitBytes }),
    },
  );

describe("Windows Job Object lifecycle and poll ownership", () => {
  it("keeps polling a job after a transient observation failure", async () => {
    vi.useFakeTimers();
    const { native, calls } = authority({
      polls: [new Error("transient poll failure"), settledPoll],
    });
    const child = launch(native);
    let closed = false;
    child.once("close", () => {
      closed = true;
    });

    try {
      await vi.advanceTimersByTimeAsync(300);
      expect(closed).toBe(true);
      expect(
        calls.filter(({ operation }) => operation === "process_poll"),
      ).toHaveLength(2);
      expect(calls.at(-1)?.operation).toBe("process_close");
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds repeated poll failures while retaining the job for explicit cleanup retry", async () => {
    vi.useFakeTimers();
    const original = authority({
      polls: [
        new Error("persistent"),
        new Error("persistent"),
        new Error("persistent"),
        settledPoll,
      ],
    });
    const native: WindowsNativeAuthority = {
      ...original.native,
      call: (operation, arguments_) =>
        operation === "process_terminate"
          ? true
          : original.native.call(operation, arguments_),
    };
    const child = launch(native);
    try {
      await vi.advanceTimersByTimeAsync(2_000);
      expect(
        original.calls.filter(({ operation }) => operation === "process_poll"),
      ).toHaveLength(3);
      expect(
        original.calls.some(({ operation }) => operation === "process_close"),
      ).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
      const closing = child.cleanup();
      await vi.advanceTimersByTimeAsync(25);
      expect(await closing).toEqual({ cleaned: true, signaled: true });
      expect(vi.getTimerCount()).toBe(0);
      expect(
        original.calls.filter(({ operation }) => operation === "process_close"),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits close only after descendants leave the Job Object", async () => {
    const { native, calls } = authority({
      polls: [
        {
          ...settledPoll,
          stdoutEnded: false,
          stderrEnded: false,
          activeProcesses: 1,
        },
        settledPoll,
      ],
    });
    const child = launch(native);
    const events: string[] = [];
    child.once("exit", () => events.push("exit"));
    child.once("close", () => events.push("close"));

    await once(child, "close");

    expect(events).toEqual(["exit", "close"]);
    expect(
      calls.filter(({ operation }) => operation === "process_poll"),
    ).toHaveLength(2);
    expect(calls.at(-1)?.operation).toBe("process_close");
  });
});

describe("Windows Job Object memory limits", () => {
  it("refuses a requested limit before launch when the artifact lacks the control", () => {
    const { native, calls } = authority();
    expect(() => launch(native, LIMIT)).toThrow(
      "does not support Job Object memory limits",
    );
    expect(calls).toEqual([]);
  });

  it("keeps the unlimited launch shape and rejects limit fields it did not request", async () => {
    const { native, calls } = authority({
      jobMemoryLimit: true,
      polls: [
        { ...settledPoll, memoryLimitReached: true, peakJobMemoryBytes: 1 },
      ],
    });
    const child = launch(native);
    onTestFinished(() => child.cleanup());
    const failure = once(child, "error");
    expect(calls[0]?.arguments_).toHaveLength(4);
    const [error] = await failure;
    expect(error).toBeInstanceOf(Error);
    expect(child.memoryLimitReached).toBe(false);
    expect(child.peakJobMemoryBytes).toBeUndefined();
  });

  it("passes the limit, verifies its read-back and reports a reached limit before exit", async () => {
    const { native, calls } = authority({
      jobMemoryLimit: true,
      polls: [
        {
          ...settledPoll,
          exitCode: null,
          stdoutEnded: false,
          stderrEnded: false,
          activeProcesses: 1,
          memoryLimitReached: false,
          peakJobMemoryBytes: 300 * 1024 * 1024,
        },
        { ...settledPoll, memoryLimitReached: true, peakJobMemoryBytes: LIMIT },
      ],
    });
    const child = launch(native, LIMIT);
    expect(calls[0]?.arguments_.slice(4)).toEqual([false, LIMIT]);
    const closed = once(child, "close");
    const exited = new Promise((resolve) => {
      child.once("exit", (code: number) =>
        resolve({ code, reached: child.memoryLimitReached }),
      );
    });
    expect(await exited).toEqual({ code: 3, reached: true });
    expect(child.peakJobMemoryBytes).toBe(LIMIT);
    await closed;
    expect(calls.at(-1)?.operation).toBe("process_close");
  });

  it("rejects a limited poll that omits the job's notification state", async () => {
    const { native } = authority({
      jobMemoryLimit: true,
      polls: [settledPoll],
    });
    const child = launch(native, LIMIT);
    onTestFinished(() => child.cleanup());
    const [error] = await once(child, "error");
    expect(error).toBeInstanceOf(Error);
    expect(child.memoryLimitReached).toBe(false);
  });

  it("refuses a launch whose applied limit differs from the request", () => {
    const { native } = authority({
      jobMemoryLimit: true,
      appliedLimit: () => LIMIT - 4096,
    });
    expect(() => launch(native, LIMIT)).toThrow();
  });
});
