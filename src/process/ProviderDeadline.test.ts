import { afterEach, expect, it, vi } from "vitest";
import { ProviderStartupDeadline } from "./ProviderDeadline.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it("keeps remaining time and cancellation classification stable across wall-clock jumps", () => {
  const dateNow = vi.spyOn(Date, "now").mockReturnValue(10_000);
  const caller = new AbortController();
  const deadline = new ProviderStartupDeadline(10_000, caller.signal);
  try {
    dateNow.mockReturnValue(9_000_000_000_000);
    const remaining = deadline.remainingMs();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(10_000);
    expect(Number.isInteger(remaining)).toBe(true);
    expect(deadline.interruption).toBeUndefined();
    caller.abort(new Error("caller stopped startup"));
    expect(deadline.interruption).toBe("cancelled");
  } finally {
    deadline.dispose();
  }
});

it("aborts a bounded wait when its real monotonic deadline expires", async () => {
  const deadline = new ProviderStartupDeadline(40);
  try {
    await expect(deadline.wait(500)).resolves.toBe("aborted");
    expect(deadline.interruption).toBe("timeout");
    expect(deadline.remainingMs()).toBe(0);
  } finally {
    deadline.dispose();
  }
});

it("does not expire a future monotonic deadline on an early timer callback", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let monotonic = 0;
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  const deadline = new ProviderStartupDeadline(40);
  try {
    monotonic = 39;
    await vi.advanceTimersByTimeAsync(40);
    expect(deadline.remainingMs()).toBe(1);
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.interruption).toBeUndefined();
  } finally {
    deadline.dispose();
    vi.useRealTimers();
  }
});

it("aborts when the re-armed timer reaches the absolute deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let monotonic = 0;
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  const deadline = new ProviderStartupDeadline(40);
  try {
    monotonic = 39;
    await vi.advanceTimersByTimeAsync(40);
    expect(deadline.signal.aborted).toBe(false);
    monotonic = 40;
    await vi.advanceTimersByTimeAsync(1);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.interruption).toBe("timeout");
    expect(deadline.remainingMs()).toBe(0);
  } finally {
    deadline.dispose();
    vi.useRealTimers();
  }
});

it("reports a wait that resolves at the deadline as aborted, not elapsed", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let monotonic = 0;
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  const deadline = new ProviderStartupDeadline(40);
  try {
    const pending = deadline.wait(500);
    monotonic = 40;
    await vi.advanceTimersByTimeAsync(40);
    await expect(pending).resolves.toBe("aborted");
  } finally {
    deadline.dispose();
    vi.useRealTimers();
  }
});

it("classifies an active wait at expiry before the re-armed owner callback runs", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let monotonic = 0;
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  const timers = vi.spyOn(globalThis, "setTimeout");
  const deadline = new ProviderStartupDeadline(40);
  try {
    const pending = deadline.wait(500);
    const firstOwner = timers.mock.calls[0]?.[0];
    const wait = timers.mock.calls[1]?.[0];
    if (typeof firstOwner !== "function" || typeof wait !== "function")
      throw new Error("expected the owner and wait timer callbacks");
    clearTimeout(timers.mock.results[0]?.value);
    monotonic = 39;
    firstOwner();
    expect(deadline.signal.aborted).toBe(false);
    expect(timers.mock.calls).toHaveLength(3);
    expect(timers.mock.calls[2]?.[1]).toBe(1);

    // Deliver the pending wait at expiry while the replacement owner timer
    // remains queued. Classification must come from the absolute deadline.
    clearTimeout(timers.mock.results[1]?.value);
    monotonic = 40;
    wait();
    await expect(pending).resolves.toBe("aborted");
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.interruption).toBe("timeout");
    expect(deadline.remainingMs()).toBe(0);

    const replacementOwner = timers.mock.calls[2]?.[0];
    if (typeof replacementOwner !== "function")
      throw new Error("expected the replacement owner timer callback");
    clearTimeout(timers.mock.results[2]?.value);
    replacementOwner();
    expect(deadline.signal.aborted).toBe(true);
  } finally {
    deadline.dispose();
    timers.mockRestore();
    vi.useRealTimers();
  }
});

it("resolves a polling interval shorter than the budget as elapsed", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let monotonic = 0;
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  const deadline = new ProviderStartupDeadline(40);
  try {
    const pending = deadline.wait(10);
    monotonic = 10;
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toBe("elapsed");
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.remainingMs()).toBe(30);
  } finally {
    deadline.dispose();
    vi.useRealTimers();
  }
});

it("keeps caller cancellation classified without reporting an exhausted budget", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let monotonic = 0;
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  const caller = new AbortController();
  const deadline = new ProviderStartupDeadline(40, caller.signal);
  try {
    monotonic = 20;
    caller.abort(new Error("caller stopped startup"));
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.interruption).toBe("cancelled");
    expect(deadline.remainingMs()).toBe(20);
  } finally {
    deadline.dispose();
    vi.useRealTimers();
  }
});

// Probe from issue #2760 review: both the abort timer and the clamped polling
// timer can fire early at the same monotonic instant. The full-budget wait must
// stay pending until the absolute deadline expires.
it("keeps a full-budget wait pending when both timers fire early", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let monotonic = 0;
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  const caller = new AbortController();
  const deadline = new ProviderStartupDeadline(40, caller.signal);
  let outcome: string | undefined;
  const pending = deadline.wait(500).then((result) => {
    outcome = result;
    return result;
  });
  try {
    monotonic = 39;
    await vi.advanceTimersByTimeAsync(40);
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.remainingMs()).toBe(1);
    expect(outcome).toBeUndefined();
    monotonic = 40;
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe("aborted");
    expect(deadline.remainingMs()).toBe(0);
  } finally {
    caller.abort();
    deadline.dispose();
    vi.useRealTimers();
  }
});

it("releases the timer and listener on dispose with a pending wait", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let monotonic = 0;
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  const caller = new AbortController();
  const deadline = new ProviderStartupDeadline(40, caller.signal);
  try {
    const pending = deadline.wait(500);
    deadline.dispose();
    // The external abort listener is removed: caller cancellation after
    // dispose must not abort the deadline or classify it as cancelled.
    caller.abort(new Error("caller stopped startup"));
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.interruption).toBeUndefined();
    monotonic = 100;
    await vi.advanceTimersByTimeAsync(100);
    expect(deadline.signal.aborted).toBe(false);
    // The deadline expired while disposed, so the clamped wait resolves
    // "aborted" from the monotonic clock instead of polling past expiry.
    await expect(pending).resolves.toBe("aborted");
  } finally {
    deadline.dispose();
    vi.useRealTimers();
  }
});
