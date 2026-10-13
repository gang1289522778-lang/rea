import { expect, it } from "vitest";

import { nativeWindowsUiCapabilities } from "./NativeWindowsUiProviderMetadata.js";

it("does not advertise selected-window capture on Windows architectures without the shipped x64 addon", () => {
  expect(nativeWindowsUiCapabilities("win32", "arm64")[0]).toMatchObject({
    available: false,
    availabilityCode: "unsupported_host",
  });
  expect(nativeWindowsUiCapabilities("win32", "x64")[0]).toMatchObject({
    available: true,
  });
});
