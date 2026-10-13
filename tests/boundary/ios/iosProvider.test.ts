import { beforeEach, expect, it, vi } from "vitest";

const scenario = vi.hoisted(() => ({
  probes: [] as string[],
  calls: [] as { command: string; args: readonly string[] }[],
  spawnCount: 0,
  failForward: 0,
  spawnError: false,
  onlyUsb: false,
  oversized: false,
  cancelLaunch: false,
  controller: undefined as AbortController | undefined,
  cleanupCalls: 0,
  cleanupFails: false,
  forwardGate: undefined as Promise<void> | undefined,
  forwardStarted: undefined as (() => void) | undefined,
  spawnSignals: [] as (AbortSignal | undefined)[],
  directoryCleanupFails: false,
}));

vi.mock("../../../src/ios/IosConfiguration.js", async (original) => {
  const actual =
    await original<typeof import("../../../src/ios/IosConfiguration.js")>();
  return {
    ...actual,
    inspectIosTool: async (
      selection: Parameters<typeof actual.inspectIosTool>[0],
    ) => {
      scenario.probes.push(selection.name);
      if (scenario.onlyUsb && selection.name !== "idevice_id")
        throw new actual.IosConfigurationFailure(
          "binary_missing",
          "Optional tool unavailable",
        );
      return { ...selection, version: "1.0" };
    },
  };
});

vi.mock("node:net", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    createServer: () =>
      Object.assign(new EventEmitter(), {
        listen: (_port: number, _host: string, callback: () => void) =>
          setImmediate(callback),
        address: () => ({ port: 41000 + scenario.spawnCount }),
        close: (callback: () => void) => setImmediate(callback),
      }),
    connect: () => {
      const socket = Object.assign(new EventEmitter(), {
        destroy: () => undefined,
        setTimeout: () => undefined,
      });
      setImmediate(() => socket.emit("connect"));
      return socket;
    },
  };
});

vi.mock("../../../src/process/ProviderProcess.js", async (original) => {
  const actual =
    await original<typeof import("../../../src/process/ProviderProcess.js")>();
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  return {
    ...actual,
    spawnOwnedProviderProcess: async (
      options: Parameters<typeof actual.spawnOwnedProviderProcess>[0],
    ) => {
      scenario.spawnCount += 1;
      scenario.spawnSignals.push(options.signal);
      scenario.forwardStarted?.();
      await scenario.forwardGate;
      if (scenario.spawnCount === scenario.failForward)
        throw new Error("Forward launch failed");
      const process = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null as number | null,
        signalCode: null,
        kill: () => false,
      });
      if (scenario.spawnError)
        setImmediate(() => process.emit("error", new Error("EAGAIN")));
      return {
        process,
        ownership: {
          runId: options.runId,
          leaderPid: 12345,
          processGroupId: 12345,
        },
        cleanup: async () => {
          if (scenario.cleanupFails)
            return {
              cleaned: false as const,
              reason: "Controlled cleanup failure",
            };
          process.exitCode = 0;
          process.stdout.end();
          process.stderr.end();
          process.emit("exit", 0, null);
          process.emit("close", 0, null);
          return { cleaned: true as const, signaled: false };
        },
      };
    },
  };
});

vi.mock("../../../src/process/ExecFileOutput.js", async (original) => {
  const actual =
    await original<typeof import("../../../src/process/ExecFileOutput.js")>();
  return {
    ...actual,
    execFileBytes: async (command: string, args: readonly string[]) => {
      scenario.calls.push({ command, args });
      const script = args.at(-1) ?? "";
      const result = (stdout = "", stderr = "") => ({
        stdout: Buffer.from(stdout),
        stderr: Buffer.from(stderr),
      });
      if (command === "idevice_id") return result("device-udid\n");
      if (
        scenario.oversized &&
        (command === "idevicesyslog" || command === "frida")
      )
        throw Object.assign(new Error("Output limit"), {
          code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          killed: true,
          stdout: "line\n",
          stderr: "",
        });
      if (script.includes("rmdir ")) {
        if (scenario.directoryCleanupFails)
          throw Object.assign(new Error("directory busy"), {
            code: 1,
            stdout: "",
            stderr: "directory busy",
          });
        return result();
      }
      if (script.includes("kill -TERM")) {
        scenario.cleanupCalls += 1;
        return result();
      }
      if (script.includes("dbg=$(command -v")) {
        if (scenario.cancelLaunch) {
          scenario.controller?.abort();
          throw Object.assign(new Error("Cancelled"), {
            code: "ABORT_ERR",
            stdout: "",
            stderr: "",
          });
        }
        return result(
          "directory_created\t1\nstatus\tattached\npath\t/usr/bin/debugserver\npid\t42\n",
        );
      }
      if (script.includes("frida=$(command -v")) {
        if (scenario.cancelLaunch) {
          scenario.controller?.abort();
          throw Object.assign(new Error("Cancelled"), {
            code: "ABORT_ERR",
            stdout: "",
            stderr: "",
          });
        }
        return result(
          "directory_created\t1\npath\t/usr/bin/frida-server\npid\t43\nowned\t1\n",
        );
      }
      if (script.includes("REA_PROBE_"))
        return result(
          "123 root /app\n",
          "lsof: permission denied\nREA_PROBE_ps_EXIT=0\nREA_PROBE_lsof_EXIT=1\n",
        );
      if (command === "lldb")
        throw Object.assign(new Error("Invalid address"), {
          code: 1,
          stdout: "(lldb) memory read\n",
          stderr: "invalid address",
        });
      return result("ran\n");
    },
  };
});

