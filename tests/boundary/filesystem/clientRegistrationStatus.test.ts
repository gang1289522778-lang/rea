import { mkdir, writeFile, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { clearClientLocationEnvironment } from "../../fixtures/clientEnvironment.js";

import { readClientRegistrationStatuses } from "../../../src/application/ClientRegistrationStatus.js";
import { PRODUCT_IDENTITY } from "../../../src/identity.js";
import { npxRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";

beforeEach(clearClientLocationEnvironment);
afterEach(() => {
  vi.unstubAllEnvs();
});

it("keeps a nonexistent requested project invalid instead of reporting user readiness", async () => {
  const home = await createTestTempDirectory("rea-claude-missing-project-");
  const workspaceDirectory = join(home, "missing");
  const [command, ...args] = npxRegistrationCommand();
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { rea: { command, args } } }),
  );
  expect(
    await readClientRegistrationStatuses(home, "/current/rea", {
      environment: {},
      workspaceDirectory,
    }),
  ).toEqual([
    expect.objectContaining({
      state: "invalid",
      requested_project_directory: workspaceDirectory,
      command: [],
    }),
  ]);
});

it("recognizes an ordinary separate Git directory without worktree commondir", async () => {
  const home = await createTestTempDirectory("rea-claude-git-file-");
  const workspaceDirectory = join(home, "project");
  const metadata = join(home, "metadata");
  await Promise.all([mkdir(workspaceDirectory), mkdir(metadata)]);
  await writeFile(join(workspaceDirectory, ".git"), `gitdir: ${metadata}\n`);
  const key =
    process.platform === "win32"
      ? workspaceDirectory.replaceAll("\\", "/")
      : workspaceDirectory;
  const [command, ...args] = npxRegistrationCommand();
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({
      projects: { [key]: { mcpServers: { rea: { command, args } } } },
    }),
  );
  expect(
    await readClientRegistrationStatuses(home, "/current/rea", {
      environment: {},
      workspaceDirectory,
    }),
  ).toEqual([
    expect.objectContaining({ state: "aligned", project_directory: key }),
  ]);
});

it("recognizes a Git directory junction as a project marker", async () => {
  const home = await createTestTempDirectory("rea-claude-git-junction-");
  const project = join(home, "project");
  const metadata = join(home, "metadata");
  const nested = join(project, "src");
  await Promise.all([mkdir(nested, { recursive: true }), mkdir(metadata)]);
  await symlink(
    metadata,
    join(project, ".git"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const [command, ...args] = npxRegistrationCommand();
  const key =
    process.platform === "win32" ? project.replaceAll("\\", "/") : project;
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({
      projects: { [key]: { mcpServers: { rea: { command, args } } } },
    }),
  );
  expect(
    await readClientRegistrationStatuses(home, "/current/rea", {
      environment: {},
      workspaceDirectory: nested,
    }),
  ).toEqual([
    expect.objectContaining({ state: "aligned", project_directory: key }),
  ]);
});

it("discovers a Claude Code local registration only for its selected project", async () => {
  const home = await createTestTempDirectory("rea-claude-local-");
  await mkdir(join(home, "other"));
  const workspaceDirectory = join(home, "分析 project");
  await mkdir(workspaceDirectory, { recursive: true });
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({
      projects: {
        [workspaceDirectory]: {
          mcpServers: {
            rea: {
              command: "npx",
              args: [
                "-y",
                PRODUCT_IDENTITY.registrationPackageSpecifier,
                "mcp",
              ],
            },
          },
        },
      },
    }),
  );
  const options = {
    platform: "linux" as const,
    environment: {},
    workspaceDirectory,
  };
  expect(
    await readClientRegistrationStatuses(home, "/current/rea", options),
  ).toEqual([
    expect.objectContaining({
      client: "claude_code",
      state: "aligned",
      registration_scope: "local",
      project_directory: workspaceDirectory,
    }),
  ]);
  expect(
    await readClientRegistrationStatuses(home, "/current/rea", {
      ...options,
      workspaceDirectory: join(home, "other"),
    }),
  ).toEqual([
    expect.objectContaining({ state: "missing", registration_scope: "user" }),
  ]);
  // Maintenance callers without a workspace still inspect the global write target.
  expect(
    await readClientRegistrationStatuses(home, "/current/rea", {
      environment: {},
    }),
  ).toEqual([expect.objectContaining({ state: "missing" })]);
});

