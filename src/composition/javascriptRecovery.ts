import type { JavaScriptRecoveryPort } from "../application/javascript/JavaScriptRecoveryPort.js";
import { jsbeautifyEngine } from "../javascript/recovery/JsBeautifyEngine.js";
import type { RecoveryLauncher } from "../javascript/recovery/RecoveryEngine.js";
import { RecoveryProvider } from "../javascript/recovery/RecoveryProvider.js";
import { wakaruEngine } from "../javascript/recovery/WakaruExecution.js";

/** Construct optional recovery without acquiring tools, processes or workspaces. */
export const createJavaScriptRecoveryProvider = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  launcher?: RecoveryLauncher,
): JavaScriptRecoveryPort =>
  new RecoveryProvider([wakaruEngine, jsbeautifyEngine], environment, launcher);
