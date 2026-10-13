export function verifyPortableInventory(
  directory: string,
  files: readonly { readonly path: string }[],
): Promise<void>;
