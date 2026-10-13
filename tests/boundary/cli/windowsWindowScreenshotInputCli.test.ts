import { describe, expect } from "vitest";

import { cliTest } from "../../support/cli/cliFixture.js";

describe("Windows native-window screenshot CLI input", () => {
  cliTest(
    "rejects a non-canonical HWND before opening a provider",
    async ({ cli }) => {
      const result = await cli.run({
        arguments: [
          "capture-windows-window-screenshot",
          "C:\\fixture.exe",
          "--pid",
          "1",
          "--window-handle",
          "0x0001",
          "--json",
        ],
        environment: { REA_LOG_LEVEL: "silent" },
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.json).toMatchObject({
        code: "invalid_request",
        details: {
          operation: "capture_windows_window_screenshot",
          issues: [{ path: ["window_handle"], reason: "invalid_format" }],
        },
      });
    },
  );
});
