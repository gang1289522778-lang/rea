import { parseAddress } from "./functionComparisonNormalization.js";

const HEXADECIMAL_ADDRESS = /(?<![0-9A-Za-z_:])0x[0-9a-f]+/giu;

export interface TextAddressLocation {
  readonly instructionAddress: bigint | null;
  readonly isInstructionAddress: boolean;
  readonly isControlFlowTarget: boolean;
  readonly isAddressSpaceQualified: boolean;
  readonly operandIndex: number | null;
  readonly operandAddressOccurrences: number;
  readonly instructionAddressOccurrences: number;
}

/** Transform code while preserving quoted literals and provider comments. */
export const transformProviderText = (
  text: string,
  assembly: boolean,
  transform: (code: string, offset: number) => string,
): string | null => {
  let output = "";
  let codeStart = 0;
  let index = 0;
  while (index < text.length) {
    const current = text[index];
    const next = text[index + 1];
    if (current === '"' || current === "'") {
      if (current === '"' && isRawStringStart(text, index)) return null;
      output += transform(text.slice(codeStart, index), codeStart);
      const quote = current;
      const literalStart = index++;
      let closed = false;
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2;
          continue;
        }
        if (text[index] === quote) {
          index += 1;
          closed = true;
          break;
        }
        if (text[index] === "\n" || text[index] === "\r") return null;
        index += 1;
      }
      if (!closed) return null;
      output += text.slice(literalStart, index);
      codeStart = index;
      continue;
    }
    if (current === "/" && (next === "/" || next === "*")) {
      output += transform(text.slice(codeStart, index), codeStart);
      const commentStart = index;
      if (next === "/") {
        index += 2;
        while (index < text.length && text[index] !== "\n") index += 1;
      } else {
        index += 2;
        const end = text.indexOf("*/", index);
        if (end < 0) return null;
        index = end + 2;
      }
      output += text.slice(commentStart, index);
      codeStart = index;
      continue;
    }
    if (assembly && current === ";") {
      output += transform(text.slice(codeStart, index), codeStart);
      const commentStart = index;
      while (index < text.length && text[index] !== "\n") index += 1;
      output += text.slice(commentStart, index);
      codeStart = index;
      continue;
    }
    if (current === "`") return null;
    index += 1;
  }
  output += transform(text.slice(codeStart), codeStart);
  return output;
};

/** Detect supported raw-string prefixes using only the adjacent token. */
const isRawStringStart = (text: string, quoteIndex: number): boolean => {
  let markerIndex = quoteIndex - 1;
  while (markerIndex >= 0 && text[markerIndex] === "#") markerIndex -= 1;
  const marker = text[markerIndex];
  if (marker === "r") {
    const prefixIndex =
      markerIndex > 0 && text[markerIndex - 1] === "b"
        ? markerIndex - 1
        : markerIndex;
    return !isIdentifierCharacter(text[prefixIndex - 1]);
  }
  if (marker !== "R" || markerIndex !== quoteIndex - 1) return false;
  return ["R", "uR", "u8R", "UR", "LR"].some((prefix) => {
    const prefixIndex = quoteIndex - prefix.length;
    return (
      text.slice(prefixIndex, quoteIndex) === prefix &&
      !isIdentifierCharacter(text[prefixIndex - 1])
    );
  });
};

const isIdentifierCharacter = (character: string | undefined): boolean =>
  character !== undefined && /[A-Za-z0-9_]/u.test(character);

/** Keep named assembly address spaces literal, even when their offsets match. */
const hasAddressSpaceQualifier = (
  text: string,
  lineStart: number,
  tokenOffset: number,
): boolean => {
  let index = tokenOffset - 1;
  while (index >= lineStart && isWhitespace(text[index])) index -= 1;
  if (text[index] !== ":") return false;
  index -= 1;
  while (index >= lineStart && isWhitespace(text[index])) index -= 1;
  const nameEnd = index + 1;
  while (index >= lineStart && /[A-Za-z0-9_.$-]/u.test(text[index] ?? ""))
    index -= 1;
  const nameStart = index + 1;
  return nameStart < nameEnd && /[A-Za-z_.$]/u.test(text[nameStart] ?? "");
};

const isWhitespace = (character: string | undefined): boolean =>
  character !== undefined && /\s/u.test(character);

