import { z } from "zod";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import { PWNTOOLS_LIMITS } from "../native/pwntools/PwntoolsRelease.js";

/** Reserve worker address space for four input-sized representations plus bounded reply/diagnostics. */
export const PWNTOOLS_INPUT_CAPACITY_BYTES = Math.floor(
  (PWNTOOLS_LIMITS.addressSpaceBytes -
    PWNTOOLS_LIMITS.outputBytes -
    PWNTOOLS_LIMITS.diagnosticBytes) /
    4,
);

/** Positive decimal input budget within the worker representation capacity. */
export const pwntoolsMaxInputBytesSchema = z
  .string()
  .refine(
    (val) => val === "" || /^[1-9]\d*$/u.test(val),
    "must be a positive decimal integer",
  )
  .transform((val) => (val === "" ? undefined : Number(val)))
  .pipe(
    z
      .number()
      .int()
      .safe()
      .min(1)
      .max(PWNTOOLS_INPUT_CAPACITY_BYTES)
      .optional(),
  );

const budgetConstraint = `REA_PWNTOOLS_MAX_INPUT_BYTES must be a positive decimal safe integer no greater than ${PWNTOOLS_INPUT_CAPACITY_BYTES} bytes (worker representation capacity).`;

/** Parse the optional pwntools input budget setting without reading the ambient process environment. */
export const parsePwntoolsMaxInputBytes = (
  value: string | undefined,
): Result<number, ConfigurationError> => {
  if (value === undefined || value === "")
    return ok(PWNTOOLS_LIMITS.inputBytes);
  const parsed = pwntoolsMaxInputBytesSchema.safeParse(value);
  return parsed.success && parsed.data !== undefined
    ? ok(parsed.data)
    : err(
        new ConfigurationError(budgetConstraint, {
          settings: [
            {
              setting: "REA_PWNTOOLS_MAX_INPUT_BYTES",
              constraint: budgetConstraint,
            },
          ],
        }),
      );
};