import { IosProvider } from "../../../src/ios/IosProvider.js";
import { IosDeviceAnalysisService } from "../../../src/application/ios/IosDeviceAnalysisService.js";
import { iosResultSchemas } from "../../../src/domain/ios/iosDeviceAnalysis.js";

beforeEach(() => {
  scenario.probes = [];
  scenario.calls = [];
  scenario.spawnCount = 0;
  scenario.failForward = 0;
  scenario.spawnError = false;
  scenario.onlyUsb = false;
  scenario.oversized = false;
  scenario.cancelLaunch = false;
  scenario.controller = undefined;
  scenario.cleanupCalls = 0;
  scenario.cleanupFails = false;
  scenario.forwardGate = undefined;
  scenario.forwardStarted = undefined;
  scenario.spawnSignals = [];
  scenario.directoryCleanupFails = false;
});

it("lists USB devices without probing unrelated optional tools", async () => {
  scenario.onlyUsb = true;
  const provider = new IosProvider({ environment: {} });
  try {
    const response = await new IosDeviceAnalysisService(provider).execute(
      "list_ios_devices",
      {},
    );
    expect(response.ok).toBe(true);
    expect(scenario.probes).toEqual(["idevice_id"]);
  } finally {
    await provider.close();
  }
});

it("shares a forward, uses the configured account, and pins trust to device identity", async () => {
  const provider = new IosProvider({
    environment: { REA_IOS_SSH_USER: "mobile" },
  });
  const service = new IosDeviceAnalysisService(provider);
  try {
    const responses = await Promise.all(
      [1, 2].map(() =>
        service.execute("run_ios_command", {
          device_id: "device-udid",
          command: "id",
        }),
      ),
    );
    expect(responses.every((response) => response.ok)).toBe(true);
    expect(scenario.spawnCount).toBe(1);
    const ssh = scenario.calls.filter((call) => call.command === "ssh");
    for (const call of ssh)
      expect(call.args).toEqual(
        expect.arrayContaining([
          "StrictHostKeyChecking=yes",
          "HostKeyAlias=rea-ios-device-udid",
          "mobile@127.0.0.1",
        ]),
      );
    const explicit = await service.execute("run_ios_command", {
      device_id: "device-udid",
      command: "id",
      user: "root",
    });
    expect(explicit.ok).toBe(true);
    expect(scenario.calls.at(-1)?.args).toContain("root@127.0.0.1");
  } finally {
    await provider.close();
  }
});

it("turns a forwarding child startup error into a typed operation failure", async () => {
  scenario.spawnError = true;
  const provider = new IosProvider({ environment: {} });
  try {
    const response = await new IosDeviceAnalysisService(provider).execute(
      "run_ios_command",
      { device_id: "device-udid", command: "id" },
    );
    expect(response.ok).toBe(false);
  } finally {
    await provider.close();
  }
});

it("rolls back an acknowledged remote attach if the debug forward fails", async () => {
  scenario.failForward = 2;
  const provider = new IosProvider({ environment: {} });
  const response = await new IosDeviceAnalysisService(provider).execute(
    "attach_ios_debugserver",
    { device_id: "device-udid", pid: 123 },
  );
  expect(response.ok).toBe(false);
  expect(scenario.cleanupCalls).toBe(1);
  await provider.close();
  expect(scenario.cleanupCalls).toBe(1);
});

it.each([
  {
    operation: "attach_ios_debugserver" as const,
    input: { device_id: "device-udid", pid: 123 },
  },
  {
    operation: "run_ios_frida_script" as const,
    input: { device_id: "device-udid", pid: 123, script: "console.log(1)" },
  },
])(
  "retains unknown $operation startup ownership after SSH cancellation",
  async ({ operation, input }) => {
    scenario.cancelLaunch = true;
    scenario.controller = new AbortController();
    const provider = new IosProvider({ environment: {} });
    const response = await new IosDeviceAnalysisService(provider).execute(
      operation,
      input,
      { signal: scenario.controller.signal },
    );
    expect(response.ok).toBe(false);
    if (!response.ok && operation === "run_ios_frida_script")
      expect(response.error).toMatchObject({ cleanupIncomplete: true });
    await expect(provider.close()).rejects.toMatchObject({
      cleanupIncomplete: true,
    });
    expect(scenario.cleanupCalls).toBe(2);
  },
);

it("reports syslog output overflow as partial output_limit coverage", async () => {
  scenario.oversized = true;
  const provider = new IosProvider({ environment: {} });
  try {
    const response = await new IosDeviceAnalysisService(provider).execute(
      "read_ios_log",
      { device_id: "device-udid" },
    );
    if (!response.ok) throw response.error;
    expect(
      iosResultSchemas.read_ios_log.parse(response.value.normalized_result),
    ).toMatchObject({ stop_reason: "output_limit", coverage: "partial" });
  } finally {
    await provider.close();
  }
});

