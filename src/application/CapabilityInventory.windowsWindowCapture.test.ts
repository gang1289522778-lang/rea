import { expect, it } from "vitest";

import { buildCapabilityInventory } from "./CapabilityInventory.js";

const policy = { processCaptureEnabled: false };
const capability = (
  format: string,
  executableRole:
    | "application"
    | "shared-library"
    | "non-executable" = "application",
) =>
  buildCapabilityInventory(
    {
      open: true,
      kind: "executable",
      format,
      executable_role: executableRole,
      capabilities: [
        {
          provider: {
            id: "native-windows-ui",
            name: "Windows selected-window capture",
            version: null,
          },
          shared_limitations: [],
          groups: [
            {
              operations: ["capture_windows_window_screenshot"],
              effects: [],
              limitations: [],
              available: true,
              reason: null,
              availability_code: null,
            },
          ],
        },
      ],
    },
    policy,
  ).find((entry) => entry.name === "capture_windows_window_screenshot");

it("advertises selected-window capture only for an active PE executable", () => {
  expect(capability("pe")).toMatchObject({
    available: true,
    reason: "available",
  });
  expect(capability("mach-o")).toMatchObject({
    available: false,
    reason: "target_unsupported",
  });
  expect(capability("pe", "shared-library")).toMatchObject({
    available: false,
    reason: "target_unsupported",
  });
});
