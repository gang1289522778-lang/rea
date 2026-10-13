import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import {
  captureWindowsWindowScreenshot,
  type WindowsWindowCaptureHost,
} from "./NativeWindowsUiProvider.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAF/gJ+Qv1aRwAAAABJRU5ErkJggg==",
  "base64",
);
const SHA256 = "a".repeat(64);
const TARGET = {
  path: "C:\\Apps\\fixture.exe",
  sha256: SHA256,
  kind: "executable",
  format: "pe",
  architecture: "x86_64",
  availableArchitectures: ["x86_64"],
  executableRole: "application",
  managed: false,
} satisfies BinaryTarget;

const host = (
  overrides: Partial<WindowsWindowCaptureHost> = {},
): WindowsWindowCaptureHost => ({
  capture: () => ({
    pid: 42,
    window_handle: "0x1234",
    process_image_path: "C:\\Apps\\fixture.exe",
    process_start_time_unix_ms: 1_700_000_000_000,
    title: "Fixture",
    source_width: 1,
    source_height: 1,
    width: 1,
    height: 1,
    png: PNG,
  }),
  identifyExecutable: async () => ({
    fileIdentity: "c:\\apps\\fixture.exe",
    sha256: SHA256,
  }),
  ...overrides,
});

it("captures only an HWND whose live executable identity matches the active PE target", async () => {
  const captured = await captureWindowsWindowScreenshot(
    TARGET,
    { pid: 42, window_handle: "0x1234" },
    host(),
  );

  expect(captured.ok).toBe(true);
  if (!captured.ok) return;
  expect(captured.value).toMatchObject({
    target_sha256: SHA256,
    window: { pid: 42, window_handle: "0x1234" },
    screenshot: {
      sha256: createHash("sha256").update(PNG).digest("hex"),
      width: 1,
      height: 1,
    },
  });
});

it("fails closed when the selected PID maps to different executable bytes", async () => {
  const captured = await captureWindowsWindowScreenshot(
    TARGET,
    { pid: 42, window_handle: "0x1234" },
    host({
      capture: () => ({
        pid: 42,
        window_handle: "0x1234",
        process_image_path: "C:\\Apps\\other.exe",
        process_start_time_unix_ms: 1_700_000_000_000,
        title: "Fixture",
        source_width: 1,
        source_height: 1,
        width: 1,
        height: 1,
        png: PNG,
      }),
      identifyExecutable: async (path) => ({
        fileIdentity: path.toLowerCase(),
        sha256: path === TARGET.path ? SHA256 : "b".repeat(64),
      }),
    }),
  );

  expect(captured).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
});

it("does not invoke native capture for a malformed HWND", async () => {
  let invoked = false;
  const captured = await captureWindowsWindowScreenshot(
    TARGET,
    { pid: 42, window_handle: "0x0001" },
    host({
      capture: () => {
        invoked = true;
        return {};
      },
    }),
  );

  expect(invoked).toBe(false);
  expect(captured).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
});

it("classifies malformed native replies as output failures", async () => {
  const captured = await captureWindowsWindowScreenshot(
    TARGET,
    { pid: 42, window_handle: "0x1234" },
    host({ capture: () => ({ pid: 42 }) }),
  );
  expect(captured).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
});

it.each([
  [6, "artifact_changed", "AnalysisArtifactChangedError"],
  [13, "artifact_changed", "AnalysisArtifactChangedError"],
  [5, "window_owner_mismatch", "AnalysisInputError"],
  [5, "process_identity_mismatch", "AnalysisInputError"],
] as const)(
  "preserves native refusal semantics for code %s and %s",
  async (code, kind, tag) => {
    const captured = await captureWindowsWindowScreenshot(
      TARGET,
      { pid: 42, window_handle: "0x1234" },
      host({
        capture: () => {
          throw Object.assign(new Error("Native refusal"), {
            win32Code: code,
            failureKind: kind,
          });
        },
      }),
    );
    expect(captured).toMatchObject({ ok: false, error: { _tag: tag } });
  },
);

it("does not commit a screenshot cancelled during final identity reads", async () => {
  const controller = new AbortController();
  let reads = 0;
  const captured = await captureWindowsWindowScreenshot(
    TARGET,
    { pid: 42, window_handle: "0x1234" },
    host({
      identifyExecutable: async () => {
        if (++reads > 1) controller.abort();
        return { fileIdentity: "c:\\apps\\fixture.exe", sha256: SHA256 };
      },
    }),
    { signal: controller.signal },
  );
  expect(captured).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
});
