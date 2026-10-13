import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

import { ArtifactProvider } from "../../../src/artifacts/ArtifactProvider.js";
import {
  PYTHON_39_MAGIC,
  cArchiveExecutable,
  pyzArchive,
} from "../../../src/artifacts/pyinstaller/CArchive.fixture.js";
import { artifactInspectionOutputSchema } from "../../../src/domain/artifactInspection.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("inventories a PyInstaller executable through inspect_artifact", async () => {
  const directory = await createTestTempDirectory("rea-pyinstaller-mcp-");
  const path = join(directory, "hello");
  await writeFile(
    path,
    cArchiveExecutable({
      layout: "2.1",
      pythonVersion: 312,
      pythonLibrary: "libpython3.12.so",
      members: [
        {
          name: "hello",
          typeCode: "s",
          payload: Buffer.from("print('hi')"),
          compress: false,
        },
        {
          name: "PYZ.pyz",
          typeCode: "z",
          payload: pyzArchive({
            magic: PYTHON_39_MAGIC,
            modules: [{ name: "app", typeCode: 0, body: Buffer.from("app") }],
          }),
          compress: false,
        },
      ],
    }),
  );
  const session = createTestBinarySession(new ArtifactProvider(process.env));
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "pyinstaller-mcp-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const opened = await client.callTool({
    name: "open_binary",
    arguments: { path },
  });
  expect(opened.isError).not.toBe(true);
  const inspected = await client.callTool({
    name: "inspect_artifact",
    arguments: {},
  });
  expect(inspected.isError).not.toBe(true);
  const inspection = artifactInspectionOutputSchema.parse(
    parseEvidence(inspected.structuredContent).normalized_result,
  );
  expect(inspection.subject.root_format).toBe("pyinstaller");
  expect(inspection.next_probes).toEqual([]);
  expect(
    inspection.substeps[0]?.evidence.normalized_result.occurrences.map(
      (occurrence) => occurrence.logical_path,
    ),
  ).toEqual(expect.arrayContaining(["hello", "PYZ.pyz/app.pyc"]));
  await client.close();
  await server.close();
});
