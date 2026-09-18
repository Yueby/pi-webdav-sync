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
- `/webdav-sync:push [--profile <name> | --create-profile <name>]` - pick a profile (existing or create a new one), show a summary and ask for confirmation, then upload `latest.zip`, `latest.json`, and one timestamped snapshot. Push prunes remote snapshots beyond `snapshotRetention` (default 5), keeping the newest ones. Cancelling the profile picker, the name input, or the confirmation does not upload anything.
- `/webdav-sync:pull [--profile <name>] [--select] [snapshot-id|latest]` - pick a profile, then a remote snapshot, then what to apply: the whole profile (replaces the local config) or only picked files (the `Space`/`Enter` tree, applied in place). It backs up local state first, applies it, and optionally installs package specs found in the snapshot. Cancelling any picker aborts without downloading or applying anything; with no interactive picker it applies everything and needs `--profile` plus an explicit snapshot id.
- `/webdav-sync:restore [backup-id]` - restore a local backup created by `pull` or `restore` (default: latest). Asks for confirmation, creates a new safety backup first, then applies the selected backup. Local backups are not profile-scoped.
- `/webdav-sync:status [--profile <name>]` - compare the local allowlist state with that profile's remote `latest` snapshot and report the `+/~/-` differences.
- `/webdav-sync:profiles [delete <name> [--yes] | rename <old> [new] | migrate [--yes]]` - manage remote profiles interactively, or with these arguments for scripts.

When `installMissingPackages` is:

- `ask` - ask before installing packages and show footer progress.
- `always` - install packages automatically.
- `never` - do not install packages.

Only packages this machine is actually missing are offered: a spec counts as present when the local `settings.json` lists it (versions and `npm:` prefixes are compared by package name) or when its directory exists under Pi's `~/.pi/agent/npm/node_modules/` (or the project-level `.pi/npm/node_modules/`). A full pull therefore stays quiet on a machine that already has everything, and a selective pull only offers packages when `settings.json` is part of the selection — taking a single extension file never asks to sync packages.

## Profiles

Selective pull walks the snapshot's tree and writes only what you pick. The walk starts at the top of the profile: `Space` selects the highlighted file or the whole folder, `Enter` expands/collapses a folder (and selects a file), `←`/`→` collapse/expand, `Esc` cancels, and the `✓ Pull N selection(s) into the local config` row applies the selection. The tree shows indented children with `▾`/`▸` and keeps `✓` marks across levels. Applying writes the selected files to their local targets (allowlist files, configured extra paths, `external-resources/` content), takes a local safety backup first, and leaves every other local file untouched — nothing is deleted, so the rest of the config stays as it was. `--select` skips the `Everything`/`Choose files…` question and goes straight to the tree.

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

**Migrating the pre-profile layout (automatic)**: versions before profiles kept `latest.zip`, `latest.json`, and `snapshots/` directly under `remoteDir`. The first `push` or `pull` that meets those files migrates them transparently as part of the same command: it downloads a local backup of that archive first, moves the objects into `profiles/default/` one at a time — a `MOVE` per object, falling back to copy-then-delete on servers without MOVE — writes `layout.json`, and then continues with the original upload or download. Nothing has to be run by hand, unrelated files at the remote root are never touched, and the migration is idempotent. `/webdav-sync:status` stays read-only and just reports `layout: legacy root`; `/webdav-sync:profiles migrate` (or `Migrate legacy layout…` in the interactive menu) is still there to migrate without an upload, and asks for confirmation unless `--yes` is given.

Names are lowercase letters, digits, dot, dash, and underscore, at most 64 characters, and must start and end with a letter or digit. `latest` is reserved, and Windows device names are rejected including extensions (`con`, `nul`, `com1`, `con.txt`, `nul.json`). A remote directory whose name does not match is reported by `/webdav-sync:profiles` as `unsupported name` and can never be selected or written to.

Snapshot retention applies per profile, so pruning one profile never touches another, and no profile operation can reach a sibling profile's files.

Prompts (TUI):

- `/webdav-sync:push` opens a profile picker listing every existing profile plus `＋ Create profile…`. The profile you used last comes first and is marked `(current)`, so one Enter repeats it. Choosing create asks for the name, and the confirmation dialog names the destination profile. Cancelling any dialog uploads nothing.
- `/webdav-sync:pull` asks which profile when more than one exists (the remembered one pinned first), then the snapshot picker, then `✓ Everything (replace the local config)` or `Choose files…`; `/webdav-sync:status` asks the profile the same way. Cancelling any step aborts before anything is downloaded, backed up, or applied.
- The profile in use is remembered per machine in `.webdav-sync/state.json`, next to the local backups, and is never uploaded. It records the profile you actually pushed to or pulled from — opening the picker and cancelling changes nothing, and neither does a command that fails. Deleting the profile forgets it and renaming it follows the new name. A single-profile remote still asks nothing at all.
- `/webdav-sync:profiles` opens an action menu: `List profiles`, `Delete a profile…`, `Rename a profile…`, plus `Migrate legacy layout…` when pre-profile data is still at the remote root. Delete asks which profile and shows a confirmation preview; rename asks which profile and then for the new name.
- Every dialog can be skipped with the equivalent arguments (`--profile`, `--create-profile`, `delete <name> --yes`, `rename <old> [new]`, `migrate --yes`), which is what non-interactive runs use. Without a picker the commands fall back to `default` unless `--profile` is given, and `pull` still requires an explicit snapshot id.

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
