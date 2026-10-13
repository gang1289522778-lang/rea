import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { npxRegistrationCommand } from "../../../src/application/ClientRegistrationIdentity.js";

cliTest(
  "first-run local planning distinguishes a selected client from a detected client",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-claude-first-run-");
    const result = await cli.run({
      arguments: [
        "setup",
        "--scope",
        "local",
        "--project",
        home,
        "--client",
        "claude_code",
        "--dry-run",
        "--json",
      ],
      environment: { HOME: home, USERPROFILE: home },
      timeoutMs: 60_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      status: "planned",
      clientStates: [
        expect.objectContaining({
          client: expect.objectContaining({ name: "claude_code" }),
          detected: false,
          configured: false,
        }),
      ],
    });
    expect(await readdir(home)).toEqual([]);
  },
  120_000,
);

cliTest(
  "local setup stays ready when an unrelated user server table is null",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-claude-shadowed-table-");
    const config = join(home, ".claude.json");
    await writeFile(config, '{"mcpServers":null,"keep":true}');
    const result = await cli.run({
      arguments: [
        "setup",
        "--scope",
        "local",
        "--project",
        home,
        "--client",
        "claude_code",
        "--yes",
        "--json",
      ],
      environment: { HOME: home, USERPROFILE: home },
      timeoutMs: 60_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ status: "ready" });
    expect(JSON.parse(await readFile(config, "utf8"))).toMatchObject({
      mcpServers: null,
      keep: true,
    });
  },
  120_000,
);

cliTest(
  "reports invalid local project paths as structured failures without writes",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-claude-project-path-");
    const config = join(home, ".claude.json");
    const original = '{"keep":true}';
    await writeFile(config, original);
    const environment = { HOME: home, USERPROFILE: home };
    for (const project of [join(home, "missing"), config]) {
      for (const command of ["setup", "uninstall"]) {
        const result = await cli.run({
          arguments: [
            command,
            "--scope",
            "local",
            "--project",
            project,
            "--json",
            ...(command === "setup"
              ? ["--client", "claude_code", "--yes"]
              : []),
          ],
          environment,
          timeoutMs: 60_000,
        });
        expect(result.exitCode).toBe(1);
        expect(result.json).toMatchObject({
          code: "invalid_request",
          details: { issues: [expect.objectContaining({ path: ["project"] })] },
        });
        expect(JSON.stringify(result.json)).toContain(
          "existing, readable directory",
        );
        expect(await readFile(config, "utf8")).toBe(original);
      }
    }
  },
  120_000,
);

cliTest(
  "rejects incompatible local scope flags before changing configuration",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-claude-invalid-scope-");
    const config = join(home, ".claude.json");
    const original = '{"keep":true}';
    await writeFile(config, original);
    const environment = { HOME: home, USERPROFILE: home };
    for (const arguments_ of [
      ["setup", "--scope", "local", "--client", "cursor", "--yes"],
      [
        "setup",
        "--scope",
        "local",
        "--client",
        "claude_code",
        "--skill",
        "--yes",
      ],
      ["uninstall", "--scope", "local", "--purge-data"],
      ["uninstall", "--project", home],
    ]) {
      const result = await cli.run({
        arguments: [...arguments_, "--json"],
        environment,
        timeoutMs: 60_000,
      });
      expect(result.exitCode).toBe(1);
      expect(await readFile(config, "utf8")).toBe(original);
    }
  },
  120_000,
);

