import { z } from "zod";

import { localPathStringSchema } from "../localPath.js";

/** UDID format emitted by idevice_id. Keep the original value for provenance. */
const deviceIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9-]*$/u,
    "iOS device id contains invalid characters",
  );

const remotePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^\/[^\x00]*$/u, "Remote iOS path must be absolute and NUL-free");

const sshUserSchema = z
  .enum(["root", "mobile"])
  .optional()
  .describe("SSH account; omitted uses REA_IOS_SSH_USER, then root");

/** Caller intent for a libimobiledevice plus jailbreak SSH observation. */
export const iosInputSchemas = {
  inspect_ios_toolchain: z.strictObject({}),
  list_ios_devices: z.strictObject({}),
  inspect_ios_device: z.strictObject({
    device_id: deviceIdSchema.describe("UDID exactly as idevice_id reports it"),
  }),
  list_ios_apps: z.strictObject({
    device_id: deviceIdSchema.describe("UDID exactly as idevice_id reports it"),
    scope: z
      .enum(["all", "user", "system"])
      .default("all")
      .describe("Installed application scope"),
  }),
  list_ios_processes: z.strictObject({
    device_id: deviceIdSchema.describe("UDID exactly as idevice_id reports it"),
  }),
  inspect_ios_process: z.strictObject({
    device_id: deviceIdSchema.describe("UDID exactly as idevice_id reports it"),
    pid: z
      .number()
      .int()
      .positive()
      .describe("Process id observed on the device"),
    user: sshUserSchema,
  }),
  read_ios_log: z.strictObject({
    device_id: deviceIdSchema.describe("UDID exactly as idevice_id reports it"),
    count: z.number().int().min(1).max(20_000).default(500),
    duration_ms: z.number().int().min(250).max(60_000).default(5000),
    match: z
      .string()
      .max(512)
      .optional()
      .describe("Optional idevicesyslog match filter"),
    process: z
      .string()
      .max(256)
      .optional()
      .describe("Optional process name filter"),
  }),
  pull_ios_file: z.strictObject({
    device_id: deviceIdSchema.describe("UDID exactly as idevice_id reports it"),
    remote_path: remotePathSchema.describe(
      "Absolute path on the jailbroken device",
    ),
    output_directory: localPathStringSchema.describe("Local output directory"),
    user: sshUserSchema,
  }),
  run_ios_command: z.strictObject({
    device_id: deviceIdSchema.describe("UDID exactly as idevice_id reports it"),
    command: z
      .string()
      .min(1)
      .max(16_384)
      .regex(/^[^\x00]*$/u, "Command cannot contain NUL"),
    user: sshUserSchema,
    timeout_ms: z.number().int().min(250).max(300_000).default(30_000),
  }),
  inspect_ios_runtime: z.strictObject({
    device_id: deviceIdSchema.describe("UDID exactly as idevice_id reports it"),
  }),
  attach_ios_debugserver: z.strictObject({
    device_id: deviceIdSchema.describe("UDID exactly as idevice_id reports it"),
    pid: z
      .number()
      .int()
      .positive()
      .describe("Process id observed on the device"),
    remote_port: z.number().int().min(1024).max(65535).default(12345),
    user: sshUserSchema,
  }),
  run_ios_lldb_command: z.strictObject({
    device_id: deviceIdSchema.describe("UDID exactly as idevice_id reports it"),
    pid: z
      .number()
      .int()
      .positive()
      .describe("Process id observed on the device"),
    commands: z
      .array(
        z
          .string()
          .min(1)
          .max(4096)
          .regex(/^[^\x00]*$/u),
      )
      .min(1)
      .max(64),
    remote_port: z.number().int().min(1024).max(65535).default(12345),
    user: sshUserSchema,
    timeout_ms: z.number().int().min(250).max(300_000).default(30_000),
  }),
  run_ios_frida_script: z
    .strictObject({
      device_id: deviceIdSchema.describe(
        "UDID exactly as idevice_id reports it",
      ),
      pid: z.number().int().positive().optional(),
      process: z
        .string()
        .min(1)
        .max(512)
        .regex(/^[^\x00]*$/u)
        .optional(),
      script: z
        .string()
        .min(1)
        .max(1_000_000)
        .regex(/^[^\x00]*$/u),
      remote_port: z.number().int().min(1024).max(65535).default(27042),
      user: sshUserSchema,
      timeout_ms: z.number().int().min(250).max(300_000).default(30_000),
    })
    .refine(
      (value) => (value.pid !== undefined) !== (value.process !== undefined),
      {
        message: "Select exactly one of pid or process",
      },
    ),
  dump_ios_process_memory: z.strictObject({
    device_id: deviceIdSchema.describe("UDID exactly as idevice_id reports it"),
    pid: z
      .number()
      .int()
      .positive()
      .describe("Process id observed on the device"),
    address: z
      .string()
      .regex(/^0x[0-9a-f]+$/iu)
      .max(18),
    size: z.number().int().min(1).max(1_048_576).default(256),
    remote_port: z.number().int().min(1024).max(65535).default(12345),
    user: sshUserSchema,
    timeout_ms: z.number().int().min(250).max(300_000).default(30_000),
  }),
} as const;

