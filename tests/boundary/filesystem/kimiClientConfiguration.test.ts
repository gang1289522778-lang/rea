import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseJsonc } from "jsonc-parser";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import {
  clientConfigurationAligned,
  configureClientConfiguration,
  inspectClientConfiguration,
} from "../../../src/application/SetupClientConfiguration.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { systemUninstallHost } from "../../../src/application/Uninstall.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  clearClientLocationEnvironment,
  NPX_REGISTRATION_COMMAND,
} from "../../fixtures/clientEnvironment.js";

const command = NPX_REGISTRATION_COMMAND;

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

const kimiPath = (
  home: string,
  platform: NodeJS.Platform,
  env: Parameters<typeof supportedClients>[2] = {},
) =>
  supportedClients(home, platform, env).find(
    ({ name }) => name === "kimi_code",
  );

describe("Kimi Code configuration paths", () => {
  it("resolves the user mcp.json and marker directory", () => {
    expect(kimiPath("/home/a", "linux")).toEqual({
      name: "kimi_code",
      displayName: "Kimi Code",
      configPath: join("/home/a", ".kimi-code", "mcp.json"),
      markerPath: join("/home/a", ".kimi-code"),
      format: "json",
    });
    expect(kimiPath("/Users/a", "darwin")?.configPath).toBe(
      join("/Users/a", ".kimi-code", "mcp.json"),
    );
  });

  it.each([
    ["", join("/home/a", ".kimi-code")],
    ["/custom/kimi", "/custom/kimi"],
    ["~/kimi", join("~", "kimi")],
    ["profiles/work", "profiles/work"],
  ])("uses a nonempty KIMI_CODE_HOME as-is for %j", (override, directory) => {
    expect(
      supportedClients("/home/a", "linux", { KIMI_CODE_HOME: override }).find(
        ({ name }) => name === "kimi_code",
      ),
    ).toMatchObject({
      configPath: join(directory, "mcp.json"),
      markerPath: directory,
    });
  });
});

describe("Kimi Code client lifecycle", () => {
  const kimiClient = async () => {
    const home = await createTestTempDirectory("rea-kimi-");
    const client = kimiPath(home, process.platform, {});
    if (client?.markerPath === undefined)
      throw new Error("missing Kimi Code client");
    await mkdir(client.markerPath, { recursive: true });
    return { home, client };
  };

  it("registers rea in mcpServers with the compact schema profile while preserving unrelated settings", async () => {
    const { home, client } = await kimiClient();
    await writeFile(
      client.configPath,
      `{
  // Keep this note.
  "model": "kimi-k2.6",
  "mcpServers": { "other": { "command": "other-server" } }
}
`,
    );
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const text = await readFile(client.configPath, "utf8");
    expect(text).toContain("// Keep this note.");
    expect(parseJsonc(text)).toEqual({
      model: "kimi-k2.6",
      mcpServers: {
        other: { command: "other-server" },
        rea: {
          command: "npx",
          args: command.slice(1),
          env: { REA_MCP_INPUT_SCHEMA_PROFILE: "compact" },
        },
      },
    });
    expect(await clientConfigurationAligned(client, {}, command)).toBe(true);
    expect(await inspectClientConfiguration(client, {}, command)).toEqual({
      status: "already_current",
    });
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    expect(await readFile(client.configPath, "utf8")).toBe(text);
    const status = (
      await readClientRegistrationStatuses(home, resolve("scripts/rea.mjs"), {
        environment: {},
      })
    ).find(({ client: name }) => name === "kimi_code");
    expect(status).toMatchObject({ state: "aligned" });
    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
    const removedText = await readFile(client.configPath, "utf8");
    expect(parseJsonc(removedText)).toEqual({
      model: "kimi-k2.6",
      mcpServers: { other: { command: "other-server" } },
    });
    expect(removedText).toContain("// Keep this note.");
  });

  it("seeds the compact profile on a registration without an environment", async () => {
    const { client } = await kimiClient();
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const parsed = parseJsonc(await readFile(client.configPath, "utf8"));
    expect(parsed).toEqual({
      mcpServers: {
        rea: {
          command: "npx",
          args: command.slice(1),
          env: { REA_MCP_INPUT_SCHEMA_PROFILE: "compact" },
        },
      },
    });
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
  });

  it("keeps an explicitly configured profile and adds only discovered provider settings", async () => {
    const { client } = await kimiClient();
    await writeFile(
      client.configPath,
      JSON.stringify({
        mcpServers: {
          rea: {
            command: "npx",
            args: command.slice(1),
            env: {
              REA_MCP_INPUT_SCHEMA_PROFILE: "full",
              REA_MCP_MAX_RESPONSE_BYTES: "33554432",
            },
          },
        },
      }),
    );
    const providers = { GHIDRA_INSTALL_DIR: "/opt/ghidra" };
    expect(
      (await configureClientConfiguration(client, providers, command)).status,
    ).toBe("configured");
    const parsed = parseJsonc(await readFile(client.configPath, "utf8"));
    expect(parsed).toMatchObject({
      mcpServers: {
        rea: {
          env: {
            REA_MCP_INPUT_SCHEMA_PROFILE: "full",
            REA_MCP_MAX_RESPONSE_BYTES: "33554432",
            GHIDRA_INSTALL_DIR: "/opt/ghidra",
          },
        },
      },
    });
    expect(await clientConfigurationAligned(client, providers, command)).toBe(
      true,
    );
    expect(
      await configureClientConfiguration(client, providers, command),
    ).toEqual({ status: "unchanged" });
  });

  it("writes under KIMI_CODE_HOME when configured", async () => {
    const home = await createTestTempDirectory("rea-kimi-home-");
    const directory = join(home, "kimi-profile");
    await mkdir(directory, { recursive: true });
    const client = kimiPath(home, process.platform, {
      KIMI_CODE_HOME: directory,
    });
    if (client === undefined) throw new Error("missing Kimi Code client");
    expect(client.configPath).toBe(join(directory, "mcp.json"));
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    expect(parseJsonc(await readFile(client.configPath, "utf8"))).toMatchObject(
      {
        mcpServers: {
          rea: { env: { REA_MCP_INPUT_SCHEMA_PROFILE: "compact" } },
        },
      },
    );
    expect((await systemUninstallHost(home).removeClient(client)).status).toBe(
      "removed",
    );
  });
});

describe("Kimi Code registration status", () => {
  it("marks a profile-less hand-written registration stale and keeps an explicit profile", async () => {
    const home = await createTestTempDirectory("rea-kimi-");
    const client = kimiPath(home, process.platform, {});
    if (client?.markerPath === undefined)
      throw new Error("missing Kimi Code client");
    await mkdir(client.markerPath, { recursive: true });
    const statusOf = async () =>
      (
        await readClientRegistrationStatuses(home, resolve("scripts/rea.mjs"), {
          environment: {},
        })
      ).find(({ client: name }) => name === "kimi_code");
    await writeFile(
      client.configPath,
      `{
  "mcpServers": {
    "rea": {
      "command": "npx",
      "args": ${JSON.stringify(command.slice(1))}
    }
  }
}
`,
    );
    expect(await statusOf()).toMatchObject({ state: "stale" });
    await writeFile(
      client.configPath,
      `{
  "mcpServers": {
    "rea": {
      "command": "npx",
      "args": ${JSON.stringify(command.slice(1))},
      "env": { "REA_MCP_INPUT_SCHEMA_PROFILE": "full" }
    }
  }
}
`,
    );
    expect(await statusOf()).toMatchObject({ state: "aligned" });
  });
});
