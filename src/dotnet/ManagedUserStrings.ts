import {
  admitManagedProjection,
  managedDecodeBudget,
} from "./ManagedDecodeBudget.js";
import type { ManagedParseIssue } from "../domain/managed/managedArtifact.js";
import type {
  ManagedMethod,
  ManagedUserString,
} from "./ManagedMemberInspectorCore.js";
import type { ManagedMetadataLayout } from "./ManagedMetadataLayout.js";
import { readMetadataUserString } from "./ManagedMetadataHeaps.js";
import { readManagedValue } from "./ManagedReaderFailure.js";

/** Bookkeeping per distinct ldstr token: its set entry and its sorted slot. */
const USER_STRING_TOKEN_BYTES = 128;

/** Decode each distinct #US literal an inspected method loads, in token order. */
export const parseUserStrings = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  methods: readonly ManagedMethod[],
): {
  readonly userStrings: readonly ManagedUserString[];
  readonly issues: readonly ManagedParseIssue[];
} => {
  const budget = managedDecodeBudget(layout);
  const userStrings: ManagedUserString[] = [];
  const issues: ManagedParseIssue[] = [];
  const tokens = new Set<string>();
  try {
    // Only ldstr loads a literal; a malformed ldtoken can carry a 0x70 token.
    for (const method of methods)
      for (const { opcode, operand } of method.body.anchors)
        if (opcode === "ldstr" && operand !== null && !tokens.has(operand)) {
          budget.admitTransient(USER_STRING_TOKEN_BYTES, null);
          tokens.add(operand);
        }
    // Tokens are fixed-width lowercase hex, so string order is token order.
    const references: string[] = [];
    for (const token of [...tokens].sort()) {
      if (token.startsWith("0x70")) references.push(token);
      // An operand from another table names no #US item, with or without
      // the stream.
      else
        issues.push(
          admitManagedProjection(
            {
              code: "invalid-heap-index",
              scope: `metadata.#US:${token}`,
              offset: null,
              detail: "ldstr operand does not name an item inside #US",
            },
            budget,
          ),
        );
    }
    if (references.length > 0 && layout.userStrings === null) {
      // A missing stream is one fact about the metadata, not one per token.
      issues.push(
        admitManagedProjection(
          {
            code: "missing-stream",
            scope: "metadata.#US",
            offset: null,
            detail: `${String(references.length)} distinct ldstr operand(s) reference #US, but the metadata has no #US stream`,
          },
          budget,
        ),
      );
      return { userStrings, issues };
    }
    for (const token of references) {
      const failures: ManagedParseIssue[] = [];
      readManagedValue(() => {
        const { offset, value, issue } = readMetadataUserString(
          bytes,
          layout,
          token,
        );
        if (issue !== null) failures.push(issue);
        userStrings.push(
          admitManagedProjection({ token, offset, value }, budget),
        );
      }, failures);
      for (const failure of failures)
        issues.push(admitManagedProjection(failure, budget));
    }
    return { userStrings, issues };
  } finally {
    budget.releaseTransient();
  }
};
