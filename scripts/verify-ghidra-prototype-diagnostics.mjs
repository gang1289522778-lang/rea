#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { inspectGhidraInstallation } from "../dist/ghidra/GhidraInstallation.js";
import {
  spawnOwnedProviderProcess,
  ProviderProcessSupervisor,
} from "../dist/process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../dist/process/ProcessOwnership.js";
import { OwnedCommandFailure } from "../dist/process/OwnedCommand.js";
import { parseEvidence } from "../dist/domain/evidence.js";
import { requireMcpOperationResult } from "./lib/mcp-verifier-results.mjs";
import { createVerifierRun, completeVerifierRun } from "./lib/verifier-run.mjs";
import { assertPrototypeDiagnosticsReport } from "./verify-ghidra-prototype-diagnostics-assertions.mjs";

const exec = promisify(execFile);
const defaultEntrypoint = fileURLToPath(new URL("./rea.mjs", import.meta.url));
const fixtureSources = fileURLToPath(
  new URL("../tests/conformance/ghidra", import.meta.url),
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Real producer controls plus independent public CLI/MCP sessions. No target executes. */
export async function verifyGhidraPrototypeDiagnostics({
  installation,
  entrypoint = defaultEntrypoint,
}) {
  assert.ok(
    process.platform === "linux" && process.arch === "x64",
    "Prototype fixture lane requires Linux x64 and GNU as/ld",
  );
  const run = createVerifierRun();
  const workspace = await mkdtemp(join(tmpdir(), "rea-prototype-proof-"));
  const runtime = join(workspace, "runtime");
  await mkdir(runtime);
  const object = join(workspace, "prototype.o");
  const target = join(workspace, "prototype");
  const bridge = await realpath(
    join(dirname(entrypoint), "../bridge/ghidra/ReaGhidraBridge.java"),
  );
  const helper = join(dirname(bridge), "ReaGhidraPrototypeDiagnostics.java");
  const producerOutput = join(workspace, "producer.json");
  let retainWorkspace = false;
  let verifierFinished = false;
  try {
    await exec(process.env.REA_AS ?? "as", [
      "--32",
      join(fixtureSources, "prototype-conflicts.S"),
      "-o",
      object,
    ]);
    await exec(process.env.REA_LD ?? "ld", [
      "-m",
      "elf_i386",
      "-e",
      "_start",
      object,
      "-o",
      target,
    ]);
    const targetDigest = digest(await readFile(target));
    const sourceDigests = [
      digest(await readFile(bridge)),
      digest(await readFile(helper)),
    ];
    const project = join(workspace, "project");
    await mkdir(project);
    const launch = await spawnOwnedProviderProcess({
      command: installation.analyzeHeadlessPath,
      arguments: [
        project,
        "PrototypeControls",
        "-import",
        target,
        "-processor",
        "x86:LE:32:default",
        "-cspec",
        "windows",
        "-deleteProject",
        "-scriptPath",
        `${fixtureSources};${dirname(bridge)}`,
        "-postScript",
        "ReaPrototypeDiagnosticsProbe.java",
        bridge,
        producerOutput,
      ],
      runId: run.run_id,
      expectedCommand: null,
    });
    const supervisor = new ProviderProcessSupervisor({
      ...launch,
      ownsProcessLifetime: true,
      cleanup: () => cleanupOwnedProcessGroup(launch.ownership),
    });
    retainWorkspace = true;
    let producer;
    let producerFailure;
    try {
      assert.ok(
        await supervisor.waitForExit(180000),
        "Prototype producer probe exceeded its headless deadline",
      );
      assert.ok(
        await supervisor.waitForOutputClose(1000),
        "Prototype producer output did not close",
      );
      const snapshot = supervisor.snapshot();
      const output = `${snapshot.stdout.text}\n${snapshot.stderr.text}`;
      assert.equal(snapshot.exitCode, 0, output);
      assert.ok(
        output.includes("REA_PROTOTYPE_DIAGNOSTICS_PROBE_COMPLETE"),
        output,
      );
      producer = assertPrototypeDiagnosticsReport(
        JSON.parse(await readFile(producerOutput, "utf8")),
      );
    } catch (cause) {
      producerFailure = cause;
      throw cause;
    } finally {
      const stopped = await supervisor.stop();
      if (stopped.status === "incomplete")
        throw new OwnedCommandFailure(
          "process",
          `Prototype producer cleanup incomplete; workspace retained at ${workspace}`,
          supervisor.snapshot(),
          stopped.reason,
          producerFailure === undefined
            ? undefined
            : { cause: producerFailure },
          [workspace, run.run_id, `pid:${launch.ownership.leaderPid}`],
          supervisor,
        );
      retainWorkspace = false;
    }
    retainWorkspace = true;
    const publicWorkflows = await verifyPublicWorkflows({
      entrypoint,
      target,
      runtime,
      run,
      targetDigest,
      workspace,
      onCleanupComplete: async () => {
        assert.deepEqual(
          (await readdir(runtime)).filter((name) =>
            name.startsWith("rea-ghidra-"),
          ),
          [],
          "Owned runtime survived public close; workspace retained",
        );
        retainWorkspace = false;
        if (verifierFinished)
          await rm(workspace, { recursive: true, force: true });
      },
    });
    assert.equal(
      digest(await readFile(target)),
      targetDigest,
      "Analysis modified imported executable bytes",
    );
    assert.deepEqual(
      [digest(await readFile(bridge)), digest(await readFile(helper))],
      sourceDigests,
    );
    assert.deepEqual(
      (await readdir(runtime)).filter((name) => name.startsWith("rea-ghidra-")),
      [],
      "Owned runtime survived close",
    );
    return {
      producer,
      public_workflows: publicWorkflows,
      target_sha256: targetDigest,
      cleanup: "complete",
    };
  } finally {
    verifierFinished = true;
    if (!retainWorkspace) await rm(workspace, { recursive: true, force: true });
  }
}

async function verifyPublicWorkflows({
  entrypoint,
  target,
  runtime,
  run,
  targetDigest,
  workspace,
  onCleanupComplete,
}) {
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: runtime,
    REA_LOG_LEVEL: "silent",
    REA_ANALYSIS_PROVIDER: "ghidra",
    REA_PROCESS_RUN_ID: run.run_id,
    GHIDRA_INSTALL_DIR: process.env.GHIDRA_INSTALL_DIR,
    ...(process.env.JAVA_HOME === undefined
      ? {}
      : { JAVA_HOME: process.env.JAVA_HOME }),
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint, "mcp"],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "rea-real-prototype-proof", version: "1" });
  let opened = false;
  let primaryFailure;
  const observations = [];
  const call = async (name, arguments_ = {}) => {
    const result = await client.callTool(
      { name, arguments: arguments_ },
      { timeout: 240000 },
    );
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent;
  };
  try {
    await client.connect(transport);
    // An unsuccessful open may retain an acquired provider after cleanup fails.
    opened = true;
    requireMcpOperationResult(
      await client.callTool(
        {
          name: "open_binary",
          arguments: { path: target, provider_id: "ghidra" },
        },
        { timeout: 240000 },
      ),
      "open_binary",
    );
    for (const procedure of [
      "rea_stack_x87",
      "rea_cleanup_conflict",
      "rea_cleanup_control",
      "rea_forward_return",
      "rea_overwrite_return",
    ]) {
      const analyzed = parseEvidence(
        await call("analyze_function", { procedure }),
      );
      assert.equal(analyzed.subject.digest.sha256, targetDigest);
      const dossier = analyzed.normalized_result;
      const inspected = parseEvidence(
        await call("inspect_native_api", { procedure }),
      );
      assert.deepEqual(
        inspected.normalized_result.boundary,
        dossier.native_api,
      );
      const { stdout } = await exec(
        process.execPath,
        [
          entrypoint,
          "inspect-native-api",
          target,
          procedure,
          "--provider",
          "ghidra",
          "--json",
        ],
        { env, timeout: 240000, maxBuffer: 16 * 1024 * 1024 },
      );
      const cli = parseEvidence(JSON.parse(stdout));
      assert.deepEqual(
        cli.normalized_result.boundary,
        inspected.normalized_result.boundary,
        `${procedure}: CLI/MCP boundary differs`,
      );
      assert.deepEqual(
        cli.normalized_result.residual_unknowns,
        inspected.normalized_result.residual_unknowns,
        `${procedure}: CLI/MCP unknowns differ`,
      );
      const diagnostics = dossier.native_api.prototype_diagnostics;
      if (procedure === "rea_stack_x87") {
        assert.deepEqual(dossier.native_api.parameters, []);
        assert.ok(
          diagnostics.some(
            (item) =>
              item.kind === "stack-parameter-read" &&
              item.classification === "conflict",
          ),
        );
        assert.ok(diagnostics.some((item) => item.kind === "x87-expression"));
      } else if (procedure === "rea_cleanup_conflict") {
        assert.equal(dossier.native_api.parameters.length, 4);
        assert.ok(diagnostics.some((item) => item.kind === "stack-cleanup"));
      } else if (procedure === "rea_cleanup_control")
        assert.deepEqual(
          diagnostics.filter((item) => item.classification === "conflict"),
          [],
        );
      else if (procedure === "rea_forward_return")
        assert.ok(
          diagnostics.some(
            (item) =>
              item.kind === "return-register-forwarding" &&
              item.classification === "observation",
          ),
        );
      else
        assert.ok(
          !diagnostics.some(
            (item) => item.kind === "return-register-forwarding",
          ),
        );
      for (const facet of ["native_api", "assembly"]) {
        const view = await call("inspect_analysis_view", {
          source: {
            kind: "retained-evidence",
            evidence_id: analyzed.evidence_id,
          },
          view: { kind: "native", facet, offset: 0, limit: 64 },
        });
        if (facet === "native_api")
          assert.deepEqual(view.normalized_result.item, dossier.native_api);
        else assert.deepEqual(view.normalized_result.item, dossier.assembly);
        for (const diagnostic of diagnostics)
          for (const unknown of diagnostic.residual_unknowns)
            assert.ok(view.normalized_result.unknowns.includes(unknown));
        for (const limitation of dossier.native_api.prototype_check_limitations)
          assert.ok(view.normalized_result.limitations.includes(limitation));
      }
      observations.push({ procedure, diagnostics, cli_mcp_equal: true });
    }
  } catch (cause) {
    primaryFailure = cause;
    throw cause;
  } finally {
    await retirePrototypePublicClient({
      client,
      opened,
      workspace,
      primaryFailure,
      onCleanupComplete,
    });
  }
  return observations;
}

