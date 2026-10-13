import { describe, expect, it } from "vitest";
import { pwntoolsUnavailable } from "./PwntoolsFailures.js";
import { PWNTOOLS_PROVIDER_IDENTITY } from "./PwntoolsRelease.js";

const CONSTRAINT = "fixture configured input bound is invalid";

describe("pwntools unavailability configuration key", () => {
  const context = {
    operation: "inspect_binary_layout",
    providerId: PWNTOOLS_PROVIDER_IDENTITY.id,
  };
  const reportedKey = (configurationKey?: string) =>
    pwntoolsUnavailable(
      CONSTRAINT,
      "/caller-selected/python",
      undefined,
      undefined,
      configurationKey === undefined
        ? context
        : { ...context, configurationKey },
    ).rejections[0]?.diagnostics["configuration_key"];

  it("keeps the engine key unless the failure is about the bound", () => {
    expect(reportedKey()).toBe("REA_PWNTOOLS_PYTHON");
    expect(reportedKey("REA_PWNTOOLS_MAX_INPUT_BYTES")).toBe(
      "REA_PWNTOOLS_MAX_INPUT_BYTES",
    );
  });
});
