import { z } from "zod";
import type { ClientRegistrationDialect } from "./ClientConfigurationDocument.js";

/**
 * Registration-status fields doctor parses on every client. User fields
 * outside this schema, such as OMP `timeout`, are not registration-status
 * fields. Setup accepts a retained value only when this schema does.
 */
export const registrationSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    startup_timeout_sec: z.number().positive().optional(),
    type: z.string().optional(),
    transport: z.string().optional(),
    serverName: z.string().optional(),
    tools: z.array(z.string()).optional(),
    disabled: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .passthrough();

const codexRegistrationSchema = registrationSchema.extend({
  tool_timeout_sec: z.number().optional(),
  enabled_tools: z.array(z.string()).optional(),
  disabled_tools: z.array(z.string()).optional(),
});

const zcodeRegistrationSchema = registrationSchema.extend({
  enable: z.boolean().optional(),
});

/** Client-specific parsing is shared by retention and registration diagnostics. */
export const registrationSchemaFor = (dialect: ClientRegistrationDialect) =>
  dialect === "toml"
    ? codexRegistrationSchema
    : dialect === "zcode"
      ? zcodeRegistrationSchema
      : registrationSchema;

/** Whether a retained field satisfies the selected client's known contract. */
export const registrationFieldAccepted = (
  dialect: ClientRegistrationDialect,
  key: string,
  value: unknown,
): boolean => {
  const shape: Readonly<Record<string, z.ZodType>> =
    registrationSchemaFor(dialect).shape;
  const field = Object.hasOwn(shape, key) ? shape[key] : undefined;
  return field === undefined || field.safeParse(value).success;
};
