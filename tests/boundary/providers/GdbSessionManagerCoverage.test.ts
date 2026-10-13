import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, expect, it } from "vitest";

import { AnalysisTimeoutError } from "../../../src/domain/analysisErrorCore.js";
import {
  GdbSessionManager,
  waitForGdbCommandTurn,
} from "../../../src/gdb/GdbSessionManager.js";
import type {
  OwnedProviderProcessSpawnOptions,
  ProviderProcessHandle,
  SpawnedOwnedProviderProcess,
} from "../../../src/process/ProviderProcess.js";
import { stopOwnedDebuggerProcess } from "../../../src/process/ownedDebuggerSession.js";
import { expectGdbSessionStarted } from "./gdbTestHelpers.js";

let directory: string | undefined;
const managers: GdbSessionManager[] = [];

class FakeGdbProcess extends EventEmitter implements ProviderProcessHandle {
  readonly pid = process.pid + 1;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: PassThrough | null;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killSignals: NodeJS.Signals[] = [];

  constructor(stdinEnabled = true) {
    super();
    this.stdin = stdinEnabled ? new PassThrough() : null;
  }

  kill(signal: NodeJS.Signals): boolean {
    this.killSignals.push(signal);
    this.exit(null, signal);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.stdin?.destroy();
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }

  exitLeader(code: number): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.emit("exit", code, null);
  }

  closeInheritedOutput(): void {
    this.stdout.end();
    this.stderr.end();
    this.stdin?.destroy();
    this.emit("close", this.exitCode, this.signalCode);
  }
}

const createFakeSpawner = (
  respond: (process: FakeGdbProcess, token: string, command: string) => void = (
    child,
    token,
    command,
  ) =>
    child.stdout.write(
      command.includes("list-thread-groups")
        ? `${token}^done,groups=[]\n`
        : `${token}^done\n`,
    ),
  options: {
    readonly stdinEnabled?: boolean;
    readonly exitAfterPrompt?: boolean;
    readonly exitOnFirstStdoutData?: boolean;
    readonly afterSpawn?: () => void;
  } = {},
): {
  readonly spawnProcess: (
    spawnOptions: OwnedProviderProcessSpawnOptions,
  ) => Promise<SpawnedOwnedProviderProcess>;
  readonly children: FakeGdbProcess[];
} => {
  const children: FakeGdbProcess[] = [];
  return {
    children,
    spawnProcess: async (spawnOptions) => {
      const child = new FakeGdbProcess(options.stdinEnabled ?? true);
      children.push(child);
      child.stdout.write("(gdb)\n");
      if (options.exitOnFirstStdoutData)
        child.stdout.once("data", () =>
          queueMicrotask(() => child.exit(0, null)),
        );
      child.stdin?.setEncoding("utf8");
      child.stdin?.on("data", (chunk: string | Buffer) => {
        for (const line of String(chunk).split("\n")) {
          const match = /^(\d+)(.*)$/u.exec(line);
          if (match !== null) respond(child, match[1] ?? "", match[2] ?? "");
        }
      });
      if (options.exitAfterPrompt) queueMicrotask(() => child.exit(0, null));
      options.afterSpawn?.();
      return {
        process: child,
        ownership: {
          runId: spawnOptions.runId,
          leaderPid: child.pid,
          processGroupId: child.pid,
          expectedParentPid: process.pid,
        },
      };
    },
  };
};

const recordingInferiorListResponder = (groups: string) => {
  const commands: string[] = [];
  return {
    commands,
    respond: (child: FakeGdbProcess, token: string, command: string): void => {
      commands.push(command);
      child.stdout.write(
        command.includes("list-thread-groups")
          ? `${token}^done,groups=${groups}\n`
          : `${token}^done\n`,
      );
    },
  };
};

it("returns cancellation when GDB startup is aborted after spawn", async () => {
  const controller = new AbortController();
  const fake = createFakeSpawner(undefined, {
    afterSpawn: () => controller.abort(),
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);

  const started = await manager.start(controller.signal);

  expect(started.ok).toBe(false);
  if (!started.ok) expect(started.error._tag).toBe("AnalysisCancelledError");
  expect(fake.children[0]?.signalCode).toBe("SIGTERM");
});

it("classifies cancellation while asynchronous GDB ownership preparation is pending", async () => {
  const controller = new AbortController();
  let entered!: () => void;
  const spawnEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const manager = new GdbSessionManager({
    environment: {},
    spawnProcess: async (options) =>
      new Promise<never>((_resolve, reject) => {
        entered();
        options.signal?.addEventListener(
          "abort",
          () => reject(new Error("spawn preparation aborted")),
          { once: true },
        );
      }),
  });
  const starting = manager.start(controller.signal);
  await spawnEntered;
  controller.abort();
  const started = await starting;
  expect(started).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
});

it("drains active GDB commands and rejects new commands before closeAll cleanup", async () => {
  let heldToken = "";
  let heldCommand = "";
  const fake = createFakeSpawner((_child, token, command) => {
    if (command.includes("held command")) {
      heldToken = token;
      heldCommand = command;
    } else
      _child.stdout.write(
        command.includes("list-thread-groups")
          ? `${token}^done,groups=[]\n`
          : `${token}^done\n`,
      );
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);
  const active = manager.execute(started.value.session_id, "held command");
  await expect.poll(() => heldToken).not.toBe("");
  const closing = manager.closeAll();
  const rejected = await manager.execute(
    started.value.session_id,
    "late command",
  );
  expect(rejected.ok).toBe(false);
  const duplicateClose = await manager.close(started.value.session_id);
  expect(duplicateClose).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError", operation: "close_gdb_session" },
  });
  expect(fake.children[0]?.killSignals).toEqual([]);
  fake.children[0]?.stdout.write(`${heldToken}^done\n`);
  expect((await active).ok).toBe(true);
  await closing;
  expect(heldCommand).toContain("held command");
  expect(fake.children[0]?.killSignals).toEqual(["SIGTERM"]);
});

it("reports invalid UTF-8 in retained GDB stderr status", async () => {
  const fake = createFakeSpawner();
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);
  fake.children[0]?.stderr.write(Buffer.from([0xff]));
  await new Promise((resolve) => setImmediate(resolve));
  expect(manager.status(started.value.session_id)).toMatchObject({
    stderr: "�",
    stderr_invalid_utf8: true,
  });
});

