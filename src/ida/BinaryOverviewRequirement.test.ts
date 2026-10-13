import { describe, expect, it } from "vitest";
import { providerCapability } from "../contracts/toolOutputSchemaPrimitives.js";
import { idaCapabilities } from "./IdaProviderCapabilities.js";
import { composedAvailabilityFor } from "../application/CapabilityInventory.js";

const effects = () =>
  Object.fromEntries(
    [
      "mutates_artifact",
      "launches_process",
      "may_show_ui",
      "may_access_network",
      "may_write_filesystem",
      "changes_permissions",
      "requires_root",
    ].map((name) => [name, false]),
  );

/** Project IDA adapter descriptors onto the inventory's wire-shaped facts. */
const wireDescriptors = () =>
  new Map(
    idaCapabilities("headless", true).map((capability) => [
      capability.operation,
      providerCapability.parse({
        operation: capability.operation,
        available: true,
        reason: null,
        availability_code: null,
        effects: effects(),
        limitations: [...capability.limitations],
      }),
    ]),
  );

describe("IDA adapter x binary_overview required operations", () => {
  it("declares list_documents so headless document resolution works", () => {
    const capabilities = idaCapabilities("headless", true);
    const declared = new Set(capabilities.map((c) => c.operation));
    expect(declared.has("list_documents")).toBe(true);
  });

  it("satisfies binary_overview requirements when segments are optional", () => {
    const availability = composedAvailabilityFor(
      ["list_segments?", "list_documents", "list_procedures", "list_strings"],
      wireDescriptors(),
    );
    expect(availability.reason).toBe("available");
  });

  it("still fails when a required operation is missing", () => {
    const descriptors = wireDescriptors();
    descriptors.delete("list_documents");
    const availability = composedAvailabilityFor(
      ["list_segments?", "list_documents", "list_procedures", "list_strings"],
      descriptors,
    );
    expect(availability.reason).toBe("provider_missing");
  });
});
