import { constants } from "node:buffer";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import { bufferedJsonParts } from "../domain/jsonSerialization.js";

export const IDA_REDACTION_MARKER = "[redacted transport credential]";
export type IdaDiagnosticMatch = Readonly<{ start: number; end: number }>;

type DiagnosticRepresentation = "redacted-output" | "json-character-run";

/** An owned diagnostic cannot be represented as one runtime string. */
export class IdaDiagnosticResourceError extends AnalysisResourceConstraintError {
  constructor(
    inputCodeUnits: number,
    representedCodeUnits: number,
    representation: DiagnosticRepresentation = "redacted-output",
  ) {
    super(
      "ida_diagnostic_redaction",
      "memory",
      representation === "redacted-output"
        ? "Redacted IDA diagnostics exceed the runtime's maximum string length."
        : "Temporary IDA diagnostic JSON character decoding exceeds the runtime's maximum string length.",
      {
        boundary: "ida-diagnostic-redaction",
        representation,
        input_code_units: inputCodeUnits,
        ...(representation === "redacted-output"
          ? { output_code_units_at_least: representedCodeUnits }
          : { json_decoding_code_units_at_least: representedCodeUnits }),
        max_string_code_units: constants.MAX_STRING_LENGTH,
      },
    );
  }
}

/** Write ordered source spans without retaining a per-match collection. */
export const writeIdaDiagnostic = (
  text: string,
  matches: Iterable<IdaDiagnosticMatch>,
): string => {
  function* parts(): Generator<string> {
    let cursor = 0;
    let outputCodeUnits = 0;
    const account = (part: string): string => {
      outputCodeUnits += part.length;
      if (outputCodeUnits > constants.MAX_STRING_LENGTH)
        throw new IdaDiagnosticResourceError(text.length, outputCodeUnits);
      return part;
    };
    let pending: IdaDiagnosticMatch | undefined;
    for (const match of matches) {
      if (pending !== undefined && match.start < pending.end) {
        pending = {
          start: pending.start,
          end: Math.max(pending.end, match.end),
        };
        continue;
      }
      if (pending !== undefined) {
        yield account(text.slice(cursor, pending.start));
        yield account(IDA_REDACTION_MARKER);
        cursor = pending.end;
      }
      pending = match;
    }
    if (pending !== undefined) {
      yield account(text.slice(cursor, pending.start));
      yield account(IDA_REDACTION_MARKER);
      cursor = pending.end;
    }
    yield account(text.slice(cursor));
  }
  return [...bufferedJsonParts(parts())].join("");
};
