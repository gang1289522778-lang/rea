interface ParsedDyldSymbol {
  readonly name: string;
  readonly address: string | null;
  readonly weak: boolean | null;
  readonly reexport: boolean | null;
  readonly source: string | null;
  /** The source library's name for a symbol it re-exports under another name. */
  readonly sourceSymbol?: string;
}

/** Decode Apple dyld inventory rows, projecting export offsets to VM addresses. */
export const parseDyldSymbols = (
  output: string,
  mode: "imports" | "exports",
  imageBase: string | null = null,
  knownExportNames: ReadonlySet<string> = new Set(),
) => {
  const offsets = /^\s*offset\s+symbol\s*$/mu.test(output);
  return output.split(/\r?\n/u).flatMap<ParsedDyldSymbol>((rawLine) => {
    const line = rawLine.trim();
    if (mode === "imports") {
      const imported =
        /^(?:0x[\da-f]+\s+)?(.+?)(?:\s+\[([^\]]+)\])?\s+\(from (.+)\)$/iu.exec(
          line,
        );
      if (imported?.[1] !== undefined)
        return [
          {
            name: imported[1],
            address: null,
            weak: /\bweak-import\b/u.test(imported[2] ?? "") ? true : null,
            reexport: null,
            source: imported[3] ?? null,
          },
        ];
      return [];
    }
    // dyld_info prints `_sym (from lib)`, or `_new (_old from lib)` when the
    // source library names the symbol differently. Split the trailing
    // parenthesized suffix with string scans so a library path containing
    // " from ", or a source symbol containing parentheses such as
    // `operator()`, cannot pull the match into nested lazy quantifiers.
    const reexport = parseReexportRow(line);
    if (reexport !== null)
      return [
        {
          name: reexport.name,
          address: null,
          weak: null,
          reexport: true,
          source: reexport.source,
          ...(reexport.sourceSymbol === undefined
            ? {}
            : { sourceSymbol: reexport.sourceSymbol }),
        },
      ];
    const exported = /^(0x[\da-f]+)\s+(.+?)(?:\s+\[([^\]]+)\])?$/iu.exec(line);
    if (exported?.[1] === undefined || exported[2] === undefined) return [];
    const rawName = /^0x[\da-f]+\s+(.+)$/iu.exec(line)?.[1];
    const literalName = rawName !== undefined && knownExportNames.has(rawName);
    // If nm establishes both interpretations, the textual row cannot bind an address or flags.
    // Let the caller retain the exact nm names without guessing which one owns this row.
    if (
      literalName &&
      exported[3] !== undefined &&
      knownExportNames.has(exported[2])
    )
      return [];
    const annotation = literalName ? undefined : exported[3];
    const absolute = /\babsolute\b/u.test(annotation ?? "");
    const address =
      offsets && !absolute
        ? imageBase === null
          ? null
          : `0x${(BigInt(imageBase) + BigInt(exported[1])).toString(16)}`
        : canonicalHex(exported[1]);
    return [
      {
        name: literalName ? rawName : exported[2],
        address,
        weak: /\bweak-def\b/u.test(annotation ?? "") ? true : null,
        reexport: false,
        source: null,
      },
    ];
  });
};

const canonicalHex = (value: string | undefined): string | null =>
  value === undefined ? null : `0x${BigInt(value).toString(16)}`;

interface ReexportRow {
  readonly name: string;
  readonly source: string | null;
  readonly sourceSymbol?: string;
}

/**
 * Split a `[re-export]` row without nested lazy quantifiers.
 *
 * Returns null when the line is not a re-export row so callers fall through
 * to the plain export parser. A `[re-export]` line without a valid trailing
 * `(from lib)` / `(old from lib)` suffix keeps its whole remainder as a bare
 * name, matching the previous optional-suffix behaviour.
 */
const parseReexportRow = (line: string): ReexportRow | null => {
  const prefix = /^\[re-export\]\s+/u.exec(line);
  if (prefix === null) return null;
  const rest = line.slice(prefix[0].length);
  if (rest.length === 0) return null;
  if (!rest.endsWith(")")) return { name: rest, source: null };
  // Candidate suffix starts are whitespace + `(`; the source symbol itself may
  // contain parentheses without preceding whitespace (e.g. `operator()`),
  // so those never split. Scan from the last candidate so an exported name
  // containing ` (` keeps its full text.
  const starts: number[] = [];
  const delimiter = /\s+\(/gu;
  let delimiterMatch: RegExpExecArray | null;
  while ((delimiterMatch = delimiter.exec(rest)) !== null) {
    starts.push(delimiterMatch.index);
    // Avoid stalling on zero-length progress (defensive; \s+\( consumes).
    if (delimiter.lastIndex === delimiterMatch.index) delimiter.lastIndex += 1;
  }
  for (let i = starts.length - 1; i >= 0; i -= 1) {
    const boundary = starts[i];
    if (boundary === undefined) continue;
    const name = rest.slice(0, boundary);
    if (name.length === 0) continue;
    const delimiterLength =
      rest.slice(boundary).match(/^\s+\(/u)?.[0].length ?? 2;
    // Skip the delimiter; the line ends with `)`.
    const inner = rest.slice(boundary + delimiterLength, rest.length - 1);
    if (inner.length === 0) continue;
    // Try the plain `(from lib)` form first so a library install name
    // containing ` from ` keeps its whole text.
    if (inner.startsWith("from ") && inner.length > "from ".length)
      return { name, source: inner.slice("from ".length) };
    const separator = /\s+from /u.exec(inner);
    if (separator === null) continue;
    const sourceSymbol = inner.slice(0, separator.index);
    const source = inner.slice(separator.index + separator[0].length);
    if (sourceSymbol.length === 0 || source.length === 0) continue;
    return { name, source, sourceSymbol };
  }
  return { name: rest, source: null };
};
