import { describe, expect, it } from "vitest";

import {
  parsePwntoolsMaxInputBytes,
  PWNTOOLS_INPUT_CAPACITY_BYTES,
  pwntoolsMaxInputBytesSchema,
} from "../../../src/config/pwntoolsMaxInputBytes.js";
import { parseEnvironment } from "../../../src/config/environment.js";
import { parseConfig } from "../../../src/config/parseConfig.js";
import { PWNTOOLS_LIMITS } from "../../../src/native/pwntools/PwntoolsRelease.js";
describe("pwntools max input bytes parsing and configuration", () => {
  it("defaults to PWNTOOLS_LIMITS.inputBytes when unset or empty", () => {
    expect(parsePwntoolsMaxInputBytes(undefined)).toEqual({
      ok: true,
      value: PWNTOOLS_LIMITS.inputBytes,
    });
    expect(parsePwntoolsMaxInputBytes("")).toEqual({
      ok: true,
      value: PWNTOOLS_LIMITS.inputBytes,
    });
  });

  it("parses valid positive decimal safe integers", () => {
    // 64 MiB
    expect(parsePwntoolsMaxInputBytes("67108864")).toEqual({
      ok: true,
      value: 67_108_864,
    });
    // 256 MiB
    expect(parsePwntoolsMaxInputBytes("268435456")).toEqual({
      ok: true,
      value: 268_435_456,
    });
    // 512 MiB
    expect(parsePwntoolsMaxInputBytes("536870912")).toEqual({
      ok: true,
      value: 536_870_912,
    });
    // Minimum 1 byte
    expect(parsePwntoolsMaxInputBytes("1")).toEqual({
      ok: true,
      value: 1,
    });
  });

  it.each([1024, 172_879_872, PWNTOOLS_INPUT_CAPACITY_BYTES])(
    "admits an explicit %s byte bound within representation capacity",
    (bytes) => {
      expect(parsePwntoolsMaxInputBytes(String(bytes))).toEqual({
        ok: true,
        value: bytes,
      });
    },
  );

  it.each([
    "0",
    "-1",
    "-1024",
    "1.5",
    "33554432.0",
    "67_108_864",
    "0x2000000",
    String(PWNTOOLS_INPUT_CAPACITY_BYTES + 1),
    `${PWNTOOLS_INPUT_CAPACITY_BYTES}.00000000001`,
    "99999999999999999999",
    "abc",
    "0123",
    "1e8",
    " 33554432",
    "33554432 ",
    "1073741824", // exceeds the fixed worker representation capacity
    "4294967296",
    "9007199254740992", // > Number.MAX_SAFE_INTEGER
  ])("rejects malformed or unsafe values: %j", (value) => {
    const result = parsePwntoolsMaxInputBytes(value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("REA_PWNTOOLS_MAX_INPUT_BYTES");
      expect(result.error.settings).toEqual([
        {
          setting: "REA_PWNTOOLS_MAX_INPUT_BYTES",
          constraint: `REA_PWNTOOLS_MAX_INPUT_BYTES must be a positive decimal safe integer no greater than ${PWNTOOLS_INPUT_CAPACITY_BYTES} bytes (worker representation capacity).`,
        },
      ]);
    }
  });

  it("exports pwntoolsMaxInputBytesSchema for composition in environmentSchema", () => {
    expect(pwntoolsMaxInputBytesSchema.safeParse("268435456").success).toBe(
      true,
    );
    expect(pwntoolsMaxInputBytesSchema.safeParse("0").success).toBe(false);
    expect(pwntoolsMaxInputBytesSchema.safeParse("").success).toBe(true);
  });

  it("integrates with parseEnvironment and parseConfig, accepting empty settings", () => {
    const validEnv = parseEnvironment({
      REA_PWNTOOLS_MAX_INPUT_BYTES: "268435456",
    });
    expect(validEnv.ok).toBe(true);
    if (validEnv.ok) {
      expect(validEnv.value.REA_PWNTOOLS_MAX_INPUT_BYTES).toBe(268_435_456);
    }

    // Empty setting must not fail startup
    const emptyEnv = parseEnvironment({
      REA_PWNTOOLS_MAX_INPUT_BYTES: "",
    });
    expect(emptyEnv.ok).toBe(true);
    if (emptyEnv.ok) {
      expect(emptyEnv.value.REA_PWNTOOLS_MAX_INPUT_BYTES).toBeUndefined();
    }

    const emptyConfig = parseConfig({
      REA_PWNTOOLS_MAX_INPUT_BYTES: "",
    });
    expect(emptyConfig.ok).toBe(true);

    const invalidEnv = parseEnvironment({
      REA_PWNTOOLS_MAX_INPUT_BYTES: "invalid-bytes",
    });
    expect(invalidEnv.ok).toBe(false);
    if (!invalidEnv.ok) {
      expect(invalidEnv.error.settings).toEqual([
        expect.objectContaining({
          setting: "REA_PWNTOOLS_MAX_INPUT_BYTES",
        }),
      ]);
    }

    const configResult = parseConfig({
      REA_PWNTOOLS_MAX_INPUT_BYTES: "536870912", // 512 MiB
    });
    expect(configResult.ok).toBe(true);
  });
});
