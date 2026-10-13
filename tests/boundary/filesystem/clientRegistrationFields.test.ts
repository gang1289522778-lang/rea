import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  clientRegistrationEntry,
  parseClientConfiguration,
  serializeClientConfiguration,
  type ClientRegistrationDialect,
} from "../../../src/application/ClientConfigurationDocument.js";
import {
  clientConfigurationAligned,
  configureClientConfiguration,
  inspectClientConfiguration,
} from "../../../src/application/SetupClientConfiguration.js";
import type { SetupClient } from "../../../src/application/SupportedClients.js";
import { MCP_STARTUP_POLICY } from "../../../src/mcpStartupPolicy.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const command = ["rea", "mcp"];
const environment = { REA_MCP_INPUT_SCHEMA_PROFILE: "compact" };

/** Wrap an entry in the server table each dialect reads. */
const configurationWith = (
  dialect: ClientRegistrationDialect,
  entry: unknown,
): Record<string, unknown> => {
  switch (dialect) {
    case "opencode":
      return { mcp: { rea: entry } };
    case "opencode_v2":
      return { mcp: { servers: { rea: entry } } };
    case "vscode":
      return { servers: { rea: entry } };
    case "toml":
    case "grok":
    case "hermes":
      return { mcp_servers: { rea: entry } };
    default:
      return { mcpServers: { rea: entry } };
  }
};

it.each([
  ["cursor", "json", "json", { timeout: 600000, trust: true }],
  ["vscode", "vscode", "vscode", { envFile: ".env" }],
  [
    "omp",
    "omp",
    "omp",
    { timeout: 0, enabled: true, instructions: "Use for binaries." },
  ],
  ["pi", "pi", "pi", { timeout: 0 }],
  ["copilot_cli", "copilot_cli", "copilot_cli", { timeout: 120000 }],
  ["commandcode", "commandcode", "commandcode", { timeout: 300 }],
  ["opencode", "opencode", "opencode", { timeout: 600000 }],
  ["opencode", "opencode", "opencode_v2", { timeout: 600000 }],
  [
    "codex",
    "toml",
    "toml",
    { tool_timeout_sec: 900, enabled_tools: ["analyze_function"] },
  ],
  ["grok_build", "grok", "grok", { tool_timeout_sec: 900 }],
  ["hermes", "hermes", "hermes", { timeout: 600, connect_timeout: 60 }],
] as const)(
  "keeps %s fields REA does not manage (%s, %s entry)",
  async (name, format, dialect, extras) => {
    const root = await createTestTempDirectory("rea-registration-fields-");
    const configPath = join(root, "config");
    const client: SetupClient = { name, format, configPath };
    const existing = {
      ...clientRegistrationEntry(dialect, ["rea-old", "mcp"], environment),
      ...extras,
      // Remote and disabling keys contradict the active stdio entry REA writes.
      url: "https://stale.example/mcp",
      ...(Object.hasOwn(extras, "enabled") ? {} : { enabled: false }),
    };
    await writeFile(
      configPath,
      serializeClientConfiguration(
        configurationWith(dialect, existing),
        format,
      ),
    );
    expect(await inspectClientConfiguration(client, {}, command)).toMatchObject(
      { status: "update" },
    );
    expect(
      await configureClientConfiguration(client, {}, command),
    ).toMatchObject({ status: "configured" });
    const configured = await readFile(configPath, "utf8");
    expect(parseClientConfiguration(configured, format).servers.rea).toEqual({
      ...clientRegistrationEntry(dialect, command, environment),
      ...(name === "codex" || name === "grok_build"
        ? {
            startup_timeout_sec: MCP_STARTUP_POLICY.codexStartupTimeoutSeconds,
          }
        : {}),
      ...extras,
    });
    expect(await clientConfigurationAligned(client, {}, command)).toBe(true);
    expect(await inspectClientConfiguration(client, {}, command)).toEqual({
      status: "already_current",
      dialect,
    });
    expect(await configureClientConfiguration(client, {}, command)).toEqual({
      status: "unchanged",
    });
    expect(await readFile(configPath, "utf8")).toBe(configured);
  },
);

it("drops Codex oauth_resource from a local command entry", async () => {
  const root = await createTestTempDirectory(
    "rea-registration-oauth-resource-",
  );
  const configPath = join(root, "config.toml");
  const client: SetupClient = { name: "codex", format: "toml", configPath };
  const existing = {
    ...clientRegistrationEntry("toml", ["rea-old", "mcp"], environment),
    tool_timeout_sec: 900,
    oauth_resource: "https://stale.example/resource",
  };
  await writeFile(
    configPath,
    serializeClientConfiguration(configurationWith("toml", existing), "toml"),
  );
  expect(await configureClientConfiguration(client, {}, command)).toMatchObject(
    { status: "configured" },
  );
  expect(
    parseClientConfiguration(await readFile(configPath, "utf8"), "toml").servers
      .rea,
  ).toEqual({
    ...clientRegistrationEntry("toml", command, environment),
    startup_timeout_sec: MCP_STARTUP_POLICY.codexStartupTimeoutSeconds,
    tool_timeout_sec: 900,
  });
});

