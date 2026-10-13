import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import {
  windowsWindowPngSchema,
  windowsWindowScreenshotInputSchema,
} from "./windowsWindowScreenshot.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAF/gJ+Qv1aRwAAAABJRU5ErkJggg==",
  "base64",
);

it("accepts a self-verifying canonical PNG for a selected Windows window", () => {
  expect(
    windowsWindowPngSchema.parse({
      media_type: "image/png",
      data_base64: PNG.toString("base64"),
      sha256: createHash("sha256").update(PNG).digest("hex"),
      bytes: PNG.byteLength,
      width: 1,
      height: 1,
      source_width: 1,
      source_height: 1,
    }),
  ).toMatchObject({ width: 1, height: 1 });
});

it("rejects a non-canonical or zero HWND before native capture", () => {
  expect(
    windowsWindowScreenshotInputSchema.safeParse({
      pid: 1,
      window_handle: "0x0001",
    }).success,
  ).toBe(false);
  expect(
    windowsWindowScreenshotInputSchema.safeParse({
      pid: 1,
      window_handle: "0x0",
    }).success,
  ).toBe(false);
});

it("rejects PNG dimensions that disagree with its IHDR", () => {
  expect(
    windowsWindowPngSchema.safeParse({
      media_type: "image/png",
      data_base64: PNG.toString("base64"),
      sha256: createHash("sha256").update(PNG).digest("hex"),
      bytes: PNG.byteLength,
      width: 2,
      height: 1,
      source_width: 2,
      source_height: 1,
    }).success,
  ).toBe(false);
});
