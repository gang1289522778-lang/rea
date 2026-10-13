import { rm } from "node:fs/promises";
import { createArtifact } from "../support/reverseEngineeringCompositionFixtures.js";

import { expect, it } from "vitest";

import { TestReverseEngineeringService as ReverseEngineeringService } from "../support/reverseEngineeringService.js";

it("rejects NUL in a Rizin command before touching the provider", async () => {
  const { directory, path } = await createArtifact();
  let invoked = false;
  const service = new ReverseEngineeringService({
    run: async () => {
      invoked = true;
      return { stdout: "", stderr: "" };
    },
  });

  try {
    const result = await service.executeRizinCommand({
      path,
      command: "wx\u0000 00",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisInputError", operation: "execute_rizin_command" },
    });
    expect(invoked).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects a digest when cancellation arrives before stream listeners attach", async () => {
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
