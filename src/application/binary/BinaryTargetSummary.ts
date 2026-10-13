import type { BinaryTarget } from "../../domain/binaryTargetTypes.js";

/** Preserve the admitted target interpretation in public lifecycle results. */
export const binaryTargetSummary = (target: BinaryTarget) => ({
  path: target.path,
  format: target.format,
  kind: target.kind,
  sha256: target.sha256,
  architecture: target.architecture ?? null,
  ...(target.format === "raw-binary" ? { entry_point: target.entryPoint } : {}),
  ...(target.format !== "mach-o" && target.format !== "mach-o-universal"
    ? {}
    : target.debugCompanion === undefined
      ? {}
      : {
          debug_companion: {
            source_path: target.debugCompanion.sourcePath,
            uuid: target.debugCompanion.uuid,
            member_sha256: target.debugCompanion.memberSha256,
          },
        }),
});
