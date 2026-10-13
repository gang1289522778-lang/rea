import { redactIdaJsonDiagnostic } from "./IdaJsonDiagnostic.js";
import {
  writeIdaDiagnostic,
  type IdaDiagnosticMatch,
} from "./IdaDiagnosticWriter.js";
import type { IdaConfiguration } from "./IdaConfiguration.js";

// Diagnostic text is bounded before decoding or replacement expansion.
export const IDA_DIAGNOSTIC_SOURCE_BYTES = 64 * 1024;
const omittedDiagnostic = "[IDA diagnostic omitted: exceeds 65536 UTF-8 bytes]";

const boundedDiagnostic =
  (redact: (message: string) => string) =>
  (message: string): string =>
    Buffer.byteLength(message, "utf8") > IDA_DIAGNOSTIC_SOURCE_BYTES
      ? omittedDiagnostic
      : redact(message);

/** RFC 7617 user-pass candidates; the configured request carries no charset. */
const basicPayloads = (payload: string): readonly string[] => {
  if (!/^[A-Za-z\d+/]+={0,2}$/u.test(payload)) return [];
  const octets = Buffer.from(payload, "base64");
  // Match the supported padded/unpadded policy without accepting Buffer's
  // permissive alphabet or discarding nonzero pad bits.
  if (
    octets.toString("base64").replace(/=+$/u, "") !==
      payload.replace(/=+$/u, "") ||
    octets.indexOf(0x3a) < 0
  )
    return [];
  // Basic user-id and password exclude ASCII control characters.
  if (octets.some((value) => value < 0x20 || value === 0x7f)) return [];
  const candidates = [octets.toString("latin1")];
  try {
    candidates.push(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(octets),
    );
  } catch {
    // Invalid UTF-8 has no decoded Unicode candidate. Exact Latin-1 preserves
    // each octet; do not invent a replacement-character credential.
  }
  // The default charset is unknown. Retain both supported interpretations
  // rather than selecting one or normalizing their configured source bytes.
  return candidates.flatMap((pair) => {
    const separator = pair.indexOf(":");
    // The complete pair and password are credentials; a bare user-id is not.
    return [pair, pair.slice(separator + 1)].filter(
      (value) => value.length > 0,
    );
  });
};

/** RFC 9110 credentials: any scheme, followed by opaque data or auth-params. */
const authorizationPayloads = (header: string): readonly string[] => {
  const credentials = header.match(
    /^([!#$%&'*+.^_`|~\dA-Za-z-]+)[ \t]+([\s\S]+)$/u,
  );
  const payload = credentials?.[2];
  if (payload === undefined) return [];
  if (credentials?.[1]?.toLowerCase() === "basic")
    return [payload, ...basicPayloads(payload)];
  const values = [payload];
  // A sticky parse cannot reinterpret commas inside an incomplete quoted value.
  // Keep complete parameters preceding malformed input; the opaque payload above
  // remains a known credential even when the parameter grammar is not satisfied.
  const parameter =
    /[ \t,]*[!#$%&'*+.^_`|~\dA-Za-z-]+[ \t]*=[ \t]*("(?:[^"\\\r\n]|\\[^\r\n])*"|[!#$%&'*+.^_`|~\dA-Za-z-]+)[ \t]*(?:,|$)/uy;
  let cursor = 0;
  while (cursor < payload.length) {
    parameter.lastIndex = cursor;
    const match = parameter.exec(payload);
    if (match === null) break;
    cursor = parameter.lastIndex;
    const value = match[1] ?? "";
    if (!value.startsWith('"')) {
      values.push(value);
      continue;
    }
    const quoted = value.slice(1, -1);
    if (quoted.length > 0)
      values.push(value, quoted, quoted.replace(/\\([^\r\n])/gu, "$1"));
  }
  return values;
};

/** RFC 6265 cookie-pairs: retain duplicates and '=' inside values. */
const cookiePayloads = (header: string): readonly string[] =>
  header.split(";").flatMap((pair) => {
    const value = pair.match(
      /^[ \t]*[!#$%&'*+.^_`|~\dA-Za-z-]+[ \t]*=[ \t]*(.*?)[ \t]*$/u,
    )?.[1];
    if (value === undefined) return [];
    const payload =
      value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
    // Cookie quotes wrap cookie-octets; they do not introduce escape syntax.
    if (!/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/u.test(payload))
      return [];
    return [value, payload];
  });

/** Own configured credential interpretation for all IDA error diagnostics. */
export const createIdaDiagnosticRedactor = (
  config: IdaConfiguration,
): Readonly<{
  text(message: string): string;
  json(message: string): string;
}> => {
  const headers = "headers" in config ? Object.entries(config.headers) : [];
  const values = headers.flatMap(([name, value]) => {
    if (!/^(?:authorization|proxy-authorization|cookie)$/iu.test(name))
      return [];
    // Fetch normalizes surrounding HTTP whitespace before sending headers.
    const normalized = value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/gu, "");
    if (normalized.length === 0) return [];
    return [
      value,
      normalized,
      ...(name.toLowerCase() === "cookie"
        ? cookiePayloads(normalized)
        : authorizationPayloads(normalized)),
    ];
  });
  const secrets = [...new Set(values.filter((value) => value.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
  if (secrets.length === 0) {
    const unchanged = boundedDiagnostic((message) => message);
    return { text: unchanged, json: unchanged };
  }
  const pattern = new RegExp(
    secrets
      .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
      .join("|"),
    "gu",
  );
  const matches = function* (value: string): Iterable<IdaDiagnosticMatch> {
    for (const match of value.matchAll(pattern))
      yield { start: match.index, end: match.index + match[0].length };
  };
  return {
    text: boundedDiagnostic((message) =>
      writeIdaDiagnostic(message, matches(message)),
    ),
    json: boundedDiagnostic((message) =>
      redactIdaJsonDiagnostic(message, matches),
    ),
  };
};
