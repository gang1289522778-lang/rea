import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "jsonc-parser";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "keeps Kimi Code registration and shared skill consistent through setup, doctor and uninstall",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-kimi-client-");
    const home = join(root, "account");
    const kimiHome = join(root, "kimi-home");
    const config = join(kimiHome, "mcp.json");
    const skill = join(
      home,
      ".agents",
      "skills",
      "reverse-engineer-anything",
      "SKILL.md",
    );
    const environment = {
      HOME: home,
      USERPROFILE: home,
      KIMI_CODE_HOME: kimiHome,
    };
    const original =
      '{\n  // Keep my configuration.\n  "model": "kimi-k2.6",\n  "mcpServers": {"other": {"command": "other-server"}}\n}\n';
    await mkdir(kimiHome, { recursive: true });
    await writeFile(config, original);
    const run = (arguments_: readonly string[]) =>
      cli.run({ arguments: [...arguments_, "--json"], environment });

    const plan = await run(["setup", "--client", "kimi_code", "--dry-run"]);
    expect(plan.exitCode, plan.stderr).toBe(0);
    expect(plan.json).toMatchObject({
      status: "planned",
      plannedActions: [
        { kind: "configure_client", target: config },
        {
          kind: "install_skill",
          target: join(home, ".agents", "skills", "reverse-engineer-anything"),
        },
      ],
    });
    expect(await readFile(config, "utf8")).toBe(original);
    await expect(access(skill)).rejects.toMatchObject({ code: "ENOENT" });

    const installed = await run(["setup", "--client", "kimi_code", "--yes"]);
    expect(installed.exitCode, installed.stderr).toBe(0);
    expect(installed.json).toMatchObject({ status: "ready" });
    expect(await readFile(`${config}.rea.backup`, "utf8")).toBe(original);
    const configured = await readFile(config, "utf8");
    expect(configured).toContain("// Keep my configuration.");
    expect(parse(configured)).toMatchObject({
      model: "kimi-k2.6",
      mcpServers: {
        other: { command: "other-server" },
        rea: {
          command:
            process.platform === "win32"
              ? process.execPath
              : resolve("scripts/rea.mjs"),
          args:
            process.platform === "win32"
              ? [resolve("scripts/rea.mjs"), "mcp"]
              : ["mcp"],
          env: { REA_MCP_INPUT_SCHEMA_PROFILE: "compact" },
        },
      },
    });
    expect(await readFile(skill, "utf8")).toContain(
      "name: reverse-engineer-anything",
    );

    const doctor = await run(["doctor", "--client", "kimi_code", "--skill"]);
    expect(doctor.exitCode, doctor.stderr).toBe(0);
    expect(doctor.json).toMatchObject({ healthy: true });
    const repeated = await run(["setup", "--client", "kimi_code", "--yes"]);
    expect(repeated.exitCode, repeated.stderr).toBe(0);
    expect(repeated.json).toMatchObject({
      status: "ready",
      appliedActions: [],
    });
    expect(await readFile(config, "utf8")).toBe(configured);

    const removed = await run(["uninstall"]);
    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(removed.json).toMatchObject({ status: "complete" });
    expect(parse(await readFile(config, "utf8"))).toEqual({
      model: "kimi-k2.6",
      mcpServers: { other: { command: "other-server" } },
    });
    await expect(access(skill)).rejects.toMatchObject({ code: "ENOENT" });
  },
  120_000,
);
