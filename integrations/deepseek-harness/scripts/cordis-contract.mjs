import { parseDocument } from "yaml";

class LauncherExpression {
  constructor(source) {
    this.source = source;
  }
}

const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keysAre = (value, keys) =>
  record(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const expressionIs = (value, field) =>
  value instanceof LauncherExpression &&
  value.source === `ctx.reaLauncher.${field}`;

/** Parse the owned patch without evaluating JavaScript or accepting alias expansion. */
export function parseReaCordisPatch(source) {
  try {
    const document = parseDocument(source, {
      customTags: [
        {
          tag: "tag:yaml.org,2002:js",
          resolve: (value) => new LauncherExpression(value),
        },
      ],
      uniqueKeys: true,
    });
    if (document.errors.length || document.warnings.length)
      throw new Error(
        [...document.errors, ...document.warnings]
          .map((error) => error.message)
          .join("; "),
      );
    const patch = document.toJS({ maxAliasCount: 0 });
    if (
      !Array.isArray(patch) ||
      patch.length !== 1 ||
      !keysAre(patch[0], ["insert"])
    )
      throw new Error("expected one root insertion");
    const rows = patch[0].insert;
    if (!Array.isArray(rows) || rows.length !== 2)
      throw new Error("expected exactly the launcher and MCP client rows");
    const [launcher, client] = rows;
    if (
      !keysAre(launcher, ["id", "name"]) ||
      launcher.id !== "rea-launcher" ||
      launcher.name !== "dsh-rea-bundle/launcher"
    )
      throw new Error("invalid launcher service row");
    if (
      !keysAre(client, ["id", "name", "inject", "config"]) ||
      client.id !== "rea-mcp" ||
      client.name !== "@deepseek-ai/dsh-mcp-client" ||
      !Array.isArray(client.inject) ||
      client.inject.length !== 1 ||
      client.inject[0] !== "reaLauncher"
    )
      throw new Error("invalid MCP service row or launcher injection");
    const config = client.config;
    const fields = ["command", "args", "env", "toolCallTimeoutMs"];
    if (
      !keysAre(config, [
        "serverName",
        "transport",
        ...fields,
        "failOnStartupError",
      ]) ||
      config.serverName !== "rea" ||
      config.transport !== "stdio" ||
      config.failOnStartupError !== true ||
      !fields.every((field) => expressionIs(config[field], field))
    )
      throw new Error(
        "invalid MCP launcher configuration or service expressions",
      );
    return { ok: true, value: patch };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
