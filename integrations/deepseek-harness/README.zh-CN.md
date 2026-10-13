# REA × DeepSeek Harness 最新版安装说明

适用：DeepSeek Harness 新版 CLI（`dsh.bundle` + Cordis），macOS/Linux。
截至 2026-10-13，npm 的 `@deepseek-ai/dsh@latest` 指向 `0.2.0-rc.2`，
而上游 `master` 仍在快速迭代。安装 REA 时建议使用正式发布、版本固定的插件压缩包。

## Desktop 候选版本：先配置宿主 Node 路径

原生 Desktop 支持尚未验证。不可变的 0.2.0 启动器使用 Electron 应用可执行文件
启动 MCP 子进程，不适用于 Desktop；启用开关不能修复它。源码中的 0.2.1
候选版本尚未作为经过验证的版本发布。以下步骤和地址用于候选版本验证，
不是受支持的 Desktop 安装建议。

启用候选版本前，需要让 Desktop 宿主进程继承 `REA_DSH_NODE_PATH`，
其值为已经安装、符合 REA 版本要求的独立 Node 可执行文件绝对路径。
安装 Node 不会自动设置该变量。在 macOS 上完全退出 Desktop，
然后从同一个终端直接启动应用内的可执行文件：

```sh
# 填写已有的本机安装路径；这些命令不安装任何运行时。
REA_DSH_NODE_PATH="/absolute/path/to/node"
DSH_DESKTOP_APP="/absolute/path/to/DeepSeek Harness.app"
DSH_DESKTOP_EXECUTABLE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$DSH_DESKTOP_APP/Contents/Info.plist")"
export REA_DSH_NODE_PATH
"$REA_DSH_NODE_PATH" --version
"$DSH_DESKTOP_APP/Contents/MacOS/$DSH_DESKTOP_EXECUTABLE"
```

之后从 Finder 打开的应用不会继承此终端变量。启用 bundle 或执行激活辅助脚本
都不会设置宿主变量。此启动步骤及原生 Desktop 工具发现仍待验证；
只有实际会话中发现 `mcp__rea__*` 工具后才能判断运行时是否可用。

## Desktop 已安装，但没有启用：修复 dsh.profile.bundles

适用的典型症状：Desktop 中的 `package.json` 已声明 `dsh-rea-bundle`，
插件安装日志显示成功，但 `dsh.profile.bundles` 没有这个名字，
会话中也没有
`mcp__rea__*` 工具。

当前 Harness 插件管理器把
**安装**与**立即启用**作为两个独立操作；关闭安装成功对话框而没有
点「立即启用」，可能留下一个已安装、但处于关闭状态的 bundle。

推荐先打开 **DeepSeek Harness Desktop → 插件 → 已安装插件 →
dsh-rea-bundle**，将该包的开关**开启**，不是去修改 `rea-agents`
的普通 npm 依赖。然后**完全退出并重新启动 Desktop**，重新打开一个
会话检查 REA 工具。

### 如果界面找不到开关：使用安全激活脚本（仅本机 macOS）

候选版本 0.2.1 包含这个脚本。不可变的 0.2.0 启动器不适用于 Electron Desktop，
不能通过启用开关修复；请等待修复版本完成验证并发布。

此脚本在当前仓库的
[`scripts/activate-installed.mjs`](scripts/activate-installed.mjs)。
它不会连接服务器，不会执行 pnpm、不会重新下载或重装 REA。
默认 `--status` **只读**；只有显式 `--activate` 才会在备份
`~/.dsh/profiles/desktop/package.json` 后，将
`dsh-rea-bundle` **追加一次**到原有 `dsh.profile.bundles`
尾部。已有插件和顺序、其他依赖、锁文件、`allowBuilds` 都保持不变。
如果包未安装、插件元数据损坏、数组不合法，脚本会拒绝修改。

在 Mac 的终端执行（可先打开链接阅读脚本再运行）：

```sh

node "$HOME/.dsh/profiles/desktop/node_modules/dsh-rea-bundle/scripts/activate-installed.mjs" --status

# 先从菜单中完全退出 DeepSeek Harness Desktop，然后执行：
node "$HOME/.dsh/profiles/desktop/node_modules/dsh-rea-bundle/scripts/activate-installed.mjs" --activate

# 重新打开 Desktop，在会话中检查 mcp__rea__* 工具。以下命令只检查存储的启用选择：
node "$HOME/.dsh/profiles/desktop/node_modules/dsh-rea-bundle/scripts/activate-installed.mjs" --status
```

其中 `node` 使用 Mac 本机已有的 Node.js（满足插件运行版本要求），
不是全局 `dsh` 命令；**不要执行 `dsh --profile desktop`**。
`--activate` 成功后会打印精确的 `package.json.rea-backup-...`
备份路径；再次运行不会添加重复条目或再次生成备份。
如果需要回滚，在**完全退出 Desktop** 后从这份原样备份恢复
`package.json`。如果仅想关闭插件，更推荐直接使用 Desktop 的开关。