it("retains successful process facts alongside a failed lsof probe", async () => {
  const provider = new IosProvider({ environment: {} });
  try {
    const response = await new IosDeviceAnalysisService(provider).execute(
      "inspect_ios_process",
      { device_id: "device-udid", pid: 123 },
    );
    if (!response.ok) throw response.error;
    expect(
      iosResultSchemas.inspect_ios_process.parse(
        response.value.normalized_result,
      ),
    ).toMatchObject({
      stdout: "123 root /app\n",
      stderr: "lsof: permission denied",
      probes: [
        { name: "ps", exit_code: 0 },
        { name: "lsof", exit_code: 1 },
      ],
      coverage: "partial",
    });
  } finally {
    await provider.close();
  }
});

it("preserves LLDB memory-read errors and exit status", async () => {
  const provider = new IosProvider({ environment: {} });
  try {
    const response = await new IosDeviceAnalysisService(provider).execute(
      "dump_ios_process_memory",
      { device_id: "device-udid", pid: 123, address: "0xdeadbeef" },
    );
    if (!response.ok) throw response.error;
    expect(
      iosResultSchemas.dump_ios_process_memory.parse(
        response.value.normalized_result,
      ),
    ).toMatchObject({
      stderr: "invalid address",
      exit_code: 1,
      coverage: "partial",
    });
  } finally {
    await provider.close();
  }
});

it("retains failed forward cleanup ownership for a later close retry", async () => {
  const provider = new IosProvider({ environment: {} });
  const response = await new IosDeviceAnalysisService(provider).execute(
    "run_ios_command",
    { device_id: "device-udid", command: "id" },
  );
  expect(response.ok).toBe(true);
  scenario.cleanupFails = true;
  await expect(provider.close()).rejects.toMatchObject({
    cleanupIncomplete: true,
  });
  scenario.cleanupFails = false;
  await provider.close();
  expect(scenario.spawnCount).toBe(1);
});

it("reports Frida output overflow without claiming a timeout or complete coverage", async () => {
  scenario.oversized = true;
  const provider = new IosProvider({ environment: {} });
  try {
    const response = await new IosDeviceAnalysisService(provider).execute(
      "run_ios_frida_script",
      { device_id: "device-udid", pid: 123, script: "console.log(1)" },
    );
    if (!response.ok) throw response.error;
    expect(
      iosResultSchemas.run_ios_frida_script.parse(
        response.value.normalized_result,
      ),
    ).toMatchObject({
      stop_reason: "output_limit",
      timed_out: false,
      coverage: "partial",
    });
  } finally {
    await provider.close();
  }
});

it("lets a caller cancel its wait without canceling another caller's shared forward", async () => {
  let release!: () => void;
  scenario.forwardGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    scenario.forwardStarted = resolve;
  });
  const controller = new AbortController();
  const provider = new IosProvider({ environment: {} });
  const service = new IosDeviceAnalysisService(provider);
  const input = { device_id: "device-udid", command: "id" };
  try {
    const first = service.execute("run_ios_command", input, {
      signal: controller.signal,
    });
    await began;
    const second = service.execute("run_ios_command", input);
    controller.abort();
    const canceled = await first;
    expect(canceled.ok).toBe(false);
    expect(scenario.spawnSignals[0]?.aborted).toBe(false);
    release();
    expect((await second).ok).toBe(true);
    expect(scenario.spawnCount).toBe(1);
  } finally {
    release();
    await provider.close();
  }
});

it.each([
  {
    operation: "attach_ios_debugserver" as const,
    input: { device_id: "device-udid", pid: 123 },
  },
  {
    operation: "run_ios_frida_script" as const,
    input: { device_id: "device-udid", pid: 123, script: "console.log(1)" },
  },
])(
  "owns private remote logs and retains failed directory cleanup for $operation",
  async ({ operation, input }) => {
    const provider = new IosProvider({ environment: {} });
    const response = await new IosDeviceAnalysisService(provider).execute(
      operation,
      input,
    );
    expect(response.ok).toBe(true);
    const launch = scenario.calls
      .map((call) => call.args.at(-1) ?? "")
      .find((script) => script.includes("nohup"))!;
    expect(launch).toContain("umask 077; rea_dir=");
    expect(launch).toContain('mkdir "$rea_dir" || {');
    expect(launch).toContain("exit 73; }");
    expect(launch).toContain('log="$rea_dir/helper.log"');
    expect(launch).not.toContain("/tmp/rea-debugserver-");
    expect(launch).not.toContain("/tmp/rea-frida-server-");
    scenario.directoryCleanupFails = true;
    await expect(provider.close()).rejects.toMatchObject({
      cleanupIncomplete: true,
    });
    scenario.directoryCleanupFails = false;
    await provider.close();
    expect(
      scenario.calls.some((call) =>
        call.args.at(-1)?.includes('rmdir "$rea_dir"'),
      ),
    ).toBe(true);
  },
);
