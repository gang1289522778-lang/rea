import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { npxRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import { configureClientConfiguration } from "../../../src/application/SetupClientConfiguration.js";
import { detectClients } from "../../../src/application/SetupHost.js";
import { skillDestinations } from "../../../src/application/SetupSkill.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import {
  runUninstall,
  systemUninstallHost,
} from "../../../src/application/Uninstall.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";

/**
 * The registration command setup writes on the host running the tests. Windows
 * wraps it in `cmd.exe /d /c`, so the expected entry follows the host too.
 */
const command = npxRegistrationCommand(process.platform);

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

const freebuffPath = (
  home: string,
  platform: NodeJS.Platform = "linux",
  env: Parameters<typeof supportedClients>[2] = {},
) =>
  supportedClients(home, platform, env).find(({ name }) => name === "freebuff");

describe("FreeBuff configuration paths", () => {
  it("resolves the shared user agents file and the profile marker directory", () => {
    expect(freebuffPath("/home/a")).toEqual({
      name: "freebuff",
      displayName: "FreeBuff",
      configPath: join("/home/a", ".agents", "mcp.json"),
      markerPath: join("/home/a", ".config", "freebuff-desktop"),
      discoveryPaths: [join("/home/a", ".config", "freebuff-desktop")],
      format: "json",
    });
    expect(freebuffPath("/Users/a", "darwin")?.markerPath).toBe(
      join("/Users/a", ".config", "freebuff-desktop"),
    );
    expect(freebuffPath("C:\\Users\\a", "win32")?.markerPath).toBe(
      join("C:\\Users\\a", ".config", "freebuff-desktop"),
    );
  });

  it("stays undetected when only the shared agents skill directory exists", async () => {
    const home = await createTestTempDirectory("rea-freebuff-shared-");
    // REA's own skill installs create this directory for every client.
    await mkdir(join(home, ".agents", "skills"), { recursive: true });
    await writeFile(
      join(home, ".agents", "mcp.json"),
      '{"mcpServers":{"other":{"command":"other-server"}}}',
    );
    expect((await detectClients(home)).map(({ name }) => name)).not.toContain(
      "freebuff",
    );
    expect(
      (
        await readClientRegistrationStatuses(home, undefined, {
          platform: process.platform,
          environment: {},
        })
      ).map(({ client }) => client),
    ).not.toContain("freebuff");

    await mkdir(join(home, ".config", "freebuff-desktop"), {
      recursive: true,
    });
    expect((await detectClients(home)).map(({ name }) => name)).toContain(
      "freebuff",
    );
  });

  it("shares the user-scope file ZCode loads as its fallback", () => {
    const clients = supportedClients("/home/a", "linux", {});
    const freebuff = clients.find(({ name }) => name === "freebuff");
    const zcode = clients.find(({ name }) => name === "zcode");
    expect(freebuff?.configPath).toBe(zcode?.zcodeFallbackPath);
  });

  it("resolves the personal skills directory FreeBuff discovers", () => {
    expect(skillDestinations("/home/a", ["freebuff"])).toEqual([
      {
        client: "shared",
        path: join("/home/a", ".agents", "skills", "reverse-engineer-anything"),
      },
    ]);
  });
});

