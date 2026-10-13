import { redactCapturedTransportCredential } from "../process/ProviderDiagnosticRedaction.js";
import { expect, it } from "vitest";

import { DarwinProcessOwnershipInspectionError } from "../process/DarwinProcessRunTokenReader.js";
import { bindGhidraSessionFailure } from "./GhidraSessionError.js";
import { GhidraLaunchError } from "./GhidraLauncher.js";
import { GhidraLaunchSupportError } from "./GhidraJavaLaunch.js";

it("reports truncated cyclic causes in serializable diagnostics", () => {
  const cause = new Error("cyclic launcher failure");
  cause.cause = cause;
  const projectFailure = bindGhidraSessionFailure(() => ({}));

  const diagnostics = projectFailure(
    "start",
    "Ghidra launcher failed",
    cause,
  ).diagnostics;

  expect(JSON.stringify(diagnostics)).toContain('"cause_truncated":true');
});

it("keeps bounded compiler and nested launcher outcomes in diagnostics", () => {
  const compiler = new DarwinProcessOwnershipInspectionError(
    "macOS process ownership helper compilation failed via xcrun (compiler result: 7)",
    {
      cause: Object.assign(new Error("compiler exited"), {
        code: 7,
        signal: null,
        killed: false,
        stdout: "",
        stderr: "SDK mismatch",
      }),
      compilerOutcome: {
        outcome: "exited",
        code: 7,
        signal: null,
        stderr: "SDK mismatch",
        stderrBytes: 12,
        stderrTruncated: false,
        outputTruncated: false,
        killed: false,
      },
    },
  );
  const launch = new GhidraLaunchError("Ghidra headless launch failed", {
    cause: compiler,
  });
  const projectFailure = bindGhidraSessionFailure(() => ({}));

  const diagnostics = projectFailure(
    "start",
    "Ghidra launcher failed",
    launch,
  ).diagnostics;
  expect(diagnostics).toMatchObject({
    failure_cause: {
      name: "GhidraLaunchError",
      cause: {
        name: "DarwinProcessOwnershipInspectionError",
        compiler_outcome: {
          outcome: "exited",
          code: 7,
          stderr: "SDK mismatch",
        },
        cause: { code: 7 },
      },
    },
  });
  expect(JSON.stringify(diagnostics)).not.toContain("command_outcome");

  const spawnFailure = Object.assign(
    new Error("spawn analyzeHeadless ENOENT"),
    { code: "ENOENT" },
  );
  const launchFailure = new GhidraLaunchError("Ghidra headless launch failed", {
    cause: spawnFailure,
  });
  expect(
    projectFailure("start", "Ghidra launcher failed", launchFailure)
      .diagnostics,
  ).toMatchObject({
    failure_cause: {
      name: "GhidraLaunchError",
      cause: { code: "ENOENT" },
    },
  });
});

it("bounds compiler stderr after explicit redaction at UTF-8 boundaries", () => {
  const sensitiveValue = "caller-selected-secret";
  const projectFailure = bindGhidraSessionFailure(
    () => ({}),
    (value) => value.replaceAll(sensitiveValue, "replacement".repeat(100)),
  );
  const stderr = `${"é".repeat(3900)}${sensitiveValue}`;
  const compiler = new DarwinProcessOwnershipInspectionError(
    "compiler failed",
    {
      compilerOutcome: {
        outcome: "exited",
        code: 1,
        signal: null,
        stderr,
        stderrBytes: Buffer.byteLength(stderr, "utf8"),
        stderrTruncated: false,
        outputTruncated: false,
        killed: false,
      },
    },
  );
  const failureCause = projectFailure(
    "start",
    "Ghidra launcher failed",
    compiler,
  ).diagnostics.failure_cause as {
    readonly compiler_outcome: {
      readonly stderr: string;
      readonly stderrTruncated: boolean;
    };
  };

  expect(
    Buffer.byteLength(failureCause.compiler_outcome.stderr, "utf8"),
  ).toBeLessThanOrEqual(8 * 1024);
  expect(failureCause.compiler_outcome.stderrTruncated).toBe(true);
  expect(failureCause.compiler_outcome.stderr).not.toContain(sensitiveValue);
  expect(failureCause.compiler_outcome.stderr).not.toContain("\uFFFD");
});

