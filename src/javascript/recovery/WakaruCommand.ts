import { resolveRecoveryTool } from "./RecoveryCommand.js";
import { WAKARU_LIMITS, WAKARU_PROVIDER_IDENTITY } from "./WakaruRelease.js";

const WAKARU_REQUIREMENT =
  "Provide an absolute REA_WAKARU_COMMAND pointing to a Wakaru ^1.13.0 Linux x64 binary (verified with 1.14.0); no tool is installed by REA. See docs/javascript-recovery.md#install-wakaru.";

/** Resolve and fingerprint the explicitly configured Wakaru binary. */
export const resolveWakaruCommand = (
  environment: Readonly<Record<string, string | undefined>>,
) =>
  resolveRecoveryTool(environment, {
    id: WAKARU_PROVIDER_IDENTITY.id,
    name: WAKARU_PROVIDER_IDENTITY.name,
    configured: environment.REA_WAKARU_COMMAND,
    supported: process.platform === "linux" && process.arch === "x64",
    requirement: WAKARU_REQUIREMENT,
    limits: WAKARU_LIMITS,
  });