describe("FreeBuff JSON registration", () => {
  const freebuffClient = async () => {
    const home = await createTestTempDirectory("rea-freebuff-");
    const client = freebuffPath(home, process.platform);
    if (client === undefined) throw new Error("missing FreeBuff client");
    await mkdir(dirname(client.configPath), { recursive: true });
    await mkdir(client.markerPath!, { recursive: true });
    return { home, client };
  };

  it("upserts rea into mcpServers while preserving unrelated settings", async () => {
    const { home, client } = await freebuffClient();
    await writeFile(
      client.configPath,
      `{
  "mcpServers": {
    "other": { "command": "other-server" }
  },
  "agents": { "discoverSkills": true }
}`,
    );

    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcpServers.other).toEqual({ command: "other-server" });
    expect(parsed.agents).toEqual({ discoverSkills: true });
    expect(parsed.mcpServers.rea).toEqual({
      command: command[0],
      args: command.slice(1),
    });

    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    expect(
      (
        await readClientRegistrationStatuses(home, undefined, {
          platform: process.platform,
          environment: {},
        })
      ).find(({ client }) => client === "freebuff"),
    ).toMatchObject({ state: "aligned", command });
  });

  it("creates the mcpServers table in an existing file without servers", async () => {
    const { client } = await freebuffClient();
    await writeFile(
      client.configPath,
      JSON.stringify({ agents: { discoverSkills: true } }, null, 2),
    );
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.agents).toEqual({ discoverSkills: true });
    expect(parsed.mcpServers.rea).toEqual({
      command: command[0],
      args: command.slice(1),
    });
  });

  it("registers into an empty settings file", async () => {
    const { client } = await freebuffClient();
    await writeFile(client.configPath, "");
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcpServers.rea).toEqual({
      command: command[0],
      args: command.slice(1),
    });
  });

  it("removes only the rea entry on uninstall", async () => {
    const { home, client } = await freebuffClient();
    await writeFile(
      client.configPath,
      JSON.stringify(
        { mcpServers: { other: { command: "other-server" } } },
        null,
        2,
      ),
    );
    await configureClientConfiguration(client, {}, command);

    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    const parsed = JSON.parse(await readFile(client.configPath, "utf8"));
    expect(parsed.mcpServers.other).toEqual({ command: "other-server" });
    expect(parsed.mcpServers.rea).toBeUndefined();
  });
});

describe("uninstall applicability for shared FreeBuff storage", () => {
  it("retains malformed shared settings without blocking unrelated REA removal", async () => {
    const home = await createTestTempDirectory("rea-freebuff-absent-");
    const client = freebuffPath(home, process.platform)!;
    await mkdir(dirname(client.configPath), { recursive: true });
    await writeFile(client.configPath, "{unrelated malformed shared data");
    const codex = supportedClients(home, process.platform, {}).find(
      ({ name }) => name === "codex",
    )!;
    await mkdir(dirname(codex.configPath), { recursive: true });
    await writeFile(codex.configPath, "");
    await configureClientConfiguration(codex, {}, command);
    await mkdir(join(home, ".rea", "cache"), { recursive: true });
    await writeFile(join(home, ".rea", "cache", "owned"), "owned");
    const result = await runUninstall(
      true,
      systemUninstallHost(home, undefined, {}),
    );
    expect(result.status).toBe("complete");
    expect(result.items.find(({ name }) => name === "freebuff")).toMatchObject({
      status: "retained",
    });
    expect(result.items.find(({ name }) => name === "codex")).toMatchObject({
      status: "removed",
    });
    expect(result.items.find(({ name }) => name === "cache")).toMatchObject({
      status: "removed",
    });
    expect(await readFile(client.configPath, "utf8")).toBe(
      "{unrelated malformed shared data",
    );
  });

  it("removes a recognizable owned shared row even without a FreeBuff profile", async () => {
    const home = await createTestTempDirectory("rea-freebuff-owned-row-");
    const client = freebuffPath(home, process.platform)!;
    await mkdir(dirname(client.configPath), { recursive: true });
    await writeFile(
      client.configPath,
      JSON.stringify({ mcpServers: { other: { command: "other-server" } } }),
    );
    await configureClientConfiguration(client, {}, command);
    const result = await runUninstall(
      false,
      systemUninstallHost(home, undefined, {}),
    );
    expect(result.status).toBe("complete");
    expect(result.items.find(({ name }) => name === "freebuff")).toMatchObject({
      status: "removed",
    });
    expect(
      JSON.parse(await readFile(client.configPath, "utf8")).mcpServers,
    ).toEqual({ other: { command: "other-server" } });
  });
});
