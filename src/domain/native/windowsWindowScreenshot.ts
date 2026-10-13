import { createHash } from "node:crypto";

import { z } from "zod";

import { decodeCanonicalBase64 } from "../webScreenshot.js";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** Fits the duplicated structured/text MCP delivery inside the default 10 MiB buffer. */
export const MAX_WINDOWS_WINDOW_PNG_BYTES = 3 * 1024 * 1024;

/** A Win64 HWND stays textual so no JavaScript number truncates its identity. */
export const windowsWindowHandleSchema = z
  .string()
  .regex(/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/u)
  .refine((value) => value !== "0x0", "Window handle must not be zero");

/** Passive capture admits exactly one already-running selected native window. */
export const windowsWindowScreenshotInputSchema = z.strictObject({
  pid: z.number().int().positive(),
  window_handle: windowsWindowHandleSchema,
  max_dimension: z.number().int().min(1).max(4096).default(2048),
});
export type WindowsWindowScreenshotInput = z.infer<
  typeof windowsWindowScreenshotInputSchema
>;

/** Self-verifying inline PNG, including both rendered and pre-scale dimensions. */
export const windowsWindowPngSchema = z
  .strictObject({
    media_type: z.literal("image/png"),
    data_base64: z.string().min(4),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    bytes: z.number().int().min(1).max(MAX_WINDOWS_WINDOW_PNG_BYTES),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    source_width: z.number().int().positive(),
    source_height: z.number().int().positive(),
  })
  .superRefine((screenshot, context) => {
    const bytes = decodeCanonicalBase64(screenshot.data_base64);
    if (bytes === undefined) {
      context.addIssue({
        code: "custom",
        message: "Invalid canonical PNG base64",
      });
      return;
    }
    if (bytes.byteLength !== screenshot.bytes)
      context.addIssue({
        code: "custom",
        path: ["bytes"],
        message: "PNG byte count mismatch",
      });
    if (createHash("sha256").update(bytes).digest("hex") !== screenshot.sha256)
      context.addIssue({
        code: "custom",
        path: ["sha256"],
        message: "PNG digest mismatch",
      });
    if (
      bytes.byteLength < 24 ||
      !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
      bytes.subarray(12, 16).toString("ascii") !== "IHDR"
    ) {
      context.addIssue({
        code: "custom",
        message: "Screenshot bytes are not a PNG image",
      });
      return;
    }
    if (
      bytes.readUInt32BE(16) !== screenshot.width ||
      bytes.readUInt32BE(20) !== screenshot.height
    )
      context.addIssue({
        code: "custom",
        message: "PNG dimensions mismatch",
      });
  });

/** Target-bound native-window evidence; UIA and input control are intentionally absent. */
export const windowsWindowScreenshotResultSchema = z.strictObject({
  target_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  window: z.strictObject({
    pid: z.number().int().positive(),
    window_handle: windowsWindowHandleSchema,
    executable: z.string().min(1),
    process_image_path: z.string().min(1),
    process_start_time_unix_ms: z.number().int().nonnegative(),
    title: z.string(),
  }),
  screenshot: windowsWindowPngSchema,
  gaps: z.array(z.string()),
});
export type WindowsWindowScreenshotResult = z.infer<
  typeof windowsWindowScreenshotResultSchema
>;
