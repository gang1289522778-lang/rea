import type { JavaScriptModuleSemanticIr } from "./javascriptModuleSemanticIr.js";
import { estimateSemanticReturnValueBytes } from "./javascriptSemanticReturns.js";
import type { JavaScriptStaticAnalysis } from "./javascriptStaticAnalysisTypes.js";

/** Forecast static-fact expansion into observations, nodes and relationships. */
export const estimateJavaScriptStaticApplicationProjection = (
  facts: JavaScriptStaticAnalysis,
  checkpointBytes: number,
  sourcePath: string,
): number => {
  // A finding can produce a node, a separate observation and several edges.
  // Allow for identifiers, locations, authority, coverage and schema copies,
  // independently of the producer's compact checkpoint representation.
  const findings =
    facts.references.length +
    facts.endpoints.length +
    facts.storage.length +
    facts.role_paths.length +
    facts.source_map_urls.length +
    facts.electron.browser_windows.length +
    facts.electron.context_bridge_apis.length +
    facts.electron.ipc.length +
    facts.electron.sender_validations.length +
    facts.electron.utility_processes.length +
    facts.electron.native_addon_bindings.length;
  let records = findings * 8;
  let repeatedBytes = 0;
  for (const registration of facts.bundler_registrations) {
    records +=
      3 +
      registration.modules.length * 3 +
      registration.entry_module_keys.length * 3 +
      registration.async_chunk_keys.length * 3;
    // Every module observation and containment edge repeats its chunk keys.
    repeatedBytes +=
      Buffer.byteLength(JSON.stringify(registration.chunk_keys)) *
      registration.modules.length *
      2;
  }
  for (const binding of facts.electron.native_addon_bindings)
    records += binding.members.length * 3;
  for (const path of facts.electron.call_paths ?? []) {
    // One contextual node and edge per step, with repeated guards and identity.
    records += path.steps.length * 4 + 8;
    repeatedBytes +=
      Buffer.byteLength(JSON.stringify(path.conditions)) *
      path.steps.length *
      2;
  }
  const metadataBytes = 2048 + Buffer.byteLength(sourcePath) * 4;
  // Measured on a complete Grok Bot app.asar analysis: the sum of these
  // forecasts was 89 MB for 73 MB of retained application-graph objects.
  return checkpointBytes * 4 + repeatedBytes + records * metadataBytes;
};

/** Forecast exported facts without materializing flattened shapes or ancestor paths. */
export const estimateJavaScriptModuleApplicationProjection = (
  module: JavaScriptModuleSemanticIr,
  sourcePath: string,
  allowance = Number.MAX_SAFE_INTEGER - 1,
): number => {
  const shapesByCallable = new Map<string, number>();
  const callables = new Map(
    module.callables.map((callable) => [callable.callableId, callable]),
  );
  const pathBytes = Buffer.byteLength(JSON.stringify(sourcePath));
  const limitationsBytes = Buffer.byteLength(
    JSON.stringify(module.limitations),
  );
  let bytes = 0;
  for (const link of module.moduleLinks) {
    bytes +=
      8 * (2048 + pathBytes * 4) + Buffer.byteLength(JSON.stringify(link)) * 4;
    if (bytes > allowance) return allowance + 1;
    if (link.callableId === null || link.exportedName === null) continue;
    let shapeBytes = shapesByCallable.get(link.callableId);
    if (shapeBytes === undefined) {
      shapeBytes = 0;
      const callable = callables.get(link.callableId);
      if (callable !== undefined) {
        shapeBytes =
          4096 +
          pathBytes +
          limitationsBytes +
          Buffer.byteLength(JSON.stringify(callable.location)) +
          Buffer.byteLength(JSON.stringify(callable.callableId));
        for (const site of callable.returnSites) {
          shapeBytes += 256 + Buffer.byteLength(JSON.stringify(site.location));
          const remaining = Math.max(
            0,
            Math.floor((allowance - bytes) / 4) - shapeBytes,
          );
          shapeBytes += estimateSemanticReturnValueBytes(site.value, remaining);
          if (bytes + shapeBytes * 4 > allowance) return allowance + 1;
        }
      }
      shapesByCallable.set(link.callableId, shapeBytes);
    }
    bytes +=
      (shapeBytes + Buffer.byteLength(JSON.stringify(link.exportedName))) * 4;
    if (bytes > allowance) return allowance + 1;
  }
  return bytes;
};
