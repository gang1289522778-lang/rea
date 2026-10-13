/** An API-key-free MCP handshake against the actual packaged REA child. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolveReaLauncher } from "../launcher.mjs";

const launcher = resolveReaLauncher();
const child = spawn(launcher.command, launcher.args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    USERPROFILE: process.env.USERPROFILE ?? "",
    ...launcher.env,
  },
});
const exited = new Promise((resolve) => child.once("exit", resolve));
let hasExited = false;
child.once("exit", () => {
  hasExited = true;
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr = (stderr + chunk).slice(-8192);
});
let nextId = 0;
const pending = new Map();
let settled = false;
const messages = createInterface({ input: child.stdout });
messages.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message?.id === undefined) return;
  const request = pending.get(message.id);
  if (request) {
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  }
});
const request = (method, params) => {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
    );
  });
};
const notify = (method) =>
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
const failAll = (message) => {
  for (const p of pending.values()) p.reject(new Error(message));
  pending.clear();
};
child.on("error", (error) => failAll(error.message));
child.on("exit", (code) => {
  if (!settled) failAll(`REA exited with ${code}: ${stderr}`);
});
const timeout = setTimeout(
  () => failAll(`REA MCP startup exceeded 90 seconds: ${stderr}`),
  90000,
);
timeout.unref();
try {
  const response = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "rea-dsh-bundle-check", version: "0.1.0" },
  });
  assert(
    response && typeof response.protocolVersion === "string",
    "MCP initialize must negotiate a protocol",
  );
  notify("notifications/initialized");
  const list = await request("tools/list", {});
  assert(Array.isArray(list?.tools), "MCP tools/list must return tools");
  assert(list.tools.length > 0, "MCP server must register tools");
  assert(
    list.tools.some((tool) => tool.name === "analyze_javascript_application"),
    "Expected REA JS analysis tool",
  );
  console.log(`REA MCP native handshake passed (${list.tools.length} tools)`);
  settled = true;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  messages.close();
  child.stdin.destroy();
  const waitForExit = async (milliseconds) => {
    if (hasExited) return true;
    let timer;
    try {
      return await Promise.race([
        exited.then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  if (!hasExited) child.kill("SIGTERM");
  if (!(await waitForExit(5000))) {
    child.kill("SIGKILL");
    if (!(await waitForExit(5000))) {
      console.error("REA MCP child did not exit after forced termination");
      process.exitCode = 1;
    }
  }
}
