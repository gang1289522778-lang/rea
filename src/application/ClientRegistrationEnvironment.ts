import { z } from "zod";

import { parseEnvironment } from "../config/environment.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  effectiveClientServer,
  type ClientConfigurationDocument,
} from "./ClientConfigurationDocument.js";
import { environmentKeyIdentity } from "../config/environmentKey.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import { dshDocument } from "./DshCordisPatch.js";

/**
 * Read explicit REA overrides without dropping peers when one value is
 * invalid. Seeded `defaults` fill keys the existing entry does not configure,
 * matching platform environment-key identity so one Windows variable keeps
 * one spelling.
 */
export const clientRegistrationEnvironment = (
  parsed: ClientConfigurationDocument | undefined,
  overrides: Readonly<Record<string, string>> = {},
  defaults: Readonly<Record<string, string>> = {},
  platform: NodeJS.Platform = process.platform,
): Result<Readonly<Record<string, string>>, ConfigurationError> => {
  if (parsed?.dialect === "dsh")
    return dshDocument(parsed.document).environment(overrides);
  const key =
    parsed?.dialect === "opencode" || parsed?.dialect === "opencode_v2"
      ? "environment"
      : "env";
  const registration =
    parsed === undefined
      ? undefined
      : effectiveClientServer(parsed, PRODUCT_IDENTITY.mcpServerKey);
  const raw =
    typeof registration === "object" && registration !== null
      ? Reflect.get(registration, key)
      : undefined;
  const existing = z
    .record(z.string(), z.string())
    .safeParse(raw === undefined ? {} : raw);
  if (!existing.success)
    return err(
      new ConfigurationError("Invalid REA server environment", {
        settings: existing.error.issues.map((issue) => ({
          setting: [key, ...issue.path].join("."),
          constraint:
            "Server environment must be an object containing only string values",
        })),
      }),
    );
  // Validate known settings with the runtime's parser, but retain the original
  // string overrides, including unknown client-specific keys and no defaults.
  // Seeded registration defaults sit beneath an explicitly configured value,
  // so an existing entry keeps whatever the caller chose. Layers collide under
  // platform environment-key identity (Windows names are case-insensitive),
  // and the winning layer keeps its own spelling.
  const selected = new Map<string, readonly [string, string]>();
  for (const layer of [defaults, existing.data, overrides]) {
    const seen = new Set<string>();
    // Select Node's first lexicographic spelling within each source layer.
    const entries = Object.entries(layer).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    for (const [key, value] of entries) {
      const identity = environmentKeyIdentity(key, platform);
      if (seen.has(identity)) continue;
      seen.add(identity);
      selected.set(identity, [key, value]);
    }
  }
  const environment = Object.fromEntries(selected.values());
  // Validate the runtime view, while retaining caller spelling and values below.
  const validated = parseEnvironment(
    snapshotEnvironment(environment, platform),
  );
  if (!validated.ok) return validated;
  return ok(
    Object.fromEntries(
      Object.entries(environment).sort(([left], [right]) =>
        compareUnicodeCodePoints(left, right),
      ),
    ),
  );
};