it("recognizes native client project keys from nested Git and worktree directories", async () => {
  const home = await createTestTempDirectory("rea-claude-native-key-");
  const project = join(home, "分析 project");
  const nested = join(project, "src");
  await mkdir(nested, { recursive: true });
  await mkdir(join(project, ".git"));
  const projectKey =
    process.platform === "win32" ? project.replaceAll("\\", "/") : project;
  const [command, ...args] = npxRegistrationCommand();
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({
      projects: {
        [projectKey]: { mcpServers: { rea: { command, args } } },
        [nested]: { mcpServers: { rea: { command: "wrong-subdirectory" } } },
      },
    }),
  );
  expect(
    await readClientRegistrationStatuses(home, "/current/rea", {
      environment: {},
      workspaceDirectory: nested,
    }),
  ).toEqual([
    expect.objectContaining({
      state: "aligned",
      project_directory: projectKey,
      registration_scope: "local",
    }),
  ]);
  // Claude Code shares a worktree's private registration with the original checkout.
  const worktree = join(nested, "worktree");
  await mkdir(worktree);
  const metadata = join(project, ".git", "worktrees", "fixture");
  await mkdir(metadata, { recursive: true });
  await writeFile(join(worktree, ".git"), `gitdir: ${metadata}\n`);
  await writeFile(join(metadata, "commondir"), "../..\n");
  expect(
    await readClientRegistrationStatuses(home, "/current/rea", {
      environment: {},
      workspaceDirectory: worktree,
    }),
  ).toEqual([
    expect.objectContaining({
      state: "aligned",
      registration_scope: "local",
      project_directory: projectKey,
    }),
  ]);
});

it("uses the whole local entry before the user entry, without merging fields", async () => {
  const home = await createTestTempDirectory("rea-claude-precedence-");
  const workspaceDirectory = join(home, "project");
  await mkdir(workspaceDirectory, { recursive: true });
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        rea: {
          command: "npx",
          args: ["-y", PRODUCT_IDENTITY.registrationPackageSpecifier, "mcp"],
        },
      },
      projects: {
        [workspaceDirectory]: {
          mcpServers: { rea: { command: "/old/rea" } },
        },
      },
    }),
  );
  expect(
    await readClientRegistrationStatuses(home, "/current/rea", {
      platform: "linux",
      environment: {},
      workspaceDirectory,
    }),
  ).toEqual([
    expect.objectContaining({
      state: "stale",
      command: ["/old/rea"],
      registration_scope: "local",
      project_directory: workspaceDirectory,
    }),
  ]);
});

it.each([
  "invalid-pointer",
  "missing-directory",
  "oversized-common",
  "non-directory-common",
  "missing-linked-common",
] as const)(
  "keeps unresolved Git project metadata %s invalid",
  async (scenario) => {
    const home = await createTestTempDirectory("rea-claude-git-metadata-");
    const project = join(home, "project");
    const metadata = join(home, "git-metadata");
    await mkdir(project);
    if (scenario !== "missing-directory") await mkdir(metadata);
    await writeFile(
      join(project, ".git"),
      scenario === "invalid-pointer"
        ? "not a Git directory pointer\n"
        : `gitdir: ${metadata}\n`,
    );
    if (scenario === "oversized-common")
      await writeFile(join(metadata, "commondir"), "x".repeat(128 * 1024 + 1));
    if (scenario === "missing-linked-common")
      await writeFile(join(metadata, "gitdir"), join(project, ".git"));
    if (scenario === "non-directory-common") {
      const common = join(home, "common-file");
      await writeFile(common, "not a directory");
      await writeFile(join(metadata, "commondir"), common);
    }
    const [command, ...args] = npxRegistrationCommand();
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { rea: { command, args } }, projects: {} }),
    );
    expect(
      await readClientRegistrationStatuses(home, "/current/rea", {
        environment: {},
        workspaceDirectory: project,
      }),
    ).toEqual([expect.objectContaining({ state: "invalid", command: [] })]);
  },
);

