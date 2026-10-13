import { describe, expect, it } from "vitest";

import {
  parseClientConfiguration,
  claudeCodeRegistrationConfiguration,
  withClientServers,
} from "./ClientConfigurationDocument.js";

it("does not select a Windows backslash alias that native Claude ignores", () => {
  const directory = "C:\\work\\project";
  const original = {
    mcpServers: { rea: { command: "user" } },
    projects: { [directory]: { mcpServers: { rea: { command: "ignored" } } } },
  };
  const parsed = parseClientConfiguration(JSON.stringify(original), "json");
  const effective = claudeCodeRegistrationConfiguration(parsed, directory, {
    platform: "win32",
  });
  expect(effective.serversPath).toEqual(["mcpServers"]);
  const local = parseClientConfiguration(
    JSON.stringify(original),
    "json",
    directory,
    { platform: "win32" },
  );
  expect(local.serversPath).toEqual([
    "projects",
    "C:/work/project",
    "mcpServers",
  ]);
  expect(withClientServers(local, { rea: { command: "new-local" } })).toEqual({
    ...original,
    projects: {
      ...original.projects,
      "C:/work/project": { mcpServers: { rea: { command: "new-local" } } },
    },
  });
});

it("selects native Windows project keys using the injected platform", () => {
  const parsed = parseClientConfiguration(
    JSON.stringify({
      projects: {
        "C:/work/project": { mcpServers: { rea: { command: "local" } } },
      },
    }),
    "json",
  );
  const selected = claudeCodeRegistrationConfiguration(
    parsed,
    "C:\\work\\project",
    { platform: "win32" },
  );
  expect(selected.serversPath).toEqual([
    "projects",
    "C:/work/project",
    "mcpServers",
  ]);
});

it("creates an exact local target without inheriting user servers", () => {
  const original = {
    mcpServers: { rea: { command: "user" }, peer: { command: "user-peer" } },
    keep: true,
  };
  const selected = parseClientConfiguration(
    JSON.stringify(original),
    "json",
    "/new/project",
  );
  expect(selected.servers).toEqual({});
  expect(withClientServers(selected, { rea: { command: "local" } })).toEqual({
    ...original,
    projects: { "/new/project": { mcpServers: { rea: { command: "local" } } } },
  });
});

it("preserves the full local registration path when replacing its server table", () => {
  const original = {
    mcpServers: { rea: { command: "user" } },
    projects: {
      "/selected/project": {
        trust: true,
        mcpServers: { rea: { command: "local" }, other: { command: "other" } },
      },
      "/other/project": { mcpServers: { rea: { command: "other-project" } } },
    },
  };
  const selected = claudeCodeRegistrationConfiguration(
    parseClientConfiguration(JSON.stringify(original), "json"),
    "/selected/project",
  );
  const servers = { ...selected.servers, rea: { command: "updated" } };
  expect(withClientServers(selected, servers)).toEqual({
    ...original,
    projects: {
      ...original.projects,
      "/selected/project": {
        ...original.projects["/selected/project"],
        mcpServers: servers,
      },
    },
  });
  expect(original.projects["/selected/project"].mcpServers.rea.command).toBe(
    "local",
  );
});

describe("parseClientConfiguration shape diagnostics", () => {
  it.each([
    ["null", "null"],
    ["array", "[]"],
    ["string", '"x"'],
  ] as const)("names a non-object JSON root (%s)", (_label, text) => {
    expect(() => parseClientConfiguration(text, "json")).toThrow(
      new TypeError("The configuration root must be an object"),
    );
  });

  it.each([
    ["null", "null"],
    ["array", "[]"],
    ["string", '"x"'],
  ] as const)(
    'names a non-object "mcpServers" value (%s)',
    (_label, servers) => {
      expect(() =>
        parseClientConfiguration(`{"mcpServers":${servers},"keep":1}`, "json"),
      ).toThrow(new TypeError('"mcpServers" must be an object'));
    },
  );

  it("still rejects unparsable JSON with SyntaxError", () => {
    expect(() => parseClientConfiguration("not-json", "json")).toThrow(
      SyntaxError,
    );
  });
});