it("drops a Codex tools array from a local command entry", async () => {
  const root = await createTestTempDirectory("rea-registration-codex-tools-");
  const configPath = join(root, "config.toml");
  const client: SetupClient = { name: "codex", format: "toml", configPath };
  const existing = {
    ...clientRegistrationEntry("toml", ["rea-old", "mcp"], environment),
    tool_timeout_sec: 900,
    tools: ["*"],
  };
  await writeFile(
    configPath,
    serializeClientConfiguration(configurationWith("toml", existing), "toml"),
  );
  expect(await configureClientConfiguration(client, {}, command)).toMatchObject(
    { status: "configured" },
  );
  expect(
    parseClientConfiguration(await readFile(configPath, "utf8"), "toml").servers
      .rea,
  ).toEqual({
    ...clientRegistrationEntry("toml", command, environment),
    startup_timeout_sec: MCP_STARTUP_POLICY.codexStartupTimeoutSeconds,
    tool_timeout_sec: 900,
  });
});

it("drops malformed registration fields from a local command entry", async () => {
  const root = await createTestTempDirectory("rea-registration-schema-");
  const configPath = join(root, "mcp.json");
  const client: SetupClient = { name: "cursor", format: "json", configPath };
  const existing = {
    ...clientRegistrationEntry("json", ["rea-old", "mcp"], environment),
    timeout: 600000,
    startup_timeout_sec: "30",
    tools: "*",
  };
  await writeFile(
    configPath,
    serializeClientConfiguration(configurationWith("json", existing), "json"),
  );
  expect(await configureClientConfiguration(client, {}, command)).toMatchObject(
    { status: "configured" },
  );
  expect(
    parseClientConfiguration(await readFile(configPath, "utf8"), "json").servers
      .rea,
  ).toEqual({
    ...clientRegistrationEntry("json", command, environment),
    timeout: 600000,
  });
});

it("drops malformed activation switches from a local command entry", async () => {
  const root = await createTestTempDirectory("rea-registration-switches-");
  const configPath = join(root, "mcp.json");
  const client: SetupClient = { name: "cursor", format: "json", configPath };
  const existing = {
    ...clientRegistrationEntry("json", ["rea-old", "mcp"], environment),
    timeout: 600000,
    enabled: "false",
    disabled: "true",
  };
  await writeFile(
    configPath,
    serializeClientConfiguration(configurationWith("json", existing), "json"),
  );
  expect(await configureClientConfiguration(client, {}, command)).toMatchObject(
    { status: "configured" },
  );
  expect(
    parseClientConfiguration(await readFile(configPath, "utf8"), "json").servers
      .rea,
  ).toEqual({
    ...clientRegistrationEntry("json", command, environment),
    timeout: 600000,
  });
});

it("drops a Qwen tcp endpoint from a local command entry", async () => {
  const root = await createTestTempDirectory("rea-registration-tcp-");
  const configPath = join(root, "settings.json");
  const client: SetupClient = {
    name: "qwen_code",
    format: "json",
    configPath,
  };
  const existing = {
    ...clientRegistrationEntry("json", ["rea-old", "mcp"], environment),
    timeout: 600000,
    tcp: "ws://stale.example/mcp",
  };
  await writeFile(
    configPath,
    serializeClientConfiguration(configurationWith("json", existing), "json"),
  );
  expect(await configureClientConfiguration(client, {}, command)).toMatchObject(
    { status: "configured" },
  );
  expect(
    parseClientConfiguration(await readFile(configPath, "utf8"), "json").servers
      .rea,
  ).toEqual({
    ...clientRegistrationEntry("json", command, environment),
    timeout: 600000,
  });
});

it("replaces a remote server entry instead of merging its fields", async () => {
  const root = await createTestTempDirectory("rea-registration-remote-");
  const configPath = join(root, "mcp.json");
  const client: SetupClient = { name: "cursor", format: "json", configPath };
  await writeFile(
    configPath,
    JSON.stringify({
      mcpServers: {
        rea: {
          url: "https://stale.example/mcp",
          headers: { Authorization: "Bearer stale" },
          timeout: 5000,
        },
      },
    }),
  );
  expect(await configureClientConfiguration(client, {}, command)).toMatchObject(
    { status: "configured" },
  );
  expect(
    parseClientConfiguration(await readFile(configPath, "utf8"), "json").servers
      .rea,
  ).toEqual(clientRegistrationEntry("json", command, {}));
});

it.each([
  ["tool_timeout_sec", "900"],
  ["enabled_tools", "analyze_function"],
  ["disabled_tools", [123]],
] as const)(
  "repairs invalid Codex field %s before reporting alignment",
  async (field, value) => {
    const root = await createTestTempDirectory("rea-codex-field-repair-");
    const configPath = join(root, "config.toml");
    const client: SetupClient = { name: "codex", format: "toml", configPath };
    await writeFile(
      configPath,
      serializeClientConfiguration(
        {
          mcp_servers: {
            rea: {
              command: "rea",
              args: ["mcp"],
              [field]: value,
              timeout_note: "keep",
            },
          },
        },
        "toml",
      ),
    );
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("configured");
    const entry = parseClientConfiguration(
      await readFile(configPath, "utf8"),
      "toml",
    ).servers.rea;
    expect(entry).not.toHaveProperty(field);
    expect(entry).toHaveProperty("timeout_note", "keep");
    expect(await clientConfigurationAligned(client, {}, command)).toBe(true);
    expect(
      (await configureClientConfiguration(client, {}, command)).status,
    ).toBe("unchanged");
  },
);
