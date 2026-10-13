import type { IosDeviceAnalysisPort } from "../application/ios/IosDeviceAnalysisPort.js";
import { IosProvider } from "../ios/IosProvider.js";

/** Construct one iOS device provider bound to caller-selected local tools. */
export const createIosDeviceAnalysisProvider = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): IosDeviceAnalysisPort => new IosProvider({ environment });
