import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  IOS_JAILBREAK_PATH_SCRIPT,
  parseIosDeviceIds,
  parseIosProcessList,
  parseIosRemoteTools,
  parseIosStopReason,
  quoteIosShell,
} from "./IosDeviceOutput.js";

describe("iOS device output parsing", () => {
  it("keeps valid UDIDs and reports noise", () => {
    expect(parseIosDeviceIds("00008101-ABC\nnot a udid\n")).toEqual({
      ids: ["00008101-ABC"],
      unparsed: ["not a udid"],
    });
  });

  it("parses process and runtime tool inventories", () => {
    expect(parseIosProcessList("12 launchd\ninvalid\n55 Runner\n")).toEqual({
      processes: [
        { pid: 12, name: "launchd", raw: "12 launchd" },
        { pid: 55, name: "Runner", raw: "55 Runner" },
      ],
      unparsed: ["invalid"],
    });
    expect(
      parseIosRemoteTools(
        "debugserver\t/var/jb/usr/bin/debugserver\nfrida-server\t\n",
      ),
    ).toEqual({
      tools: [
        {
          name: "debugserver",
          path: "/var/jb/usr/bin/debugserver",
          available: true,
        },
        { name: "frida-server", path: null, available: false },
      ],
      unparsed: [],
    });
  });

  it("quotes remote shell paths and extracts LLDB stop reasons", () => {
    expect(quoteIosShell("/tmp/it's a file")).toBe("'/tmp/it'\\''s a file'");
    expect(parseIosStopReason("stop reason = breakpoint 1.1\n")).toBe(
      "breakpoint 1.1",
    );
    expect(parseIosStopReason("connected\n")).toBeNull();
  });
});

it.skipIf(process.platform === "win32")(
  "composes the jailbreak path prefix as a valid shell command",
  () => {
    expect(() =>
      execFileSync("/bin/sh", ["-n"], {
        input: `${IOS_JAILBREAK_PATH_SCRIPT}; printf 'ready\\n'`,
      }),
    ).not.toThrow();
  },
);