cliTest(
  "private Claude Code setup and uninstall preserve user and peer project settings",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-claude-scope-cycle-");
    const project = join(home, "分析 project");
    const other = join(home, "other");
    await Promise.all([mkdir(project), mkdir(other)]);
    await mkdir(join(project, ".git"));
    const key =
      process.platform === "win32" ? project.replaceAll("\\", "/") : project;
    const config = join(home, ".claude.json");
    const original = {
      mcpServers: { rea: { command: "foreign-user", args: [] } },
      projects: {
        [key]: { trust: true, mcpServers: { peer: { command: "peer" } } },
        untouched: { mcpServers: { rea: { command: "foreign-project" } } },
      },
      keep: 42,
    };
    const bytes = JSON.stringify(original);
    await writeFile(config, bytes);
    const environment = { HOME: home, USERPROFILE: home };
    const setupArgs = [
      "setup",
      "--client",
      "claude_code",
      "--scope",
      "local",
      "--project",
      project,
      "--json",
    ];
    const dry = await cli.run({
      arguments: [...setupArgs, "--dry-run"],
      cwd: other,
      environment,
      timeoutMs: 60_000,
    });
    expect(dry.exitCode).toBe(0);
    expect(JSON.stringify(dry.json)).toContain("Private local scope");
    expect(await readFile(config, "utf8")).toBe(bytes);
    const setup = await cli.run({
      arguments: [...setupArgs, "--yes"],
      cwd: other,
      environment,
      timeoutMs: 60_000,
    });
    expect(setup.exitCode).toBe(0);
    expect(setup.json).toMatchObject({ status: "ready" });
    const configured = JSON.parse(await readFile(config, "utf8"));
    expect(configured.mcpServers).toEqual(original.mcpServers);
    expect(configured.projects.untouched).toEqual(original.projects.untouched);
    expect(configured.projects[key]).toMatchObject({
      trust: true,
      mcpServers: { peer: { command: "peer" } },
    });
    expect(configured.projects[key].mcpServers.rea.command).toBeTypeOf(
      "string",
    );
    expect(await readFile(`${config}.rea.backup`, "utf8")).toBe(bytes);
    const configuredBytes = await readFile(config, "utf8");
    const repeat = await cli.run({
      arguments: [...setupArgs, "--yes"],
      cwd: other,
      environment,
      timeoutMs: 60_000,
    });
    expect(repeat.exitCode).toBe(0);
    expect(await readFile(config, "utf8")).toBe(configuredBytes);
    const diagnosis = await cli.run({
      arguments: [
        "doctor",
        "--client",
        "claude_code",
        "--project",
        project,
        "--json",
      ],
      cwd: other,
      environment,
      timeoutMs: 60_000,
    });
    expect(diagnosis.exitCode).toBe(0);
    expect(diagnosis.json).toMatchObject({ healthy: true });
    const uninstallArgs = [
      "uninstall",
      "--scope",
      "local",
      "--project",
      project,
      "--json",
    ];
    const uninstall = await cli.run({
      arguments: uninstallArgs,
      cwd: other,
      environment,
      timeoutMs: 60_000,
    });
    expect(uninstall.exitCode).toBe(0);
    expect(JSON.parse(await readFile(config, "utf8"))).toEqual(original);
    const removedBytes = await readFile(config, "utf8");
    const twice = await cli.run({
      arguments: uninstallArgs,
      cwd: other,
      environment,
      timeoutMs: 60_000,
    });
    expect(twice.exitCode).toBe(0);
    expect(await readFile(config, "utf8")).toBe(removedBytes);
    expect(await readFile(`${config}.rea.backup`, "utf8")).toBe(bytes);
  },
  240_000,
);

cliTest(
  "doctor recognizes a private Claude Code registration only in the selected project",
  async ({ cli }) => {
    const home = await createTestTempDirectory("rea-claude-local-cli-");
    const project = join(home, "分析 project");
    const other = join(home, "other");
    const nested = join(project, "src");
    await Promise.all([mkdir(project), mkdir(other)]);
    await Promise.all([mkdir(nested), mkdir(join(project, ".git"))]);
    const [command, ...args] = npxRegistrationCommand();
    const config = join(home, ".claude.json");
    const projectKey =
      process.platform === "win32" ? project.replaceAll("\\", "/") : project;
    const original = JSON.stringify({
      mcpServers: {
        rea: { command, args, env: { REA_LOG_LEVEL: "invalid-level" } },
      },
      projects: { [projectKey]: { mcpServers: { rea: { command, args } } } },
    });
    await writeFile(config, original);
    const environment = { HOME: home, USERPROFILE: home };
    const local = await cli.run({
      arguments: ["doctor", "--client", "claude_code", "--json"],
      cwd: nested,
      environment,
      timeoutMs: 60_000,
    });
    expect(local.exitCode).toBe(0);
    expect(local.json).toMatchObject({
      healthy: true,
      identity: {
        registrations: [
          expect.objectContaining({
            client: "claude_code",
            state: "aligned",
            registration_scope: "local",
            project_directory: projectKey,
          }),
        ],
      },
    });
    const elsewhere = await cli.run({
      arguments: ["doctor", "--client", "claude_code", "--json"],
      cwd: other,
      environment,
      timeoutMs: 60_000,
    });
    expect(elsewhere.exitCode).toBe(1);
    expect(elsewhere.json).toMatchObject({
      healthy: false,
      identity: {
        registrations: [
          expect.objectContaining({
            client: "claude_code",
            state: "invalid",
          }),
        ],
      },
    });
    expect(await readFile(config, "utf8")).toBe(original);
  },
  120_000,
);