export type IosOperation = keyof typeof iosInputSchemas;
export type IosRequest = {
  [Name in IosOperation]: {
    operation: Name;
    input: z.infer<(typeof iosInputSchemas)[Name]>;
  };
}[IosOperation];

export const iosRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    operation: z.literal("inspect_ios_toolchain"),
    input: iosInputSchemas.inspect_ios_toolchain,
  }),
  z.strictObject({
    operation: z.literal("list_ios_devices"),
    input: iosInputSchemas.list_ios_devices,
  }),
  z.strictObject({
    operation: z.literal("inspect_ios_device"),
    input: iosInputSchemas.inspect_ios_device,
  }),
  z.strictObject({
    operation: z.literal("list_ios_apps"),
    input: iosInputSchemas.list_ios_apps,
  }),
  z.strictObject({
    operation: z.literal("list_ios_processes"),
    input: iosInputSchemas.list_ios_processes,
  }),
  z.strictObject({
    operation: z.literal("inspect_ios_process"),
    input: iosInputSchemas.inspect_ios_process,
  }),
  z.strictObject({
    operation: z.literal("read_ios_log"),
    input: iosInputSchemas.read_ios_log,
  }),
  z.strictObject({
    operation: z.literal("pull_ios_file"),
    input: iosInputSchemas.pull_ios_file,
  }),
  z.strictObject({
    operation: z.literal("run_ios_command"),
    input: iosInputSchemas.run_ios_command,
  }),
  z.strictObject({
    operation: z.literal("inspect_ios_runtime"),
    input: iosInputSchemas.inspect_ios_runtime,
  }),
  z.strictObject({
    operation: z.literal("attach_ios_debugserver"),
    input: iosInputSchemas.attach_ios_debugserver,
  }),
  z.strictObject({
    operation: z.literal("run_ios_lldb_command"),
    input: iosInputSchemas.run_ios_lldb_command,
  }),
  z.strictObject({
    operation: z.literal("run_ios_frida_script"),
    input: iosInputSchemas.run_ios_frida_script,
  }),
  z.strictObject({
    operation: z.literal("dump_ios_process_memory"),
    input: iosInputSchemas.dump_ios_process_memory,
  }),
]);

const clientTool = z.strictObject({
  name: z.string().min(1),
  binary_path: z.string().min(1),
  version: z.string().nullable(),
  available: z.boolean(),
  reason: z.string().nullable(),
});

const iosDevice = z.strictObject({
  device_id: deviceIdSchema,
  name: z.string().nullable(),
  transport: z.enum(["usb", "network", "unknown"]),
});

const iosApp = z.strictObject({
  bundle_id: z.string().min(1),
  version: z.string().nullable(),
  name: z.string().nullable(),
  path: z.string().nullable(),
  executable: z.string().nullable(),
  scope: z.enum(["user", "system", "unknown"]),
});

const iosProcess = z.strictObject({
  pid: z.number().int().nonnegative(),
  name: z.string().min(1),
  raw: z.string().nullable(),
});

