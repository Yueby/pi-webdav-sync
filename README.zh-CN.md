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
- `/webdav-sync:push [--profile <name> | --create-profile <name>] [--select | --models | --plugins]` - 选择目标 profile，再选择与下载一致的模型 / 插件及配置 / 所有内容。整份上传替换目标；模型、插件、文件选择则合并进目标已有内容，并发布完整的新快照。不执行本地包安装；新建 profile 和旧布局迁移均延后到确认之后。仍按 `snapshotRetention`（默认 5）清理旧快照。
- `/webdav-sync:pull [--profile <name>] [--select | --models | --plugins] [snapshot-id|latest]` - 先选来源 profile 和远程快照，再选 `Models…`（模型）、`Plugins and configuration…`（插件及配置）或 `All content…`（所有内容）。模型/插件合并进当前配置；所有内容可整份替换或按文件选择。本地写入前沿用安全备份。最终导入确认前取消，不改本地文件和当前 profile；没有交互选择器时保留整份拉取行为，且必须显式给出快照 id。
- `/webdav-sync:restore [backup-id]` - 恢复 `pull`/`restore` 生成的本地备份（默认最新一个）。确认后先创建一份新的安全备份，再应用选中的备份。本地备份不区分 profile。
- `/webdav-sync:status [--profile <name>]` - 比较本地 allowlist 状态与该 profile 的远端 `latest` 快照，报告 `+/~/-` 差异。
- `/webdav-sync:profiles [delete <name> [--yes] | rename <old> [new] | migrate [--yes]]` - 交互式管理远端 profile；以上参数供脚本使用。

当 `installMissingPackages` 为：

- `ask` - 安装前询问，并在 footer 显示进度。
- `always` - 自动安装 packages。
- `never` - 不安装 packages。

安装检查区分“配置中声明了”与“实际已安装”。个人 npm 包必须在 agent 的 `npm/node_modules/<name>/package.json` 中具备名称匹配、版本非空的有效元数据；仅有 settings 声明、空目录或项目级安装都不算个人安装。Git 来源必须在 Pi 管理的个人 clone 路径中存在仓库元数据。跳过安装不会被标成已安装，下次导入时仍会提示实际缺失的包。普通整份/按文件下载只有传输 `settings.json` 时才处理包安装；只拉扩展文件不会询问无关插件。

## 模型与插件双向同步

`/webdav-sync:push` 和 `/webdav-sync:pull` 都提供模型 / 插件及配置 / 所有内容三个类别。也可用 `push --models`、`push --plugins`、`pull --models`、`pull --plugins` 直接进入；这些参数与 `--select` 互斥。**在目录行按 Space 即选整组**：勾 `Models/` 就是全部模型，勾一个 provider 就是它的全部模型，也能只勾某几项。定向传输前会显示新增、替换和依赖文件预览，确认后才写入；**模型/插件双向同步都不改变当前 profile**。

原生 TUI 的 push/pull 全程使用**一个持续挂载的界面容器**。profile、快照、类别、勾选、新建名称和预览都是容器内的子页；返回和异步读取期间保留同一容器，并在原位显示加载/进度。只有整次操作完成、终止错误或从最外层退出时才关闭。

同步菜单和目录树中，**Esc 逐级返回，在最外层继续按会关闭 TUI；Ctrl+C 请求取消整次操作**。菜单只展示操作选项，导航统一使用底部提示的快捷键。只读取数期间的返回/取消会排队，在下一个交互点或提交前安全检查处处理；实际迁移、备份、写入开始后，界面显示进度并暂不允许取消，完成后关闭，不会将进行中的写入假报为已取消。返回后保留勾选、展开目录、光标和 provider 选择；临时草稿按方向、profile、快照/来源版本和类别隔离；provider 决策还关联目标版本，换来源或目标已变化时重新以“保留目标连接”为安全默认。目录树内 `←` / `→` 仍用于收起/展开目录。预览明细很长时可用 `PgUp` / `PgDn` 翻阅，操作菜单始终可见。普通选择器回退模式下，Esc 先返回父目录，在树根才返回前一个步骤。profile 管理菜单沿用自己的取消方式。

