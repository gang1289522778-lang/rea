import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Require exact files and their parent directories before running the artifact. */
export async function verifyPortableInventory(directory, files) {
  const actual = [];
  const parents = new Set();
  for (const { path } of files) {
    const parts = path.split("/");
    for (let length = 1; length < parts.length; length++)
      parents.add(parts.slice(0, length).join("/"));
  }
  async function visit(current, prefix = "") {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) {
        // Even an empty package directory can shadow a hoisted Node dependency.
        if (!parents.has(path))
          throw new Error(
            `Portable inventory contains an unlisted directory: ${path}`,
          );
        await visit(join(current, entry.name), `${path}/`);
      } else if (!entry.isFile())
        throw new Error(
          `Portable inventory contains a non-regular entry: ${path}`,
        );
      else if (path !== "portable.json") actual.push(path);
    }
  }
  await visit(directory);
  assert.deepEqual(
    files.map((file) => file.path).sort(),
    actual.sort(),
    "Portable inventory must match the exact regular-file set",
  );
}
