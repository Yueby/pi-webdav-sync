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

Supported fields include `remoteBaseUrl`, `username`, `passwordEnv`, `password` (less safe fallback), `remoteDir`, `installMissingPackages`, `backupRetention`, `snapshotRetention`, `extraFiles`, and `extraDirs`.

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
- `/webdav-sync:push` - show a summary and ask for confirmation, then upload `latest.zip`, `latest.json`, and one timestamped snapshot. Push prunes remote snapshots beyond `snapshotRetention` (default 5), keeping the newest ones. Cancelling does not upload anything.
- `/webdav-sync:pull` - choose a remote snapshot, back up local state, apply it, and optionally install package specs found in the snapshot.
- `/webdav-sync:restore [backup-id]` - restore a local backup created by `pull` or `restore` (default: latest). Asks for confirmation, creates a new safety backup first, then applies the selected backup.
- `/webdav-sync:status` - compare the local allowlist state with the remote `latest` snapshot and report the `+/~/-` differences.

When `installMissingPackages` is:

- `ask` - ask before installing packages and show footer progress.
- `always` - install packages automatically.
- `never` - do not install packages.

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

Backups are local safety copies. Restore one with `/webdav-sync:restore` (or `/webdav-sync:restore <backup-id>`); every restore creates a new safety backup before overwriting the current state.

## Security boundary

This package has no client-side encryption. Secret-bearing allowlist files such as `auth.json`, `models.json`, and `mcp.json` can be included in `latest.zip`; the WebDAV service can see zip contents. Command output prints paths, counts, sizes, and hash prefixes only, not file contents or password values.

Path safety checks reject unsafe zip entries (`..`, absolute paths, Windows drive paths, backslashes, and duplicate entries). Restore writes only to the agent directory, explicitly configured `~/` targets, and manifest-validated external resources. A custom manifest path is rejected unless it is also authorized by the receiving machine's local config.

## Contributors

- [oversk7](https://github.com/oversk7) — user-configurable sync allowlist
