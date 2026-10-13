import { Ajv2020 } from "ajv/dist/2020.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { expandToolAvailability } from "../../../src/contracts/toolOutputSchemaPrimitives.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createObfuscatedModJar } from "../../fixtures/java/classFile.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

const JAVA_TOOLS = [
  "inspect_java_archive",
  "inspect_java_class",
  "decompile_java_class",
] as const;

mcpTest(
  "advertises valid Java schemas and records class-file Evidence without a target or JVM",
  async ({ mcp }) => {
    const session = createTestBinarySession(() => {
      throw new Error("Java inspection must not start a deep provider");
    });
    try {
      const client = await mcp.connect(
        createServer(
          { kind: "session", session },
          { environment: { PATH: process.env.PATH ?? "" } },
        ),
      );
      const status = await client.callTool({
        name: "binary_session",
        arguments: {},
      });
      const availability = expandToolAvailability(
        toolContract("binary_session").outputSchema.parse(
          status.structuredContent,
        ).result.tool_availability,
      );
      expect(availability).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "inspect_java_archive",
            available: true,
          }),
          expect.objectContaining({
            name: "inspect_java_class",
            available: true,
          }),
          expect.objectContaining({
            name: "decompile_java_class",
            available: false,
            reason: "provider_missing",
          }),
        ]),
      );

      const ajv = new Ajv2020({ strict: false, validateFormats: false });
      const tools = (await client.listTools()).tools;
      const schemas = new Map(
        JAVA_TOOLS.map((name) => {
          const advertised = tools.find((tool) => tool.name === name);
          if (advertised?.outputSchema === undefined)
            throw new Error(`${name} must publish both schemas`);
          const input: Record<string, unknown> = advertised.inputSchema;
          const output: Record<string, unknown> = advertised.outputSchema;
          expect(ajv.validateSchema(input), name).toBe(true);
          expect(ajv.validateSchema(output), name).toBe(true);
          expect(
            ajv.validate(input, { path: "/artifacts/a.jar", unknown: true }),
          ).toBe(false);
          return [name, output] as const;
        }),
      );

      const root = await createTestTempDirectory("rea-java-mcp-");
      const path = join(root, "mod.jar");
      await writeFile(path, await createObfuscatedModJar());
      for (const [name, args] of [
        ["inspect_java_archive", { path, limit: 1 }],
        ["inspect_java_class", { path, class_name: "com/example/mod/a" }],
      ] as const) {
        const response = await client.callTool({ name, arguments: args });
        expect(response.isError, JSON.stringify(response.content)).not.toBe(
          true,
        );
        expect(
          ajv.validate(schemas.get(name) ?? {}, response.structuredContent),
          JSON.stringify(ajv.errors),
        ).toBe(true);
        const evidence = parseEvidence(
          toolContract(name).outputSchema.parse(response.structuredContent),
        );
        expect(evidence).toMatchObject({
          operation: name,
          confidence: "observed",
          subject: { format: "zip" },
        });
        expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
      }

      const unconfigured = await client.callTool({
        name: "decompile_java_class",
        arguments: { path, class_name: "com.example.mod.Main" },
      });
      expect(unconfigured.isError).toBe(true);
      expect(parseMcpToolError(unconfigured)).toMatchObject({
        error: {
          code: "capability_unavailable",
          details: { provider_id: "vineflower" },
        },
      });
    } finally {
      await session.close();
    }
  },
);