it.each([
  [null, "invalid", "rea setup --client claude_code --scope local --project"],
  [
    { command: "rea", args: null },
    "invalid",
    "rea setup --client claude_code --scope local --project",
  ],
  [
    { command: "/old/rea", args: ["mcp"], disabled: true },
    "stale",
    "Re-enable it in /mcp",
  ],
] as const)(
  "does not fall back from a rejected local entry %j",
  async (local, state, remediation) => {
    const home = await createTestTempDirectory("rea-claude-rejected-local-");
    const workspaceDirectory = join(home, "project");
    await mkdir(workspaceDirectory, { recursive: true });
    const projectKey =
      process.platform === "win32"
        ? workspaceDirectory.replaceAll("\\", "/")
        : workspaceDirectory;
    const [command, ...args] = npxRegistrationCommand();
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { rea: { command, args } },
        projects: { [projectKey]: { mcpServers: { rea: local } } },
      }),
    );
    expect(
      await readClientRegistrationStatuses(home, "/current/rea", {
        environment: {},
        workspaceDirectory,
      }),
    ).toEqual([
      expect.objectContaining({
        state,
        registration_scope: "local",
        project_directory: projectKey,
        remediation: expect.stringContaining(remediation),
      }),
    ]);
  },
);

it("uses the physical project when launched through a directory alias", async () => {
  const home = await createTestTempDirectory("rea-claude-project-alias-");
  const project = join(home, "project");
  const alias = join(home, "alias");
  await mkdir(project);
  await symlink(
    project,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const projectKey =
    process.platform === "win32" ? project.replaceAll("\\", "/") : project;
  const [command, ...args] = npxRegistrationCommand();
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({
      projects: { [projectKey]: { mcpServers: { rea: { command, args } } } },
    }),
  );
  expect(
    await readClientRegistrationStatuses(home, "/current/rea", {
      environment: {},
      workspaceDirectory: alias,
    }),
  ).toEqual([
    expect.objectContaining({
      state: "aligned",
      registration_scope: "local",
      project_directory: projectKey,
    }),
  ]);
});

it.each(["local", "user"] as const)(
  "reports a %s entry disabled by Claude Code's project policy as stale",
  async (scope) => {
    const home = await createTestTempDirectory("rea-claude-disabled-policy-");
    const workspaceDirectory = join(home, "project");
    await mkdir(workspaceDirectory, { recursive: true });
    const projectKey =
      process.platform === "win32"
        ? workspaceDirectory.replaceAll("\\", "/")
        : workspaceDirectory;
    const [command, ...args] = npxRegistrationCommand();
    const registration = { command, args, type: "stdio" };
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { rea: registration },
        projects: {
          [projectKey]: {
            disabledMcpServers: ["rea"],
            enabledMcpServers: ["rea"],
            mcpServers: scope === "local" ? { rea: registration } : {},
          },
        },
      }),
    );
    expect(
      await readClientRegistrationStatuses(home, "/current/rea", {
        environment: {},
        workspaceDirectory,
      }),
    ).toEqual([
      expect.objectContaining({
        state: "stale",
        registration_scope: scope,
        remediation: expect.stringContaining("Re-enable it in /mcp"),
      }),
    ]);
  },
);

it("rejects a local non-stdio transport even when it carries an aligned command", async () => {
  const home = await createTestTempDirectory("rea-claude-transport-");
  const workspaceDirectory = join(home, "project");
  await mkdir(workspaceDirectory, { recursive: true });
  const projectKey =
    process.platform === "win32"
      ? workspaceDirectory.replaceAll("\\", "/")
      : workspaceDirectory;
  const [command, ...args] = npxRegistrationCommand();
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({
      projects: {
        [projectKey]: {
          mcpServers: {
            rea: {
              command,
              args,
              type: "http",
              url: "https://example.invalid",
            },
          },
        },
      },
    }),
  );
  expect(
    await readClientRegistrationStatuses(home, "/current/rea", {
      environment: {},
      workspaceDirectory,
    }),
  ).toEqual([
    expect.objectContaining({ state: "invalid", registration_scope: "local" }),
  ]);
});

it("falls back to the user entry when the current project has only other servers", async () => {
  const home = await createTestTempDirectory("rea-claude-user-fallback-");
  const workspaceDirectory = join(home, "project");
  await mkdir(workspaceDirectory, { recursive: true });
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        rea: {
          command: "npx",
          args: ["-y", PRODUCT_IDENTITY.registrationPackageSpecifier, "mcp"],
        },
      },
      projects: {
        [workspaceDirectory]: { mcpServers: { other: { command: "other" } } },
      },
    }),
  );
  expect(
    await readClientRegistrationStatuses(home, "/current/rea", {
      platform: "linux",
      environment: {},
      workspaceDirectory,
    }),
  ).toEqual([
    expect.objectContaining({ state: "aligned", registration_scope: "user" }),
  ]);
});

