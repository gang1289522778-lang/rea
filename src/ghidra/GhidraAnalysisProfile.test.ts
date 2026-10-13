import { describe, expect, it } from "vitest";

import { parseConfig } from "../config/parseConfig.js";
import { createAnalysisProfile } from "../domain/analysisProfile.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { silentLogger } from "../logger.js";
import { GhidraProvider } from "./GhidraProvider.js";

// Only installation discovery is substituted; profile construction and its
// canonical digest use production code. No JVM launch is claimed by this test.
const provider = (platform: NodeJS.Platform) => {
  const config = parseConfig({ GHIDRA_INSTALL_DIR: "/fixture/ghidra" });
  if (!config.ok) throw config.error;
  return new GhidraProvider(
    config.value,
    silentLogger,
    {},
    {
      platform,
      architecture: "x64",
      readText: () => "application.version=12.1.4\napplication.java.min=21\n",
      executable: () => true,
      probeJava: () => ({
        version: "21.0.11",
        major: 21,
        home: "/fixture/jdk",
        bits: 64,
        runtime: "jdk",
        vmName: "OpenJDK 64-Bit Server VM",
      }),
    },
  );
};

const ordinary: BinaryTarget = {
  path: "/fixture/program.exe",
  sha256: "a".repeat(64),
  kind: "executable",
  format: "pe",
  architecture: "x86_64",
  availableArchitectures: ["x86_64"],
  executableRole: "application",
  managed: false,
};
const raw: BinaryTarget = {
  path: "/fixture/program.bin",
  sha256: "a".repeat(64),
  kind: "executable",
  format: "raw-binary",
  architecture: "x86_64",
  availableArchitectures: ["x86_64"],
  entryPoint: "0x1000",
  entryPointSource: "0x1000",
};

describe.each(["win32", "linux", "darwin"] as const)(
  "Ghidra %s launch profile",
  (platform) => {
    it.each([ordinary, raw])(
      "commits versioned direct JVM launch for $format",
      async (target) => {
        const ghidra = provider(platform);
        const resolved = await ghidra.resolveAnalysisProfile(target);
        if (!resolved.ok) throw resolved.error;
        const profile = resolved.value.profile;
        if (profile === null) throw new Error("Expected a Ghidra profile");
        expect(profile.parameters.process_launch, target.format).toBe(
          "inspected-jvm-launch-support-v2",
        );
        const legacy = createAnalysisProfile(profile.provider, {
          ...profile.parameters,
          process_launch:
            platform === "win32"
              ? "official-headless-script-v1"
              : "inspected-jvm-launch-support-v1",
        });
        expect(profile.digest, target.format).not.toBe(legacy.digest);
        // A profile commitment does not admit an unsupported target lane.
        if (platform === "win32" && target.format === "raw-binary")
          expect(ghidra.inspectTargetSupport(target).status).toBe(
            "unsupported",
          );
      },
    );
  },
);
