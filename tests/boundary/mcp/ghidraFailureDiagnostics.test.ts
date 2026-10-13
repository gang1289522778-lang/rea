import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, onTestFinished, vi } from "vitest";

import { logCliCommand } from "../../../src/cliLogging.js";
import { analysisErrorProjectionSchema } from "../../../src/contracts/errorSchemas.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { GhidraClient } from "../../../src/ghidra/GhidraClient.js";
import { GhidraHeadlessLauncher } from "../../../src/ghidra/GhidraLauncher.js";
import { GhidraRequestQueue } from "../../../src/ghidra/GhidraRequestQueue.js";
import { bindGhidraSessionFailure } from "../../../src/ghidra/GhidraSessionError.js";
import { silentLogger } from "../../../src/logger.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectGhidraMcp } from "./ghidraMcpHarness.js";

it("preserves queue failure diagnostics through the provider, CLI adapter and SDK MCP transport", async () => {
  const token = "fixture-authentication-token";
  const cause = Object.assign(
    new TypeError(
      `Decode failed ${token}: /tmp/password-fixture http://localhost/secret?token=public-value`,
    ),
    { code: "EDECODE" },
  );
  const failure = bindGhidraSessionFailure(
    () => ({
      target_path: "/tmp/public-fixture",
      target_sha256: "a".repeat(64),
    }),
    (value) => value.replaceAll(token, "[REDACTED]"),
  );
  const queue = new GhidraRequestQueue(
    async () => {
      throw cause;
    },
    failure,
    () => Promise.resolve(),
  );
  const harness = await connectGhidraMcp(
    "ghidra-failure-diagnostics",
    (operation, input, options) => queue.run(operation, input, options ?? {}),
  );
  const previousExitCode = process.exitCode;
  try {
    const cli = await logCliCommand(silentLogger, "inspect", async () => {
      const result = await harness.session.execute("list_procedures", {});
      if (!result.ok) throw result.error;
      return result.value.result;
    });
    expect(process.exitCode).toBe(1);
    const parsed = analysisErrorProjectionSchema.parse(cli);
    expect(parsed).toMatchObject({
      code: "execution_failure",
      details: {
        diagnostics: {
          target_path: "/tmp/public-fixture",
          failure_kind: "protocol",
          failure_message:
            "Ghidra serial request execution rejected unexpectedly",
          failure_cause: {
            name: "TypeError",
            code: "EDECODE",
            message:
              "Decode failed [REDACTED]: /tmp/password-fixture http://localhost/secret?token=public-value",
          },
        },
      },
    });
    const mcp = await harness.mcp.callTool({
      name: "list_procedures",
      arguments: {},
    });
    expect(mcp.isError).toBe(true);
    expect(parseMcpToolError(mcp)).toMatchObject({ error: parsed });
    expect(mcp.content).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("EDECODE"),
      }),
    );
    expect(JSON.stringify(mcp)).not.toContain(token);
    expect(JSON.stringify(mcp)).not.toContain(cause.stack);
  } finally {
    process.exitCode = previousExitCode;
    await harness.close();
  }
}, 30_000);

it.skipIf(process.platform === "win32").each(["-envvars", "-vmargs"])(
  "preserves LaunchSupport %s failure output through the provider, CLI adapter and SDK MCP transport",
  async (phase) => {
    const { started, stdout, stderr } = await launchSupportFailure(
      phase,
      false,
    );
    expect(started.error.diagnostics).toMatchObject({
      failure_kind: "start",
      failure_cause: {
        name: "GhidraLaunchError",
        cause: {
          name: "GhidraLaunchSupportError",
          command_outcome: {
            stdout,
            stderr,
            stdoutBytes: Buffer.byteLength(stdout),
            stderrBytes: Buffer.byteLength(stderr),
            stdoutTruncated: false,
            stderrTruncated: false,
            killed: false,
            outputTruncated: false,
          },
          cause: {
            code: 7,
            signal: null,
            message_truncated: true,
          },
        },
      },
    });
    const harness = await connectGhidraMcp(
      "ghidra-launch-failure-diagnostics",
      () => Promise.resolve(started),
    );
    const previousExitCode = process.exitCode;
    try {
      const cli = await logCliCommand(silentLogger, "inspect", async () => {
        const result = await harness.session.execute("list_procedures", {});
        if (!result.ok) throw result.error;
        return result.value.result;
      });
      const parsed = analysisErrorProjectionSchema.parse(cli);
      expect(parsed).toMatchObject({
        code: "execution_failure",
        details: { diagnostics: started.error.diagnostics },
      });
      const mcp = await harness.mcp.callTool({
        name: "list_procedures",
        arguments: {},
      });
      expect(mcp.isError).toBe(true);
      expect(parseMcpToolError(mcp)).toMatchObject({ error: parsed });
    } finally {
      process.exitCode = previousExitCode;
      await harness.close();
    }
  },
  30_000,
);