| 类别 | 选择与合并规则 |
|---|---|
| 模型 | 按 provider 分组展示 `models.json` 中的模型。同 provider key + model ID 替换对应条目（含所选 override），未选模型、其他 provider 和目标根级元数据保留；支持 `modelOverrides` 与仅含连接配置的 provider。 |
| 插件及配置 | `Packages/` 选择包声明，`Resources/` 选择扩展/skill/prompt/theme 的资源引用；`Settings (manual)/` 和 `Supplemental files (manual)/` 单独标明通用配置字段及独立文件，不会随包声明自动选中。插件与配置没有统一归属表，仍由你明确勾选。模型和鉴权文件请走模型类别。 |
| 所有内容 | `Everything` 整份替换目标配置，`Choose files…` 只传选中文件。文件选择上传会发布合并后的完整快照，远端未选文件保留；`--select` 直接进入文件树。 |

已有 provider 的连接配置或鉴权有差异时，可选择 **保留目标连接**（默认）或 **使用来源连接**：下载时目标是本机，上传时目标是远端 profile。Esc 返回前一个选择，而不是直接取消。使用来源连接会影响该 provider 下所有模型；只替换这个 provider 的 `auth.json` 条目，其他凭据不动。来源没有该凭据时，Use source 会移除旧凭据，避免旧鉴权优先级高于来源 `models.json` 的 API key。即使目标仅在 `auth.json` 中存在该 provider，也会按已有连接询问。连接策略同时约束 provider、模型和 model override 的有效连接字段（地址、API、headers/鉴权及兼容配置）。“保留目标连接”保留所选目标模型的连接覆盖；新模型继承目标 provider，不会悄悄带入来源覆盖、让目标凭据发往来源地址。“使用来源连接”会清掉妨碍来源连接生效的旧目标覆盖。两种策略下仍导入所选模型的非连接元数据。提示只展示字段名，不展示密钥、token 或配置值；环境变量和鉴权命令保留为引用，导入过程不执行求值。只导入可信来源：插件代码和鉴权命令可在 Pi 加载时执行。

插件包按 npm 包名（支持 scoped、裸名和带版本写法）或去掉 ref 的 Git 仓库身份合并，选中的来源条目连同资源过滤设置一起替换同名声明，其他包保留。选中的 settings 对象递归合并，冲突的标量/数组以来源为准；`extensions`/`skills`/`prompts`/`themes` 列表按资源身份合并。独立文件按整文件覆盖。选中的本地插件/资源引用会自动带上归档内对应的依赖文件，并在预览里列出；依赖缺失或含未解析通配符会中止，避免导入后引用失效。额外路径仍需接收机器自己的 `settings.webdav.json` 授权。

只有下载中选中的插件包才询问安装；显式版本变化也会作为更新列出，仍遵守 `installMissingPackages`。完整固定 npm 版本会与实际安装元数据比较；tag/range 离线判断声明意图变化，不查询 registry 最新版本；Git 判断 clone 存在性和 ref 意图，不自动检查远端新提交。需要刷新 registry/远端版本时使用 Pi 的包更新命令。这些选择发生在本地写入之前，因此返回或取消不会留下半次操作。模型同步和所有上传都不执行本地插件安装。生成的配置文件会重新计算归档哈希并走现有路径/符号链接校验；导入写入失败会恢复本次选中的目标、移除新写入文件。该恢复不包含外部包管理器的副作用，也不保证进程崩溃时的原子性。

定向上传会验证目标快照，拒绝将 raw 本地备份归档作为合并目标，并在确认后复查目标是否变化；已发生变化则要求重新预览，不覆盖未见过的修改。历史快照先于 `latest` 写入。WebDAV 后端不能对 ZIP/索引这一对文件执行原子 compare-and-swap，这种复查能降低并发覆盖风险，但不等于事务。

选择状态按实际条目保存：`[x]` 全选、`[-]` 部分选择、`[ ]` 未选。可先勾整组再排除某个模型/文件，标题显示实际选中条目数。所有按文件下载都会先展开引用依赖，预览会明确列出自动附带的文件及覆盖目标，再确认写入。

本地合并计划会记录读取过的目标配置和将写入的文件指纹，也记录“文件原本不存在”。提交产生副作用前、实际写入前各复查一次；预览期间若文件变化，会中止并要求重新运行/预览，而不是覆盖新修改。这是乐观校验，不是操作系统写锁。