export const iosResultSchemas = {
  inspect_ios_toolchain: z.strictObject({
    tools: z.array(clientTool),
    ssh_password_source: z.enum(["environment", "none"]),
  }),
  list_ios_devices: z.strictObject({
    devices: z.array(iosDevice),
    unparsed_lines: z.array(z.string()),
    coverage: z.enum(["complete", "partial"]),
  }),
  inspect_ios_device: z.strictObject({
    device_id: deviceIdSchema,
    name: z.string().nullable(),
    product_type: z.string().nullable(),
    product_version: z.string().nullable(),
    build_version: z.string().nullable(),
    architecture: z.string().nullable(),
    jailbroken_ssh: z.strictObject({
      connected: z.boolean(),
      user: z.string().nullable(),
      uname: z.string().nullable(),
      jailbreak_roots: z.array(z.string()),
      reason: z.string().nullable(),
    }),
    selected_info: z.array(
      z.strictObject({ key: z.string(), value: z.string() }),
    ),
  }),
  list_ios_apps: z.strictObject({
    device_id: deviceIdSchema,
    scope: z.enum(["all", "user", "system"]),
    apps: z.array(iosApp),
    unparsed_lines: z.array(z.string()),
    coverage: z.enum(["complete", "partial"]),
  }),
  list_ios_processes: z.strictObject({
    device_id: deviceIdSchema,
    processes: z.array(iosProcess),
    source: z.literal("idevicesyslog"),
    unparsed_lines: z.array(z.string()),
    coverage: z.enum(["complete", "partial"]),
  }),
  inspect_ios_process: z.strictObject({
    device_id: deviceIdSchema,
    pid: z.number().int().positive(),
    probes: z.array(
      z.strictObject({
        name: z.enum(["ps", "lsof"]),
        exit_code: z.number().int().nullable(),
      }),
    ),
    user: z.enum(["root", "mobile"]),
    stdout: z.string(),
    stderr: z.string(),
    exit_code: z.number().int().nullable(),
    coverage: z.enum(["complete", "partial"]),
  }),
  read_ios_log: z.strictObject({
    device_id: deviceIdSchema,
    count: z.number().int().positive(),
    lines: z.array(z.string()),
    duration_ms: z.number().int().positive(),
    stop_reason: z.enum(["duration", "exited", "output_limit"]),
    source: z.literal("idevicesyslog"),
    coverage: z.enum(["complete", "partial"]),
  }),
  pull_ios_file: z.strictObject({
    device_id: deviceIdSchema,
    remote_path: remotePathSchema,
    local_path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    user: z.enum(["root", "mobile"]),
  }),
  run_ios_command: z.strictObject({
    device_id: deviceIdSchema,
    user: z.enum(["root", "mobile"]),
    stdout: z.string(),
    stderr: z.string(),
    exit_code: z.number().int().nullable(),
    timed_out: z.boolean(),
    coverage: z.enum(["complete", "partial"]),
  }),
  inspect_ios_runtime: z.strictObject({
    device_id: deviceIdSchema,
    host_tools: z.array(
      z.strictObject({
        name: z.string(),
        path: z.string(),
        available: z.boolean(),
        version: z.string().nullable(),
        reason: z.string().nullable(),
      }),
    ),
    remote_tools: z.array(
      z.strictObject({
        name: z.string(),
        path: z.string().nullable(),
        available: z.boolean(),
      }),
    ),
    unparsed_lines: z.array(z.string()),
    coverage: z.enum(["complete", "partial"]),
  }),
  attach_ios_debugserver: z.strictObject({
    device_id: deviceIdSchema,
    pid: z.number().int().positive(),
    remote_port: z.number().int().positive(),
    local_port: z.number().int().positive(),
    remote_pid: z.number().int().positive().nullable(),
    debugserver_path: z.string().nullable(),
    status: z.enum(["attached", "unavailable"]),
  }),
  run_ios_lldb_command: z.strictObject({
    device_id: deviceIdSchema,
    pid: z.number().int().positive(),
    local_port: z.number().int().positive(),
    commands: z.array(z.string()),
    stdout: z.string(),
    stderr: z.string(),
    exit_code: z.number().int().nullable(),
    stop_reason: z.string().nullable(),
    coverage: z.enum(["complete", "partial"]),
  }),
  run_ios_frida_script: z.strictObject({
    device_id: deviceIdSchema,
    pid: z.number().int().positive().nullable(),
    process: z.string().nullable(),
    local_port: z.number().int().positive(),
    stdout: z.string(),
    stderr: z.string(),
    exit_code: z.number().int().nullable(),
    timed_out: z.boolean(),
    stop_reason: z.enum(["duration", "exited", "output_limit"]).optional(),
    coverage: z.enum(["complete", "partial"]),
  }),
  dump_ios_process_memory: z.strictObject({
    device_id: deviceIdSchema,
    pid: z.number().int().positive(),
    address: z.string(),
    size: z.number().int().positive(),
    local_port: z.number().int().positive(),
    hexdump: z.string(),
    stderr: z.string(),
    exit_code: z.number().int().nullable(),
    stop_reason: z.string().nullable(),
    coverage: z.enum(["complete", "partial"]),
  }),
} as const;
