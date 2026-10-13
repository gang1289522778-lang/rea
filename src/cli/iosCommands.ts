import { z } from "incur";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { IosDeviceAnalysisService } from "../application/ios/IosDeviceAnalysisService.js";
import type { IosDeviceAnalysisPort } from "../application/ios/IosDeviceAnalysisPort.js";
import { createIosDeviceAnalysisProvider } from "../composition/ios.js";
import type { IosOperation } from "../domain/ios/iosDeviceAnalysis.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { logCliCommand } from "../cliLogging.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";

/** Expose iOS USB and jailbreak SSH observations through one-shot commands. */
export const registerIosCommands = (
  cli: CliInstance,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
  provider: IosDeviceAnalysisPort = createIosDeviceAnalysisProvider(
    environment,
  ),
): void => {
  const service = new IosDeviceAnalysisService(provider);
  const execute = (name: string, operation: IosOperation, input: unknown) =>
    withCommandCancellation((signal) =>
      logCliCommand(logger, name, async () => {
        const result = await service.execute(operation, input, { signal });
        try {
          await provider.close();
        } catch (cause) {
          if (cause instanceof AnalysisError)
            return projectAnalysisError(cause);
          throw cause;
        }
        return result.ok ? result.value : projectAnalysisError(result.error);
      }),
    );
  const deviceId = z
    .string()
    .min(1)
    .describe("UDID exactly as idevice_id reports it");
  const user = z
    .enum(["root", "mobile"])
    .optional()
    .describe("SSH account on the jailbroken device");
  cli.command(CLI_COMMANDS.inspectIosToolchain, {
    description: "Inspect libimobiledevice, iproxy, and SSH tools",
    args: z.object({}),
    run: () =>
      execute(CLI_COMMANDS.inspectIosToolchain, "inspect_ios_toolchain", {}),
  });
  cli.command(CLI_COMMANDS.listIosDevices, {
    description: "List paired USB iOS devices",
    args: z.object({}),
    run: () => execute(CLI_COMMANDS.listIosDevices, "list_ios_devices", {}),
  });
  cli.command(CLI_COMMANDS.inspectIosDevice, {
    description: "Inspect one iOS device and probe jailbreak SSH",
    args: z.object({ deviceId }),
    run: ({ args }) =>
      execute(CLI_COMMANDS.inspectIosDevice, "inspect_ios_device", {
        device_id: args.deviceId,
      }),
  });
  cli.command(CLI_COMMANDS.listIosApps, {
    description: "List installed apps and jailbreak filesystem paths",
    args: z.object({ deviceId }),
    options: z.object({
      scope: z
        .enum(["all", "user", "system"])
        .default("all")
        .describe("Installed application scope"),
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.listIosApps, "list_ios_apps", {
        device_id: args.deviceId,
        scope: options.scope,
      }),
  });
  cli.command(CLI_COMMANDS.listIosProcesses, {
    description: "List running iOS processes",
    args: z.object({ deviceId }),
    run: ({ args }) =>
      execute(CLI_COMMANDS.listIosProcesses, "list_ios_processes", {
        device_id: args.deviceId,
      }),
  });
  cli.command(CLI_COMMANDS.inspectIosProcess, {
    description: "Inspect one jailbreak process with ps and lsof",
    args: z.object({
      deviceId,
      pid: z.coerce
        .number()
        .int()
        .positive()
        .describe("Process ID observed on the device"),
      user,
    }),
    run: ({ args }) =>
      execute(CLI_COMMANDS.inspectIosProcess, "inspect_ios_process", {
        device_id: args.deviceId,
        pid: args.pid,
        user: args.user,
      }),
  });
  cli.command(CLI_COMMANDS.readIosLog, {
    description: "Read a bounded live iOS syslog window",
    args: z.object({ deviceId }),
    options: z.object({
      count: z.coerce
        .number()
        .int()
        .min(1)
        .max(20_000)
        .default(500)
        .describe("Maximum number of retained log lines"),
      "duration-ms": z.coerce
        .number()
        .int()
        .min(250)
        .max(60_000)
        .default(5000)
        .describe("Live log capture duration in milliseconds"),
      match: z.string().optional().describe("Optional syslog text filter"),
      process: z
        .string()
        .optional()
        .describe("Optional syslog process name filter"),
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.readIosLog, "read_ios_log", {
        device_id: args.deviceId,
        count: options.count,
        duration_ms: options["duration-ms"],
        ...(options.match === undefined ? {} : { match: options.match }),
        ...(options.process === undefined ? {} : { process: options.process }),
      }),
  });
  cli.command(CLI_COMMANDS.pullIosFile, {
    description: "Pull a jailbroken device file and digest it",
    args: z.object({
      deviceId,
      remotePath: z
        .string()
        .min(1)
        .describe("Absolute path on the jailbroken device"),
      outputDirectory: z
        .string()
        .min(1)
        .describe("Local directory for the acquired file"),
      user,
    }),
    run: ({ args }) =>
      execute(CLI_COMMANDS.pullIosFile, "pull_ios_file", {
        device_id: args.deviceId,
        remote_path: args.remotePath,
        output_directory: args.outputDirectory,
        user: args.user,
      }),
  });
  cli.command(CLI_COMMANDS.runIosCommand, {
    description: "Run an explicitly selected jailbreak SSH command",
    args: z.object({
      deviceId,
      command: z
        .string()
        .min(1)
        .describe("Explicitly selected remote shell command"),
      user,
    }),
    options: z.object({
      timeout: z.coerce
        .number()
        .int()
        .min(250)
        .max(300_000)
        .default(30_000)
        .describe("Operation timeout in milliseconds"),
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.runIosCommand, "run_ios_command", {
        device_id: args.deviceId,
        command: args.command,
        user: args.user,
        timeout_ms: options.timeout,
      }),
  });
  cli.command(CLI_COMMANDS.inspectIosRuntime, {
    description:
      "Inspect remote debugserver/frida-server and host debugger tools",
    args: z.object({ deviceId }),
    run: ({ args }) =>
      execute(CLI_COMMANDS.inspectIosRuntime, "inspect_ios_runtime", {
        device_id: args.deviceId,
      }),
  });
  cli.command(CLI_COMMANDS.runIosLldbCommand, {
    description: "Run LLDB commands through debugserver",
    args: z.object({
      deviceId,
      pid: z.coerce
        .number()
        .int()
        .positive()
        .describe("Process ID observed on the device"),
      commands: z.string().min(1).describe("Newline-separated LLDB commands"),
      user,
    }),
    options: z.object({
      "remote-port": z.coerce
        .number()
        .int()
        .min(1024)
        .max(65535)
        .default(12345)
        .describe("Remote debugger listening port"),
      timeout: z.coerce
        .number()
        .int()
        .min(250)
        .max(300_000)
        .default(30_000)
        .describe("Operation timeout in milliseconds"),
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.runIosLldbCommand, "run_ios_lldb_command", {
        device_id: args.deviceId,
        pid: args.pid,
        commands: args.commands.split(/\r?\n/u).filter(Boolean),
        remote_port: options["remote-port"],
        user: args.user,
        timeout_ms: options.timeout,
      }),
  });
  cli.command(CLI_COMMANDS.runIosFridaScript, {
    description: "Run a Frida JavaScript agent against a jailbroken process",
    args: z.object({
      deviceId,
      script: z.string().min(1).describe("Frida JavaScript agent source"),
    }),
    options: z.object({
      pid: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .describe("Target process ID; select this or --process"),
      process: z
        .string()
        .min(1)
        .optional()
        .describe("Target process name; select this or --pid"),
      user,
      "remote-port": z.coerce
        .number()
        .int()
        .min(1024)
        .max(65535)
        .default(27042)
        .describe("Remote Frida server listening port"),
      timeout: z.coerce
        .number()
        .int()
        .min(250)
        .max(300_000)
        .default(30_000)
        .describe("Operation timeout in milliseconds"),
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.runIosFridaScript, "run_ios_frida_script", {
        device_id: args.deviceId,
        script: args.script,
        ...(options.pid === undefined ? {} : { pid: options.pid }),
        ...(options.process === undefined ? {} : { process: options.process }),
        remote_port: options["remote-port"],
        user: options.user,
        timeout_ms: options.timeout,
      }),
  });
  cli.command(CLI_COMMANDS.dumpIosProcessMemory, {
    description: "Read a bounded process memory range through LLDB",
    args: z.object({
      deviceId,
      pid: z.coerce
        .number()
        .int()
        .positive()
        .describe("Process ID observed on the device"),
      address: z
        .string()
        .regex(/^0x[0-9a-f]+$/iu)
        .describe("Hexadecimal address in the selected process"),
      user,
    }),
    options: z.object({
      size: z.coerce
        .number()
        .int()
        .min(1)
        .max(1_048_576)
        .default(256)
        .describe("Maximum number of memory bytes to read"),
      "remote-port": z.coerce
        .number()
        .int()
        .min(1024)
        .max(65535)
        .default(12345)
        .describe("Remote debugger listening port"),
      timeout: z.coerce
        .number()
        .int()
        .min(250)
        .max(300_000)
        .default(30_000)
        .describe("Operation timeout in milliseconds"),
    }),
    run: ({ args, options }) =>
      execute(CLI_COMMANDS.dumpIosProcessMemory, "dump_ios_process_memory", {
        device_id: args.deviceId,
        pid: args.pid,
        address: args.address,
        size: options.size,
        remote_port: options["remote-port"],
        user: args.user,
        timeout_ms: options.timeout,
      }),
  });
};
