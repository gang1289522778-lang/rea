import { createHash } from "node:crypto";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, it } from "vitest";

import {
  createAnalysisExecution,
  type AnalysisOperationPort,
} from "../../../src/application/AnalysisProvider.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAF/gJ+Qv1aRwAAAABJRU5ErkJggg==",
  "base64",
);
const provider = {
  id: "native-windows-ui",
  name: "Windows selected-window capture",
  version: null,
} as const;
const resources: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
});

it("delivers target-bound Windows screenshot Evidence through MCP", async () => {
  const calls: Array<{
    readonly operation: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  }> = [];
  const result = {
    target_sha256: "a".repeat(64),
    window: {
      pid: 42,
      window_handle: "0x1234",
      executable: "C:\\Apps\\fixture.exe",
      process_image_path: "C:\\Apps\\fixture.exe",
      process_start_time_unix_ms: 1_700_000_000_000,
      title: "Fixture",
    },
    screenshot: {
      media_type: "image/png",
      data_base64: PNG.toString("base64"),
      sha256: createHash("sha256").update(PNG).digest("hex"),
      bytes: PNG.byteLength,
      width: 1,
      height: 1,
      source_width: 1,
      source_height: 1,
    },
    gaps: ["Accessibility-tree capture is unavailable."],
  };
  const execute: AnalysisOperationPort["execute"] = (operation, parameters) => {
    calls.push({ operation, parameters });
    return Promise.resolve(ok(createAnalysisExecution(result, provider)));
  };
  const server = createServer({ kind: "fixed", analysis: { execute } });
  const client = new Client({ name: "windows-window-mcp-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server);
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const observed = await client.callTool({
    name: "capture_windows_window_screenshot",
    arguments: { pid: 42, window_handle: "0x1234" },
  });

  expect(observed.isError).not.toBe(true);
  expect(calls).toEqual([
    {
      operation: "capture_windows_window_screenshot",
      parameters: {
        pid: 42,
        window_handle: "0x1234",
        max_dimension: 2048,
      },
    },
  ]);
  expect(
    toolContract("capture_windows_window_screenshot").outputSchema.parse(
      observed.structuredContent,
    ),
  ).toMatchObject({
    normalized_result: { window: { pid: 42, window_handle: "0x1234" } },
  });
});
