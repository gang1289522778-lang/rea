import { expect } from "vitest";

import type { GdbSessionManager } from "../../../src/gdb/GdbSessionManager.js";

type GdbSessionStart = Awaited<ReturnType<GdbSessionManager["start"]>>;
type StartedGdbSession = Extract<GdbSessionStart, { readonly ok: true }>;

export const expectGdbSessionStarted = async (
  manager: GdbSessionManager,
): Promise<StartedGdbSession> => {
  const started = await manager.start();
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(started.error.message);
  return started;
};