it.skipIf(process.platform === "win32").each(["-envvars", "-vmargs"])(
  "preserves captured LaunchSupport %s output with unknown cancellation outcomes",
  async (phase) => {
    const { started, stdout, stderr } = await launchSupportFailure(phase, true);
    expect(started.error.diagnostics.failure_kind).toBe("cancelled");
    const outcome = commandOutcome(started.error.diagnostics.failure_cause);
    if (
      outcome === null ||
      typeof outcome !== "object" ||
      Array.isArray(outcome) ||
      typeof outcome.stdout !== "string" ||
      typeof outcome.stderr !== "string"
    )
      throw new Error("Expected captured LaunchSupport output");
    expect(stdout.startsWith(outcome.stdout)).toBe(true);
    expect(stderr.startsWith(outcome.stderr)).toBe(true);
    expect(outcome).toEqual({
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      stdoutBytes: Buffer.byteLength(outcome.stdout),
      stderrBytes: Buffer.byteLength(outcome.stderr),
      stdoutTruncated: false,
      stderrTruncated: false,
      killed: null,
      outputTruncated: null,
    });
  },
  30_000,
);

const launchSupportFailure = async (phase: string, cancelled: boolean) => {
  const root = await createTestTempDirectory("rea-ghidra-launch-output-");
  const javaHome = join(root, "jdk");
  const java = join(javaHome, "bin", "java");
  const ready = join(root, "ready");
  const stdout = `LaunchSupport ${phase} stdout diagnostic`;
  const stderr = `${"é".repeat(1600)}\nLaunchSupport ${phase} stderr reason`;
  await mkdir(join(javaHome, "bin"), { recursive: true });
  await writeFile(
    java,
    `#!${process.execPath}\n` +
      `const { writeSync, writeFileSync } = require("node:fs");\n` +
      `const phase = process.argv.at(-1);\n` +
      `if (${JSON.stringify(phase)} === "-vmargs" && phase === "-envvars") process.exit(0);\n` +
      `if (phase !== ${JSON.stringify(phase)}) throw new Error("Unexpected LaunchSupport invocation");\n` +
      `writeSync(1, ${JSON.stringify(stdout)});\n` +
      `writeSync(2, ${JSON.stringify(stderr)});\n` +
      (cancelled
        ? `writeFileSync(${JSON.stringify(ready)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`
        : `process.exit(7);\n`),
  );
  await chmod(java, 0o755);
  const targetPath = join(root, "target.bin");
  const target = Buffer.from("inert Ghidra startup diagnostic fixture\n");
  await writeFile(targetPath, target);
  const spawnProcess = vi.fn(async () => {
    throw new Error("The main JVM must not start after LaunchSupport fails");
  });
  const headless = new GhidraHeadlessLauncher({
    environment: process.env,
    javaHome,
    analyzeHeadlessPath: join(root, "ghidra", "support", "analyzeHeadless"),
    bridgeScriptPath: join(root, "ReaGhidraBridge.java"),
    spawnProcess,
  });
  let runtimeRoot: string | undefined;
  let childPid: number | undefined;
  const controller = new AbortController();
  const client = new GhidraClient({
    launcher: {
      launch(session, options) {
        runtimeRoot = session.runtimeRoot;
        return headless.launch(session, options);
      },
    },
    targetPath,
    targetSha256: createHash("sha256").update(target).digest("hex"),
    providerVersion: "12.1.4",
    profileDigest: "a".repeat(64),
    transport: "unix-socket",
    startupTimeoutMs: 10_000,
  });
  onTestFinished(async () => {
    controller.abort();
    const closed = await client.close();
    if (!closed.ok) throw closed.error;
    if (childPid !== undefined) {
      const pid = childPid;
      await expect
        .poll(() => {
          try {
            process.kill(pid, 0);
            return true;
          } catch (cause: unknown) {
            if (
              cause instanceof Error &&
              "code" in cause &&
              cause.code === "ESRCH"
            )
              return false;
            throw cause;
          }
        })
        .toBe(false);
    }
  });
  const starting = client.start(controller.signal);
  if (cancelled) {
    await expect
      .poll(() => readFile(ready, "utf8").catch(() => ""))
      .toMatch(/^[1-9]\d*$/u);
    childPid = Number(await readFile(ready, "utf8"));
    controller.abort();
  }
  const started = await starting;
  if (started.ok) throw new Error("Expected LaunchSupport startup failure");
  expect(spawnProcess).not.toHaveBeenCalled();
  if (runtimeRoot === undefined)
    throw new Error("Runtime root was not allocated");
  await expect(access(runtimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  return { started, stdout, stderr };
};

const commandOutcome = (
  cause: JsonValue | undefined,
): JsonValue | undefined => {
  if (cause === null || typeof cause !== "object" || Array.isArray(cause))
    return undefined;
  return cause.command_outcome ?? commandOutcome(cause.cause);
};