## Profile

选择性拉取会先走进快照的目录树，只写你勾的东西。入口在 profile 顶层：`Space` 勾选当前高亮的文件或**整个文件夹**（不用进去），`Enter` 展开/收起文件夹（在文件上则勾选），`←`/`→` 收起/展开，`Esc` 返回上一步、`Ctrl+C` 取消，最后移到 `✓ Pull N selection(s) into the local config` 行按 `Enter` 即写回本地。树里用 `▾`/`▸` 加缩进显示层级，`✓` 标记跨层级保留。写回时会先存一份本地安全备份，只覆盖选中的文件（含 allowlist、配置的额外路径、`external-resources/`），**其余本地文件一律不动，也不会删除任何东西**。加 `--select` 可跳过 `Everything` / `Choose files…` 那一步，直接进目录树。

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

**从旧布局迁移（自动）**：引入 profile 之前的版本把 `latest.zip`、`latest.json`、`snapshots/` 直接放在 `remoteDir` 下。第一次遇到这些文件的 `push` 或 `pull` 会在确认之后、同一次命令里自动完成迁移：先把该归档下载成本地备份，再逐个对象搬进 `profiles/default/`（每个对象一次 `MOVE`，服务器不支持 MOVE 时退化为复制后删除），写入 `layout.json`，然后继续执行原本的上传或下载。你不需要跑任何命令，远端根目录下无关的文件绝不会被碰，迁移本身幂等。`/webdav-sync:status` 保持只读，只会在输出里标注 `layout: legacy root`；`/webdav-sync:profiles migrate`（交互菜单里的 `Migrate legacy layout…`）仍保留，用于“只想迁移、不顺便上传”的情况，除非传 `--yes` 否则需要确认。

名称只允许小写字母、数字、点、短横线和下划线，最长 64 个字符，且首尾必须是字母或数字。`latest` 为保留名，Windows 设备名（含带扩展名的写法，如 `con`、`nul`、`com1`、`con.txt`、`nul.json`）会被拒绝。名字不合规的远端目录会在 `/webdav-sync:profiles` 中标记为 `unsupported name`，且永远不会被选中或写入。

快照清理按 profile 独立进行，因此清理一个 profile 不会影响其他 profile，任何 profile 操作也不会触及其他 profile 的文件。

交互流程（TUI）：

- `/webdav-sync:push` 列出现有 profile 以及 `＋ Create profile…`，当前 profile 置顶；profile/名称选择后，同样进入三个同步类别。新建名称只在最终确认后才原子抢占，提交前取消不会创建远端目录。
- `/webdav-sync:pull` 在存在多个 profile 时先问选哪个（当前 profile 置顶），再弹快照和类别选择器。`All content…` 内可选 `✓ Everything（替换本地配置）` 或 `Choose files…`（只应用选中项）；模型/插件类别会进入合并导入及最终预览。`/webdav-sync:status` 同样先问 profile。取消选择或预览不改本地文件。
- 当前 profile 按机器记在 `.webdav-sync/state.json`（就在本地备份旁边，**永远不会上传**）。记录的是**真正上传过或按文件拉取过的**那个 profile；模型/插件合并导入不切换当前 profile。只在选择器里选了却取消、或命令执行失败，都不会改动记忆。删掉它会清除记忆，重命名会让记忆跟着改名。远端只有一个可用 profile 时，下载/status 可跳过 profile 选择；上传仍提供新建 profile 的入口。
- `/webdav-sync:profiles` 弹出操作菜单：`List profiles`、`Delete a profile…`、`Rename a profile…`；远端根目录还留着旧布局数据时，会多出 `Migrate legacy layout…`。删除会先问哪个 profile，再弹出删除内容预览确认；重命名先问哪个 profile，再问新名字。
- profile/名称/管理菜单可用等价参数跳过（`--profile`、`--create-profile`、`delete <name> --yes`、`rename <old> [new]`、`migrate --yes`）。模型/插件和文件选择传输仍需交互选择及确认。没有选择器时命令默认操作 `default`（除非传 `--profile`），且 `pull` 仍要求显式给快照 id。

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
