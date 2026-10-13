import type { FunctionSnapshot } from "./functionDossierEvidence.js";
import { parseAddress } from "./functionComparisonNormalization.js";
import type { TextAddressLocation } from "./functionComparisonTextParsing.js";

export interface AddressMask {
  readonly kind: "relative" | "external";
  /** Exact relative offset or a side-local key for an external ordinal. */
  readonly value: string;
}

export interface AddressProjection {
  readonly maskIdentifier: (address: bigint) => AddressMask | null;
  readonly maskTextAddress: (
    address: bigint,
    location: TextAddressLocation,
  ) => AddressMask | null;
  readonly isCalleeAddress: (address: bigint) => boolean;
}

interface BodyExtent {
  readonly base: bigint;
  readonly ranges: readonly (readonly [bigint, bigint])[];
}

/** Whether this dossier provides ranges for its function body. */
export const hasFunctionBodyExtent = (snapshot: FunctionSnapshot): boolean =>
  bodyExtent(snapshot) !== null;

/** Build the evidence-backed address projection for one dossier. */
export const createFunctionAddressProjection = (
  snapshot: FunctionSnapshot,
  relativeOffsets: boolean,
): AddressProjection => {
  const addresses = corroboratedAddresses(snapshot);
  const calleeAddresses = new Set(
    [
      ...snapshot.dossier.callees.flatMap((callee) =>
        [callee.address, callee.classification?.thunk_target]
          .map((value) => parseAddress((value ?? "").toLowerCase()))
          .filter((value): value is bigint => value !== null),
      ),
      parseAddress(
        (
          snapshot.dossier.procedure.classification?.thunk_target ?? ""
        ).toLowerCase(),
      ),
    ].filter((value): value is bigint => value !== null),
  );
  const extent = relativeOffsets ? bodyExtent(snapshot) : null;
  const targetsBySite = referenceTargetsBySite(snapshot);
  const instructionSites = observedInstructionSites(snapshot);
  const observedAddress = (address: bigint): AddressMask | null => {
    if (extent !== null && contains(extent.ranges, address))
      return {
        kind: "relative",
        value: `+0x${(address - extent.base).toString(16)}`,
      };
    return addresses.has(address)
      ? { kind: "external", value: `address:${address.toString(16)}` }
      : null;
  };
  return {
    isCalleeAddress: (address) => calleeAddresses.has(address),
    maskIdentifier: observedAddress,
    maskTextAddress: (address, location) => {
      if (location.isAddressSpaceQualified) return null;
      if (
        location.isInstructionAddress &&
        location.instructionAddress === address
      ) {
        const relative = observedAddress(address);
        if (relative?.kind === "relative") return relative;
        return instructionSites.has(address) ? relative : null;
      }
      if (
        location.isControlFlowTarget &&
        extent !== null &&
        contains(extent.ranges, address)
      )
        return observedAddress(address);
      const siteTargets =
        location.instructionAddress === null
          ? undefined
          : targetsBySite.get(location.instructionAddress);
      if (
        location.operandIndex !== null &&
        location.operandAddressOccurrences === 1 &&
        siteTargets?.some(
          (reference) =>
            reference.target === address &&
            reference.operandIndex === location.operandIndex,
        ) === true
      )
        return observedAddress(address);
      if (
        location.operandIndex !== null &&
        location.operandAddressOccurrences === 1 &&
        location.instructionAddressOccurrences === 1 &&
        siteTargets?.some(
          (reference) =>
            reference.target === address && reference.operandIndex === null,
        ) === true
      )
        return observedAddress(address);
      if (location.isControlFlowTarget && calleeAddresses.has(address))
        return observedAddress(address);
      return null;
    },
  };
};

interface ReferenceTarget {
  readonly target: bigint;
  readonly operandIndex: number | null;
}

/** Read the observed body extent without expanding an address into a lookup table. */
const bodyExtent = (snapshot: FunctionSnapshot): BodyExtent | null => {
  const body = snapshot.dossier.procedure.body;
  const base = parseAddress(snapshot.dossier.procedure.address.toLowerCase());
  if (base === null || !body.available || body.ranges.length === 0) return null;
  const ranges: [bigint, bigint][] = [];
  for (const range of body.ranges) {
    const start = parseAddress(range.start.toLowerCase());
    const end = parseAddress(range.end.toLowerCase());
    if (start === null || end === null || end < start) return null;
    ranges.push([start, end]);
  }
  ranges.sort((left, right) =>
    left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
  );
  return { base, ranges };
};