### 验证层次

| 检查                        | 预期结果                                    |
| --------------------------- | ------------------------------------------- |
| `package.json.dependencies` | 有 `dsh-rea-bundle`                         |
| `dsh.profile.bundles`       | 有且仅有一个 `dsh-rea-bundle`               |
| 存储的 `cordis.yml`         | 空 loader 根，不能据此判断实际运行时组合    |
| Desktop 的 Loader / 新会话  | `rea-mcp` 成功启动，出现 `mcp__rea__*` 工具 |

`--verify` 会报告运行时尚未验证，并返回非零状态；存储的配置不证明 MCP 已就绪。
若已安装并启用却仍无 REA 工具，应检查 Desktop 插件详情中的
`rea-mcp` 启动错误、所需的本机权限与 MCP 客户端状态，而不是重新安装。
**170** 是之前安装的 `rea-agents@6.4.0` 在该次握手返回的工具数量，
并非所有 Harness 版本都必须恰好暴露 170 个工具。

## Desktop 候选版本安装来源（尚未验证和发布）

**直接复制整行地址到 DeepSeek Harness Desktop → 插件 → 添加插件**：

```text
https://github.com/morluto/rea#dsh-plugin-v0.2.1
```

这个 `#dsh-plugin-v0.2.1` **不能省略**。它指向独立的、根目录
就是 `dsh-rea-bundle` 的 Git 发行快照，具备 Harness 要求的
`dsh.bundle`，并且没有 `prepare` 或其他安装期构建脚本。

如果输入 `https://github.com/morluto/rea`（不含上述标签），
仍会安装仓库 `main` 上的 `rea-agents` CLI，触发
`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`。**不要开放 `allowBuilds`**。

也可以在「添加插件」直接输入这个 Release 安装包 URL：

```text
https://github.com/morluto/rea/releases/download/dsh-v0.2.1/dsh-rea-bundle-0.2.1.tgz
```

这两个地址任选一个，不需要同时安装。安装后启用
`dsh-rea-bundle`，先完成上面的独立 Node 宿主配置，
再**完全退出并从带有该环境变量的终端启动** Desktop。
如果之前的错误 Git 安装留下了 `rea-agents` 依赖，备份后只删除
这项错误依赖，保留其余插件配置。
若旧 `rea setup --client dsh` 曾写入全局 `rea-mcp`，也应先备份
`$DSH_HOME/cordis.patch.yml`，只清理旧 REA 条目以免覆盖新版。

## Desktop 修复：`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`

错误若出现 `rea-agents@6.4.0` 和
`https://codeload.github.com/morluto/rea/tar.gz/...`，表示
Desktop 正在安装**整个 REA GitHub 仓库的 CLI**，不是 Harness 插件。
根包需要 `prepare` 构建脚本，所以被 pnpm 的 `allowBuilds` 安全策略拒绝。
**不要将 `rea-agents` 加入 `allowBuilds`**，也不要删除或重装 Desktop。

在 macOS 终端执行（不用安装额外的 npm `dsh`）：

```sh
mkdir -p "$HOME/.dsh/plugin-packages"
curl -fL --retry 3 -o "$HOME/.dsh/plugin-packages/dsh-rea-bundle-0.2.1.tgz" \
  https://github.com/morluto/rea/releases/download/dsh-v0.2.1/dsh-rea-bundle-0.2.1.tgz
curl -fL --retry 3 --output "$HOME/.dsh/plugin-packages/SHA256SUMS" https://github.com/morluto/rea/releases/download/dsh-v0.2.1/SHA256SUMS
(cd "$HOME/.dsh/plugin-packages" && shasum -a 256 -c SHA256SUMS)
printf '%s\n' "$HOME/.dsh/plugin-packages/dsh-rea-bundle-0.2.1.tgz"
```

校验显示 `OK` 后，打开 **DeepSeek Harness Desktop → 插件 → 添加插件**，
粘贴最后打印的**本地 `.tgz` 文件绝对路径**进行安装，不要填
`https://github.com/morluto/rea`，；带版本标签的插件 Git URL 和版本化 Release 压缩包 URL 也是受支持的安装来源。
安装并启用 `dsh-rea-bundle` 后，完全退出并重新打开 Desktop。

如果之前的失败安装已经将 Git 依赖写进
`~/.dsh/profiles/desktop/package.json`，请先备份该 Profile，
通过 Desktop 自带插件管理器**只删除误装的 `rea-agents` Git 依赖**，
保留其他插件、`pnpm-lock.yaml` 和设置。
如果安装失败时并未写入依赖，就不需要清理。
此前执行过 `rea setup --client dsh` 的，还要检查
`$DSH_HOME/cordis.patch.yml` 的旧 `rea-mcp` 配置；
修改前备份，只移除旧的 REA 项，避免覆盖新插件。

已下载仓库源码的用户，也可执行带摘要校验的安装准备脚本：

```sh
bash integrations/deepseek-harness/scripts/prepare-desktop-install.sh
```

