# Windows desktop GUI

REA includes a small Korean-language desktop interface for Windows. It is a
PowerShell WinForms front end to the packaged REA CLI; it adds no Electron
runtime, local web server, or provider. The GUI does not expose a command-line
text box or run an inspected application.

## Install and start

### Download the portable application

After a release includes the Windows GUI asset, download
[`rea-windows-x64-<version>.zip`](https://github.com/morluto/rea/releases/latest)
and extract the entire archive to a local folder. Double-click `rea-gui.exe`;
the archive includes the Node.js runtime and REA package, so a separate Node.js
or npm installation is not needed. Keep `rea-gui.exe`, `node.exe`, and
`node_modules` together in the extracted folder.

Verify the adjacent `.sha256` checksum before running the download:

```powershell
$archive = Get-Item .\rea-windows-x64-*.zip
$expected = ((Get-Content -Raw "$($archive.FullName).sha256") -split '\s+')[0]
if ((Get-FileHash $archive.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
  throw "REA GUI archive checksum mismatch."
}
```

The executable is currently unsigned, so Windows SmartScreen may show a publisher
warning. Windows may also mark the included PowerShell script as downloaded;
after verifying that you trust the release, use the ZIP file's **Properties >
Unblock** option before extracting it. The application still requires Windows
PowerShell and Windows Forms, which are included with supported Windows desktop
installations. If organization policy blocks it, ask the administrator for an
approved launch method rather than bypassing policy.

### Install from npm

Install a supported Node.js release and REA from PowerShell:

```powershell
npm.cmd install --global rea-agents
rea-gui.cmd
```

The global npm installation adds `rea-gui.cmd` beside `rea.cmd`. The `.cmd`
forms work from PowerShell even when its script policy blocks npm's generated
PowerShell shims. If the command cannot be found, open a new terminal after
installing REA and verify that npm's global binary directory is on `PATH`. The
command remains active until the GUI window closes.

From a source checkout, install and build REA first, then run:

```powershell
npm ci
npm run build:cached
node .\windows-gui\rea-gui.mjs
```

The npm-installed GUI uses the CLI from the same package installation. Both
launch methods select `RemoteSigned` for the child PowerShell process only;
they do not persist a policy change or use `Bypass`. Organization Group Policy
takes precedence. If it blocks the packaged script, ask the administrator to
approve an allowed launch method.

## Included operations

Choose a file or, for the applicable workflows, an application directory:

- `analyze`: the normal REA overview workflow. Native targets use the selected
  or configured provider; JavaScript application directories and ASAR files
  use REA's static analysis route. Ghidra and IDA can be selected explicitly.
- `analyze-javascript-application`: static analysis of an application directory
  or ASAR without starting the application or a native analysis provider.
- `inspect-go-binary`: reads embedded Go build metadata from an ELF, PE, or
  thin Mach-O file.
- `inspect-managed-artifact`: reads .NET PE/CLI identity without loading target
  code.
- `inspect-sqlite-database`: inspects a local SQLite snapshot schema.

The GUI invokes these existing CLI workflows with JSON output and displays
standard output, standard error, and the process exit status. Target analysis
starts only after the user presses **분석 실행**. Native analysis may start the
selected REA provider; the target executable itself is not launched. Provider
availability, format support, and setup requirements remain those of the
underlying REA command.

This MVP accepts local file and directory paths only; UNC and mapped network
drives are rejected before checking whether a target exists. It does not accept URLs,
arbitrary REA commands, MCP sessions, or commands that mutate targets, capture
live processes, or install/configure software. SQLite row selection and the
full command catalog remain available through the CLI. Large analysis results
can consume substantial memory in the results window; use the CLI to save and
inspect very large Evidence output. A running operation cannot be cancelled from
the GUI, and the window stays open until it finishes. The portable ZIP is
Windows x64 only; native analysis remains subject to the selected provider's
requirements and the Windows native artifact's NTFS limitations.
