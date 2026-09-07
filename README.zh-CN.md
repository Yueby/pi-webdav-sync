# pi-webdav-sync

[English README](./README.md)

[![npm version](https://img.shields.io/npm/v/pi-webdav-sync.svg)](https://www.npmjs.com/package/pi-webdav-sync)
[![npm downloads](https://img.shields.io/npm/dm/pi-webdav-sync.svg)](https://www.npmjs.com/package/pi-webdav-sync)
[![GitHub stars](https://img.shields.io/github/stars/Yueby/pi-webdav-sync.svg?style=flat)](https://github.com/Yueby/pi-webdav-sync/stargazers)
[![license](https://img.shields.io/npm/l/pi-webdav-sync.svg)](./package.json)

用于通过通用 WebDAV 服务同步 Pi `~/.pi/agent` 中选定配置文件的 Pi package。它会在远端保存 `latest.zip`、`latest.json`，并在 `snapshots/` 下保存带时间戳的快照。

## 安装

安装发布包到 Pi 后，重新加载或重启 Pi：

```bash
pi install npm:pi-webdav-sync
```

从当前 checkout 开发：

```bash
npm install
npm run typecheck
npm test
npm run release
```

## 配置

安装后创建模板配置：

```bash
/webdav-sync:init
```

也可以从远程配置文本初始化：

```bash
/webdav-sync:init https://example.com/pi-webdav-sync.txt
```

远程 init 只接受 `http://` 或 `https://` URL。下载到的文本会写入配置文件；如果文本是合法 JSON，会先校验并格式化。使用 `push` 或 `pull` 前，请确认远程文本内容是一份合法的 WebDAV sync 配置。

如果配置文件已经存在，TUI 模式下会询问是否覆盖。没有覆盖确认回调时，已有配置文件会保持不变。

WebDAV 配置文件位于 Pi 全局配置目录旁边，并且不会被同步：

```text
~/.pi/agent/settings.webdav.json
```

备份和内部状态位于隐藏本地状态目录：

```text
~/.pi/agent/.webdav-sync/backups/
```

支持字段包括 `remoteBaseUrl`、`username`、`passwordEnv`、`password`（不太安全的兜底方式）、`remoteDir`、`installMissingPackages`、`backupRetention`、`snapshotRetention`、`extraFiles` 和 `extraDirs`。

### 坚果云 WebDAV 示例

在坚果云创建应用密码，然后写入：

```json
{
  "backend": "webdav",
  "remoteBaseUrl": "https://dav.jianguoyun.com/dav/",
  "username": "your-email@example.com",
  "passwordEnv": "PI_WEBDAV_PASSWORD",
  "remoteDir": "/pi-agent-sync",
  "installMissingPackages": "ask",
  "backupRetention": 5,
  "extraFiles": ["~/.pi/web-search.json", "hermes-memory-config.json"],
  "extraDirs": ["~/.config/rpiv-ask-user-question"]
}
```

推荐使用 `passwordEnv`，在本机设置 `PI_WEBDAV_PASSWORD`，不要把密码直接发布到远程配置文本里。后端是通用 WebDAV；坚果云只是一个示例。

## 命令

- `/webdav-sync:init [https-url]` - 从模板或远程配置文本创建 `settings.webdav.json`，覆盖前会询问。
- `/webdav-sync:push` - 显示摘要并询问确认，然后上传 `latest.zip`、`latest.json` 和一个时间戳快照。push 会清理超出 `snapshotRetention`（默认 5）的远端旧快照，只保留最新的。取消后不会上传任何内容。
- `/webdav-sync:pull` - 选择远程快照，备份本地状态，应用远程配置，并可选择安装快照中的 package specs。
- `/webdav-sync:restore [backup-id]` - 恢复 `pull`/`restore` 生成的本地备份（默认最新一个）。确认后先创建一份新的安全备份，再应用选中的备份。
- `/webdav-sync:status` - 比较本地 allowlist 状态与远端 `latest` 快照，报告 `+/~/-` 差异。

当 `installMissingPackages` 为：

- `ask` - 安装前询问，并在 footer 显示进度。
- `always` - 自动安装 packages。
- `never` - 不安装 packages。

## 会收集什么

允许同步的文件：

- `settings.json`、`auth.json`、`models.json`、`AGENTS.md`、`SYSTEM.md`、`APPEND_SYSTEM.md`、`keybindings.json`、`mcp.json`

允许同步的目录：

- `prompts/`、`skills/`、`extensions/`、`themes/`

可以通过 `extraFiles` 和 `extraDirs` 额外加入文件和目录。相对路径从 agent 目录解析，以 `~/` 开头的路径从当前用户的 home 目录解析。绝对路径、单独的 `~` 和通过 `..` 跳出基准目录的路径会被拒绝；不存在的配置路径会跳过并产生 warning。

pull 只会接受接收机器本地 `settings.webdav.json` 已授权的非内置 manifest 路径：路径必须与某个额外文件完全一致，或位于某个额外目录之下。因此每台机器都要明确配置愿意恢复的路径。pull 会像处理内置 allowlist 一样替换额外文件和目录，请让 `extraDirs` 保持足够精确。

任意层级都会排除：

- `npm/`、`git/`、`node_modules/`、`sessions/`、`cache/`、`logs/`、`webdav-sync/`、`.webdav-sync/`、`.git/`
- `settings.webdav.json`
- 日志文件和临时文件
- 不跟随符号链接；被跳过的符号链接会记录为 warning

`settings.json` 会经过重写步骤后再同步。本机相关配置会在同步前移除：

- `shellPath`
- `npmCommand`
- `sessionDir`

## settings 外部路径重写

`settings.json` 会解析 package 以及顶层 `extensions`、`skills`、`prompts`、`themes` 引用。以 `npm:`、`git:`、`http://`、`https://`、`ssh://` 或 `git://` 开头的 package specs 会保留为安装 specs。agent 目录外的本地路径会被复制到 zip 的 `external-resources/<stable-id>/...`，并把 settings 里的值重写为 `./external-resources/<stable-id>/<basename>`，同时保留 `!`、`+`、`-` 前缀。

`pull` 会把外部资源恢复到 `~/.pi/agent/external-resources/...`，因此重写后的相对路径仍然有效。

## 备份

`pull` 前会把当前本地内置 allowlist 和已配置的额外路径保存到：

```text
~/.pi/agent/.webdav-sync/backups/<timestamp>/backup.zip
```

备份是本地安全副本。可以用 `/webdav-sync:restore`（或 `/webdav-sync:restore <backup-id>`）恢复；每次 restore 都会先创建新的安全备份再覆盖当前状态。

## 安全边界

这个 package 没有客户端加密。`auth.json`、`models.json`、`mcp.json` 等可能包含密钥的 allowlist 文件会被包含进 `latest.zip`；WebDAV 服务可以看到 zip 内容。命令输出只打印路径、数量、大小和哈希前缀，不打印文件内容或密码值。

路径安全检查会拒绝不安全 zip 条目（`..`、绝对路径、Windows 盘符路径、反斜杠、重复条目）。恢复时只会写入 agent 目录、明确配置的 `~/` 目标和经过 manifest 校验的外部资源；接收机器本地配置未授权的自定义 manifest 路径会被拒绝。

## 贡献者

- [oversk7](https://github.com/oversk7) — 用户可配置的同步 allowlist