it("waits for GDB stdout settlement after a no-inferior exit without re-entering MI", async () => {
  const commands: string[] = [];
  const fake = createFakeSpawner((child, token, command) => {
    commands.push(command);
    if (command.includes("list-thread-groups"))
      child.stdout.write(`${token}^done,groups=[]\n`);
    else if (command.includes("gdb-exit")) {
      child.stdout.write(`${token}^exit\n`);
      queueMicrotask(() => child.exit(0, null));
    } else child.stdout.write(`${token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);
  const closed = await manager.close(started.value.session_id);
  expect(closed).toMatchObject({
    ok: true,
    value: { target_state: "none_observed" },
  });
  expect(
    commands.filter((command) => command.includes("list-thread-groups")),
  ).toHaveLength(1);
  expect(commands).toContain("-gdb-exit");
});

it("configures and verifies the caller-selected inferior TTY before reporting ready", async () => {
  const tty = '/dev/pts/42 "🚀"';
  const miTty = tty.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const commands: string[] = [];
  const fake = createFakeSpawner((_child, token, command) => {
    commands.push(command);
    if (command.includes("inferior-tty-show"))
      _child.stdout.write(`${token}^done,inferior_tty_terminal="${miTty}"\n`);
    else if (command.includes("list-thread-groups"))
      _child.stdout.write(`${token}^done,groups=[]\n`);
    else _child.stdout.write(`${token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);

  const started = await manager.start(undefined, { inferiorTty: tty });

  expect(started.ok).toBe(true);
  if (!started.ok) return;
  const status = manager.status(started.value.session_id);
  expect(status).toMatchObject({
    inferior_tty: tty,
    inferior_tty_verified: true,
  });
  expect(
    commands.indexOf(`-inferior-tty-set ${JSON.stringify(tty)}`),
  ).toBeGreaterThan(-1);
  expect(commands.indexOf("-inferior-tty-show")).toBeGreaterThan(
    commands.indexOf(`-inferior-tty-set ${JSON.stringify(tty)}`),
  );
});

it("rejects a GDB leader exit without a verified sink and retains inherited output", async () => {
  const fake = createFakeSpawner();
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);
  const child = fake.children[0];
  if (child === undefined) return;
  child.exitLeader(7);

  const closed = await manager.close(started.value.session_id);

  expect(closed.ok).toBe(false);
  expect(manager.status(started.value.session_id)).toMatchObject({
    state: "closed",
    inferior_tty: null,
    inferior_tty_verified: false,
  });
  expect(child.killSignals).toEqual([]);
  child.stdout.write("=thread-group-exited,id=descendant-sentinel\n");
  child.closeInheritedOutput();
  expect(manager.status(started.value.session_id)?.recent_mi_records).toContain(
    "=thread-group-exited,id=descendant-sentinel",
  );
});

it("waits for inherited output settlement after leader exit when a sink was verified", async () => {
  directory ??= await mkdtemp(join(tmpdir(), "rea-gdb-coverage-"));
  const tty = join(directory, "inferior-output");
  await writeFile(tty, "");
  const fake = createFakeSpawner((_child, token, command) => {
    if (command.includes("inferior-tty-show"))
      fake.children[0]?.stdout.write(
        `${token}^done,inferior_tty_terminal=${JSON.stringify(tty)}\n`,
      );
    else if (command.includes("list-thread-groups"))
      fake.children[0]?.stdout.write(`${token}^done,groups=[]\n`);
    else fake.children[0]?.stdout.write(`${token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await manager.start(undefined, { inferiorTty: tty });
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  const child = fake.children[0];
  if (child === undefined) return;
  expect(manager.status(started.value.session_id)?.inferior_tty_verified).toBe(
    true,
  );
  child.exitLeader(7);

  const closing = manager.close(started.value.session_id);
  await new Promise((resolve) => setImmediate(resolve));
  await writeFile(tty, "descendant sentinel after GDB leader exit\n");
  child.closeInheritedOutput();
  const closed = await closing;

  expect(closed).toMatchObject({
    ok: true,
    value: { target_state: "unknown" },
  });
  expect(await readFile(tty, "utf8")).toBe(
    "descendant sentinel after GDB leader exit\n",
  );
  expect(manager.status(started.value.session_id)).toBeUndefined();
  expect(child.killSignals).toEqual([]);
});

it("retries close after an exited GDB's inherited output streams settle", async () => {
  const fake = createFakeSpawner();
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);
  const child = fake.children[0];
  if (child === undefined) return;

  child.exitLeader(3);
  const firstClose = await manager.close(started.value.session_id);
  expect(firstClose.ok).toBe(false);
  if (!firstClose.ok)
    expect(firstClose.error.message).toMatch(/inherited output streams/i);
  expect(manager.status(started.value.session_id)).toBeDefined();

  child.closeInheritedOutput();
  await expect(manager.close(started.value.session_id)).resolves.toMatchObject({
    ok: true,
    value: { target_state: "unknown" },
  });
  expect(manager.status(started.value.session_id)).toBeUndefined();
});

it("rejects inferior TTY configuration when GDB reports a different terminal", async () => {
  const fake = createFakeSpawner((child, token, command) => {
    child.stdout.write(
      command.includes("inferior-tty-show")
        ? `${token}^done,inferior_tty_terminal="/dev/pts/other"\n`
        : command.includes("list-thread-groups")
          ? `${token}^done,groups=[]\n`
          : `${token}^done\n`,
    );
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);

  const started = await manager.start(undefined, {
    inferiorTty: "/dev/pts/requested",
  });

  expect(started.ok).toBe(false);
  if (!started.ok)
    expect(started.error._tag).toBe("AnalysisCapabilityUnavailableError");
  expect(
    fake.children.every((child) => child.killSignals.includes("SIGTERM")),
  ).toBe(true);
});

it.each([
  ["trailing garbage", 'inferior_tty_terminal="/dev/pts/42"junk'],
  [
    "duplicate field",
    'inferior_tty_terminal="/dev/pts/42",inferior_tty_terminal="/dev/pts/42"',
  ],
])("rejects MI inferior TTY readback with %s", async (_label, fields) => {
  const fake = createFakeSpawner((child, token, command) => {
    child.stdout.write(
      command.includes("inferior-tty-show")
        ? `${token}^done,${fields}\n`
        : `${token}^done\n`,
    );
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await manager.start(undefined, {
    inferiorTty: "/dev/pts/42",
  });
  expect(started.ok).toBe(false);
  if (!started.ok)
    expect(started.error._tag).toBe("AnalysisCapabilityUnavailableError");
});

const managerWithFakeSpawner = (
  spawnProcess: (
    options: OwnedProviderProcessSpawnOptions,
  ) => Promise<SpawnedOwnedProviderProcess>,
  options: ConstructorParameters<typeof GdbSessionManager>[0] = {},
): GdbSessionManager => {
  const manager = new GdbSessionManager({
    environment: { REA_GDB_COMMAND: "fake-gdb" },
    spawnProcess,
    ...options,
  });
  managers.push(manager);
  return manager;
};

const startWithVerifiedInferiorTty = async (
  tty: string,
): Promise<{
  readonly manager: GdbSessionManager;
  readonly sessionId: string;
  readonly commands: string[];
}> => {
  const commands: string[] = [];
  const fake = createFakeSpawner((_child, token, command) => {
    commands.push(command);
    const response = command.includes("inferior-tty-show")
      ? `^done,inferior_tty_terminal=${JSON.stringify(tty)}`
      : command.includes("list-thread-groups")
        ? '^done,groups=[{id="i1",pid="123"}]'
        : "^done";
    fake.children[0]?.stdout.write(`${token}${response}\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await manager.start(undefined, { inferiorTty: tty });
  if (!started.ok) throw new Error("GDB did not start with its selected TTY");
  return { manager, sessionId: started.value.session_id, commands };
};

const createProvider = async (body: string): Promise<string> => {
  directory ??= await mkdtemp(join(tmpdir(), "rea-gdb-coverage-"));
  const provider = join(directory, `fake-gdb-${managers.length}.mjs`);
  await writeFile(provider, `#!${process.execPath}\n${body}`);
  await chmod(provider, 0o700);
  return provider;
};

const managerFor = async (
  body: string,
  options: ConstructorParameters<typeof GdbSessionManager>[0] = {},
): Promise<GdbSessionManager> => {
  const manager = new GdbSessionManager({
    environment: { REA_GDB_COMMAND: await createProvider(body) },
    ...options,
  });
  managers.push(manager);
  return manager;
};

const responsiveProvider = (
  handler = "if (match[2].includes('list-thread-groups')) process.stdout.write(match[1] + '^done,groups=[]\\n'); else process.stdout.write(match[1] + '^done\\n');",
): string => `
process.stdout.write('(gdb)\\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  for (;;) {
    const end = input.indexOf('\\n');
    if (end < 0) break;
    const line = input.slice(0, end); input = input.slice(end + 1);
    const match = /^(\\d+)(.*)/.exec(line);
    if (!match) continue;
    ${handler}
  }
});
`;

afterEach(async () => {
  await Promise.all(
    managers
      .splice(0)
      .map((manager) => manager.closeAll().catch(() => undefined)),
  );
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

it("rejects a pre-cancelled GDB start and an unconfigured executable", async () => {
  const cancelled = new AbortController();
  cancelled.abort();
  const startResult = await new GdbSessionManager().start(cancelled.signal);
  expect(startResult.ok).toBe(false);
  if (!startResult.ok)
    expect(startResult.error._tag).toBe("AnalysisCancelledError");

  const missing = await new GdbSessionManager({
    environment: { REA_GDB_COMMAND: join(tmpdir(), "does-not-exist-gdb") },
  }).start();
  expect(missing.ok).toBe(false);
  if (!missing.ok) {
    expect(missing.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(missing.error.message).toContain("does-not-exist-gdb");
  }
});

it("retries MI2 after an MI3 process exits before its startup prompt", async () => {
  const provider = await createProvider(`
if (process.argv.includes('--interpreter=mi3')) process.exit(0);
${responsiveProvider()}
`);
  const manager = new GdbSessionManager({
    environment: { REA_GDB_COMMAND: provider },
  });
  managers.push(manager);

  const started = await manager.start();

  expect(started.ok).toBe(true);
  if (started.ok) expect(started.value.mi_version).toBe("mi2");
});

it("retains ownership when GDB startup fails before its prompt and stop is incomplete", async () => {
  let stopCalls = 0;
  let retainedSessionId: string | undefined;
  const provider = await createProvider("process.exit(0);\n");
  const manager = new GdbSessionManager({
    environment: { REA_GDB_COMMAND: provider },
    stopProcess: async (session, name) => {
      stopCalls += 1;
      if (stopCalls === 1) {
        retainedSessionId = (session as typeof session & { id: string }).id;
        return { status: "incomplete", reason: "simulated stop uncertainty" };
      }
      return stopOwnedDebuggerProcess(session, name);
    },
  });
  managers.push(manager);

  const started = await manager.start();

  expect(started.ok).toBe(false);
  if (!started.ok) {
    expect(started.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(started.error.message).toContain("simulated stop uncertainty");
  }
  expect(stopCalls).toBe(1);
  expect(manager.status(retainedSessionId ?? "")?.state).toBe("closed");
});

it("uses a fallback message when the process launcher rejects without an Error", async () => {
  let attempts = 0;
  const manager = managerWithFakeSpawner(async () => {
    attempts += 1;
    return Promise.reject("non-error launch failure");
  });

  const started = await manager.start();

  expect(started.ok).toBe(false);
  if (!started.ok) {
    expect(started.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(started.error.message).toContain("Unable to start GDB");
  }
  expect(attempts).toBe(2);
});

it("returns startup timeout when the MI prompt never arrives", async () => {
  const provider = await createProvider(
    "process.stdin.resume(); setInterval(() => {}, 1000);\n",
  );
  const manager = new GdbSessionManager({
    environment: { REA_GDB_COMMAND: provider },
    startupTimeoutMs: 20,
  });
  managers.push(manager);

  const started = await manager.start();

  expect(started.ok).toBe(false);
  if (!started.ok) {
    expect(started.error._tag).toBe("AnalysisTimeoutError");
    expect(started.error).toBeInstanceOf(AnalysisTimeoutError);
    if (started.error instanceof AnalysisTimeoutError)
      expect(started.error.operation).toBe("start_gdb_session");
  }
});

it("preserves a timeout while startup waits for the automatic-loading response", async () => {
  const fake = createFakeSpawner((_child, _token, _command) => undefined);
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    commandTimeoutMs: 25,
  });

  const started = await manager.start();

  expect(started.ok).toBe(false);
  if (!started.ok) {
    expect(started.error._tag).toBe("AnalysisTimeoutError");
    expect(started.error).toBeInstanceOf(AnalysisTimeoutError);
    if (started.error instanceof AnalysisTimeoutError)
      expect(started.error.operation).toBe("start_gdb_session");
  }
});

it("handles a start signal that becomes aborted during listener registration", async () => {
  const provider = await createProvider(responsiveProvider());
  const controller = new AbortController();
  let registrations = 0;
  const signal = new Proxy(controller.signal, {
    get(target, property) {
      if (property === "addEventListener")
        return (...arguments_: Parameters<AbortSignal["addEventListener"]>) => {
          registrations += 1;
          if (registrations === 1) {
            controller.abort();
          }
          return target.addEventListener(...arguments_);
        };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const manager = new GdbSessionManager({
    environment: { REA_GDB_COMMAND: provider },
  });
  managers.push(manager);

  const started = await manager.start(signal);

  expect(registrations).toBe(1);
  expect(started.ok).toBe(false);
  if (!started.ok) expect(started.error._tag).toBe("AnalysisCancelledError");
});

it("handles cancellation after the automatic-loading response", async () => {
  const controller = new AbortController();
  const fake = createFakeSpawner((child, token, command) => {
    child.stdout.write(
      command.includes("list-thread-groups")
        ? `${token}^done,groups=[]\n`
        : `${token}^done\n`,
    );
    if (command.includes("auto-load off")) controller.abort();
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await manager.start(controller.signal);

  expect(started.ok).toBe(false);
  if (!started.ok) expect(started.error._tag).toBe("AnalysisCancelledError");
});

it("reports an MI stream failure when the child has no stdin pipe", async () => {
  const fake = createFakeSpawner(undefined, { stdinEnabled: false });
  const manager = managerWithFakeSpawner(fake.spawnProcess);

  const started = await manager.start();

  expect(started.ok).toBe(false);
  if (!started.ok) {
    expect(started.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(started.error.message).toContain("input stream is closed");
  }
  expect(fake.children[0]?.exitCode).toBeNull();
  expect(fake.children[0]?.killSignals).toEqual([]);
});

it("fails pending commands when the child closes stdin unexpectedly", async () => {
  const fake = createFakeSpawner();
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);

  const stdin = fake.children[0]?.stdin;
  expect(stdin).toBeDefined();
  if (stdin === null || stdin === undefined) return;
  const inputClosed = new Promise<void>((resolve) =>
    stdin.once("close", resolve),
  );
  stdin.destroy();
  await inputClosed;

  expect(manager.status(started.value.session_id)?.state).toBe("closed");
  expect(
    (await manager.execute(started.value.session_id, "after-close")).ok,
  ).toBe(false);
});

it.each([
  ["throws an Error", "error"],
  ["throws a non-Error value", "non-error"],
  ["reports a callback write error", "callback"],
] as const)(
  "handles stdin write failure when the fake writer %s",
  async (_label, failure) => {
    const fake = createFakeSpawner();
    const manager = managerWithFakeSpawner(fake.spawnProcess);
    const started = await expectGdbSessionStarted(manager);
    const stdin = fake.children[0]?.stdin;
    expect(stdin).toBeDefined();
    if (stdin === null || stdin === undefined) return;
    const originalWrite = stdin.write.bind(stdin);
    Object.defineProperty(stdin, "write", {
      value: (...arguments_: unknown[]) => {
        const payload = String(arguments_[0]);
        if (!payload.includes("-interpreter-exec"))
          return Reflect.apply(originalWrite, stdin, arguments_);
        if (failure === "callback") {
          const callback = arguments_[2] as
            | ((error?: Error | null) => void)
            | undefined;
          queueMicrotask(() =>
            callback?.(new Error("simulated callback error")),
          );
          return true;
        }
        if (failure === "error") throw new Error("simulated write error");
        throw "unstructured write failure";
      },
    });

    const failed = await manager.execute(started.value.session_id, "will-fail");

    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error._tag).toBe("AnalysisCapabilityUnavailableError");
      expect(failed.error.message).toContain(
        failure === "callback"
          ? "simulated callback error"
          : failure === "error"
            ? "simulated write error"
            : "unknown error",
      );
    }
  },
);

it("does not issue a command after an exit wins the startup prompt race", async () => {
  const fake = createFakeSpawner(undefined, { exitOnFirstStdoutData: true });
  const manager = managerWithFakeSpawner(fake.spawnProcess);

  const started = await manager.start();

  expect(started.ok).toBe(false);
  if (!started.ok)
    expect(started.error._tag).toBe("AnalysisCapabilityUnavailableError");
});

it("rejects the command queued behind a timed-out GDB request", async () => {
  const fake = createFakeSpawner((_child, _token, command) => {
    if (command.includes("auto-load off"))
      fake.children[0]?.stdout.write(`${_token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    commandTimeoutMs: 25,
  });
  const started = await expectGdbSessionStarted(manager);

  const first = manager.execute(started.value.session_id, "stall");
  const queued = manager.execute(started.value.session_id, "after-timeout");
  const firstResult = await first;
  expect(firstResult.ok).toBe(false);
  if (!firstResult.ok)
    expect(firstResult.error._tag).toBe("AnalysisCapabilityUnavailableError");
  const rejected = await queued;

  expect(rejected.ok).toBe(false);
  if (!rejected.ok) expect(rejected.error._tag).toBe("AnalysisInputError");
});

it("waits for the prior command and preserves cancellation and queue failures", async () => {
  const resolved = Promise.resolve();
  expect(waitForGdbCommandTurn(resolved)).toBe(resolved);

  const preAborted = new AbortController();
  preAborted.abort();
  await expect(
    waitForGdbCommandTurn(Promise.resolve(), preAborted.signal),
  ).rejects.toMatchObject({ _tag: "AnalysisCancelledError" });

  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const cancelledWait = waitForGdbCommandTurn(pending, controller.signal);
  controller.abort();
  await expect(cancelledWait).rejects.toMatchObject({
    _tag: "AnalysisCancelledError",
  });
  release();

  const queueFailure = new Error("previous command queue failed");
  await expect(
    waitForGdbCommandTurn(
      Promise.reject(queueFailure),
      new AbortController().signal,
    ),
  ).rejects.toBe(queueFailure);
});

it("correlates command output records and reports invalid or cancelled requests", async () => {
  const manager = await managerFor(
    responsiveProvider(`
      if (match[2].includes('auto-load off')) process.stdout.write(match[1] + '^done\\n');
      else {
        process.stdout.write('=thread-created,id="1"\\n');
        process.stdout.write('~"console\\n"\\n@"target\\n"\\n&"log\\n"\\n');
        process.stdout.write(match[1] + '^running\\n');
      }
    `),
  );
  expect((await manager.execute("missing", "info registers")).ok).toBe(false);
  expect((await manager.close("missing")).ok).toBe(false);

  const started = await expectGdbSessionStarted(manager);
  const result = await manager.execute(
    started.value.session_id,
    "info registers",
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.result).toMatchObject({
      mi: expect.stringMatching(/\^running/u),
      console: '~"console',
      target: '@"target',
      log: '&"log',
    });
  }
  const signalled = await manager.execute(
    started.value.session_id,
    "info registers",
    new AbortController().signal,
  );
  expect(signalled.ok).toBe(true);
  const cancelled = new AbortController();
  cancelled.abort();
  const rejected = await manager.execute(
    started.value.session_id,
    "info registers",
    cancelled.signal,
  );
  expect(rejected.ok).toBe(false);
  if (!rejected.ok) expect(rejected.error._tag).toBe("AnalysisCancelledError");
  const closed = await manager.close(started.value.session_id);
  expect(closed.ok).toBe(false);
  expect(manager.status(started.value.session_id)).toBeDefined();
});

it("refuses to close a session while GDB reports a live target", async () => {
  const manager = await managerFor(
    responsiveProvider(`
      if (match[2].includes('auto-load off')) process.stdout.write(match[1] + '^done\\n');
      else if (match[2].includes('list-thread-groups')) process.stdout.write(match[1] + '^done,groups=[{id="i1",pid="123"}]\\n');
      else process.stdout.write(match[1] + '^done\\n');
    `),
  );
  const started = await expectGdbSessionStarted(manager);

  const closed = await manager.close(started.value.session_id);

  expect(closed.ok).toBe(false);
  if (!closed.ok)
    expect(JSON.stringify(closed.error)).toContain(
      "Live GDB thread groups remain",
    );
});

it("detaches a live inferior before the shared stop helper signals GDB", async () => {
  const tty = "/dev/pts/42";
  const commands: string[] = [];
  let detached = false;
  const fake = createFakeSpawner((_child, token, command) => {
    commands.push(command);
    if (command.includes("inferior-tty-show"))
      fake.children[0]?.stdout.write(
        `${token}^done,inferior_tty_terminal=${JSON.stringify(tty)}\n`,
      );
    else if (command.includes("list-thread-groups"))
      fake.children[0]?.stdout.write(
        detached
          ? `${token}^done,groups=[]\n`
          : `${token}^done,groups=[{id="i1",pid="123"}]\n`,
      );
    else {
      if (command.includes("target-detach")) detached = true;
      fake.children[0]?.stdout.write(`${token}^done\n`);
    }
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await manager.start(undefined, { inferiorTty: tty });
  expect(started.ok).toBe(true);
  if (!started.ok) return;

  const closed = await manager.close(started.value.session_id);

  expect(closed).toMatchObject({
    ok: true,
    value: { target_state: "unknown" },
  });
  expect(commands).toContain("-list-thread-groups --recurse 1");
  expect(commands).toContain("-target-detach");
  expect(
    commands.filter((command) => command.includes("target-detach")),
  ).toHaveLength(1);
  expect(commands).not.toContain("-gdb-exit");
  expect(commands.indexOf("-inferior-tty-show")).toBeLessThan(
    commands.indexOf("-target-detach"),
  );
  expect(fake.children[0]?.killSignals).toEqual(["SIGTERM"]);
});

it("revokes the verified sink after an abbreviated with inferior-tty run command", async () => {
  const tty = "/dev/pts/42";
  const commands: string[] = [];
  const fake = createFakeSpawner((_child, token, command) => {
    commands.push(command);
    if (command.includes("inferior-tty-show"))
      fake.children[0]?.stdout.write(
        `${token}^done,inferior_tty_terminal=${JSON.stringify(tty)}\n`,
      );
    else if (command.includes("list-thread-groups"))
      fake.children[0]?.stdout.write(
        `${token}^done,groups=[{id="i1",pid="123"}]\n`,
      );
    else fake.children[0]?.stdout.write(`${token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await manager.start(undefined, { inferiorTty: tty });
  expect(started.ok).toBe(true);
  if (!started.ok) return;

  const overridden = await manager.execute(
    started.value.session_id,
    "with inferior-t /tmp/other-output -- run",
  );

  expect(overridden.ok).toBe(true);
  expect(manager.status(started.value.session_id)).toMatchObject({
    inferior_tty: tty,
    inferior_tty_verified: false,
  });
  const closed = await manager.close(started.value.session_id);
  expect(closed.ok).toBe(false);
  expect(commands).not.toContain("-target-detach");
  expect(manager.status(started.value.session_id)).toBeDefined();
});

it("permanently revokes automatic detach after an abbreviated TTY change and restore", async () => {
  const tty = "/dev/pts/42";
  const { manager, sessionId, commands } =
    await startWithVerifiedInferiorTty(tty);
  await manager.execute(sessionId, "set pagination off");
  expect(manager.status(sessionId)?.inferior_tty_verified).toBe(true);
  await manager.execute(sessionId, "set inferior-t /tmp/other");
  await manager.execute(sessionId, `set inferior-t ${tty}`);
  await manager.execute(sessionId, "start");
  expect(manager.status(sessionId)?.inferior_tty_verified).toBe(false);
  const closed = await manager.close(sessionId);
  expect(closed.ok).toBe(false);
  expect(commands).not.toContain("-target-detach");
});

it("revokes detach proof for redirection attached to a run argument", async () => {
  const tty = "/dev/pts/42";
  const { manager, sessionId, commands } =
    await startWithVerifiedInferiorTty(tty);

  await manager.execute(sessionId, "start arg>/dev/null");

  expect(manager.status(sessionId)?.inferior_tty_verified).toBe(false);
  const closed = await manager.close(sessionId);
  expect(closed.ok).toBe(false);
  expect(commands).not.toContain("-target-detach");
});

it("revokes detach proof for a GDB Python abbreviation that changes inferior TTY", async () => {
  const tty = "/dev/pts/42";
  const { manager, sessionId, commands } =
    await startWithVerifiedInferiorTty(tty);

  await manager.execute(
    sessionId,
    'py gdb.execute("set " + chr(45).join(["inferior", "tty"]) + " /dev/null")',
  );

  expect(manager.status(sessionId)?.inferior_tty_verified).toBe(false);
  const closed = await manager.close(sessionId);
  expect(closed.ok).toBe(false);
  expect(commands).not.toContain("-target-detach");
});

it.each([
  ["TTY", "tt /tmp/gdb-alternate-inferior-output"],
  ["run", "ru > /tmp/gdb-alternate-inferior-output"],
])(
  "revokes detach proof for an abbreviated %s command that changes output",
  async (_operation, command) => {
    const { manager, sessionId, commands } =
      await startWithVerifiedInferiorTty("/dev/pts/42");

    await manager.execute(sessionId, command);

    expect(manager.status(sessionId)?.inferior_tty_verified).toBe(false);
    const closed = await manager.close(sessionId);
    expect(closed.ok).toBe(false);
    expect(commands).not.toContain("-target-detach");
  },
);

it.each(["with", "wit"])(
  "revokes detach proof for a Python alias nested in GDB %s command",
  async (withCommand) => {
    const tty = "/dev/pts/42";
    const { manager, sessionId, commands } =
      await startWithVerifiedInferiorTty(tty);

    await manager.execute(
      sessionId,
      `${withCommand} confirm off -- py gdb.execute("set " + chr(45).join(["inferior", "tty"]) + " /dev/null")`,
    );

    expect(manager.status(sessionId)?.inferior_tty_verified).toBe(false);
    const closed = await manager.close(sessionId);
    expect(closed.ok).toBe(false);
    expect(commands).not.toContain("-target-detach");
  },
);

it("does not detach a live inferior when no durable TTY was selected", async () => {
  const responder = recordingInferiorListResponder('[{id="i1",pid="123"}]');
  const fake = createFakeSpawner(responder.respond);
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);

  await expect(manager.closeAll()).rejects.toMatchObject({
    errors: [
      expect.objectContaining({
        message: expect.stringMatching(/durable output sink/i),
      }),
    ],
  });

  expect(responder.commands).not.toContain("-target-detach");
  expect(responder.commands).not.toContain("-gdb-exit");
  expect(manager.status(started.value.session_id)).toBeDefined();
  expect(fake.children[0]?.killSignals).toEqual([]);
});

it("retains ownership without signaling when recursive MI reports multiple inferiors", async () => {
  const responder = recordingInferiorListResponder(
    '[{id="i1",pid="123"},{id="i2",pid="456"}]',
  );
  const fake = createFakeSpawner(responder.respond);
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);

  await expect(manager.closeAll()).rejects.toMatchObject({
    errors: [
      expect.objectContaining({
        message: expect.stringMatching(/multiple inferiors/iu),
      }),
    ],
  });

  expect(responder.commands).toContain("-list-thread-groups --recurse 1");
  expect(responder.commands).not.toContain("-target-detach");
  expect(manager.status(started.value.session_id)).toBeDefined();
  expect(fake.children[0]?.killSignals).toEqual([]);
});

it("confirms no inferior before the shared stop helper signals GDB", async () => {
  const fake = createFakeSpawner();
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);

  const closed = await manager.close(started.value.session_id);

  expect(closed).toMatchObject({
    ok: true,
    value: { target_state: "none_observed" },
  });
  expect(fake.children[0]?.killSignals).toEqual(["SIGTERM"]);
});

it("retains ownership when manual close receives a truncated empty inferior list", async () => {
  const commands: string[] = [];
  const fake = createFakeSpawner((_child, token, command) => {
    commands.push(command);
    if (command.includes("auto-load off")) {
      fake.children[0]?.stdout.write(`${token}^done\n`);
      return;
    }
    if (command.includes("list-thread-groups")) {
      const child = fake.children[0];
      if (child === undefined) return;
      // Keep each MI record below the per-line ceiling while exceeding the
      // per-command byte budget before the apparently empty result arrives.
      for (let index = 0; index < 17; index += 1)
        child.stdout.write(`~"${"x".repeat(1_000_000)}"\n`);
      child.stdout.write(`${token}^done,groups=[]\n`);
      return;
    }
    fake.children[0]?.stdout.write(`${token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);

  const closed = await manager.close(started.value.session_id);

  expect(closed.ok).toBe(false);
  expect(commands).toContain("-list-thread-groups --recurse 1");
  expect(commands).not.toContain("-gdb-exit");
  expect(commands).not.toContain("-target-detach");
  expect(manager.status(started.value.session_id)).toBeDefined();
  expect(fake.children[0]?.killSignals).toEqual([]);
});

it("retains ownership and sends no signal when MI state is saturated or unknown", async () => {
  const fake = createFakeSpawner((_child, token, command) => {
    if (command.includes("auto-load off"))
      fake.children[0]?.stdout.write(`${token}^done\n`);
    else if (command.includes("list-thread-groups"))
      fake.children[0]?.stdout.write(`${token}^error,msg="unknown"\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    commandTimeoutMs: 20,
  });
  const started = await expectGdbSessionStarted(manager);

  const timedOut = await manager.execute(started.value.session_id, "saturated");
  expect(timedOut.ok).toBe(false);
  await expect(manager.closeAll()).rejects.toMatchObject({
    errors: [
      expect.objectContaining({
        message: expect.stringMatching(/inferior detach/i),
      }),
    ],
  });

  expect(manager.status(started.value.session_id)?.state).toBe("closed");
  expect(fake.children[0]?.killSignals).toEqual([]);
});

it("routes protocol failure cleanup through detach verification without direct signals", async () => {
  const fake = createFakeSpawner();
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);
  const child = fake.children[0];
  if (child?.stdin === null || child?.stdin === undefined) return;
  Object.defineProperty(child.stdin, "write", {
    value: (
      _chunk: string,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ): boolean => {
      callback(new Error("synthetic protocol failure"));
      return false;
    },
  });

  const failed = await manager.execute(started.value.session_id, "will-fail");
  expect(failed.ok).toBe(false);
  await new Promise((resolve) => setImmediate(resolve));
  expect(child.killSignals).toEqual([]);
});

it("retains ownership without signaling when detach confirmation fails", async () => {
  const fake = createFakeSpawner((_child, token, command) => {
    fake.children[0]?.stdout.write(
      command.includes("list-thread-groups")
        ? `${token}^error,msg="state unavailable"\n`
        : `${token}^done\n`,
    );
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);

  await expect(manager.closeAll()).rejects.toThrow(/did not stop cleanly/i);

  expect(manager.status(started.value.session_id)?.state).toBe("ready");
  expect(fake.children[0]?.killSignals).toEqual([]);
});

it("closes with unknown target state when MI cannot confirm thread groups", async () => {
  const manager = await managerFor(
    responsiveProvider(`
      if (match[2].includes('auto-load off')) process.stdout.write(match[1] + '^done\\n');
      else if (match[2].includes('list-thread-groups')) process.stdout.write(match[1] + '^error,msg="not supported"\\n');
      else process.stdout.write(match[1] + '^done\\n');
    `),
  );
  const started = await expectGdbSessionStarted(manager);
  const closed = await manager.close(started.value.session_id);
  expect(closed.ok).toBe(false);
  if (!closed.ok) {
    expect(closed.error.message).toContain("inferior state");
    expect(closed.error._tag).toBe("AnalysisCapabilityUnavailableError");
  }
  expect(manager.status(started.value.session_id)).toBeDefined();
});

it("closes an exited GDB session without a TTY after inherited output settles", async () => {
  const manager = await managerFor(
    responsiveProvider(`
      if (match[2].includes('auto-load off')) process.stdout.write(match[1] + '^done\\n');
      else process.stdout.write('~leaving\\n', () => process.exit(2));
    `),
  );
  const started = await expectGdbSessionStarted(manager);

  const executing = manager.execute(
    started.value.session_id,
    "exit during command",
  );
  const closing = manager.close(started.value.session_id);
  await expect(executing).resolves.toMatchObject({ ok: true });
  await expect(closing).resolves.toMatchObject({
    ok: true,
    value: { target_state: "unknown" },
  });
  expect(manager.status(started.value.session_id)).toBeUndefined();
});

it("closes an exited GDB session when close begins after inherited output settled", async () => {
  const manager = await managerFor(
    responsiveProvider(`
      if (match[2].includes('auto-load off')) process.stdout.write(match[1] + '^done\\n');
      else process.exit(3);
    `),
  );
  const started = await expectGdbSessionStarted(manager);

  await manager.execute(started.value.session_id, "exit now");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (manager.status(started.value.session_id)?.state === "closed") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(manager.status(started.value.session_id)?.state).toBe("closed");
  await expect(manager.close(started.value.session_id)).resolves.toMatchObject({
    ok: true,
    value: { target_state: "unknown" },
  });
  expect(manager.status(started.value.session_id)).toBeUndefined();
});

it("retains a session when closing cannot confirm the debugger process stopped", async () => {
  let stopCalls = 0;
  const provider = await createProvider(responsiveProvider());
  const manager = new GdbSessionManager({
    environment: { REA_GDB_COMMAND: provider },
    stopProcess: async (session, name) => {
      stopCalls += 1;
      if (stopCalls === 1)
        return { status: "incomplete", reason: "simulated close uncertainty" };
      return stopOwnedDebuggerProcess(session, name);
    },
  });
  managers.push(manager);
  const started = await expectGdbSessionStarted(manager);

  const closed = await manager.close(started.value.session_id);

  expect(closed.ok).toBe(false);
  if (!closed.ok)
    expect(closed.error.message).toContain("simulated close uncertainty");
  expect(manager.status(started.value.session_id)?.state).toBe("ready");
});

it("preserves a command timeout when stopping the owned process rejects", async () => {
  let stopCalls = 0;
  const provider = await createProvider(
    responsiveProvider(`
    if (match[2].includes('auto-load off')) process.stdout.write(match[1] + '^done\\n');
  `),
  );
  const manager = new GdbSessionManager({
    environment: { REA_GDB_COMMAND: provider },
    commandTimeoutMs: 25,
    stopProcess: async (session, name) => {
      stopCalls += 1;
      if (stopCalls === 1) throw new Error("simulated stop failure");
      return stopOwnedDebuggerProcess(session, name);
    },
  });
  managers.push(manager);
  const started = await expectGdbSessionStarted(manager);

  const timedOut = await manager.execute(started.value.session_id, "stall");

  expect(timedOut.ok).toBe(false);
  if (!timedOut.ok) {
    expect(timedOut.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(timedOut.error.message).toContain("shutdown failed");
  }
});

it("reports cancellation if owned-process stop rejects during an active command", async () => {
  const controller = new AbortController();
  let stopCalls = 0;
  const fake = createFakeSpawner((child, token, command) => {
    if (command.includes("auto-load off"))
      child.stdout.write(`${token}^done\n`);
    else controller.abort();
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    stopProcess: async (session, name) => {
      stopCalls += 1;
      if (stopCalls === 1) throw new Error("simulated stop rejection");
      return stopOwnedDebuggerProcess(session, name);
    },
  });
  const started = await expectGdbSessionStarted(manager);

  const cancelled = await manager.execute(
    started.value.session_id,
    "cancel me",
    controller.signal,
  );

  expect(cancelled.ok).toBe(false);
  if (!cancelled.ok)
    expect(cancelled.error._tag).toBe("AnalysisCancelledError");
  expect(stopCalls).toBe(1);
});

it("classifies timeout and unexpected failures raised while quoting console commands", async () => {
  const fake = createFakeSpawner();
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);

  const timeoutCommand = Object.assign(new String("timeout"), {
    replaceAll() {
      throw new AnalysisTimeoutError("test_command_quote", 17);
    },
  }) as unknown as string;
  const timeout = await manager.execute(
    started.value.session_id,
    timeoutCommand,
  );
  expect(timeout.ok).toBe(false);
  if (!timeout.ok) expect(timeout.error._tag).toBe("AnalysisTimeoutError");

  const unexpectedCommand = Object.assign(new String("unexpected"), {
    replaceAll() {
      throw new Error("command quoting failed");
    },
  }) as unknown as string;
  const unexpected = await manager.execute(
    started.value.session_id,
    unexpectedCommand,
  );
  expect(unexpected.ok).toBe(false);
  if (!unexpected.ok)
    expect(unexpected.error._tag).toBe("AnalysisTimeoutError");
});

it("marks retained exit output as truncated when command records exceed the byte cap", async () => {
  const manager = await managerFor(`
process.stdout.write('(gdb)\\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  for (;;) {
    const end = input.indexOf('\\n');
    if (end < 0) break;
    const line = input.slice(0, end); input = input.slice(end + 1);
    const match = /^(\\d+)(.*)/.exec(line);
    if (!match) continue;
    if (match[2].includes('auto-load off')) process.stdout.write(match[1] + '^done\\n');
    else {
      const record = 'x'.repeat(6 * 1024 * 1024);
      process.stdout.write('~' + record + '\\n~' + record + '\\n~' + record + '\\n', () => process.exit(7));
    }
  }
});
`);
  const started = await expectGdbSessionStarted(manager);

  const exited = await manager.execute(started.value.session_id, "large exit");

  expect(exited.ok).toBe(true);
  if (exited.ok) {
    expect(exited.value.result).toMatchObject({
      process_exit_observed: true,
      output_truncated: true,
      completion_status: "unknown",
    });
    expect(exited.value.evidence.limitations.join(" ")).toContain(
      "truncated prefix",
    );
  }
});

it("retains split MI records while bounding recent and command output", async () => {
  const manager = await managerFor(`
process.stdout.write('(gdb)\\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  for (;;) {
    const end = input.indexOf('\\n');
    if (end < 0) break;
    const line = input.slice(0, end); input = input.slice(end + 1);
    const match = /^(\\d+)(.*)/.exec(line);
    if (!match) continue;
    if (match[2].includes('auto-load off')) process.stdout.write(match[1] + '^done\\n');
    else {
      process.stdout.write('=split-record');
      setTimeout(() => {
        process.stdout.write('\\n999^done\\n=unmatched-token\\n' + 'x'.repeat(70_000) + '\\n');
        const largeRecord = 'a'.repeat(6 * 1024 * 1024);
        process.stdout.write('~' + largeRecord + '\\n~' + largeRecord + '\\n~' + largeRecord + '\\n');
        process.stdout.write(match[1] + '^done\\n');
      }, 5);
    }
  }
});

`);
  const started = await expectGdbSessionStarted(manager);

  const result = await manager.execute(
    started.value.session_id,
    "large-output",
  );

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.result.output_truncated).toBe(true);
    expect(result.value.result.records).toHaveLength(7);
  }
  expect(
    manager.status(started.value.session_id)?.recent_mi_records_truncated,
  ).toBe(true);
});

it("truncates retained MI records on UTF-8 code point boundaries", async () => {
  const manager = await managerFor(`
process.stdout.write('(gdb)\\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  for (;;) {
    const end = input.indexOf('\\n');
    if (end < 0) break;
    const line = input.slice(0, end); input = input.slice(end + 1);
    const match = /^(\\d+)(.*)/.exec(line);
    if (!match) continue;
    if (match[2].includes('auto-load off')) process.stdout.write(match[1] + '^done\\n');
    else process.stdout.write('~' + '💩'.repeat(20_000) + '\\n' + match[1] + '^done\\n');
  }
});
`);
  const started = await expectGdbSessionStarted(manager);
  await manager.execute(started.value.session_id, "large unicode output");

  const retained = manager
    .status(started.value.session_id)
    ?.recent_mi_records.find((record) => record.startsWith("~"));
  expect(retained).toBeDefined();
  if (retained !== undefined) {
    expect(Buffer.byteLength(retained, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(retained).not.toContain("�");
    expect(retained.endsWith("[recent record truncated]")).toBe(true);
  }
});

it("stops the GDB session when a complete MI record exceeds the protocol limit", async () => {
  const manager = await managerFor(`
process.stdout.write('(gdb)\\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  for (;;) {
    const end = input.indexOf('\\n');
    if (end < 0) break;
    const line = input.slice(0, end); input = input.slice(end + 1);
    const match = /^(\\d+)(.*)/.exec(line);
    if (!match) continue;
    if (match[2].includes('auto-load off')) process.stdout.write(match[1] + '^done\\n');
    else process.stdout.write('x'.repeat(16 * 1024 * 1024 + 1) + '\\n');
  }
});
`);
  const started = await expectGdbSessionStarted(manager);

  const failed = await manager.execute(started.value.session_id, "bad-record");

  expect(failed.ok).toBe(false);
  if (!failed.ok)
    expect(failed.error._tag).toBe("AnalysisCapabilityUnavailableError");
});

it("rejects a partial MI line that exceeds the protocol limit", async () => {
  const manager = await managerFor(`
process.stdout.write('(gdb)\\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  for (;;) {
    const end = input.indexOf('\\n');
    if (end < 0) break;
    const line = input.slice(0, end); input = input.slice(end + 1);
    const match = /^(\\d+)(.*)/.exec(line);
    if (!match) continue;
    if (match[2].includes('auto-load off')) process.stdout.write(match[1] + '^done\\n');
    else process.stdout.write('x'.repeat(16 * 1024 * 1024 + 1));
  }
});
`);
  const started = await expectGdbSessionStarted(manager);

  const failed = await manager.execute(
    started.value.session_id,
    "partial-line",
  );

  expect(failed.ok).toBe(false);
  if (!failed.ok)
    expect(failed.error._tag).toBe("AnalysisCapabilityUnavailableError");
});

it("caps the number of MI records retained for a single command", async () => {
  const recordCount = 16_385;
  const manager = await managerFor(`
process.stdout.write('(gdb)\\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  for (;;) {
    const end = input.indexOf('\\n');
    if (end < 0) break;
    const line = input.slice(0, end); input = input.slice(end + 1);
    const match = /^(\\d+)(.*)/.exec(line);
    if (!match) continue;
    if (match[2].includes('auto-load off')) process.stdout.write(match[1] + '^done\\n');
    else process.stdout.write(Array.from({ length: ${recordCount} }, () => '~"x"').join('\\n') + '\\n' + match[1] + '^done\\n');
  }
});
`);
  const started = await expectGdbSessionStarted(manager);

  const result = await manager.execute(
    started.value.session_id,
    "many-records",
  );

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.result.records).toHaveLength(16_384);
    expect(result.value.result.output_truncated).toBe(true);
  }
});

it("completes an MI record split after a chunk without a newline", async () => {
  const fake = createFakeSpawner((child, token, command) => {
    if (command.includes("auto-load off")) {
      child.stdout.write(`${token}^done\n`);
      return;
    }
    child.stdout.write("=thread-created");
    setImmediate(() => child.stdout.write(`,id="1"\n${token}^done\n`));
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);

  const result = await manager.execute(started.value.session_id, "thread-info");

  expect(result.ok).toBe(true);
  if (result.ok)
    expect(result.value.result.records).toContain('=thread-created,id="1"');
});

it("preserves the protocol failure when an incomplete stop adds uncertainty", async () => {
  let stopCalls = 0;
  const fake = createFakeSpawner();
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    stopProcess: async (session, name) => {
      stopCalls += 1;
      if (stopCalls === 1) {
        return {
          status: "incomplete",
          reason: "simulated protocol stop uncertainty",
        };
      }
      return stopOwnedDebuggerProcess(session, name);
    },
  });
  const started = await expectGdbSessionStarted(manager);
  const stdin = fake.children[0]?.stdin;
  if (stdin === null || stdin === undefined) return;
  Object.defineProperty(stdin, "write", {
    value: (
      _chunk: string,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ): boolean => {
      fake.children[0]?.stdout.write('~"protocol output before failure"\n');
      callback(new Error("simulated protocol write failure"));
      return false;
    },
  });

  const failed = await manager.execute(started.value.session_id, "will-fail");

  expect(failed.ok).toBe(false);
  if (!failed.ok) {
    expect(failed.error.message).toContain(
      "GDB stdin write failed: simulated protocol write failure",
    );
    expect(failed.error.message).toContain(
      "simulated protocol stop uncertainty",
    );
    expect(failed.error.cleanup).toEqual({
      reason: "simulated protocol stop uncertainty",
      resources: [started.value.session_id],
    });
    expect(failed.error.partialObservation).toMatchObject({
      predicate_type: "rea.debugger.console-observation",
      raw_result: {
        records: ['~"protocol output before failure"'],
        completion_status: "unknown",
      },
    });
  }
  expect(manager.status(started.value.session_id)?.state).toBe("closed");
  const subsequent = await manager.execute(
    started.value.session_id,
    "must-not-run",
  );
  expect(subsequent).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
});

it("drains buffered startup stdout before capturing early-exit Evidence", async () => {
  const children: FakeGdbProcess[] = [];
  const manager = new GdbSessionManager({
    environment: {},
    startupTimeoutMs: 500,
    spawnProcess: async (options) => {
      const child = new FakeGdbProcess();
      children.push(child);
      setImmediate(() => {
        child.exitLeader(7);
        setImmediate(() => {
          child.stdout.write('~"late startup record"\n');
          child.closeInheritedOutput();
        });
      });
      return {
        process: child,
        ownership: {
          runId: options.runId,
          leaderPid: child.pid,
          processGroupId: child.pid,
          expectedParentPid: process.pid,
        },
      };
    },
  });
  managers.push(manager);

  const started = await manager.start();

  expect(started.ok).toBe(false);
  expect(children).toHaveLength(2);
  if (!started.ok)
    expect(started.error.partialObservation).toMatchObject({
      raw_result: {
        process_exit_code: 7,
        records: ['~"late startup record"'],
        completion_status: "unknown",
      },
    });
});

it("reports command timeout when an incomplete stop cannot confirm process exit", async () => {
  let stopCalls = 0;
  const fake = createFakeSpawner((_child, _token, command) => {
    if (!command.includes("auto-load off")) return;
    fake.children[0]?.stdout.write(`${_token}^done\n`);
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess, {
    commandTimeoutMs: 20,
    stopProcess: async (session, name) => {
      stopCalls += 1;
      if (stopCalls === 1)
        return {
          status: "incomplete",
          reason: "simulated timeout stop uncertainty",
        };
      return stopOwnedDebuggerProcess(session, name);
    },
  });
  const started = await expectGdbSessionStarted(manager);

  const failed = await manager.execute(started.value.session_id, "stall");

  expect(failed.ok).toBe(false);
  if (!failed.ok) {
    expect(failed.error._tag).toBe("AnalysisCapabilityUnavailableError");
    expect(failed.error.message).toContain(
      "simulated timeout stop uncertainty",
    );
  }
});

it.each(["cancel", "timeout"] as const)(
  "retries safe cleanup only after the interrupted token settles (%s)",
  async (interruption) => {
    const tty = "/dev/pts/42";
    const commands: string[] = [];
    let heldToken = "";
    let detached = false;
    let dispatched!: () => void;
    const commandDispatched = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    const fake = createFakeSpawner((child, token, command) => {
      commands.push(command);
      if (command.includes("held command")) {
        heldToken = token;
        dispatched();
        return;
      }
      if (command.includes("target-detach")) detached = true;
      const response = command.includes("inferior-tty-show")
        ? `^done,inferior_tty_terminal=${JSON.stringify(tty)}`
        : command.includes("list-thread-groups")
          ? detached
            ? "^done,groups=[]"
            : '^done,groups=[{id="i1",pid="123"}]'
          : "^done";
      child.stdout.write(`${token}${response}\n`);
    });
    const manager = managerWithFakeSpawner(fake.spawnProcess, {
      commandTimeoutMs: 200,
    });
    const started = await manager.start(undefined, { inferiorTty: tty });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const controller = new AbortController();
    const executing = manager.execute(
      started.value.session_id,
      "held command",
      controller.signal,
    );
    await commandDispatched;
    if (interruption === "cancel") controller.abort();
    const failed = await executing;
    expect(failed).toMatchObject({
      ok: false,
      error: { cleanupIncomplete: true },
    });
    const beforeCleanup = commands.length;
    expect((await manager.close(started.value.session_id)).ok).toBe(false);
    expect(commands).toHaveLength(beforeCleanup);
    expect(fake.children[0]?.killSignals).toEqual([]);
    fake.children[0]?.stdout.write("999999^done\n");
    expect((await manager.close(started.value.session_id)).ok).toBe(false);
    expect(commands).toHaveLength(beforeCleanup);
    fake.children[0]?.stdout.write(`${heldToken}^done\n`);
    expect(
      (await manager.execute(started.value.session_id, "must not run")).ok,
    ).toBe(false);
    const closed = await manager.close(started.value.session_id);
    expect(closed.ok).toBe(true);
    expect(
      commands.filter((command) => command.includes("target-detach")),
    ).toHaveLength(1);
    expect(fake.children[0]?.killSignals).toEqual(["SIGTERM"]);
    expect(manager.status(started.value.session_id)).toBeUndefined();
    if (!failed.ok) expect(failed.error.cleanupIncomplete).toBe(false);
  },
);

it("contains stdout errors as owned protocol failures with partial evidence", async () => {
  let dispatched!: () => void;
  const commandDispatched = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  const fake = createFakeSpawner((child, token, command) => {
    if (command.includes("held command")) {
      child.stdout.write('~"retained before read failure"\n');
      dispatched();
    } else
      child.stdout.write(
        command.includes("list-thread-groups")
          ? `${token}^done,groups=[]\n`
          : `${token}^done\n`,
      );
  });
  const manager = managerWithFakeSpawner(fake.spawnProcess);
  const started = await expectGdbSessionStarted(manager);
  const executing = manager.execute(started.value.session_id, "held command");
  await commandDispatched;
  const child = fake.children[0];
  if (child === undefined) throw new Error("Missing fake GDB process");
  expect(() =>
    child.stdout.emit("error", new Error("simulated read failure")),
  ).not.toThrow();
  const failed = await executing;
  expect(failed).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCapabilityUnavailableError",
      cleanupIncomplete: true,
      partialObservation: {
        raw_result: { records: ['~"retained before read failure"'] },
      },
    },
  });
  if (!failed.ok)
    expect(failed.error.message).toContain(
      "GDB stdout stream failed: simulated read failure",
    );
  expect(manager.status(started.value.session_id)?.state).toBe("closed");
  child.exit(0, null);
  expect((await manager.close(started.value.session_id)).ok).toBe(true);
});
