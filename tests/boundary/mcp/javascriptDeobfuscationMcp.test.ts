import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import {
  assertDeobfuscationCleanup,
  deobfuscationFixture,
} from "../../fixtures/javascript-deobfuscation/provider.js";

it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "advertises and executes proof-gated deobfuscation without a binary target",
  async () => {
    const fixture = await deobfuscationFixture();
    const session = createTestBinarySession(() => {
      throw new Error("no binary provider should start");
    });
    const server = createServer(
      { kind: "session", session },
      { javascriptDeobfuscation: fixture.provider },
    );
    const client = new Client({ name: "deobfuscation-contract", version: "1" });
    onTestFinished(async () => {
      await client.close();
      await server.close();
      await session.close();
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    const advertised = tools.tools.find(
      (tool) => tool.name === "deobfuscate_javascript_source",
    );
    if (advertised === undefined || advertised.outputSchema === undefined)
      throw new Error("deobfuscation tool must advertise both schemas");
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const inputSchema: Record<string, unknown> = advertised.inputSchema;
    const outputSchema: Record<string, unknown> = advertised.outputSchema;
    expect(ajv.validateSchema(inputSchema)).toBe(true);
    expect(ajv.validateSchema(outputSchema)).toBe(true);

    const args = { path: fixture.path, output_directory: fixture.output };
    const response = await client.callTool({
      name: "deobfuscate_javascript_source",
      arguments: args,
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const parsed = toolContract(
      "deobfuscate_javascript_source",
    ).outputSchema.parse(response.structuredContent);
    const evidence = parseEvidence(parsed);
    expect(evidence).toMatchObject({
      operation: "deobfuscate_javascript_source",
      provider: { id: "js-redox", version: "0.1.0" },
      confidence: "derived",
      authority: "shipped-artifact",
      parameters: { ...args, max_iterations: 16 },
      normalized_result: {
        runtime_execution: "not-performed",
        proof: { runtime_semantics_preserved_by_design: true },
      },
    });
    expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
    await assertDeobfuscationCleanup(fixture.launches);
  },
);