/** Keep the connected client as cleanup owner until close_binary is confirmed. */
export async function retirePrototypePublicClient({
  client,
  opened,
  workspace,
  primaryFailure,
  onCleanupComplete,
}) {
  let binaryClosed = !opened;
  const cleanupOwner = {
    async stop() {
      if (!binaryClosed) {
        requireMcpOperationResult(
          await client.callTool({ name: "close_binary", arguments: {} }),
          "close_binary",
        );
        binaryClosed = true;
      }
      await client.close();
      await onCleanupComplete();
    },
  };
  try {
    await cleanupOwner.stop();
  } catch (cleanupFailure) {
    const failure = new Error(
      `Prototype public cleanup incomplete; client and workspace retained at ${workspace}`,
      { cause: primaryFailure ?? cleanupFailure },
    );
    failure.cleanupFailure = cleanupFailure;
    failure.cleanupOwner = cleanupOwner;
    failure.resources = [workspace];
    throw failure;
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({ options: { entrypoint: { type: "string" } } });
  const installation = inspectGhidraInstallation({
    environment: process.env,
    installDir: process.env.GHIDRA_INSTALL_DIR,
    ...(process.env.JAVA_HOME === undefined
      ? {}
      : { javaHome: process.env.JAVA_HOME }),
  });
  assert.equal(installation.status, "available", JSON.stringify(installation));
  const run = createVerifierRun();
  const report = await verifyGhidraPrototypeDiagnostics({
    installation,
    entrypoint:
      values.entrypoint === undefined
        ? defaultEntrypoint
        : resolve(values.entrypoint),
  });
  process.stdout.write(
    `${JSON.stringify({ lane: "linux-x64-x86-32-prototype-diagnostics", ...report, verifier_run: await completeVerifierRun(run) })}\n`,
  );
}
