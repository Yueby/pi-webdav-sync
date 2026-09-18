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

支持字段包括 `remoteBaseUrl`、`username`、`passwordEnv`、`password`（不太安全的兜底方式）、`remoteDir`、`installMissingPackages`、`backupRetention`、`snapshotRetention`、`extraFiles` 和 `extraDirs`。`backupRetention` 与 `snapshotRetention` 默认 5；设为 `0` 表示不清理。未知字段会被拒绝并列出受支持的字段，所以写成 `extraFile` 这类拼写错误会直接报错；以 `$` 开头的字段会被忽略，可用作注释。

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
- `/webdav-sync:push [--profile <name> | --create-profile <name>]` - 选择 profile（现有或新建），显示摘要并询问确认，然后上传 `latest.zip`、`latest.json` 和一个时间戳快照。push 会清理该 profile 下超出 `snapshotRetention`（默认 5）的旧快照，只保留最新的。取消 profile 选择、名称输入或确认都不会上传任何内容。
- `/webdav-sync:pull [--profile <name>] [--select] [snapshot-id|latest]` - 先选 profile，再选远程快照，然后选应用范围：整份 profile（替换本地配置）或只应用选中的文件（`Space`/`Enter` 目录树，就地写回）。会先备份本地状态，再应用，并可选择安装快照中的 package specs。取消任一选择都会直接中止，不会下载或应用任何内容；没有交互选择器时默认应用整份，且必须显式传入 `--profile` 和快照 id。
- `/webdav-sync:restore [backup-id]` - 恢复 `pull`/`restore` 生成的本地备份（默认最新一个）。确认后先创建一份新的安全备份，再应用选中的备份。本地备份不区分 profile。
- `/webdav-sync:status [--profile <name>]` - 比较本地 allowlist 状态与该 profile 的远端 `latest` 快照，报告 `+/~/-` 差异。
- `/webdav-sync:profiles [delete <name> [--yes] | rename <old> [new] | migrate [--yes]]` - 交互式管理远端 profile；以上参数供脚本使用。

当 `installMissingPackages` 为：

- `ask` - 安装前询问，并在 footer 显示进度。
- `always` - 自动安装 packages。
- `never` - 不安装 packages。

只会提示本机**真正缺失**的包：本地 `settings.json` 里列出的（按包名比较，忽略 `npm:` 前缀与版本号）、或目录已存在于 Pi 的 `~/.pi/agent/npm/node_modules/`（或项目级 `.pi/npm/node_modules/`）的，都算已安装。所以本机都装齐时，整份拉取不会再多问一句；选择性拉取只有在选择里**包含 `settings.json`** 时才会问包安装 —— 只拉一个扩展文件永远不会弹出同步插件。

## Profile

选择性拉取会先走进快照的目录树，只写你勾的东西。入口在 profile 顶层：`Space` 勾选当前高亮的文件或**整个文件夹**（不用进去），`Enter` 展开/收起文件夹（在文件上则勾选），`←`/`→` 收起/展开，`Esc` 取消，最后移到 `✓ Pull N selection(s) into the local config` 行按 `Enter` 即写回本地。树里用 `▾`/`▸` 加缩进显示层级，`✓` 标记跨层级保留。写回时会先存一份本地安全备份，只覆盖选中的文件（含 allowlist、配置的额外路径、`external-resources/`），**其余本地文件一律不动，也不会删除任何东西**。加 `--select` 可跳过 `Everything` / `Choose files…` 那一步，直接进目录树。

RPC / print 模式没有自定义 TUI 组件，会退回每次只显示一层列表：`Enter` 进入文件夹，层顶的 `☑ whole directory` 行用来选中该目录下全部。

profile 是相互独立的远端命名空间，因此同一台机器可以上传不同的配置，并选择拉取其中一份。它不改变本地收集哪些文件：allowlist、`extraFiles`、`extraDirs` 仍然是全局一份，所以每个 profile 包含同一批文件、只是内容不同。

服务端目录结构（相对 `remoteDir`；`remoteDir` 本身已经叫 `pi-webdav-sync` 也没问题，不会再套一层）：

```text
layout.json                                   标记：这个远端使用 profiles/ 布局
profiles/default/latest.zip | latest.json     default 就是一个普通 profile
profiles/default/snapshots/<id>.zip | json
profiles/<name>/latest.zip | latest.json      其它 profile 结构完全相同
profiles/<name>/snapshots/<id>.zip | json
```

`layout.json` 内容为 `{"tool":"pi-webdav-sync","layoutVersion":2}`。如果远端由更新版本写入，命令会失败并保持远端不变，因此旧客户端不会改动更新版本的远端。

兼容性：该布局从 0.3.0 开始。0.2.x 客户端只认识根布局，因此把未升级的机器指向已迁移的远端会报告“没有远端快照”；共用同一远端的机器请全部升级。

**从旧布局迁移（自动）**：引入 profile 之前的版本把 `latest.zip`、`latest.json`、`snapshots/` 直接放在 `remoteDir` 下。第一次遇到这些文件的 `push` 或 `pull` 会在同一次命令里自动完成迁移：先把该归档下载成本地备份，再逐个对象搬进 `profiles/default/`（每个对象一次 `MOVE`，服务器不支持 MOVE 时退化为复制后删除），写入 `layout.json`，然后继续执行原本的上传或下载。你不需要跑任何命令，远端根目录下无关的文件绝不会被碰，迁移本身幂等。`/webdav-sync:status` 保持只读，只会在输出里标注 `layout: legacy root`；`/webdav-sync:profiles migrate`（交互菜单里的 `Migrate legacy layout…`）仍保留，用于“只想迁移、不顺便上传”的情况，除非传 `--yes` 否则需要确认。