/** Locate an assembly token and its exact operand position, when available. */
export const textAddressLocation = (
  text: string,
  tokenOffset: number,
  address: bigint,
  assembly: boolean,
): TextAddressLocation => {
  if (!assembly) return emptyAddressLocation();
  const lineStart = text.lastIndexOf("\n", tokenOffset - 1) + 1;
  const isAddressSpaceQualified = hasAddressSpaceQualifier(
    text,
    lineStart,
    tokenOffset,
  );
  const newline = text.indexOf("\n", tokenOffset);
  const lineEnd = newline < 0 ? text.length : newline;
  const line = text.slice(lineStart, lineEnd);
  const prefix = /^(\s*)(0x[0-9a-f]+):\s*/iu.exec(line);
  if (prefix === null)
    return { ...emptyAddressLocation(), isAddressSpaceQualified };

  const instructionAddress = parseAddress((prefix[2] ?? "").toLowerCase());
  const tokenInLine = tokenOffset - lineStart;
  const isInstructionAddress = tokenInLine === (prefix[1] ?? "").length;
  const instructionStart = prefix[0].length;
  const instruction = line.slice(instructionStart);
  const mnemonic = /^([a-z][a-z0-9_.]*)\b/iu.exec(instruction)?.[1];
  const lowerMnemonic = mnemonic?.toLowerCase() ?? "";
  const operandsStart =
    instructionStart + (mnemonic?.length ?? instruction.length);
  const operandRanges = splitAssemblyOperands(
    line.slice(operandsStart),
    operandsStart,
  );
  const operandIndex = operandRanges.findIndex(
    ({ start, end }) => tokenInLine >= start && tokenInLine < end,
  );
  const operandRange = operandRanges[operandIndex];
  const directOperand =
    operandRange === undefined
      ? ""
      : line.slice(operandRange.start, operandRange.end).trim();
  const isControlFlowTarget =
    /^(?:callq?|lcall|bl|blx|blr|jal|jalr|jmpq?|ljmp|j[a-z]+|b(?:\.[a-z]+)?|br|cbz|cbnz|tbz|tbnz|tbb|tbh)$/u.test(
      lowerMnemonic,
    ) &&
    operandIndex === operandRanges.length - 1 &&
    /^#?0x[0-9a-f]+$/iu.test(directOperand);
  const operandAddressOccurrences =
    operandRange === undefined
      ? 0
      : [...line.matchAll(HEXADECIMAL_ADDRESS)].filter(
          (match) =>
            (match.index ?? -1) >= operandRange.start &&
            (match.index ?? -1) < operandRange.end &&
            parseAddress(match[0].toLowerCase()) === address,
        ).length;
  const instructionAddressOccurrences = [
    ...line.matchAll(HEXADECIMAL_ADDRESS),
  ].filter((match) => (match.index ?? -1) >= operandsStart).length;
  return {
    instructionAddress,
    isInstructionAddress,
    isControlFlowTarget,
    isAddressSpaceQualified,
    operandIndex: operandIndex < 0 ? null : operandIndex,
    operandAddressOccurrences,
    instructionAddressOccurrences,
  };
};

const emptyAddressLocation = (): TextAddressLocation => ({
  instructionAddress: null,
  isInstructionAddress: false,
  isControlFlowTarget: false,
  isAddressSpaceQualified: false,
  operandIndex: null,
  operandAddressOccurrences: 0,
  instructionAddressOccurrences: 0,
});

const splitAssemblyOperands = (
  text: string,
  offset: number,
): { readonly start: number; readonly end: number }[] => {
  const ranges: { start: number; end: number }[] = [];
  const stack: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    if (quote !== null) {
      if (current === "\\") {
        if (index + 1 >= text.length) return [];
        index += 1;
      } else if (current === quote) quote = null;
      continue;
    }
    if (current === '"' || current === "'") quote = current;
    else if (current === "[" || current === "(" || current === "{")
      stack.push(current);
    else if (current === "]" || current === ")" || current === "}") {
      const expected = { "]": "[", ")": "(", "}": "{" }[current];
      if (stack.pop() !== expected) return [];
    } else if (
      (current === ";" ||
        (current === "/" &&
          (text[index + 1] === "/" || text[index + 1] === "*"))) &&
      stack.length === 0
    ) {
      break;
    } else if (current === "," && stack.length === 0) {
      addOperandRange(ranges, text, offset, start, index);
      start = index + 1;
    }
  }
  if (quote !== null || stack.length > 0) return [];
  addOperandRange(ranges, text, offset, start, text.length);
  return ranges;
};

const addOperandRange = (
  ranges: { start: number; end: number }[],
  text: string,
  offset: number,
  start: number,
  end: number,
): void => {
  while (start < end && /\s/u.test(text[start] ?? "")) start += 1;
  while (end > start && /\s/u.test(text[end - 1] ?? "")) end -= 1;
  if (start < end) ranges.push({ start: offset + start, end: offset + end });
};
