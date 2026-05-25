# pi-webdav-sync

MVP Pi package for syncing selected `~/.pi/agent` files through a generic WebDAV server. It stores `latest.zip`, `latest.json`, and timestamped snapshots under `snapshots/`.

## Install for development

```bash
npm install
npm run typecheck
npm test
npm run release
```

Install into Pi from this checkout, then reload Pi:

```bash
pi install npm:pi-webdav-sync
```

## Configure

Create this file yourself:

WebDAV config lives next to Pi's global settings file and is excluded from sync:

```text
~/.pi/agent/settings.webdav.json
```

Backups and internal state live under hidden local state:

```text
~/.pi/agent/.webdav-sync/backups/
```

Supported fields include `remoteBaseUrl`, `username`, `passwordEnv`, `password` (less safe fallback), `remoteDir`, `installMissingPackages`, and `backupRetention`.

### Jianguoyun / 坚果云 WebDAV example

Create an application password in 坚果云, then write:

```json
{
  "backend": "webdav",
  "remoteBaseUrl": "https://dav.jianguoyun.com/dav/",
  "username": "your-email@example.com",
  "password": "your-app-password",
  "remoteDir": "/pi-agent-sync",
  "installMissingPackages": "ask",
  "backupRetention": 5
}
```

The backend is generic WebDAV; 坚果云 is only an example.

## Commands

- `/webdav-sync:push` - upload `latest.zip`, `latest.json`, and one timestamped snapshot.
- `/webdav-sync:pull` - choose a remote snapshot, backup local state, and apply it.

## What is collected

Allowlist files:

- `settings.json`, `auth.json`, `models.json`, `AGENTS.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `keybindings.json`, `mcp.json`

Allowlist directories:

- `prompts/`, `skills/`, `extensions/`, `themes/`

Always excluded at any depth:

- `npm/`, `git/`, `node_modules/`, `sessions/`, `cache/`, `logs/`, `webdav-sync/`, `.webdav-sync/`, `.git/`
- log files and temporary files
- symlinks are not followed; they are reported as warnings

## Settings external path rewrite

`settings.json` is parsed for package and top-level `extensions`, `skills`, `prompts`, `themes` references. Package specs beginning with `npm:`, `git:`, `http://`, `https://`, `ssh://`, or `git://` are preserved as install specs. Local paths outside the agent directory are copied into zip entries under `external-resources/<stable-id>/...`, and settings values are rewritten to `./external-resources/<stable-id>/<basename>` while preserving `!`, `+`, and `-` prefixes.

Pull restores external resources to `~/.pi/agent/external-resources/...` so the rewritten relative settings paths remain valid.

## Backups

Before `pull`, the current local allowlist state is saved to:

```text
~/.pi/agent/.webdav-sync/backups/<timestamp>/backup.zip
```

Backups are local safety copies. There is no public restore command; use the latest backup manually if needed.

## Security boundary

This MVP has no client-side encryption. Secret-bearing allowlist files such as `auth.json`, `models.json`, and `mcp.json` can be included in `latest.zip`; the WebDAV service can see zip contents. Command output prints paths, counts, sizes, and hash prefixes only, not file contents or password values.

Path safety checks reject unsafe zip entries (`..`, absolute paths, Windows drive paths, backslashes, and duplicate entries). Restore writes only under the agent directory and only from manifest-validated archive entries.
