import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseClientConfiguration } from "../../../src/application/ClientConfigurationDocument.js";
import { clientRegistrationEnvironment } from "../../../src/application/ClientRegistrationEnvironment.js";
import { npxRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";
import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { supportedClients } from "../../../src/application/SupportedClients.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";

const command = npxRegistrationCommand("win32");

beforeEach(clearClientLocationEnvironment);
afterEach(() => vi.unstubAllEnvs());

describe("Kimi Code environment-key identity", () => {
  it("keeps one env key for a case-variant explicit profile on Windows", () => {
    const merged = clientRegistrationEnvironment(
      parseClientConfiguration(
        JSON.stringify({
          mcpServers: {
            rea: {
              command: command[0],
              args: command.slice(1),
              env: { rea_mcp_input_schema_profile: "full" },
            },
          },
        }),
        "json",
      ),
      {},
      { REA_MCP_INPUT_SCHEMA_PROFILE: "compact" },
      "win32",
    );
    if (!merged.ok) throw merged.error;
    expect(merged.value).toEqual({ rea_mcp_input_schema_profile: "full" });
  });

  it.each(["bogus", ""])(
    "rejects a case-variant invalid profile %j on Windows",
    (profile) => {
      const parsed = parseClientConfiguration(
        JSON.stringify({
          mcpServers: {
            rea: {
              command: command[0],
              args: command.slice(1),
              env: {
                rea_mcp_input_schema_profile: profile,
                CallerChoice: "keep",
              },
            },
          },
        }),
        "json",
      );
      const result = clientRegistrationEnvironment(
        parsed,
        {},
        { REA_MCP_INPUT_SCHEMA_PROFILE: "compact" },
        "win32",
      );
      expect(result).toMatchObject({
        ok: false,
        error: { settings: [{ setting: "REA_MCP_INPUT_SCHEMA_PROFILE" }] },
      });
    },
  );

  it("uses Node's source-layer winner and preserves explicit override spelling", () => {
    const parsed = parseClientConfiguration(
      JSON.stringify({
        mcpServers: {
          rea: {
            command: command[0],
            args: command.slice(1),
            env: {
              rea_mcp_input_schema_profile: "bogus",
              REA_MCP_INPUT_SCHEMA_PROFILE: "full",
              CallerChoice: "keep",
            },
          },
        },
      }),
      "json",
    );
    const existing = clientRegistrationEnvironment(parsed, {}, {}, "win32");
    expect(existing).toMatchObject({
      ok: true,
      value: {
        REA_MCP_INPUT_SCHEMA_PROFILE: "full",
        CallerChoice: "keep",
      },
    });
    if (existing.ok) expect(Object.keys(existing.value)).toHaveLength(2);
    expect(
      clientRegistrationEnvironment(
        parsed,
        { Rea_Mcp_Input_Schema_Profile: "compact" },
        {},
        "win32",
      ),
    ).toMatchObject({
      ok: true,
      value: {
        Rea_Mcp_Input_Schema_Profile: "compact",
        CallerChoice: "keep",
      },
    });
  });

  it.each([
    ["full", "aligned"],
    ["bogus", "invalid"],
    ["", "invalid"],
  ] as const)(
    "reports a case-variant %j profile as %s on Windows",
    async (profile, state) => {
      const home = await createTestTempDirectory("rea-kimi-");
      const client = supportedClients(home, process.platform, {}).find(
        ({ name }) => name === "kimi_code",
      );
      if (client?.markerPath === undefined)
        throw new Error("missing Kimi Code client");
      await mkdir(client.markerPath, { recursive: true });
      await writeFile(
        client.configPath,
        JSON.stringify({
          mcpServers: {
            rea: {
              command: command[0],
              args: command.slice(1),
              env: { rea_mcp_input_schema_profile: profile },
            },
          },
        }),
      );
      const status = (
        await readClientRegistrationStatuses(home, resolve("scripts/rea.mjs"), {
          environment: {},
          platform: "win32",
        })
      ).find(({ client: name }) => name === "kimi_code");
      expect(status).toMatchObject({ state });
    },
  );
});