it.each([null, [], "invalid"])(
  "keeps a malformed local server table %j invalid",
  async (servers) => {
    const home = await createTestTempDirectory("rea-claude-local-shape-");
    const workspaceDirectory = join(home, "project");
    await mkdir(workspaceDirectory, { recursive: true });
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          rea: {
            command: "npx",
            args: ["-y", PRODUCT_IDENTITY.registrationPackageSpecifier, "mcp"],
          },
        },
        projects: { [workspaceDirectory]: { mcpServers: servers } },
      }),
    );
    expect(
      await readClientRegistrationStatuses(home, "/current/rea", {
        platform: "linux",
        environment: {},
        workspaceDirectory,
      }),
    ).toEqual([
      expect.objectContaining({
        state: "invalid",
        command: [],
        project_directory: workspaceDirectory,
      }),
    ]);
  },
);

it("lets a valid local entry shadow an invalid user environment while maintenance still rejects it", async () => {
  const home = await createTestTempDirectory("rea-claude-shadowed-env-");
  const workspaceDirectory = join(home, "project");
  await mkdir(workspaceDirectory, { recursive: true });
  const registration = {
    command: "npx",
    args: ["-y", PRODUCT_IDENTITY.registrationPackageSpecifier, "mcp"],
  };
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        rea: { ...registration, env: { REA_LOG_LEVEL: "invalid-level" } },
      },
      projects: { [workspaceDirectory]: { mcpServers: { rea: registration } } },
    }),
  );
  const options = { platform: "linux" as const, environment: {} };
  expect(
    await readClientRegistrationStatuses(home, "/current/rea", {
      ...options,
      workspaceDirectory,
    }),
  ).toEqual([
    expect.objectContaining({ state: "aligned", registration_scope: "local" }),
  ]);
  expect(
    await readClientRegistrationStatuses(home, "/current/rea", options),
  ).toEqual([expect.objectContaining({ state: "invalid" })]);
});

it("validates the selected local environment without exposing its values", async () => {
  const home = await createTestTempDirectory("rea-claude-local-env-");
  const workspaceDirectory = join(home, "project");
  await mkdir(workspaceDirectory, { recursive: true });
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({
      projects: {
        [workspaceDirectory]: {
          mcpServers: {
            rea: {
              command: "npx",
              args: [
                "-y",
                PRODUCT_IDENTITY.registrationPackageSpecifier,
                "mcp",
              ],
              env: {
                REA_LOG_LEVEL: "invalid-level",
                SECRET: "private-value",
              },
            },
          },
        },
      },
    }),
  );
  const statuses = await readClientRegistrationStatuses(home, "/current/rea", {
    platform: "linux",
    environment: {},
    workspaceDirectory,
  });
  expect(statuses).toEqual([
    expect.objectContaining({
      state: "invalid",
      command: [],
      registration_scope: "local",
      project_directory: workspaceDirectory,
    }),
  ]);
  expect(JSON.stringify(statuses)).not.toContain("private-value");
});