名称只允许小写字母、数字、点、短横线和下划线，最长 64 个字符，且首尾必须是字母或数字。`latest` 为保留名，Windows 设备名（含带扩展名的写法，如 `con`、`nul`、`com1`、`con.txt`、`nul.json`）会被拒绝。名字不合规的远端目录会在 `/webdav-sync:profiles` 中标记为 `unsupported name`，且永远不会被选中或写入。

快照清理按 profile 独立进行，因此清理一个 profile 不会影响其他 profile，任何 profile 操作也不会触及其他 profile 的文件。

交互流程（TUI）：

- `/webdav-sync:push` 弹出 profile 选择器，列出所有现有 profile 以及 `＋ Create profile…`；上次用过的 profile 排在最前面并标为 `(current)`，直接回车就是它。选新建会再问名字，随后确认框会写明目标 profile。任一步取消都不会上传。
- `/webdav-sync:pull` 在存在多个 profile 时先问选哪个（当前 profile 置顶），再弹快照选择器，然后问 `✓ Everything（替换本地配置）` 或 `Choose files…`（只应用选中项）；`/webdav-sync:status` 同样先问 profile。取消任一步都不会下载、备份或应用。
- 当前 profile 按机器记在 `.webdav-sync/state.json`（就在本地备份旁边，**永远不会上传**）。记录的是**真正上传过或下载过的**那个 profile —— 只在选择器里选了却取消、或命令执行失败，都不会改动记忆。删掉它会清除记忆，重命名会让记忆跟着改名。远端只有一个 profile 时依旧什么都不问。
- `/webdav-sync:profiles` 弹出操作菜单：`List profiles`、`Delete a profile…`、`Rename a profile…`；远端根目录还留着旧布局数据时，会多出 `Migrate legacy layout…`。删除会先问哪个 profile，再弹出删除内容预览确认；重命名先问哪个 profile，再问新名字。
- 每一步都可以用等价参数跳过（`--profile`、`--create-profile`、`delete <name> --yes`、`rename <old> [new]`、`migrate --yes`），非交互场景就用这些。没有选择器时命令默认操作 `default`（除非传 `--profile`），且 `pull` 仍要求显式给快照 id。

profile 管理：

- 新建时用一次 `MKCOL` 抢占名称，服务端只会让一个并发写入者成功，因此两台机器不会同时建出同名 profile。目录已存在的名称必须先删除才能重建。
- `rename` 就是一次 `MOVE`，目标必须不存在；只有尚未迁移的旧根布局才逐个对象复制（因为远端根目录本身永远不会被移动）。
- `delete` 递归删除该 profile 目录；对尚未迁移的旧根布局，则只删它自己在根目录下的对象，绝不碰无关文件。删除需要确认，非交互场景用 `--yes`。删除前会先把该 profile 的最新快照下载到本地备份目录，因此可以用 `/webdav-sync:restore <id>` 把内容恢复到本地；下载失败会中止删除。
- 没有可读索引的 profile 目录仍会列出（标记 `no readable latest index`），可以删除，但不能作为 pull 来源。
- 选择器最多读取 20 个 profile 的索引信息，以免远端 profile 很多时变慢。

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

被排除的条目同样不会被删除：pull 只删除它本应收集的路径，因此 `extensions/node_modules/` 这类被排除的子树会在 pull 后保留。

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

备份是本地安全副本。可以用 `/webdav-sync:restore`（或 `/webdav-sync:restore <backup-id>`）恢复；每次 restore 都会先创建新的安全备份再覆盖当前状态。本地备份中的 `settings.json` 保持原样，包括 `shellPath`、`npmCommand`、`sessionDir` 等本机键和原始外部路径，并且会一并保存这些引用指向的外部资源文件，因此可以还原到 pull 之前的状态。删除远端 profile 之前也会写入同样的备份，从这类备份恢复时会显示 `source profile: <name>`。如果 pull 或 restore 写入过程中失败，会自动应用安全备份并在错误信息中给出该备份 id；回滚是尽力恢复而非崩溃原子操作，进程若在应用中途被杀，需要手动执行 `/webdav-sync:restore`。

## 安全边界

这个 package 没有客户端加密。`auth.json`、`models.json`、`mcp.json` 等可能包含密钥的 allowlist 文件会被包含进 `latest.zip`；WebDAV 服务可以看到 zip 内容。命令输出只打印路径、数量、大小和哈希前缀，不打印文件内容或密码值。

路径安全检查会拒绝不安全 zip 条目（`..`、绝对路径、Windows 盘符路径、反斜杠、重复条目名，以及位于始终排除目录内的条目）。恢复时只会写入 agent 目录、明确配置的 `~/` 目标和经过 manifest 校验的外部资源，并且拒绝通过目标本身或其任意上级符号链接写入。接收机器本地配置未授权的自定义 manifest 路径会被拒绝。

安装 packages 时以 Node 脚本方式运行 pi CLI，不经过 shell。以 `-` 开头、包含空白或控制字符、或超过 2048 字符的 spec 会被跳过并报告；确认框和进度输出中的 spec 会脱敏 URL 凭据。

归档大小有上限（20000 个条目、单文件 64 MiB、总计 256 MiB、压缩后 32 MiB），创建归档时同样受限：超限时 push/backup 会报错并给出限制值。重复条目名和 manifest 哈希不匹配的内容会被拒绝；不专门支持 ZIP64 归档。
