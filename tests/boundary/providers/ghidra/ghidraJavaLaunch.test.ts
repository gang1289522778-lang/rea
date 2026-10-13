import { mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { createGhidraTestRuntime } from "../../../fixtures/ghidraRuntime.js";
import { createGhidraDiagnostics } from "../../../../src/ghidra/GhidraDiagnostics.js";
import {
  GhidraHeadlessLauncher,
  GhidraLaunchError,
  GHIDRA_LAUNCH_COMMAND_OUTPUT_BYTES,
  type GhidraLaunchSession,
} from "../../../../src/ghidra/GhidraLauncher.js";
import { bindGhidraSessionFailure } from "../../../../src/ghidra/GhidraSessionError.js";
import { spawnOwnedProviderProcess } from "../../../../src/process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../../../../src/process/ProcessOwnership.js";
import { waitForAbortableDelay } from "../../../../src/process/ProviderDeadline.js";
import { GhidraProvider } from "../../../../src/ghidra/GhidraProvider.js";
import { GhidraClient } from "../../../../src/ghidra/GhidraClient.js";
import { parseConfig } from "../../../../src/config/parseConfig.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import { analysisErrorProjectionSchema } from "../../../../src/contracts/errorSchemas.js";
import type { BinaryTarget } from "../../../../src/domain/binaryTargetTypes.js";
import { elf } from "../../../../src/domain/binaryTarget.fixture.js";
import { silentLogger } from "../../../../src/logger.js";
import { GHIDRA_LAUNCH_SUPPORT_OUTPUT_BYTES } from "../../../../src/ghidra/GhidraJavaLaunch.js";

const warning =
  "[0.004s][warning][os,container] Cgroup limits may be inaccurate: /tmp/password-fixture?token=public-value";

const fixture = async (
  mode: string,
  javaVmName: string | null = "OpenJDK 64-Bit Server VM",
) => {
  const root = await createTestTempDirectory("rea-ghidra-java-launch-");
  const runtime = await createGhidraTestRuntime(root);
  onTestFinished(() => runtime.close());
  const javaHome = join(root, "jdk");
  await mkdir(join(javaHome, "bin"), { recursive: true });
  const probeScript = join(root, "probe.cjs");
  await writeFile(
    probeScript,
    `
const args = process.argv.slice(2);
const probe = args.at(-1);
if (probe !== "-envvars" && probe !== "-vmargs") process.exit(64);
const mode = ${JSON.stringify(mode)};
if (mode === "overflow-" + probe + "-stdout" || mode === "overflow-" + probe + "-stderr") {
  const stream = mode.endsWith("-stdout") ? process.stdout : process.stderr;
  stream.write("x".repeat(${GHIDRA_LAUNCH_SUPPORT_OUTPUT_BYTES + 1}));
  setInterval(() => {}, 1000);
  return;
}
if (mode === "cancel-" + probe || mode === "cleanup-failure-" + probe || mode === "timeout-" + probe) {
  setInterval(() => {}, 1000);
  return;
}
if (mode === "non-hotspot" && args.some(arg => arg.startsWith("-Xlog:"))) process.exit(65);
const warning = ${JSON.stringify(warning)};
const stream = args.includes("-Xlog:disable") && args.includes("-Xlog:all=warning:stderr") ? process.stderr : process.stdout;
if (mode !== "quiet" && mode !== "non-hotspot") stream.write(probe + ": " + warning + "\\n");
if (mode === "credential") stream.write("explicit credential: private-transport-token\\n");
if (mode === "large") stream.write("é".repeat(${GHIDRA_LAUNCH_COMMAND_OUTPUT_BYTES}) + "UNRETAINED-TAIL\\n");
if (mode === "env-failure" || (probe === "-vmargs" && mode === "vm-failure")) {
  process.stderr.write("failed " + probe + "\\n");
  process.exitCode = 3;
} else if (probe === "-envvars") {
  process.stdout.write(mode === "env-malformed" ? "invalid environment\\n" : "GHIDRA_MAXMEM=1G\\n");
} else {
  process.stdout.write(mode === "vm-malformed" ? "invalid JVM argument\\n" : "-Dfile.encoding=UTF8\\n");
}
`,
    { mode: 0o755 },
  );
  const session: GhidraLaunchSession = {
    runtimeRoot: runtime.path,
    transport: "unix-socket",
    endpointPath: join(root, "endpoint.sock"),
    token: "private-transport-token",
    runId: randomUUID(),
    targetPath: join(root, "target.bin"),
    targetSha256: "0".repeat(64),
    providerVersion: "test",
    profileDigest: "test",
  };
  const analysisArguments: (readonly string[])[] = [];
  const probePids: number[] = [];
  const controller = new AbortController();
  let cleanupAllowed = false;
  const launcher = new GhidraHeadlessLauncher({
    environment: process.env,
    platform: process.platform,
    javaHome,
    ...(javaVmName === null ? {} : { javaVmName }),
    analyzeHeadlessPath: join(root, "ghidra", "support", "analyzeHeadless"),
    bridgeScriptPath: join(root, "ReaGhidraBridge.java"),
    spawnProbe: async (options) => {
      const spawned = await spawnOwnedProviderProcess({
        ...options,
        command: process.execPath,
        arguments: [probeScript, ...options.arguments],
        expectedCommand: process.execPath,
      });
      if (spawned.process.pid === undefined)
        throw new Error("Missing probe PID");
      probePids.push(spawned.process.pid);
      const probe = options.arguments.at(-1);
      if (mode === `cancel-${probe}` || mode === `cleanup-failure-${probe}`)
        setImmediate(() => controller.abort());
      if (mode === `cleanup-failure-${probe}`) {
        const cleanup = () =>
          spawned.cleanup === undefined
            ? cleanupOwnedProcessGroup(spawned.ownership)
            : spawned.cleanup();
        onTestFinished(async () => {
          expect((await cleanup()).cleaned).toBe(true);
        });
        return {
          ...spawned,
          cleanup: async () =>
            cleanupAllowed
              ? cleanup()
              : {
                  cleaned: false as const,
                  reason: "fixture blocks cleanup verification",
                },
        };
      }
      return spawned;
    },
    spawnProcess: async (options) => {
      analysisArguments.push(options.arguments);
      const spawned = await spawnOwnedProviderProcess({
        ...options,
        command: process.execPath,
        arguments: ["-e", "setInterval(() => {}, 1000)"],
        expectedCommand: process.execPath,
      });
      onTestFinished(async () => {
        const cleanup =
          spawned.cleanup === undefined
            ? await cleanupOwnedProcessGroup(spawned.ownership)
            : await spawned.cleanup();
        expect(cleanup.cleaned).toBe(true);
      });
      if (mode === "cancel-after-spawn") controller.abort();
      if (mode === "timeout-after-spawn")
        await waitForAbortableDelay(10_000, options.signal);
      return spawned;
    },
  });
  return {
    session,
    launcher,
    analysisArguments,
    controller,
    probePids,
    releaseCleanup: () => {
      cleanupAllowed = true;
    },
  };
};

describe("Ghidra LaunchSupport JVM compatibility", () => {
  it.each(["Eclipse OpenJ9 VM", "unrecognized VM", ""])(
    "keeps HotSpot-only flags off a VM identified as %s",
    async (javaVmName) => {
      const { session, launcher, analysisArguments } = await fixture(
        "non-hotspot",
        javaVmName === "" ? null : javaVmName,
      );
      const launched = await launcher.launch(session);
      if (!launched.ok) throw launched.error;
      expect(analysisArguments).toHaveLength(1);
      expect(launched.value.launchSupport).toBeUndefined();
    },
  );

  it.each([
    "OpenJDK 64-Bit Server VM",
    "Java HotSpot(TM) 64-Bit Server VM",
    "OpenJDK 64-Bit Zero VM",
  ])(
    "preserves redirected warnings for %s while keeping the analysis JVM arguments clean",
    async (javaVmName) => {
      const { session, launcher, analysisArguments } = await fixture(
        "success",
        javaVmName,
      );
      const launched = await launcher.launch(session);
      if (!launched.ok) throw launched.error;
      expect(analysisArguments[0]).toContain("-Dfile.encoding=UTF8");
      expect(analysisArguments[0]).toContain("-Xmx1G");
      expect(
        analysisArguments[0]?.some(
          (argument) =>
            argument.startsWith("-Xlog:") || argument.includes("[warning]"),
        ),
      ).toBe(false);
      const diagnostics = createGhidraDiagnostics({
        targetPath: session.targetPath,
        targetSha256: session.targetSha256,
        transport: session.transport,
        providerVersion: session.providerVersion,
        profileDigest: session.profileDigest,
        launch: launched.value,
        token: session.token,
        previous: {},
      });
      expect(diagnostics.launch_support).toEqual(
        ["-envvars", "-vmargs"].map((mode) => ({
          mode,
          stderr: `${mode}: ${warning}\n`,
          stderr_bytes: Buffer.byteLength(`${mode}: ${warning}\n`),
          stderr_truncated: false,
        })),
      );
    },
  );
});

describe("Ghidra LaunchSupport ownership and limits", () => {
  it.each(
    ["-envvars", "-vmargs"].flatMap((mode) =>
      ["stdout", "stderr"].map((stream) => [mode, stream] as const),
    ),
  )(
    "rejects oversized %s %s before analysis and verifies probe cleanup",
    async (mode, stream) => {
      const { session, launcher, analysisArguments, probePids } = await fixture(
        `overflow-${mode}-${stream}`,
      );
      const launched = await launcher.launch(session);
      expect(launched.ok).toBe(false);
      if (launched.ok) throw new Error("Expected output-limit failure");
      expect(analysisArguments).toEqual([]);
      const failure = bindGhidraSessionFailure(() => ({}))(
        "start",
        launched.error.message,
        launched.error,
      );
      expect(failure.diagnostics.failure_cause).toMatchObject({
        launch_outcome: {
          truncated: true,
          [`${stream}_bytes`]: expect.any(Number),
        },
      });
      if (!(launched.error instanceof GhidraLaunchError)) throw launched.error;
      const output = launched.error.capturedOutput;
      if (output === undefined)
        throw new Error("Missing bounded probe outcome");
      const observedBytes =
        stream === "stdout" ? output.stdout_bytes : output.stderr_bytes;
      expect(observedBytes).toBeGreaterThan(GHIDRA_LAUNCH_SUPPORT_OUTPUT_BYTES);
      expect(
        Buffer.byteLength(stream === "stdout" ? output.stdout : output.stderr),
      ).toBeLessThanOrEqual(GHIDRA_LAUNCH_SUPPORT_OUTPUT_BYTES);
      for (const pid of probePids) expect(() => process.kill(pid, 0)).toThrow();
    },
  );

  it.each(["-envvars", "-vmargs"])(
    "settles the owned %s probe before returning cancellation",
    async (mode) => {
      const { session, launcher, controller, probePids, analysisArguments } =
        await fixture(`cancel-${mode}`);
      const launched = await launcher.launch(session, {
        signal: controller.signal,
      });
      expect(launched.ok).toBe(false);
      expect(analysisArguments).toEqual([]);
      expect(probePids).toHaveLength(mode === "-envvars" ? 1 : 2);
      for (const pid of probePids) expect(() => process.kill(pid, 0)).toThrow();
    },
  );

  it.each(["-envvars", "-vmargs"])(
    "retains and retries incomplete %s cleanup after cancellation",
    async (mode) => {
      const {
        session,
        launcher,
        controller,
        probePids,
        releaseCleanup,
        analysisArguments,
      } = await fixture(`cleanup-failure-${mode}`);
      const launched = await launcher.launch(session, {
        signal: controller.signal,
      });
      if (launched.ok || !(launched.error instanceof GhidraLaunchError))
        throw new Error("Expected retained probe cleanup ownership");
      const partial = launched.error.partialLaunch;
      expect(partial?.process.pid).toBe(probePids.at(-1));
      expect(analysisArguments).toEqual([]);
      expect(await partial?.cleanup?.()).toMatchObject({ cleaned: false });
      releaseCleanup();
      expect(await partial?.cleanup?.()).toMatchObject({ cleaned: true });
      for (const pid of probePids) expect(() => process.kill(pid, 0)).toThrow();
    },
  );

  it.each(["-envvars", "-vmargs"])(
    "cleans up %s when its startup time expires",
    async (mode) => {
      const { session, launcher, probePids, analysisArguments } = await fixture(
        `timeout-${mode}`,
      );
      const launched = await launcher.launch(session, { timeoutMs: 1000 });
      if (launched.ok || !(launched.error instanceof GhidraLaunchError))
        throw new Error("Expected probe timeout");
      expect(launched.error.cause).toMatchObject({
        reason: "timeout",
        cleanupFailure: null,
      });
      expect(analysisArguments).toEqual([]);
      for (const pid of probePids) expect(() => process.kill(pid, 0)).toThrow();
    },
  );
});

describe("Ghidra LaunchSupport diagnostics", () => {
  it.each(["env-failure", "vm-failure", "env-malformed", "vm-malformed"])(
    "retains helper warnings through session failure diagnostics after %s",
    async (mode) => {
      const { session, launcher, analysisArguments } = await fixture(mode);
      const launched = await launcher.launch(session);
      expect(launched.ok).toBe(false);
      if (launched.ok) throw new Error("Expected a helper failure");
      expect(analysisArguments).toEqual([]);
      const failure = bindGhidraSessionFailure(() => ({}))(
        "start",
        launched.error.message,
        launched.error,
      );
      const cause = failure.diagnostics.failure_cause;
      if (mode === "env-failure") {
        expect(cause).toMatchObject({
          launch_outcome: {
            exit_code: 3,
            stderr: expect.stringContaining(`-envvars: ${warning}`),
          },
        });
      } else {
        expect(cause).toMatchObject({
          launch_support: expect.arrayContaining([
            expect.objectContaining({
              mode: "-envvars",
              stderr: `-envvars: ${warning}\n`,
            }),
          ]),
        });
      }
      if (mode === "vm-failure")
        expect(cause).toMatchObject({
          launch_outcome: {
            exit_code: 3,
            stderr: expect.stringContaining(`-vmargs: ${warning}`),
          },
        });
      if (mode === "vm-malformed")
        expect(cause).toMatchObject({
          launch_support: expect.arrayContaining([
            expect.objectContaining({
              mode: "-vmargs",
              stderr: `-vmargs: ${warning}\n`,
            }),
          ]),
        });
    },
  );

  it("bounds retained UTF-8 warnings and reports original byte counts", async () => {
    const { session, launcher } = await fixture("large");
    const launched = await launcher.launch(session);
    if (!launched.ok) throw launched.error;
    for (const output of launched.value.launchSupport ?? []) {
      expect(output.stderr_truncated).toBe(true);
      expect(output.stderr_bytes).toBeGreaterThan(
        GHIDRA_LAUNCH_COMMAND_OUTPUT_BYTES,
      );
      expect(Buffer.byteLength(output.stderr)).toBeLessThanOrEqual(
        GHIDRA_LAUNCH_COMMAND_OUTPUT_BYTES,
      );
      expect(output.stderr).not.toContain("UNRETAINED-TAIL");
      expect(output.stderr).not.toContain("�");
    }
    expect(launched.value.launchSupport).toHaveLength(2);
  });

  it("omits helper diagnostics when both stderr streams are empty", async () => {
    const { session, launcher } = await fixture("quiet");
    const launched = await launcher.launch(session);
    if (!launched.ok) throw launched.error;
    expect(launched.value.launchSupport).toBeUndefined();
  });

  it("redacts the explicit transport credential and preserves caller-selected paths and URL values", async () => {
    const { session, launcher } = await fixture("credential");
    const launched = await launcher.launch(session);
    if (!launched.ok) throw launched.error;
    expect(launched.value.launchSupport).toHaveLength(2);
    for (const output of launched.value.launchSupport ?? []) {
      expect(output.stderr).toContain(warning);
      expect(output.stderr).toContain("explicit credential: [REDACTED]");
      expect(output.stderr).not.toContain(session.token);
      expect(output.stderr_truncated).toBe(false);
    }
  });
});

describe.skipIf(process.platform === "win32")(
  "Ghidra startup interruption diagnostics",
  () => {
    it.each(["cancelled", "timeout"] as const)(
      "preserves helper warnings through the provider-neutral %s projection",
      async (kind) => {
        const { session, launcher, controller } = await fixture(
          kind === "cancelled" ? "cancel-after-spawn" : "timeout-after-spawn",
        );
        const bytes = elf(2, 1, 62);
        await writeFile(session.targetPath, bytes);
        const target: BinaryTarget = {
          path: session.targetPath,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          kind: "executable",
          format: "elf",
          architecture: "x86_64",
          availableArchitectures: ["x86_64"],
        };
        const config = parseConfig({
          GHIDRA_INSTALL_DIR: "/fixture/ghidra",
          REA_GHIDRA_STARTUP_TIMEOUT_MS: "3000",
        });
        if (!config.ok) throw config.error;
        const provider = new GhidraProvider(
          config.value,
          silentLogger,
          {},
          {
            platform: process.platform,
            architecture: process.arch,
            readText: () =>
              "application.version=12.1.4\napplication.java.min=21\n",
            executable: () => true,
            probeJava: () => ({
              version: "21.0.12",
              major: 21,
              home: "/fixture/jdk",
              bits: 64,
              runtime: "jdk",
            }),
          },
          (options) => new GhidraClient({ ...options, launcher }),
        );
        const profile = await provider.resolveAnalysisProfile(target);
        if (!profile.ok) throw profile.error;
        if (profile.value.profile === null)
          throw new Error("Expected Ghidra profile");
        const client = provider.createClient(target, profile.value.profile);
        onTestFinished(async () => {
          expect((await client.close()).ok).toBe(true);
        });
        const result = await client.execute(
          "health",
          {},
          { signal: controller.signal },
        );
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("Expected interrupted startup");
        const projected = analysisErrorProjectionSchema.parse(
          JSON.parse(JSON.stringify(projectAnalysisError(result.error))),
        );
        expect(projected.code).toBe(
          kind === "cancelled" ? "cancelled" : "provider_timeout",
        );
        expect(projected).toMatchObject({
          details: {
            diagnostics: {
              failure_cause: {
                cause: {
                  launch_support: expect.arrayContaining([
                    expect.objectContaining({
                      mode: "-envvars",
                      stderr: `-envvars: ${warning}\n`,
                    }),
                    expect.objectContaining({
                      mode: "-vmargs",
                      stderr: `-vmargs: ${warning}\n`,
                    }),
                  ]),
                },
              },
            },
          },
        });
      },
    );
  },
);