describe("client registration status", () => {
  it("discovers Claude Code from its config file without a marker directory", async () => {
    const home = await createTestTempDirectory("rea-claude-config-only-");
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          rea: {
            command: "npx",
            args: ["-y", PRODUCT_IDENTITY.registrationPackageSpecifier, "mcp"],
          },
        },
      }),
    );

    const statuses = await readClientRegistrationStatuses(
      home,
      "/current/rea",
      { platform: "linux" },
    );

    expect(statuses).toEqual([
      expect.objectContaining({
        client: "claude_code",
        config_path: join(home, ".claude.json"),
        state: "aligned",
        remediation: null,
      }),
    ]);
  });

  it("distinguishes aligned, stale, missing, and invalid registrations", async () => {
    const home = await createTestTempDirectory("rea-registrations-");
    await Promise.all([
      mkdir(join(home, ".codex")),
      mkdir(join(home, ".cursor")),
      mkdir(join(home, ".gemini")),
      mkdir(join(home, ".claude")),
    ]);
    await writeFile(
      join(home, ".codex/config.toml"),
      `[mcp_servers.rea]\ncommand = "npx"\nargs = ["-y", "${PRODUCT_IDENTITY.registrationPackageSpecifier}", "mcp"]\nstartup_timeout_sec = 30\n`,
    );
    await writeFile(
      join(home, ".cursor/mcp.json"),
      JSON.stringify({
        mcpServers: {
          rea: { command: "/old/rea", args: ["mcp"], env: { SECRET: "x" } },
        },
      }),
    );
    await writeFile(join(home, ".gemini/settings.json"), "not-json");

    const statuses = await readClientRegistrationStatuses(
      home,
      "/current/rea",
      { platform: "linux" },
    );
    expect(statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          client: "codex",
          state: "aligned",
          remediation: null,
        }),
        expect.objectContaining({
          client: "cursor",
          state: "stale",
          command: ["/old/rea", "mcp"],
          remediation: expect.any(String),
        }),
        expect.objectContaining({
          client: "gemini_cli",
          state: "invalid",
          command: [],
          remediation: expect.any(String),
        }),
        expect.objectContaining({
          client: "claude_code",
          state: "missing",
          command: [],
          remediation: expect.any(String),
        }),
      ]),
    );
    expect(JSON.stringify(statuses)).not.toContain("SECRET");
  });

  it.each([null, [], "invalid"])(
    "reports a malformed server table %j as invalid",
    async (servers) => {
      const home = await createTestTempDirectory("rea-registration-shape-");
      await mkdir(join(home, ".cursor"));
      await writeFile(
        join(home, ".cursor/mcp.json"),
        JSON.stringify({ mcpServers: servers }),
      );
      expect(await readClientRegistrationStatuses(home)).toEqual([
        expect.objectContaining({
          client: "cursor",
          state: "invalid",
          command: [],
        }),
      ]);
    },
  );

  it("reports an unversioned npx registration as stale", async () => {
    const home = await createTestTempDirectory("rea-registrations-");
    await mkdir(join(home, ".codex"));
    await writeFile(
      join(home, ".codex/config.toml"),
      '[mcp_servers.rea]\ncommand = "npx"\nargs = ["-y", "rea-agents", "mcp"]\n',
    );

    const statuses = await readClientRegistrationStatuses(home);

    expect(statuses).toEqual([
      expect.objectContaining({
        client: "codex",
        command: ["npx", "-y", "rea-agents", "mcp"],
        state: "stale",
      }),
    ]);
  });
});

describe("commandcode registration status", () => {
  const writeCommandcodeRegistration = async (
    home: string,
    registration: Record<string, unknown>,
  ): Promise<void> => {
    await mkdir(join(home, ".commandcode"));
    await writeFile(
      join(home, ".commandcode/mcp.json"),
      JSON.stringify({ mcpServers: { rea: registration } }),
    );
  };

  const ownedArgs = (): readonly string[] => [
    "-y",
    PRODUCT_IDENTITY.registrationPackageSpecifier,
    "mcp",
  ];

  it.each([undefined, "sse"])(
    "reports transport %j as invalid",
    async (transport) => {
      const home = await createTestTempDirectory("rea-commandcode-transport-");
      await writeCommandcodeRegistration(home, {
        ...(transport === undefined ? {} : { transport }),
        command: "npx",
        args: [...ownedArgs()],
      });

      expect(await readClientRegistrationStatuses(home)).toEqual([
        expect.objectContaining({
          client: "commandcode",
          state: "invalid",
          command: [],
        }),
      ]);
    },
  );

  it("reports a disabled registration as stale", async () => {
    const home = await createTestTempDirectory("rea-commandcode-disabled-");
    await writeCommandcodeRegistration(home, {
      transport: "stdio",
      enabled: false,
      command: "npx",
      args: [...ownedArgs()],
    });

    expect(await readClientRegistrationStatuses(home)).toEqual([
      expect.objectContaining({
        client: "commandcode",
        state: "stale",
      }),
    ]);
  });
});

