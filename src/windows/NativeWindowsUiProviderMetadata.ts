import type {
  CapabilityDescriptor,
  ProviderIdentity,
} from "../application/AnalysisProvider.js";

/** Public provenance for the optional Windows target-window capture adapter. */
export const NATIVE_WINDOWS_UI_PROVIDER_IDENTITY: ProviderIdentity =
  Object.freeze({
    id: "native-windows-ui",
    name: "Windows selected-window capture",
    version: null,
  });

/** Declare the narrow Windows-only facet without loading its native artifact. */
export const nativeWindowsUiCapabilities = (
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): readonly CapabilityDescriptor[] => {
  const availability =
    platform === "win32" && architecture === "x64"
      ? ({ available: true, reason: null } as const)
      : ({
          available: false,
          availabilityCode: "unsupported_host",
          reason:
            "Selected-window capture requires a Windows x64 host and packaged native addon.",
        } as const);
  return Object.freeze([
    Object.freeze({
      provider: NATIVE_WINDOWS_UI_PROVIDER_IDENTITY,
      operation: "capture_windows_window_screenshot" as const,
      ...availability,
      effects: Object.freeze({
        mutatesArtifact: false,
        launchesProcess: false,
        mayShowUi: true,
        mayAccessNetwork: true,
        mayWriteFilesystem: true,
        changesPermissions: false,
        requiresRoot: false,
      }),
      limitations: Object.freeze([
        "Captures only one explicitly selected existing HWND of the active PE application.",
        "Does not enumerate windows, search titles, capture the desktop or region, send input, or expose accessibility automation. WM_PRINT can nevertheless execute the selected target's paint handler.",
      ]),
    }),
  ]);
};