/** Address facts used for identifier matching, kept separate from numeric uses. */
const corroboratedAddresses = (snapshot: FunctionSnapshot): Set<bigint> => {
  const addresses = new Set<bigint>();
  const add = (value: string | null | undefined) => {
    const parsed = parseAddress((value ?? "").toLowerCase());
    if (parsed !== null) addresses.add(parsed);
  };
  const { dossier } = snapshot;
  add(dossier.procedure.address);
  add(dossier.procedure.classification?.thunk_target);
  if (dossier.procedure.body.available)
    for (const range of dossier.procedure.body.ranges) {
      add(range.start);
      add(range.end);
    }
  for (const block of dossier.basic_blocks) {
    add(block.start);
    add(block.end);
    for (const successor of block.successors) add(successor);
  }
  for (const comment of dossier.comments) add(comment.address);
  for (const edge of [
    ...dossier.incoming_references,
    ...dossier.outgoing_references,
  ]) {
    add(edge.source_address);
    add(edge.target_address);
    for (const identity of [edge.source_procedure, edge.target_procedure]) {
      add(identity?.address);
      add(identity?.classification?.thunk_target);
    }
  }
  for (const identity of [...dossier.callers, ...dossier.callees]) {
    add(identity.address);
    add(identity.classification?.thunk_target);
  }
  for (const item of [
    ...dossier.referenced_strings,
    ...dossier.referenced_names,
  ]) {
    add(item.address);
    add(item.source_address);
  }
  return addresses;
};

/** Reference facts are matched by source site and operand, never by value alone. */
const referenceTargetsBySite = (
  snapshot: FunctionSnapshot,
): Map<bigint, ReferenceTarget[]> => {
  const targets = new Map<bigint, ReferenceTarget[]>();
  const add = (source: string, target: string, operandIndex: number | null) => {
    const sourceAddress = parseAddress(source.toLowerCase());
    const targetAddress = parseAddress(target.toLowerCase());
    if (sourceAddress === null || targetAddress === null) return;
    const siteTargets = targets.get(sourceAddress) ?? [];
    siteTargets.push({ target: targetAddress, operandIndex });
    targets.set(sourceAddress, siteTargets);
  };
  const { dossier } = snapshot;
  for (const edge of dossier.outgoing_references)
    if (
      edge.kind.available &&
      (edge.kind.call ||
        edge.kind.jump ||
        edge.kind.data ||
        edge.kind.read ||
        edge.kind.write)
    )
      add(edge.source_address, edge.target_address, edge.kind.operand_index);
  for (const item of [
    ...dossier.referenced_strings,
    ...dossier.referenced_names,
  ])
    add(item.source_address, item.address, null);
  return targets;
};

const observedInstructionSites = (snapshot: FunctionSnapshot): Set<bigint> => {
  const addresses = new Set<bigint>();
  const add = (value: string | null | undefined) => {
    const parsed = parseAddress((value ?? "").toLowerCase());
    if (parsed !== null) addresses.add(parsed);
  };
  add(snapshot.dossier.procedure.address);
  for (const block of snapshot.dossier.basic_blocks) {
    add(block.start);
    add(block.end);
  }
  for (const edge of snapshot.dossier.outgoing_references)
    add(edge.source_address);
  for (const comment of snapshot.dossier.comments) add(comment.address);
  for (const item of [
    ...snapshot.dossier.referenced_strings,
    ...snapshot.dossier.referenced_names,
  ])
    add(item.source_address);
  return addresses;
};

/** Binary search over sorted inclusive ranges; bodies are never expanded. */
const contains = (
  ranges: readonly (readonly [bigint, bigint])[],
  address: bigint,
): boolean => {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const range = ranges[middle];
    if (range === undefined) return false;
    if (address < range[0]) high = middle - 1;
    else if (address > range[1]) low = middle + 1;
    else return true;
  }
  return false;
};
