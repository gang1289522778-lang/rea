import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { verifyPortableInventory } from "../../../scripts/lib/portable-inventory.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

async function fixture() {
  const root = await createTestTempDirectory("rea-portable-inventory-");
  await mkdir(join(root, "runtime"));
  await writeFile(join(root, "runtime/node.exe"), "controlled fixture");
  await writeFile(join(root, "portable.json"), "{}");
  return { root, files: [{ path: "runtime/node.exe" }] };
}

it("accepts the complete regular-file set excluding its own manifest", async () => {
  const { root, files } = await fixture();
  await expect(verifyPortableInventory(root, files)).resolves.toBeUndefined();
});

it("rejects an unlisted nested dependency", async () => {
  const { root, files } = await fixture();
  const stale = join(root, "app/node_modules/stale/node_modules/shadow");
  await mkdir(stale, { recursive: true });
  await writeFile(join(stale, "index.js"), "stale dependency");
  await expect(verifyPortableInventory(root, files)).rejects.toThrow(
    "unlisted directory",
  );
});

it("rejects an unlisted file inside a listed directory", async () => {
  const { root, files } = await fixture();
  await writeFile(join(root, "runtime/stale.dll"), "stale native dependency");
  await expect(verifyPortableInventory(root, files)).rejects.toThrow(
    "exact regular-file set",
  );
});

it("rejects an empty nested package directory that can shadow a locked dependency", async () => {
  const { root, files } = await fixture();
  const listed = ["app/node_modules/a/index.js", "app/node_modules/b/index.js"];
  for (const path of listed) {
    const parts = path.split("/");
    await mkdir(join(root, ...parts.slice(0, -1)), { recursive: true });
    await writeFile(join(root, path), "controlled dependency");
  }
  const inventory = [...files, ...listed.map((path) => ({ path }))];
  await expect(
    verifyPortableInventory(root, inventory),
  ).resolves.toBeUndefined();
  await mkdir(join(root, "app/node_modules/a/node_modules/b"), {
    recursive: true,
  });
  await expect(verifyPortableInventory(root, inventory)).rejects.toThrow(
    "unlisted directory",
  );
});

it("rejects an omitted runtime and duplicate inventory entries", async () => {
  const { root, files } = await fixture();
  await expect(verifyPortableInventory(root, [])).rejects.toThrow(
    "unlisted directory: runtime",
  );
  await expect(
    verifyPortableInventory(root, [...files, ...files]),
  ).rejects.toThrow("exact regular-file set");
});

it("rejects directory links instead of following unlisted contents", async () => {
  const { root, files } = await fixture();
  await symlink(join(root, "runtime"), join(root, "linked"), "junction");
  await expect(verifyPortableInventory(root, files)).rejects.toThrow(
    "non-regular entry: linked",
  );
});
