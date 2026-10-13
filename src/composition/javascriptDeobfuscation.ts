import type { JavaScriptDeobfuscationPort } from "../application/javascript/JavaScriptDeobfuscationPort.js";
import {
  JsRedoxProvider,
  type JsRedoxLauncher,
} from "../javascript/deobfuscation/JsRedoxProvider.js";

/** Construct optional proof-gated deobfuscation without acquiring tools or workspaces. */
export const createJavaScriptDeobfuscationProvider = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  launcher?: JsRedoxLauncher,
): JavaScriptDeobfuscationPort => new JsRedoxProvider(environment, launcher);
