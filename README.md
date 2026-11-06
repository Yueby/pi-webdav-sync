# pi-webdav-sync

[中文说明](./README.zh-CN.md)

[![npm version](https://img.shields.io/npm/v/pi-webdav-sync.svg)](https://www.npmjs.com/package/pi-webdav-sync)
[![npm downloads](https://img.shields.io/npm/dm/pi-webdav-sync.svg)](https://www.npmjs.com/package/pi-webdav-sync)
[![GitHub stars](https://img.shields.io/github/stars/Yueby/pi-webdav-sync.svg?style=flat)](https://github.com/Yueby/pi-webdav-sync/stargazers)
[![license](https://img.shields.io/npm/l/pi-webdav-sync.svg)](./package.json)

Pi package for syncing selected `~/.pi/agent` files through a generic WebDAV server. It stores `latest.zip`, `latest.json`, and timestamped snapshots under `snapshots/`.

## Install

Install the published package into Pi, then reload or restart Pi:

```bash
pi install npm:pi-webdav-sync
```

For development from this checkout:

```bash
npm install
npm run typecheck
npm test
npm run release
```

## Configure

Create a template config after installing:

```bash
/webdav-sync:init
```

Or initialize from remote config text:

```bash
/webdav-sync:init https://example.com/pi-webdav-sync.txt
```

Remote init only accepts `http://` or `https://` URLs. The downloaded text is written to the config file; if it is valid JSON, it is validated and formatted first. Make sure the remote text contains a valid WebDAV sync config before using `push` or `pull`.

If the config file already exists, Pi asks before overwriting it in TUI mode. Without an overwrite confirmation callback, existing config files are left untouched.

WebDAV config lives next to Pi's global settings file and is excluded from sync:

```text
~/.pi/agent/settings.webdav.json
```

Backups and internal state live under hidden local state:

```text
~/.pi/agent/.webdav-sync/backups/
```

Supported fields include `remoteBaseUrl`, `username`, `passwordEnv`, `password` (less safe fallback), `remoteDir`, `installMissingPackages`, `backupRetention`, `snapshotRetention`, `extraFiles`, and `extraDirs`. `backupRetention` and `snapshotRetention` default to 5; `0` disables pruning. Unknown keys are rejected with the list of supported ones, so a typo like `extraFile` fails loudly; keys starting with `$` are ignored and can be used as comments.

### Jianguoyun / 坚果云 WebDAV example

Create an application password in 坚果云, then write:

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

Using `passwordEnv` is recommended. Set `PI_WEBDAV_PASSWORD` locally instead of publishing a password in remote config text. The backend is generic WebDAV; 坚果云 is only an example.

## Commands

- `/webdav-sync:init [https-url]` - create `settings.webdav.json` from a template or remote config text, asking before overwrite.
- `/webdav-sync:push [--profile <name> | --create-profile <name>] [--select | --models | --plugins]` - choose a destination profile and the same Models / Plugins and configuration / All content categories as pull. Whole-content uploads replace the profile; model/plugin/file selections merge into its existing contents and publish a complete new snapshot. No local package installation is performed. Profile creation and legacy migration wait until confirmation. Push prunes remote snapshots beyond `snapshotRetention` (default 5).
- `/webdav-sync:pull [--profile <name>] [--select | --models | --plugins] [snapshot-id|latest]` - pick a source profile and snapshot, then choose `Models…`, `Plugins and configuration…`, or `All content…`. Model/plugin imports merge into the current configuration; All content offers whole-profile replacement or a file selection. A safety backup precedes local writes. Cancelling before the final import confirmation leaves local files and the current profile unchanged. Without an interactive picker it retains full-pull behavior and requires an explicit snapshot id.
- `/webdav-sync:restore [backup-id]` - restore a local backup created by `pull` or `restore` (default: latest). Asks for confirmation, creates a new safety backup first, then applies the selected backup. Local backups are not profile-scoped.
- `/webdav-sync:status [--profile <name>]` - compare the local allowlist state with that profile's remote `latest` snapshot and report the `+/~/-` differences.
- `/webdav-sync:profiles [delete <name> [--yes] | rename <old> [new] | migrate [--yes]]` - manage remote profiles interactively, or with these arguments for scripts.

When `installMissingPackages` is:

- `ask` - ask before installing packages and show footer progress.
- `always` - install packages automatically.
- `never` - do not install packages.

Installation checks distinguish configured declarations from real packages. A personal npm package must have matching `name` and nonempty `version` metadata under the agent's `npm/node_modules/<name>/package.json`; a settings declaration, empty directory or project-only install does not satisfy a personal install. Git sources require repository metadata under Pi's managed user clone path. Skipping an installation does not mark it installed: a later import still offers it if absent. Normal full/file pulls offer packages only when `settings.json` is transferred; taking one extension file never asks to install unrelated packages.

## Targeted synchronization

Both `/webdav-sync:push` and `/webdav-sync:pull` offer Models / Plugins and configuration / All content. Use `push --models`, `push --plugins`, `pull --models`, or `pull --plugins` to open a category directly; these flags and `--select` are mutually exclusive. **Space on a folder selects its whole group**: select `Models/` for all models, one provider for its models, or individual entries. Selected transfers lead to a review of additions, replacements and dependent files before writing. Model/plugin synchronization **keeps the current profile unchanged** in either direction.

Native TUI push/pull uses **one continuously mounted screen** for the entire command. Profile, snapshot, category, tree, name input and review are child pages inside that screen. Back navigation and asynchronous reads keep the same container visible, with an inline loading/progress view between pages; only completion, terminal error or leaving the outermost step closes it.

In sync menus and trees, **Esc returns to the previous step and closes the wizard at the outermost step; Ctrl+C requests cancellation of the operation**. Menus show operation choices, with navigation handled by the footer shortcuts. During read-only loading, navigation is queued until the next prompt or precommit gate. Once actual migration/backup/writes begin, the screen shows progress with cancellation unavailable and closes on completion; it never pretends an in-flight write was cancelled. Returning preserves checked entries, expanded folders, the cursor and provider decisions; drafts are isolated by direction, profile, snapshot/source revision and category. Provider decisions also track the destination revision, so a different source or changed destination starts with the safe Keep destination default. `←` / `→` still operate on folders inside the tree. Long review details scroll with `PgUp` / `PgDn` while the action menu remains visible. In the plain-picker fallback, Esc goes to the parent folder first, then to the preceding step from the root. Profile management menus retain their own cancellation behavior.

| Category | Selection and merge rules |
|---|---|
| Models | Select models from `models.json`, grouped by provider. The same provider key + model ID is replaced, including its selected override; other models/providers and destination root metadata survive. `modelOverrides` and provider-only connection settings are supported. |
| Plugins and configuration | `Packages/` lists package declarations and `Resources/` lists extension/skill/prompt/theme references. `Settings (manual)/` and `Supplemental files (manual)/` explicitly separate general configuration fields and independent files; they are not implicitly selected with packages. Ownership cannot be inferred, so pick the relevant fields/files yourself. Model and auth files use the Models category instead. |
| All content | `Everything` replaces the destination configuration; `Choose files…` transfers only selected files. Selected uploads preserve every unselected remote file by publishing a complete merged snapshot. `--select` opens the file tree directly. |

For an existing provider whose connection settings or credentials differ, choose **Keep destination** (default) or **Use source**. On pull the destination is this machine; on push it is the remote profile. Esc returns to the preceding decision instead of aborting the transfer. Source connections affect all models on that provider. Only that provider's `auth.json` entry is copied; unrelated credentials remain unchanged at the destination. When source credentials are absent, Use source removes the old provider credential so it cannot override the source's `models.json` API key. A provider known only through the destination's `auth.json` is treated as existing too. The policy covers effective connections at provider, model and model-override levels (`baseUrl`, API, headers/auth and compatibility settings). Keep destination retains the target's selected-model connection fields, or inherits its provider connection for a new model; source-only overrides cannot silently route target credentials elsewhere. Use source removes stale target connection overrides that would defeat the source connection. Non-connection model metadata is imported under either policy. Keys, tokens and other configuration values are not shown in prompts. Environment variables and credential commands are preserved as references, not resolved on this machine during import. Import only trusted sources: plugins and credential commands can execute code when Pi loads them.

Plugin declarations merge by npm package name (including scoped/bare/versioned forms) or Git repository identity without its ref; a selected incoming entry replaces the matching declaration together with its resource filters. Unrelated packages remain. Selected settings objects merge recursively, with source scalar/array leaves replacing conflicts; selected `extensions`/`skills`/`prompts`/`themes` lists merge by resource identity. Independently selected files are replaced as whole files. Referenced archived local plugin/resource payloads are included automatically and listed in the review; missing payloads or unresolved globs abort instead of leaving broken references. Extra paths still require authorization in the receiving machine's own `settings.webdav.json`.

Only selected plugin packages in a download are offered for installation. Explicit version changes are offered as updates too, using `installMissingPackages`. Exact full npm versions are compared with installed metadata. Tags/ranges are checked offline for configured-intent changes, not resolved against the registry; Git checks clone presence and ref intent, not remote freshness. Use Pi's package update command when you want a registry/remote refresh. These choices happen before local writes, so Back or Cancel remains safe. Model synchronization and all uploads never install plugins. Derived configuration files get fresh archive hashes and normal path/symlink validation; a failed import write restores the selected targets and removes newly written files. This recovery does not undo external package-manager side effects and is not crash-atomic.

Targeted uploads validate the destination snapshot, reject raw local-backup archives as merge targets, and recheck it after review; a changed remote requires replanning rather than overwriting an unseen update. History objects are written before `latest`. The WebDAV backend has no atomic compare-and-swap for the ZIP/index pair: this check reduces races but is not a transaction.

Selection is leaf-based: `[x]` means all descendants selected, `[-]` means partial, and `[ ]` means none. You can select a whole group and then exclude individual models/files; the header counts actual selected entries. Every selected-file download expands references first and reviews all dependency additions/overwrites before writing, just like model/plugin imports.

Local merge plans fingerprint both the destination files they read and the targets they will write, including absent files. They recheck those fingerprints before side effects and again immediately before applying. If a file changes while the review is open, synchronization stops and asks you to rerun/review rather than overwriting the newer state. This is optimistic validation, not an OS-level write lock.

## Profiles

Selective pull walks the snapshot's tree and writes only what you pick. The walk starts at the top of the profile: `Space` selects the highlighted file or the whole folder, `Enter` expands/collapses a folder (and selects a file), `←`/`→` collapse/expand, `Esc` returns to the previous step, `Ctrl+C` cancels, and the `✓ Pull N selection(s) into the local config` row applies the selection. The tree shows indented children with `▾`/`▸` and keeps `✓` marks across levels. Applying writes the selected files to their local targets (allowlist files, configured extra paths, `external-resources/` content), takes a local safety backup first, and leaves every other local file untouched — nothing is deleted, so the rest of the config stays as it was. `--select` skips the `Everything`/`Choose files…` question and goes straight to the tree.

In RPC and print modes, where a custom TUI component is unavailable, the walk falls back to one level per picker: `Enter` descends into a folder and the `☑ whole directory` row at the top of a level selects everything below it.

Profiles are separate remote namespaces, so one machine can upload different configurations and choose which one to pull. They do not change which local files are collected: the allowlist, `extraFiles`, and `extraDirs` stay global, so every profile holds the same file set with different contents.

Layout on the server, relative to `remoteDir` (which may itself be a folder named `pi-webdav-sync`):

```text
layout.json                                    marker: this remote uses the profiles/ layout
profiles/default/latest.zip | latest.json      the default profile is an ordinary profile
profiles/default/snapshots/<id>.zip | json
profiles/<name>/latest.zip | latest.json       every other profile looks the same
profiles/<name>/snapshots/<id>.zip | json
```

`layout.json` holds `{"tool":"pi-webdav-sync","layoutVersion":2}`. A remote written by a newer version is left untouched and the command fails, so an older client leaves a newer remote intact.

Compatibility: this layout was introduced in 0.3.0. A 0.2.x client only knows the root layout, so pointing an un-upgraded machine at an already-migrated remote reports no remote snapshot; upgrade every machine that shares the remote.

**Migrating the pre-profile layout (automatic)**: versions before profiles kept `latest.zip`, `latest.json`, and `snapshots/` directly under `remoteDir`. After confirmation, the first `push` or `pull` that meets those files migrates them transparently as part of the same command: it downloads a local backup of that archive first, moves the objects into `profiles/default/` one at a time — a `MOVE` per object, falling back to copy-then-delete on servers without MOVE — writes `layout.json`, and then continues with the original upload or download. Nothing has to be run by hand, unrelated files at the remote root are never touched, and the migration is idempotent. `/webdav-sync:status` stays read-only and just reports `layout: legacy root`; `/webdav-sync:profiles migrate` (or `Migrate legacy layout…` in the interactive menu) is still there to migrate without an upload, and asks for confirmation unless `--yes` is given.

Names are lowercase letters, digits, dot, dash, and underscore, at most 64 characters, and must start and end with a letter or digit. `latest` is reserved, and Windows device names are rejected including extensions (`con`, `nul`, `com1`, `con.txt`, `nul.json`). A remote directory whose name does not match is reported by `/webdav-sync:profiles` as `unsupported name` and can never be selected or written to.

Snapshot retention applies per profile, so pruning one profile never touches another, and no profile operation can reach a sibling profile's files.

Prompts (TUI):

- `/webdav-sync:push` opens a profile picker listing every existing profile plus `＋ Create profile…`. The current profile comes first. After the name/profile step it offers the same three categories as pull. Creation uses an atomic name claim only after the final confirmation; cancelling before commit creates no profile directory.
- `/webdav-sync:pull` asks which profile when more than one exists (the remembered one pinned first), then the snapshot and category pickers. `All content…` offers `✓ Everything (replace the local config)` or `Choose files…`; model/plugin categories offer merge imports with a final review. `/webdav-sync:status` asks the profile the same way. Cancelling a selection/review leaves local files unchanged.
- The profile in use is remembered per machine in `.webdav-sync/state.json`, next to the local backups, and is never uploaded. It records the profile you actually pushed to or pulled files from; model/plugin merge imports retain the current profile. Opening a picker and cancelling changes nothing, and neither does a command that fails. Deleting the profile forgets it and renaming it follows the new name. Pull/status can skip the profile menu when the remote has a single usable profile; push also offers creating a profile.
- `/webdav-sync:profiles` opens an action menu: `List profiles`, `Delete a profile…`, `Rename a profile…`, plus `Migrate legacy layout…` when pre-profile data is still at the remote root. Delete asks which profile and shows a confirmation preview; rename asks which profile and then for the new name.
- Profile/name/management dialogs have equivalent arguments (`--profile`, `--create-profile`, `delete <name> --yes`, `rename <old> [new]`, `migrate --yes`). Model/plugin and selected-file transfers still require interactive selection/review. Without a picker the commands fall back to `default` unless `--profile` is given, and `pull` still requires an explicit snapshot id.

Managing profiles:

- Creating claims the name with a single `MKCOL`, which the server accepts for exactly one racing writer, so two machines cannot both create the same profile. A name whose directory already exists must be deleted first.
- `rename` is a single `MOVE` and the destination must not exist; only a not-yet-migrated legacy root is copied object by object, since the remote root itself is never moved.
- `delete` removes the profile's directory recursively — for a not-yet-migrated legacy root it removes only that profile's own objects at the remote root, never unrelated files. Deleting asks for confirmation, or takes `--yes` for non-interactive use. Before anything is deleted, the profile's latest snapshot is downloaded into the local backup store, so `/webdav-sync:restore <id>` can bring that content back; a failed download aborts the delete.
- A profile directory without a readable index is still listed (marked `no readable latest index`), can be deleted, but cannot be pulled from.
- Profile pickers read the latest index of at most 20 profiles to keep a large remote responsive.

## What is collected

Allowlist files:

- `settings.json`, `auth.json`, `models.json`, `AGENTS.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `keybindings.json`, `mcp.json`

Allowlist directories:

- `prompts/`, `skills/`, `extensions/`, `themes/`

Additional files and directories can be opted into with `extraFiles` and `extraDirs`. Relative paths resolve from the agent directory; paths beginning with `~/` resolve from the current user's home directory. Absolute paths, bare `~`, and paths that escape through `..` are rejected. Missing configured paths are skipped with a warning.

A pull accepts a non-builtin manifest path only when the receiving machine's local `settings.webdav.json` authorizes the same file or a containing extra directory. This means every machine must opt into the paths it is willing to restore. Pull replaces configured extra files and directories just like the built-in allowlist, so keep `extraDirs` narrowly scoped.

Always excluded at any depth:

- `npm/`, `git/`, `node_modules/`, `sessions/`, `cache/`, `logs/`, `webdav-sync/`, `.webdav-sync/`, `.git/`
- `settings.webdav.json`
- log files and temporary files
- symlinks are not followed; they are reported as warnings

Excluded entries are also never deleted: `pull` removes only the paths it would collect, so an excluded subtree such as `extensions/node_modules/` survives a pull.

`settings.json` is copied through a rewrite step. Local-machine settings are removed before sync:

- `shellPath`
- `npmCommand`
- `sessionDir`

## Settings external path rewrite

`settings.json` is parsed for package and top-level `extensions`, `skills`, `prompts`, `themes` references. Package specs beginning with `npm:`, `git:`, `http://`, `https://`, `ssh://`, or `git://` are preserved as install specs. Local paths outside the agent directory are copied into zip entries under `external-resources/<stable-id>/...`, and settings values are rewritten to `./external-resources/<stable-id>/<basename>` while preserving `!`, `+`, and `-` prefixes.

Pull restores external resources to `~/.pi/agent/external-resources/...` so the rewritten relative settings paths remain valid.

## Backups

Before `pull`, the current local built-in and configured extra paths are saved to:

```text
~/.pi/agent/.webdav-sync/backups/<timestamp>/backup.zip
```

Backups are local safety copies. Restore one with `/webdav-sync:restore` (or `/webdav-sync:restore <backup-id>`); every restore creates a new safety backup before overwriting the current state. Local backups keep `settings.json` verbatim, including local-only keys (`shellPath`, `npmCommand`, `sessionDir`) and original external paths, and they include the external resource files those references point to, so a restore reproduces the pre-pull state. Backups are also written before a remote profile is deleted, and a restore from one reports `source profile: <name>`. If a pull or restore fails while writing, the safety backup is applied automatically and the error names it; rollback is best-effort recovery, not crash-atomic, so a process killed mid-apply needs an explicit `/webdav-sync:restore`.

## Security boundary

This package has no client-side encryption. Secret-bearing allowlist files such as `auth.json`, `models.json`, and `mcp.json` can be included in `latest.zip`; the WebDAV service can see zip contents. Command output prints paths, counts, sizes, and hash prefixes only, not file contents or password values.

Path safety checks reject unsafe zip entries (`..`, absolute paths, Windows drive paths, backslashes, duplicate entry names, and entries inside always-excluded directories). Restore writes only to the agent directory, explicitly configured `~/` targets, and manifest-validated external resources, and it refuses to write through a symlink at the target or anywhere above it. A custom manifest path is rejected unless it is also authorized by the receiving machine's local config.

Package installs run the pi CLI as a Node script, never through a shell. Specs that start with `-`, contain whitespace or control characters, or exceed 2048 characters are skipped and reported. Confirmation dialogs and progress output show specs with URL credentials redacted.

Archive size is bounded (20000 entries, 64 MiB per file, 256 MiB total, 32 MiB compressed) and the same limits apply when creating an archive, so an oversized configuration fails the push or backup with the limit in the message. Duplicate entry names and content that fails the manifest hashes are rejected; ZIP64 archives are not specifically supported.
