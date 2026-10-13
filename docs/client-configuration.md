# Client configuration and troubleshooting

Use this reference when a client's configuration paths, profiles, trust settings,
or schema limits affect REA. Start with [installation and setup](installation.md)
for the reviewed setup transaction and [client IDs](installation.md#supported-agents).
The versioned verification notes below describe their stated runs; live service
acceptance is verified only where explicitly recorded.

## Fiddler Everywhere alongside REA

Connect Fiddler Everywhere's MCP server separately for HTTP traffic debugging,
preserving your REA client entry. See the
[setup instructions and public skills](web-network-captures.md#fiddler-everywhere-mcp-and-public-skills).

## GitHub Copilot CLI

For GitHub Copilot CLI 1.0.95, `gpt-4.1` model metadata can block ordinary
chat with REA's full input-schema profile before sending a model request
(`compaction_static_context_blocked`; [#1554](https://github.com/morluto/rea/issues/1554)).
For the native offline OpenAI-compatible BYOK adapter, full-profile chat and
analysis also passed with a distinct `COPILOT_PROVIDER_MODEL_ID` such as
`rea-gpt-4.1`, `COPILOT_PROVIDER_WIRE_MODEL=gpt-4.1`, and that distinct ID selected
through `copilot --model rea-gpt-4.1`. The local fixture requested
`COPILOT_PROVIDER_MAX_PROMPT_TOKENS=1000000`; configure the limit supported by
your backend. This keeps every full schema and the actual wire model intact.
It does not establish the effective client budget or fix the built-in-ID path.
The existing compact profile passed native chat and analysis with the complete
tool inventory on Linux using a loopback model fixture. After setup, add
`"REA_MCP_INPUT_SCHEMA_PROFILE": "compact"` to the `env` object of the
`mcpServers.rea` entry in Copilot's `mcp-config.json`, preserving its other
settings, then restart the client. Compact advertisements can reduce nested
schema constraints; REA still validates complete canonical inputs. Full-profile
`gpt-5.4` metadata is also verified locally. Live model API acceptance and
Windows remain unverified; see [native client verification](testing.md).

## Claude Code

Claude Code normally defers MCP tool definitions through tool search. It
[turns tool search off](https://code.claude.com/docs/en/mcp#configure-tool-search)
when `ANTHROPIC_BASE_URL` points to a non-first-party host, such as DeepSeek's
Anthropic-compatible endpoint. It then sends every REA tool's name, description
and input schema with every request
([#2019](https://github.com/morluto/rea/issues/2019)). On main at 04089d5be,
with 172 tools, that payload measured about 496 KB with the default profile and
about 290 KB with `compact`. By the o200k and cl100k tokenizers, that is roughly
120k and 68k tokens. Compaction cannot remove tool definitions. If they nearly
fill the window Claude Code assumes, the context refills after every compaction
and Claude Code reports that autocompact is thrashing. To avoid this:

- Make Claude Code assume the model's actual context window. DeepSeek's Claude
  Code guide selects `deepseek-flash[1m]`; the `[1m]` suffix makes Claude Code
  assume a one-million-token window. For other unrecognized model IDs, set
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS` to the window the provider documents.
- If the endpoint forwards `tool_reference` blocks, set `ENABLE_TOOL_SEARCH=true`
  to restore deferred loading. DeepSeek's Anthropic API guide does not list
  `tool_reference` among its supported content blocks, so this setting may cause
  its requests to fail.
- To shrink the upfront catalog, add
  `"REA_MCP_INPUT_SCHEMA_PROFILE": "compact"` to the `env` object of the
  `mcpServers.rea` entry in `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json`
  when that variable is set), then restart Claude Code. Setup keeps this
  override.

The sizes above come from REA's own `tools/list`. A live Claude Code session
against DeepSeek's API is unverified.

## Pi

For [Pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md),
setup writes a `type: "stdio"` entry under `mcpServers.rea` in the user-level
`~/.pi/agent/mcp.json` and installs the bundled skill under `~/.agents/skills`.
Use `rea setup --client pi --dry-run --json` to inspect the plan, then
`rea setup --client pi --yes --json` to approve it. Check the registration with
`rea doctor --client pi --json`. Pi reads `mcp.json` as strict JSON, like its
own loader: comments, trailing commas, a byte-order mark, or an empty existing
file are invalid, and setup reports them instead of rewriting the file. Repair
such a file to plain JSON first, then rerun setup.

Setup follows Pi's `PI_CODING_AGENT_DIR`: unset or empty selects the default;
`~` and `~/` expand to the home directory; absolute paths and file URLs select
that directory; relative paths stay relative to the command's working directory.
On Windows, native paths, `~\`, and Git Bash/MSYS, Cygwin, and WSL drive paths
are normalized as Pi does. Run REA and Pi from the same working directory when
using a relative override. Pi has no profiles: `OMP_PROFILE`, `PI_PROFILE`,
`PI_CONFIG_DIR`, and OMP's `enabledServers`/`disabledServers` lists do not affect
Pi registration. Doctor accepts an omitted `type` for stdio but reports a
non-stdio type as invalid; `enabled: false` stays disabled.

REA configures only the user scope. Pi also reads `.pi/mcp.json` in trusted
projects; a same-name project entry can replace the user entry or override its
enabled state and exposure. Check that file if the user registration is aligned
but unavailable in a project. An extension that registers `/mcp` can replace
Pi's built-in MCP support and use its own configuration instead. Run `/reload`
in an existing Pi session after changing servers outside the session.

## Qwen Code

For Qwen Code, setup registers `rea` in the `mcpServers` table of the
user-level `~/.qwen/settings.json`, or `$QWEN_HOME/settings.json` when configured.
Setup and doctor follow Qwen Code's tilde and working-directory-relative home
overrides. Qwen Code also discovers personal skills in `~/.agents/skills`,
where setup installs the bundled workflow.

## Antigravity

Antigravity 2.0 discovers personal skills in `~/.gemini/config/skills`.
Setup installs its selected skill copy there.

## Gemini CLI

Gemini CLI uses `$GEMINI_CLI_HOME/.gemini/settings.json` when that home override
is nonempty, including its shared personal skills at
`$GEMINI_CLI_HOME/.agents/skills`. Setup and doctor check MCP allow/exclude
policies from system defaults, user settings, trusted workspace settings, and
system overrides. Workspace trust follows `GEMINI_CLI_TRUST_WORKSPACE`,
`GEMINI_RESTRICTED_MODE`, the effective `security.folderTrust.enabled` setting,
and the selected `trustedFolders.json` (including
`GEMINI_CLI_TRUSTED_FOLDERS_PATH`). Settings in an untrusted workspace do not
participate. A workspace or system `mcpServers.rea` replaces the entire user
entry; setup stops if the winning definition conflicts with its planned entry.
Review those files manually: setup never edits administrator/workspace settings
or grants workspace trust. Trust supplied only by a running IDE is outside this
standalone CLI check.

## Codex and Devin

Codex treats an unset or empty `CODEX_HOME` as `~/.codex`. Devin honors
`XDG_CONFIG_HOME` for its `devin/mcp_config.json` on non-Windows systems.

## OMP

For OMP, setup writes a `type: "stdio"` entry to the user-level
`~/.omp/agent/mcp.json`. It follows `PI_CONFIG_DIR` and
`PI_CODING_AGENT_DIR` (relative to the setup working directory), and the profile selected by `OMP_PROFILE` or
`PI_PROFILE` (`~/.omp/profiles/<name>/agent/mcp.json`). Setup also removes
`rea` from that file's `disabledServers` list, which would otherwise hide the
registration. Doctor treats an `enabled: false` entry as active when
`enabledServers` lists `rea`, as OMP does, unless `disabledServers` also lists
it. Run setup under each profile that should load REA.

## Hermes

For Hermes, setup writes a `mcp_servers.rea` entry to `config.yaml`, preserving
comments and unrelated settings. It resolves that file from `HERMES_HOME`, else
from the platform default Hermes itself uses — `%LOCALAPPDATA%\hermes` on
Windows, `~/.hermes` elsewhere — including any `HERMES_DATA_DIR_SUFFIX`. Hermes
connects an entry unless `enabled` is false, so setup states `enabled: true`.

Hermes personal skills install under the active Hermes home's `skills` directory.
Setup, doctor and uninstall follow the root's `active_profile` selection, as
plain Hermes CLI commands do. An explicit `HERMES_HOME` pointing to
`profiles/<name>` selects that named profile directly. An invalid, missing or
deleted sticky profile is reported instead of writing into the default home;
repair the profile or run `hermes profile use default` before retrying.
REA follows `HERMES_HOME` whitespace trimming, environment-variable expansion,
and home expansion before resolving that profile. Setup previews the resolved
configuration and skill destinations; doctor and uninstall use those same paths.

## Qoder CLI

For [Qoder](https://docs.qoder.com/cli/mcp-reference), setup writes
`mcpServers.rea` into the user-level `~/.qoder/settings.json` (the
`QODER_CONFIG_DIR` override is honored). Entries carry `command`, `args`, and
`env`; stdio is the default transport. Qoder CLI discovers personal skills
from `~/.qoder/skills` (following `QODER_CONFIG_DIR` when set), so setup
installs its skill copy there.

## Factory Droid

For [Factory Droid](https://docs.factory.com/harness/mcp), setup writes
`mcpServers.rea` into the user-level `~/.factory/mcp.json`. Entries carry
`command`, `args`, and `env`. Droid discovers personal skills from
`~/.factory/skills` ([skills](https://docs.factory.com/harness/skills)), so
setup installs its skill copy there.

## Trae

For [Trae](https://docs.trae.ai/ide/add-mcp-servers), setup writes
`mcpServers.rea` into the user-scope `mcp.json` under Trae's VS Code-style
user directory (`%APPDATA%\Trae\User` on Windows,
`~/Library/Application Support/Trae/User` on macOS, and
`~/.config/Trae/User` elsewhere). Entries carry `command`, `args`, and
`env`; stdio is the default transport. Trae discovers personal skills from
`~/.trae/skills` (`%userprofile%\.trae\skills` on Windows), so setup
installs its skill copy there.

The user-level MCP paths follow the editor's VS Code layout. Trae's official
documentation describes the raw JSON editor without specifying those paths;
loading this registration in Trae remains unverified.

## ZCode

For [ZCode](https://zcode.z.ai/en/docs/mcp-services), setup registers `rea` in the nested `mcp.servers` table of the
user-level `~/.zcode/cli/config.json`. Entries carry `command`, `args`, and
`env` without a transport discriminator. ZCode discovers personal skills from
`~/.zcode/skills` rather than the shared directory, so setup installs its
skill copy there.

ZCode reads the user-scope `~/.agents/mcp.json` fallback only while the native
`.zcode` config defines no servers at all, with no merging. When setup writes
the first native server into an empty table, it copies the fallback's
`mcpServers` entries into the native table so they keep loading, and leaves
the fallback file untouched. Existing REA environment overrides are preserved
when refreshing its command. A malformed or unreadable fallback file fails setup instead of
being silently suppressed; repair or remove it and rerun. ZCode disables a
server with `enable: false` on its entry; doctor reports such a registration
as stale, and rerunning setup removes the flag to repair it. Native configuration
uses strict JSON; setup refuses comments, trailing commas and a BOM rather than
writing a registration ZCode cannot load.

## DeepSeek Harness

DeepSeek Harness registers MCP clients through a Cordis YAML patch sequence
rather than a `mcpServers` object. `rea setup --client dsh` appends (or
replaces) the REA entry in the home patch `$DSH_HOME/cordis.patch.yml`
(`~/.dsh/cordis.patch.yml` when `DSH_HOME` is unset), preserving unrelated
patches and comments. `rea doctor --client dsh` checks that same entry id.
`rea uninstall` removes it by scanning supported clients; uninstall takes no
`--client` flag. The home patch applies to every Harness profile, so the
registration is written once and no per-profile edit is needed.

Setup, doctor and uninstall resolve `DSH_HOME` and `DSH_AGENTS_HOME` as Harness
does: unset, empty or whitespace-only values use `~/.dsh` and `~/.agents`,
respectively. Bare `~`, `~/` and `~\` expand to the user home; other relative
values resolve against the command's working directory. Nonblank values retain
their original spaces, and the agents root is independent of the Harness home.
Run REA and Harness from the same working directory when using relative overrides.
The written entry is:

```yaml
- insert:
    - id: rea-mcp
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: rea
        transport: stdio
        command: /absolute/path/to/node
        args: ["/absolute/path/to/rea/scripts/rea.mjs", mcp]
```

Setup preserves caller-owned Cordis expressions and replaces launcher fields
with literal values that doctor can verify. It refuses to edit an expression
that produces the entire REA config, or a group-targeted REA insertion. Use a
literal config and a root-level insertion as shown above.

For a global npm installation, the launcher is under
`$(npm root -g)/rea-agents/scripts/rea.mjs`. Restart Harness after setup; it
exposes tools as `mcp__rea__<tool_name>`. Run `rea setup --skill --dry-run`,
review the destination, then `rea setup --skill --yes` to install the workflow
in `~/.agents/skills` (`$DSH_AGENTS_HOME/skills` when configured); Harness
discovers that directory, and its native `skill` tool can load
`reverse-engineer-anything`.

REA's optional [native client verification](testing.md#end-to-end-integration-and-golden-evidence)
checks headless chat, skill loading, all tool input schemas and actual analysis
using the installed Harness and a local model fixture. This establishes the
Harness integration, with live DeepSeek API compatibility remaining unverified.
See the [Harness MCP guide](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/mcp/mcp-client/README.md)
for its native configuration contract.

### Desktop bundle installed but disabled

An installed `dsh-rea-bundle` dependency does not imply the bundle has
been added to `~/.dsh/profiles/desktop/package.json`'s
`dsh.profile.bundles`. The upstream plugin manager offers
**Enable now** separately from install. If the installed bundle is not
selected, the Desktop session will have no `mcp__rea__*` tools.
The stored `cordis.yml` is an empty loader root; it does not show the
effective runtime composition.

Use **Desktop → Plugins → Installed plugins → dsh-rea-bundle → Enable**
and restart. If that UI control is unavailable, the
[reviewable local-only activation script](../integrations/deepseek-harness/README.md#desktop-installed-the-bundle-but-did-not-activate-it)
checks the installed files, backs up the manifest, then appends only
the missing bundle name. It is opt-in; default mode only reports status.
The recovery helper is included in candidate 0.2.1 after qualification and
publication; immutable 0.2.0 is unsuitable for Electron Desktop and its enable UI does not
repair the launcher. Native Desktop support remains unqualified. Candidate
qualification requires the standalone `REA_DSH_NODE_PATH` host setup described
in the linked integration guide.
After restart, confirm live `mcp__rea__*` tool discovery. The helper's
`--status` reports stored selection only; `--verify` reports runtime
composition as unverified and exits nonzero.
Do **not** reinstall the bundle, change pnpm `allowBuilds`, or erase the
Desktop profile to fix a disabled bundle.

### DeepSeek Harness Desktop: fix `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`

**Cause.** If the error names `rea-agents@6.4.0` and downloads a Git archive
like `https://codeload.github.com/morluto/rea/tar.gz/<commit>`, the
Desktop plugin manager was given the **root REA repository** rather than the
installable `dsh-rea-bundle` package. Root `rea-agents` has a Git
`prepare` script. pnpm deliberately refuses it under its supply-chain
policy, and the root package does not declare `dsh.bundle`. Do **not** add
the root package to `allowBuilds`: it still would not be a Harness bundle.

**Fix with the Desktop UI** (requires no pnpm or npm CLI installation):

```sh
mkdir -p "$HOME/.dsh/plugin-packages"
curl -fL --retry 3 -o "$HOME/.dsh/plugin-packages/dsh-rea-bundle-0.2.1.tgz" \
  https://github.com/morluto/rea/releases/download/dsh-v0.2.1/dsh-rea-bundle-0.2.1.tgz
curl -fL --retry 3 --output "$HOME/.dsh/plugin-packages/SHA256SUMS" https://github.com/morluto/rea/releases/download/dsh-v0.2.1/SHA256SUMS
(cd "$HOME/.dsh/plugin-packages" && shasum -a 256 -c SHA256SUMS)
printf '%s\n' "$HOME/.dsh/plugin-packages/dsh-rea-bundle-0.2.1.tgz"
```

1. Open **DeepSeek Harness Desktop → Plugins → Add plugin** (the sidebar's
   Plugins page), and paste the **absolute local `.tgz` path** printed by
   the final command. Do **not** paste the untagged repository URL. Tagged plugin Git URLs and versioned Release tarballs are supported alternatives.
2. Install and enable **`dsh-rea-bundle`**, then completely quit and
   reopen Desktop. Inspect its plugin list for the `rea-launcher` and
   `rea-mcp` rows. If a prior `rea setup --client dsh` created a
   home-level `rea-mcp` patch, back up the patch and remove only that
   obsolete REA row: home patches override profile bundle configuration.
3. If Desktop's `~/.dsh/profiles/desktop/package.json` contains a direct
   `rea-agents` dependency referencing `xxxxxwater/rea` on GitHub,
   back up the profile, then remove **only that incorrect direct dependency**
   via the Desktop-bundled plugin manager, not by deleting the whole profile
   or editing `allowBuilds`. An installation that failed before saving
   the dependency may have nothing to remove.

**Alternative from a cloned REA checkout:**

```sh
bash integrations/deepseek-harness/scripts/prepare-desktop-install.sh
```

That script downloads the pinned GitHub Release asset, validates SHA-256,
keeps the archive in `$DSH_HOME/plugin-packages` (default `~/.dsh`),
and prints the path to paste into the Desktop installer. It does not mutate
the Desktop profile. After installing Desktop's **own** `dsh` command from
the application menu **Manage dsh Command…**, fully quit Desktop and
optionally run:

```sh
dsh plugin --profile desktop add "$HOME/.dsh/plugin-packages/dsh-rea-bundle-0.2.1.tgz"
```

A standalone `npm install -g @deepseek-ai/dsh` launcher may reject this
with `profile "desktop" is managed exclusively by the Electron application`.
Use the Desktop Plugins UI or its app-bundled CLI, not `dsh --profile
desktop` (which tries to boot the reserved profile).

### Native DeepSeek Harness bundle — Desktop Git install

For a **direct install in Desktop → Plugins → Add plugin**, enter
the **exact complete Git source**:

```text
https://github.com/morluto/rea#dsh-plugin-v0.2.1
```

This immutable tag points to a separate root `dsh-rea-bundle` package
with `dsh.bundle` metadata, ready-to-run JavaScript and no Git
`prepare` script. Its `rea-agents@6.4.0` dependency resolves from
the npm registry as a prebuilt runtime.

Using just `https://github.com/morluto/rea` instead downloads the
main repository's `rea-agents` CLI, not the plugin, and pnpm may
report `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` on Git dependencies.
**Do not approve scripts or modify `allowBuilds` to fix a wrong URL.**

Alternatively enter the Release's direct tarball address:

```text
https://github.com/morluto/rea/releases/download/dsh-v0.2.1/dsh-rea-bundle-0.2.1.tgz
```

Both install sources are recognized as Git/tarball install specs by the
current Desktop plugin manager. Choose one, enable `dsh-rea-bundle`
and fully restart Desktop. A CLI profile is separate; on a Web CLI
installation use:

```sh
dsh plugin --profile web add 'github:morluto/rea#dsh-plugin-v0.2.1'
dsh --profile web --dump-config
```

If the Desktop profile has a retained incorrect `rea-agents` Git
dependency, back up `~/.dsh/profiles/desktop/package.json` and
remove **only that dependency** with the Desktop plugin manager.
Do not delete other installed plugins. If the legacy
`rea setup --client dsh` wrote a home-level `rea-mcp` override,
back up the home patch before removing just that outdated entry.

More detail:
`integrations/deepseek-harness/README.md` and
`integrations/deepseek-harness/README.zh-CN.md`.
This Git/tarball pnpm install test does not replace real macOS Desktop
GUI or paid-model API acceptance testing.

## Other client settings

For OpenCode, setup writes the V1 `mcp.rea` entry, which OpenCode V1 and V2
both load. If the configuration already uses OpenCode V2's native
`mcp.servers` table, setup registers REA there instead and replaces any earlier
`mcp.rea` entry from REA. Setup honors `OPENCODE_CONFIG_DIR` and
`OPENCODE_CONFIG`, preferring the later-loaded JSONC file when both JSON and
JSONC exist. The ordinary XDG global configuration still participates when a
custom directory is selected. Doctor checks the merged user registration; uninstall removes
REA-owned entries from every applicable user file so an older entry cannot
become active again. Malformed applicable files block setup before changes.

Grok Build loads `[mcp_servers.rea]` from `$GROK_HOME/config.toml`, or from
`~/.grok/config.toml` when `GROK_HOME` is unset or empty. Setup edits that server
table, `[mcp_servers.rea.env]`, and a root `disabled_mcp_servers` entry that
names `rea`. It sets `startup_timeout_sec = 30` and leaves every other name
in that list. The shared skill installed under `~/.agents/skills` is already
on Grok Build's skill path.

Grok Bot (`grok_bot`) is detected from `~/.grokbot`, or from `SAND_DATA_ROOT`
when that value is an absolute path. A relative or empty `SAND_DATA_ROOT`
stays on `~/.grokbot`. That directory is not the connector store. Grok Bot
keeps connectors in the signed-in account and runs them on its hosted
computer. It does not import `mcp.json` from the data directory, and it does
not attach a stdio server running on this machine. Setup does not call the
account connector API, does not write a registration file, and does not report
the data directory as aligned. Ask the Grok Bot chat to add a custom MCP
server named `rea` that runs on the Bot's computer:

```bash
npx -y rea-agents@<version> mcp
```

Do not put credentials in that command or its arguments. `rea doctor --client grok_bot`
reports this manual step. `rea uninstall` does not remove the account connector.
