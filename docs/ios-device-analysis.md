# iOS device and jailbreak runtime analysis

REA has a provider for paired iOS devices that combines caller-supplied
libimobiledevice tools with an SSH tunnel created by `iproxy`. It is intended
for an analyst-owned, jailbroken device such as a Dopamine 2 rootless/root-hide
phone. REA never installs a jailbreak, starts a device, or stores SSH
credentials.

On macOS, SSH-backed operations also require a working Swift compiler and macOS
SDK for REA's process-ownership helper. Install Apple's Command Line Tools (for
example, run `xcode-select --install` yourself) or select an existing compatible
Xcode toolchain, then confirm `xcrun --find swiftc` and `xcrun --show-sdk-path`
succeed. REA does not install or upgrade Xcode, Swift, or an SDK. A caller-selected
direct compiler uses `REA_DARWIN_SWIFTC_PATH` and `SDKROOT` as documented in [process ownership setup](process-capture.md); both must be absolute paths.

Set the password in the process environment when password authentication is
needed:

```bash
export REA_IOS_SSH_PASSWORD='DEVICE_PASSWORD'
export REA_IOS_SSH_USER=root
rea list-ios-devices
rea inspect-ios-device device-udid
```

`idevice_id -l` and `ideviceinfo` provide paired-device identity over USB.
When an operation needs the jailbreak filesystem, REA allocates a loopback
port, starts `iproxy <port>:22 -u <UDID>`, and runs a bounded SSH command. The
tunnel is owned by the provider and is terminated when the provider closes.
The selected SSH account is `root` by default. `REA_IOS_SSH_USER` changes the
default; an explicit operation account overrides it. Use `mobile` when a rootless
operation should retain the mobile account's permissions.

SSH requires an already-trusted device host key in the user's OpenSSH known-hosts
store, under the stable alias `rea-ios-<UDID>`. Pin that device's verified key
before connecting. A temporary forwarding port never grants trust, and REA does
not accept unknown keys or write the trust store.

`attach_ios_debugserver` is exposed through the persistent MCP provider. A
one-shot CLI command cannot return a usable port after closing its owner. CLI
LLDB and memory-read operations own the complete attach/use/cleanup lifetime.
New remote helpers are registered before SSH starts and receive a unique run
token. Devices must support observing that token through `ps eww`; otherwise
helper launch is refused. Cleanup signals only token-identified children and
retains unresolved ownership for a later retry. Helper logs are written inside
an exclusively created mode-0700 device directory, removed only after helper
termination is confirmed. Failed directory cleanup retains the same owner.
Concurrent callers share provider-owned startup; canceling one caller cancels
only its wait, while provider shutdown cancels and awaits outstanding startups. If SSH startup was interrupted,
remote launch completion remains unknown even when a current token scan is empty;
REA reports incomplete cleanup rather than treating that scan as proof of absence.
This lane still requires a
maintainer scope decision and real-device verification before integration.

The dynamic lane is deliberately explicit. `list_ios_processes` uses
`idevicesyslog pidlist`, `inspect_ios_process` uses whatever `ps` and `lsof`
the jailbreak exposes, and `read_ios_log` captures a bounded live
`idevicesyslog` window. `pull_ios_file` is the acquisition bridge for a
decrypted app Mach-O image or runtime dump. `run_ios_command` remains the
escape hatch for tools supplied by the analyst, including cycript, jtool,
`launchctl`, and custom anti-obfuscation probes. Its result retains stdout,
stderr, exit status, and explicit limitations; REA does not claim that
arbitrary command output proves a complete runtime trace.

The debugger and instrumentation lane has structured operations:

```bash
rea inspect-ios-runtime UDID
rea run-ios-lldb-command UDID PID $'register read\nimage list\nbreakpoint set -n objc_msgSend' root
rea dump-ios-process-memory UDID PID 0x100000000 root --size 256
rea run-ios-frida-script UDID 'console.log(Process.enumerateModules()[0].name)' --pid PID --user root
```

`inspect_ios_runtime` checks the host `lldb` and `frida` clients and searches
the jailbreak PATH for `debugserver`, `lldb-server`, and `frida-server`.
`attach_ios_debugserver` starts a device-side debugserver (or
`lldb-server gdbserver` when debugserver is unavailable) for the selected PID
and owns an `iproxy` forward until the provider closes. LLDB commands then use
the host LLDB client with `gdb-remote`; breakpoints, register reads, and memory
reads are returned as Evidence. `dump_ios_process_memory` limits one hexdump to
1 MiB. `run_ios_frida_script` writes the caller's JavaScript to a private
short-lived host file, starts or reuses a loopback frida-server on the device,
forwards port 27042 by default, and runs the host Frida CLI against a PID or
process name.

The debugger operations require matching binaries on both sides. Install a
compatible `debugserver`/`lldb-server` and `frida-server` in the Dopamine
rootless environment, and install the host `lldb`/Frida CLI. If the device
probe reports a missing server, the operation fails explicitly; REA does not
copy or install third-party instrumentation binaries onto a phone.

For a packed or virtualized app, a useful first sequence is:

1. `list_ios_apps` to identify the bundle and executable path.
2. `pull_ios_file` to acquire the on-device (possibly decrypted) Mach-O.
3. Open that file with the existing Mach-O/Hopper/Ghidra/IDA workflows.
4. `list_ios_processes` and `inspect_ios_process` to establish the live PID.
5. Use `run_ios_lldb_command` for breakpoints/registers/memory and
   `run_ios_frida_script` for Objective-C/Swift hooks, then correlate their
   output with static addresses and the app's syslog window.

The static IPA path already exists through `project_apple_application_graph`
and the native Mach-O tools. This provider adds device identity, filesystem
acquisition, process/log observations, and analyst-controlled runtime
boundaries. It does not automatically remove VMP virtualization or undo
control-flow/string obfuscation. Those workflows need runtime decrypted code
acquisition, page/module mapping, breakpoint or Frida traces, and correlation
with the existing Mach-O analysis tools.
