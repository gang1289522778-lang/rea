import {
  iosInputSchemas,
  iosResultSchemas,
} from "../../domain/ios/iosDeviceAnalysis.js";
import type { ToolContract } from "../toolContractTypes.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import { toolContractMetadata } from "../toolEffects.js";

/** iOS USB pairing and jailbroken-device runtime observations. */
export const IOS_TOOL_CONTRACTS = [
  {
    name: "inspect_ios_toolchain",
    ...toolContractMetadata("inspect_ios_toolchain"),
    description:
      "Inspect the caller-selected libimobiledevice, iproxy, and SSH executables. REA never installs platform tools and only reads REA_IOS_SSH_PASSWORD from the environment without returning it.",
    kind: "ios-provider",
    inputSchema: iosInputSchemas.inspect_ios_toolchain,
    outputSchema: evidenceResultOf(iosResultSchemas.inspect_ios_toolchain),
    examples: [{ title: "Check the iOS device toolchain", input: {} }],
  },
  {
    name: "list_ios_devices",
    ...toolContractMetadata("list_ios_devices"),
    description:
      "List paired USB iOS devices using idevice_id -l, retaining UDIDs and explicit parse coverage.",
    kind: "ios-provider",
    inputSchema: iosInputSchemas.list_ios_devices,
    outputSchema: evidenceResultOf(iosResultSchemas.list_ios_devices),
    examples: [{ title: "List connected iPhones", input: {} }],
  },
  {
    name: "inspect_ios_device",
    ...toolContractMetadata("inspect_ios_device"),
    description:
      "Inspect selected iOS identity facts through ideviceinfo and probe the caller-authorized jailbreak SSH path, including /var/jb and roothide .jbroot-* visibility.",
    kind: "ios-provider",
    inputSchema: iosInputSchemas.inspect_ios_device,
    outputSchema: evidenceResultOf(iosResultSchemas.inspect_ios_device),
    examples: [
      {
        title: "Inspect a jailbroken iPhone",
        input: { device_id: "device-udid" },
      },
    ],
  },
  {
    name: "list_ios_apps",
    ...toolContractMetadata("list_ios_apps"),
    description:
      "List installed iOS applications with bundle identifiers and versions from ideviceinstaller, enriching paths and executable names from the jailbroken filesystem when SSH is available.",
    kind: "ios-provider",
    inputSchema: iosInputSchemas.list_ios_apps,
    outputSchema: evidenceResultOf(iosResultSchemas.list_ios_apps),
    examples: [
      {
        title: "List user apps",
        input: { device_id: "device-udid", scope: "user" },
      },
    ],
  },
  {
    name: "list_ios_processes",
    ...toolContractMetadata("list_ios_processes"),
    description:
      "List running iOS processes through idevicesyslog pidlist. This is a point-in-time inventory useful for pairing app launches with dynamic observations.",
    kind: "ios-provider",
    inputSchema: iosInputSchemas.list_ios_processes,
    outputSchema: evidenceResultOf(iosResultSchemas.list_ios_processes),
    examples: [
      {
        title: "List runtime processes",
        input: { device_id: "device-udid" },
      },
    ],
  },
  {
    name: "inspect_ios_process",
    ...toolContractMetadata("inspect_ios_process"),
    description:
      "Inspect one process through jailbroken SSH using available ps and lsof commands. Missing jailbreak utilities remain partial rather than being guessed.",
    kind: "ios-provider",
    inputSchema: iosInputSchemas.inspect_ios_process,
    outputSchema: evidenceResultOf(iosResultSchemas.inspect_ios_process),
    examples: [
      {
        title: "Inspect a process",
        input: { device_id: "device-udid", pid: 1234 },
      },
    ],
  },
  {
    name: "read_ios_log",
    ...toolContractMetadata("read_ios_log"),
    description:
      "Capture a bounded live syslog window from idevicesyslog with optional text and process filters. It does not clear or persist the device log.",
    kind: "ios-provider",
    inputSchema: iosInputSchemas.read_ios_log,
    outputSchema: evidenceResultOf(iosResultSchemas.read_ios_log),
    examples: [
      {
        title: "Read recent app logs",
        input: {
          device_id: "device-udid",
          count: 200,
          process: "Runner",
        },
      },
    ],
  },
  {
    name: "pull_ios_file",
    ...toolContractMetadata("pull_ios_file"),
    description:
      "Copy one absolute file from a jailbroken iOS filesystem over the iproxy SSH tunnel and digest the host copy. This is the acquisition lane for decrypted app Mach-O images and runtime artifacts.",
    kind: "ios-provider",
    inputSchema: iosInputSchemas.pull_ios_file,
    outputSchema: evidenceResultOf(iosResultSchemas.pull_ios_file),
    examples: [
      {
        title: "Pull an app executable",
        input: {
          device_id: "device-udid",
          remote_path: "/var/containers/Bundle/Application/.../App.app/App",
          output_directory: "/tmp/rea-ios",
        },
      },
    ],
  },
  {
    name: "run_ios_command",
    ...toolContractMetadata("run_ios_command"),
    description:
      "Run an explicitly caller-selected command on a jailbroken device through iproxy SSH. This enables Frida, LLDB/debugserver, cycript, jtool, vmmap, launchctl, and custom anti-obfuscation probes while retaining stdout, stderr, and exit status as Evidence.",
    kind: "ios-provider",
    inputSchema: iosInputSchemas.run_ios_command,
    outputSchema: evidenceResultOf(iosResultSchemas.run_ios_command),
    examples: [
      {
        title: "Run a runtime probe",
        input: {
          device_id: "device-udid",
          command: "launchctl list",
        },
      },
    ],
  },
  {
    name: "inspect_ios_runtime",
    ...toolContractMetadata("inspect_ios_runtime"),
    description:
      "Inspect host Frida/LLDB availability and discover debugserver, lldb-server, and frida-server on a jailbroken iOS device without starting them.",
    kind: "ios-provider",
    inputSchema: iosInputSchemas.inspect_ios_runtime,
    outputSchema: evidenceResultOf(iosResultSchemas.inspect_ios_runtime),
    examples: [
      {
        title: "Check runtime instrumentation tools",
        input: { device_id: "device-udid" },
      },
    ],
  },
  {
    name: "attach_ios_debugserver",
    ...toolContractMetadata("attach_ios_debugserver"),
    description:
      "Start debugserver (or lldb-server's gdbserver mode) on a selected jailbroken iOS process and expose it through an owned iproxy forward for LLDB. The standalone attach operation requires a persistent MCP session; closing its provider stops the owned resources.",
    kind: "ios-provider",
    inputSchema: iosInputSchemas.attach_ios_debugserver,
    outputSchema: evidenceResultOf(iosResultSchemas.attach_ios_debugserver),
    examples: [
      {
        title: "Attach debugserver to an app",
        input: { device_id: "device-udid", pid: 1234 },
      },
    ],
  },
  {
    name: "run_ios_lldb_command",
    ...toolContractMetadata("run_ios_lldb_command"),
    description:
      "Attach LLDB to a jailbroken iOS process through debugserver and run caller-selected breakpoint, register, thread, expression, or memory commands.",
    kind: "ios-provider",
    inputSchema: iosInputSchemas.run_ios_lldb_command,
    outputSchema: evidenceResultOf(iosResultSchemas.run_ios_lldb_command),
    examples: [
      {
        title: "Read registers and set a breakpoint",
        input: {
          device_id: "device-udid",
          pid: 1234,
          commands: ["register read", "image list"],
        },
      },
    ],
  },
  {
    name: "run_ios_frida_script",
    ...toolContractMetadata("run_ios_frida_script"),
    description:
      "Start or reuse frida-server on a jailbroken iOS device, forward its port with iproxy, and run a host Frida JavaScript agent against a process.",
    kind: "ios-provider",
    inputSchema: iosInputSchemas.run_ios_frida_script,
    outputSchema: evidenceResultOf(iosResultSchemas.run_ios_frida_script),
    examples: [
      {
        title: "Trace an Objective-C method",
        input: {
          device_id: "device-udid",
          pid: 1234,
          script: "console.log(Process.enumerateModules()[0].name);",
        },
      },
    ],
  },
  {
    name: "dump_ios_process_memory",
    ...toolContractMetadata("dump_ios_process_memory"),
    description:
      "Attach a remote debugger, which can temporarily stop or change the selected process and device state, then read a bounded byte range through LLDB and return the hexdump, stderr, and exit status as Evidence.",
    kind: "ios-provider",
    inputSchema: iosInputSchemas.dump_ios_process_memory,
    outputSchema: evidenceResultOf(iosResultSchemas.dump_ios_process_memory),
    examples: [
      {
        title: "Dump a process memory range",
        input: {
          device_id: "device-udid",
          pid: 1234,
          address: "0x100000000",
          size: 256,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