const cases = [
  {
    client: "cursor",
    path: ".cursor/mcp.json",
    text: "malformed UTF-8",
    bytes: Buffer.concat([
      Buffer.from('{"label":"'),
      Buffer.from([0xff]),
      Buffer.from('"}'),
    ]),
    diagnostic: "not valid UTF-8",
  },
  {
    client: "cursor",
    path: ".cursor/mcp.json",
    text: "[]",
    diagnostic: "The configuration root must be an object",
  },
  {
    client: "cursor",
    path: ".cursor/mcp.json",
    text: "null",
    diagnostic: "The configuration root must be an object",
  },
  {
    client: "cursor",
    path: ".cursor/mcp.json",
    text: '{"mcpServers":null,"keep":1}',
    diagnostic: '"mcpServers" must be an object',
  },
  {
    client: "cursor",
    path: ".cursor/mcp.json",
    text: '{"mcpServers":"x","keep":1}',
    diagnostic: '"mcpServers" must be an object',
  },
  {
    client: "pi",
    path: ".pi/agent/mcp.json",
    text: '{"mcpServers":[]}',
    diagnostic: '"mcpServers" must be an object',
  },
  {
    client: "codex",
    path: ".codex/config.toml",
    text: 'mcp_servers = "x"\n',
    diagnostic: '"mcp_servers" must be an object',
  },
  {
    client: "opencode",
    path: ".config/opencode/opencode.json",
    text: '{"mcp":{"servers":null}}',
    diagnostic: '"mcp.servers" must be an object',
  },
  {
    client: "hermes",
    path: ".hermes/config.yaml",
    text: "- item\n",
    diagnostic: "The configuration root must be an object",
  },
  {
    client: "hermes",
    path: ".hermes/config.yaml",
    text: "mcp_servers: null\nkeep: 1\n",
    diagnostic: '"mcp_servers" must be an object',
  },
  {
    client: "cursor",
    path: ".cursor/mcp.json",
    text: "not-json",
    diagnostic: "Configuration is not valid JSON",
    syntax: "JSON",
  },
  {
    client: "hermes",
    path: ".hermes/config.yaml",
    text: "mcp_servers: [\n",
    diagnostic: "Configuration is not valid YAML",
    syntax: "YAML",
  },
  {
    client: "dsh",
    path: ".dsh/cordis.patch.yml",
    text: "- insert: [\n",
    diagnostic: "Configuration is not valid YAML",
    syntax: "YAML",
  },
] as const;

for (const scenario of cases)
  cliTest(
    `setup and uninstall explain ${scenario.client} configuration ${scenario.text}`,
    async ({ cli }) => {
      const home = await createTestTempDirectory(
        "rea-client-config-diagnostic-",
      );
      const config = join(home, scenario.path);
      await mkdir(dirname(config), { recursive: true });
      const original =
        "bytes" in scenario ? scenario.bytes : Buffer.from(scenario.text);
      await writeFile(config, original);
      const environment = {
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        HERMES_HOME: join(home, ".hermes"),
        DSH_HOME: join(home, ".dsh"),
      };
      const setup = await cli.run({
        arguments: [
          "setup",
          "--client",
          scenario.client,
          "--skill=false",
          "--yes",
          "--json",
        ],
        cwd: home,
        environment,
      });
      expect(setup.exitCode).toBe(1);
      expect(setup.json).toMatchObject({
        status: "needs_human",
        plannedActions: [],
        appliedActions: [],
      });
      if ("syntax" in scenario) {
        expect(setup.json).toMatchObject({ remediation: expect.any(String) });
        if (scenario.syntax === "JSON")
          expect(setup.stdout).toContain("Invalid JSON/JSONC");
      } else {
        expect(setup.json).toMatchObject({
          remediation: expect.stringContaining(scenario.diagnostic),
        });
        expect(setup.stdout).not.toContain("invalid_type");
      }
      const uninstall = await cli.run({
        arguments: ["uninstall", "--json"],
        cwd: home,
        environment,
      });
      expect(uninstall.exitCode).toBe(1);
      expect(uninstall.json).toMatchObject({
        status: "failed",
        items: expect.arrayContaining([
          expect.objectContaining({
            name: scenario.client,
            status: "failed",
            detail: expect.stringContaining(scenario.diagnostic),
          }),
        ]),
      });
      if (!("syntax" in scenario))
        expect(uninstall.stdout).not.toContain("not valid JSON");
      expect(await readFile(config)).toEqual(original);
      expect(await readdir(dirname(config))).toEqual([
        scenario.path.split("/").at(-1),
      ]);
    },
  );