此脚本只下载、校验并打印本地安装路径，默认**不修改 Desktop Profile**。
如果在 Desktop 菜单 **「管理 dsh 命令…」** 安装了该应用自带的
`dsh`，完全退出 Desktop 后，也可执行：

```sh
dsh plugin --profile desktop add "$HOME/.dsh/plugin-packages/dsh-rea-bundle-0.2.1.tgz"
```

注意：通过 npm 全局安装的普通 `dsh` 可能拒绝 `desktop`
Profile（它只属于 Electron 应用）。遇到这种提示时改用应用内
**「插件」** 页面，**不要执行 `dsh --profile desktop`**。

## 一键复制安装指令

要求：Node.js `^22.19.0 || ^24.11.0 || >=26.0.0`，npm、pnpm，以及初次安装时的网络访问。

```sh
# Node.js: ^22.19, ^24.11, or >=26; macOS/Linux
npm install --global @deepseek-ai/dsh@latest pnpm@11

curl -fL --retry 3 --output dsh-rea-bundle-0.2.1.tgz https://github.com/morluto/rea/releases/download/dsh-v0.2.1/dsh-rea-bundle-0.2.1.tgz
curl -fL --retry 3 --output SHA256SUMS https://github.com/morluto/rea/releases/download/dsh-v0.2.1/SHA256SUMS
shasum -a 256 -c SHA256SUMS

dsh plugin --profile web add ./dsh-rea-bundle-0.2.1.tgz
dsh --profile web --dump-config
dsh --profile web
```

其中 SHA-256 为 GitHub Release `dsh-v0.2.1` 的附件摘要。校验失败时应停止安装；
不要绕过校验。最后的 `dsh --profile web` 将启动 Web 版 Harness。
可以通过 `dsh --version` 查看本机版本、
`npm view @deepseek-ai/dsh dist-tags --json` 查看 npm 当前标签。

## 安装成功如何确认

运行 `dsh --profile web --dump-config`，在输出中找到
`dsh-rea-bundle`、`rea-launcher` 和 `rea-mcp`。
启动后，REA 工具应按 `mcp__rea__*` 命名空间注册。
配置预览本身不证明真实的 MCP 连接、模型 API 调用或 Desktop 能运行。
安装、升级或修改配置后需重启当前 Harness 会话。

## 已经有旧的 `rea setup --client dsh`

旧安装器可能将 `rea-mcp` 写在 `$DSH_HOME/cordis.patch.yml`
（默认 `~/.dsh/cordis.patch.yml`）。此全局配置优先于 profile 插件，
可能覆盖新版本。请先备份配置，只删除旧 REA 的 `rea-mcp` 插入项，
保留其他工具与设置，再重新启动 Harness。

## 升级、卸载

```sh
# 查看正在使用的插件包
dsh plugin --profile web why dsh-rea-bundle

# 删除原生插件
dsh plugin --profile web remove dsh-rea-bundle

# 更新 Harness CLI（插件升级需另行下载新版本的 .tgz）
npm install --global @deepseek-ai/dsh@latest
```

REA 新版本发布后，下载新版本 `.tgz`，执行
`dsh plugin --profile web add /absolute/path/to/new-version.tgz`。
请勿认为对旧的本地 `.tgz` 执行 `pnpm update` 会自动取得新版。

## 使用本仓库源码 / Intel Mac Desktop

如果要执行 `xxxxxwater/rea` 的本地代码（而不是默认预编译的
`rea-agents@6.4.0`），先按仓库构建说明运行 `npm ci` 和
`npm run build:cached`，并设置环境变量
`REA_DSH_ENTRYPOINT=/绝对路径/rea/scripts/rea.mjs`。
该覆盖必须在启动 Harness 的进程环境中可见。

Desktop 有自己的应用插件配置，不能直接把 CLI 的 `web` profile 当作
Desktop 插件，也不能使用 `dsh --profile desktop`；
具体安装需使用对应 Desktop 版本支持的插件管理入口。
尤其是 Intel macOS，以上 CLI 验证不能证明原生 Desktop 应用已通过兼容性验收。

## 已验证边界

该插件复用 REA 的 MCP 服务器，而不是独立的逆向引擎。
GitHub CI 测试包括 Node/Cordis 插件合同、REA MCP 握手、
工具列表和 Harness CLI 原生配置组合。
真实 DeepSeek 付费模型调用、macOS Desktop 图形界面以及 Ghidra/IDA 等
第三方分析工具的工作状态不在这组验证之内。

0.2.1 仍是候选版本，发布后对应 URL 才会可用。Electron 宿主需将
`REA_DSH_NODE_PATH` 指向已安装的独立 Node 可执行文件。
`REA_DSH_TOOL_CALL_TIMEOUT_MS` 设置客户端计时器（默认 2147483647 毫秒），
应大于所选分析预算与清理时间。达到计时器上限的分析应直接使用 REA；
客户端计时器不能超过该上限。原生 Desktop 运行时组合仍未完成验证。
