import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { readFileHandleChunks } from "../../filesystem/readFileHandleChunks.js";
import { OwnedFileHandle } from "../../filesystem/OwnedFileHandle.js";

import { ArtifactReaderFailure } from "../ArtifactReader.js";
import {
  NonRegularFileReadError,
  RegularFileAdmissionFailure,
  openRegularFile,
  RegularFileChangedError,
  verifyRegularFileState,
} from "../../filesystem/RegularFile.js";
import {
  abortIfNeeded,
  hashReadable,
  type HashResult,
} from "../ArtifactHash.js";
import type { ArtifactResourceScope } from "../ArtifactResourceScope.js";

/** Admit a root descriptor without losing ownership when validation cleanup fails. */
export const openRootArtifact = async (
  path: string,
  resourceScope: ArtifactResourceScope,
  signal?: AbortSignal,
  admission: "initial" | "inventoried" = "initial",
): Promise<OwnedFileHandle> => {
  try {
    return new OwnedFileHandle(
      await openRegularFile(path, { symlinks: "reject", signal }),
    );
  } catch (cause: unknown) {
    const primary =
      cause instanceof RegularFileAdmissionFailure ? cause.cause : cause;
    const changed =
      admission === "inventoried" &&
      (primary instanceof NonRegularFileReadError ||
        primary instanceof RegularFileChangedError ||
        (primary instanceof Error &&
          "code" in primary &&
          [
            "ENOENT",
            "ENOTDIR",
            "ELOOP",
            "EISDIR",
            "ENOTFILE",
            "ESTALE",
          ].includes(String(primary.code))));
    // Normalize the primary failure before cleanup so failed closes keep both facts.
    const failure =
      signal?.aborted === true
        ? new ArtifactReaderFailure(
            "cancelled",
            "Artifact admission cancelled",
            { cause: primary },
          )
        : changed
          ? new ArtifactReaderFailure(
              "integrity",
              `Inventoried artifact source changed: ${path}`,
              { cause: primary },
            )
          : primary instanceof NonRegularFileReadError
            ? new ArtifactReaderFailure(
                "format",
                `Artifact root is not a regular file: ${path}`,
                { cause: primary },
              )
            : primary;
    if (cause instanceof RegularFileAdmissionFailure) {
      const resource = `root artifact descriptor for ${path}`;
      const cleanup = await resourceScope.release({
        kind: "file-handle",
        resource,
        handle: cause.owner,
      });
      if (cleanup.kind === "failed")
        throw ArtifactReaderFailure.withCleanup(
          failure,
          ArtifactReaderFailure.cleanupObservation(cleanup.cause, resource),
        );
    }
    throw failure;
  }
};

/** Hash one stable regular root file from the same descriptor that was checked. */
export const hashStableRootArtifact = async (
  path: string,
  resourceScope: ArtifactResourceScope,
  signal?: AbortSignal,
): Promise<HashResult> => {
  const owner = await openRootArtifact(path, resourceScope, signal);
  const handle = owner.handle;
  let outcome:
    | { readonly kind: "completed"; readonly value: HashResult }
    | { readonly kind: "failed"; readonly cause: unknown };
  try {
    const initial = await handle.stat();
    outcome = {
      kind: "completed",
      value: await hashStableRootArtifactHandle(path, handle, initial, signal),
    };
  } catch (cause: unknown) {
    outcome = { kind: "failed", cause };
  }
  const resource = `root artifact descriptor for ${path}`;
  const cleanup = await resourceScope.release({
    kind: "file-handle",
    resource,
    handle: owner,
  });
  if (cleanup.kind === "failed")
    throw ArtifactReaderFailure.withCleanup(
      outcome.kind === "failed" ? outcome.cause : cleanup.cause,
      ArtifactReaderFailure.cleanupObservation(cleanup.cause, resource),
    );
  if (outcome.kind === "failed") throw outcome.cause;
  return outcome.value;
};

/** Hash and revalidate the same open descriptor used for root classification. */
export const hashStableRootArtifactHandle = async (
  path: string,
  handle: FileHandle,
  initial: Stats,
  signal?: AbortSignal,
): Promise<HashResult> => {
  const digest = await hashReadable(
    // Read at most the admitted extent plus one byte to detect growth without
    // following an actively appended file indefinitely.
    readFileHandleChunks(handle, { start: 0, end: initial.size }),
    signal,
  );
  abortIfNeeded(signal);
  try {
    await verifyRegularFileState(path, { handle, initial });
  } catch (cause: unknown) {
    abortIfNeeded(signal);
    if (cause instanceof RegularFileChangedError)
      throw new ArtifactReaderFailure(
        "integrity",
        `Root artifact changed during inventory: ${path}`,
        { cause: cause.cause ?? cause },
      );
    throw cause;
  }
  abortIfNeeded(signal);
  if (digest.bytes !== initial.size)
    throw new ArtifactReaderFailure(
      "integrity",
      `Root artifact changed during inventory: ${path}`,
    );
  return digest;
};