describe("Node-wrapped registration policy", () => {
  it.each([1, 30])(
    "checks Codex startup timeout %d independently of launcher",
    async (timeout) => {
      const home = await createTestTempDirectory("rea-node-registration-");
      await mkdir(join(home, ".codex"));
      const entry = resolve("scripts/rea.mjs");
      await writeFile(
        join(home, ".codex/config.toml"),
        `[mcp_servers.rea]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(entry)}, "mcp"]\nstartup_timeout_sec = ${String(timeout)}\n`,
      );
      const statuses = await readClientRegistrationStatuses(home, entry, {
        environment: {},
      });
      expect(statuses).toEqual([
        expect.objectContaining({
          client: "codex",
          state: timeout === 30 ? "aligned" : "stale",
        }),
      ]);
    },
  );

  it.each([1, 30])(
    "checks Grok Build startup timeout %d independently of launcher",
    async (timeout) => {
      const home = await createTestTempDirectory("rea-grok-registration-");
      await mkdir(join(home, ".grok"));
      const entry = resolve("scripts/rea.mjs");
      await writeFile(
        join(home, ".grok/config.toml"),
        `[mcp_servers.rea]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(entry)}, "mcp"]\nstartup_timeout_sec = ${String(timeout)}\n`,
      );
      const statuses = await readClientRegistrationStatuses(home, entry, {
        environment: {},
      });
      expect(statuses).toEqual([
        expect.objectContaining({
          client: "grok_build",
          state: timeout === 30 ? "aligned" : "stale",
        }),
      ]);
    },
  );

  it("reports Grok Build stale when rea is listed in disabled_mcp_servers", async () => {
    const home = await createTestTempDirectory("rea-grok-disabled-status-");
    await mkdir(join(home, ".grok"));
    const entry = resolve("scripts/rea.mjs");
    await writeFile(
      join(home, ".grok/config.toml"),
      `disabled_mcp_servers = ["rea"]\n[mcp_servers.rea]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(entry)}, "mcp"]\nstartup_timeout_sec = 30\n`,
    );
    expect(
      await readClientRegistrationStatuses(home, entry, { environment: {} }),
    ).toEqual([
      expect.objectContaining({ client: "grok_build", state: "stale" }),
    ]);
  });

  it("checks a direct-launcher Codex startup timeout without Node wrapping", async () => {
    const home = await createTestTempDirectory("rea-direct-registration-");
    await mkdir(join(home, ".codex"));
    await writeFile(
      join(home, ".codex/config.toml"),
      '[mcp_servers.rea]\ncommand = "/current/rea"\nargs = ["mcp"]\nstartup_timeout_sec = 1\n',
    );
    const statuses = await readClientRegistrationStatuses(
      home,
      "/current/rea",
      {
        environment: {},
      },
    );
    expect(statuses).toEqual([
      expect.objectContaining({ client: "codex", state: "stale" }),
    ]);
  });

  it.each([{ tools: ["binary_session"] }, { tools: ["*"] }])(
    "checks Copilot tool selection $tools independently of launcher",
    async ({ tools }) => {
      const home = await createTestTempDirectory("rea-node-copilot-");
      await mkdir(join(home, ".copilot"));
      const entry = resolve("scripts/rea.mjs");
      await writeFile(
        join(home, ".copilot/mcp-config.json"),
        JSON.stringify({
          mcpServers: {
            rea: {
              type: "stdio",
              command: process.execPath,
              args: [entry, "mcp"],
              tools,
            },
          },
        }),
      );
      const statuses = await readClientRegistrationStatuses(home, entry, {
        environment: {},
      });
      expect(statuses).toEqual([
        expect.objectContaining({
          client: "copilot_cli",
          state: tools.includes("*") ? "aligned" : "stale",
        }),
      ]);
    },
  );
});

it("retains the resolved project on malformed project policy without guessing registration scope", async () => {
  const home = await createTestTempDirectory(
    "rea-claude-invalid-policy-project-",
  );
  const workspaceDirectory = join(home, "project");
  await mkdir(workspaceDirectory, { recursive: true });
  await writeFile(
    join(home, ".claude.json"),
    JSON.stringify({
      projects: { [workspaceDirectory]: { disabledMcpServers: null } },
    }),
  );
  const statuses = await readClientRegistrationStatuses(home, "/current/rea", {
    platform: "linux",
    environment: {},
    workspaceDirectory,
  });
  expect(statuses).toEqual([
    expect.objectContaining({
      state: "invalid",
      project_directory: workspaceDirectory,
    }),
  ]);
  expect(statuses[0]).not.toHaveProperty("registration_scope");
});
