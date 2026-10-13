import { afterEach, expect, it, vi } from "vitest";
import { ProviderStartupDeadline } from "./ProviderDeadline.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("rechecks the monotonic deadline when a timer fires early", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const now = vi.spyOn(performance, "now").mockReturnValue(0);
  const deadline = new ProviderStartupDeadline(40);
  try {
    const waiting = deadline.wait(500);
    now.mockReturnValue(39.5);
    await vi.advanceTimersByTimeAsync(40);
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.interruption).toBeUndefined();
    now.mockReturnValue(40);
    await vi.advanceTimersByTimeAsync(1);
    await expect(waiting).resolves.toBe("aborted");
    expect(deadline.remainingMs()).toBe(0);
  } finally {
    deadline.dispose();
  }
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