it("redacts command output before bounding each UTF-8 stream", () => {
  const token = "transport-token";
  const replacement = "é".repeat(600);
  const stdout = `${"é".repeat(4090)}${token}`;
  const stderr = `${token}${"€".repeat(3000)}`;
  const cause = Object.assign(new Error("LaunchSupport failed"), {
    code: null,
    signal: "SIGTERM",
    killed: true,
    stdout,
    stderr,
  });
  const projectFailure = bindGhidraSessionFailure(
    () => ({}),
    (value) => value.replaceAll(token, replacement),
  );
  const diagnostics = projectFailure(
    "start",
    "Ghidra launcher failed",
    new GhidraLaunchSupportError("-envvars", cause),
  ).diagnostics;

  expect(diagnostics).toMatchObject({
    failure_cause: {
      cause: { signal: "SIGTERM" },
      command_outcome: {
        stdout: "é".repeat(4096),
        stderr: `${replacement}${"€".repeat(2330)}`,
        stdoutBytes: Buffer.byteLength(stdout, "utf8"),
        stderrBytes: Buffer.byteLength(stderr, "utf8"),
        stdoutTruncated: true,
        stderrTruncated: true,
        outputTruncated: false,
        killed: true,
      },
    },
  });
  expect(JSON.stringify(diagnostics)).not.toContain(token);
  expect(JSON.stringify(diagnostics)).not.toContain("\uFFFD");
});

it("retains capture truncation separately from diagnostic output bounds", () => {
  const cause = Object.assign(new Error("stdout maxBuffer length exceeded"), {
    code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    signal: null,
    stdout: "partial stdout",
    stderr: "",
  });
  const projectFailure = bindGhidraSessionFailure(() => ({}));

  expect(
    projectFailure(
      "start",
      "Ghidra launcher failed",
      new GhidraLaunchSupportError("-vmargs", cause),
    ).diagnostics,
  ).toMatchObject({
    failure_cause: {
      cause: { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", signal: null },
      command_outcome: {
        stdout: "partial stdout",
        stderr: "",
        stdoutBytes: 14,
        stderrBytes: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        outputTruncated: true,
        killed: true,
      },
    },
  });
});

it("retains known cancellation output while final termination remains unknown", () => {
  const cause = Object.assign(new Error("The operation was aborted"), {
    code: "ABORT_ERR",
    stdout: "captured stdout",
    stderr: "captured stderr",
    killed: true,
  });
  const failure = bindGhidraSessionFailure(() => ({}))(
    "cancelled",
    "LaunchSupport cancelled",
    new GhidraLaunchSupportError("-envvars", cause),
  );
  expect(failure.diagnostics).toMatchObject({
    failure_cause: {
      command_outcome: {
        stdout: "captured stdout",
        stderr: "captured stderr",
        killed: null,
        outputTruncated: null,
      },
    },
  });
});

it("redacts capture-cut credentials and emits LaunchSupport streams once", () => {
  const token = "a".repeat(64);
  const stderr = `helper failed ${token.slice(0, 21)}`;
  const support = new GhidraLaunchSupportError(
    "-envvars",
    Object.assign(new Error("maxBuffer exceeded"), {
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      stdout: "unique helper output",
      stderr,
    }),
  );
  const launch = new GhidraLaunchError("launch failed", {
    cause: support,
    capturedOutput: {
      stdout: "unique helper output",
      stderr,
      truncated: true,
      killed: true,
      outputTruncated: true,
    },
  });
  const redact = (text: string, incomplete = false) => {
    const bytes = Buffer.byteLength(text);
    return redactCapturedTransportCredential(
      { text, bytes, observedBytes: bytes + (incomplete ? 1 : 0) },
      token,
      "[REDACTED]",
    );
  };
  const diagnostics = bindGhidraSessionFailure(() => ({}), redact)(
    "start",
    "launch failed",
    launch,
  ).diagnostics;
  expect(diagnostics).toMatchObject({
    failure_cause: {
      launch_outcome: {
        stderr: "helper failed [REDACTED]",
        killed: true,
        outputTruncated: true,
      },
    },
  });
  const serialized = JSON.stringify(diagnostics);
  expect(serialized.split("unique helper output")).toHaveLength(2);
  expect(serialized).not.toContain("command_outcome");
  expect(serialized).not.toContain(token.slice(0, 21));
});
