# pi-webdav-sync

MVP Pi package for syncing selected `~/.pi/agent` files through a generic WebDAV server. It stores only two remote files: `latest.zip` and `latest.json`.

## Install for development

```bash
npm install
npm run typecheck
npm test
```

Install into Pi from this checkout, then reload Pi:

```bash
pi install npm:pi-webdav-sync
```

## Configure

Show config path and an example:

```text
/webdav-sync init
```

Write minimal config with arguments:

```text
/webdav-sync init url=https://dav.example.com/pi-agent-sync/ username=you passwordEnv=PI_WEBDAV_PASSWORD remoteDir=/
```

WebDAV config lives next to Pi's global settings file and is excluded from sync:

```text
~/.pi/agent/settings.webdav.json
```

Backups and internal state live under hidden local state:

```text
~/.pi/agent/.webdav-sync/backups/
```

Supported fields include `remoteBaseUrl` (or init alias `url`), `username`, `passwordEnv`, `password` (less safe fallback), `remoteDir`, `installMissingPackages`, and `backupRetention`.

### Jianguoyun / 坚果云 WebDAV example

Create an application password in 坚果云, set it as an environment variable, then run:

```text
/webdav-sync init url=https://dav.jianguoyun.com/dav/ username=your-email@example.com passwordEnv=PI_WEBDAV_PASSWORD remoteDir=/pi-agent-sync
```

The backend is generic WebDAV; 坚果云 is only an example.

## Commands

- `/webdav-sync status [--json]` - collect local manifest. If configured, read remote `latest.json` and compare content hashes.
- `/webdav-sync push --dry-run [--json]` - build local zip/manifest summary without upload.
- `/webdav-sync push --yes [--json]` - upload only `latest.zip` and `latest.json`.
- `/webdav-sync pull --dry-run [--json]` - download and verify remote archive, then show planned add/modify/remove counts.
- `/webdav-sync pull --yes [--install-missing]` - verify remote archive, create a local backup, restore `files/` and `external-resources/`, and optionally run `pi install <source>` for remote package specs.
- `/webdav-sync restore latest|<id> --dry-run` - show what a local backup restore would apply.
- `/webdav-sync restore latest|<id> --yes` - restore from local backup only; it never contacts WebDAV.

`push`, `pull`, and `restore` require `--yes` unless using `--dry-run`.

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

## Backups and restore

Before non-dry-run `pull`, the current local allowlist state is saved to:

```text
~/.pi/agent/.webdav-sync/backups/<timestamp>/backup.zip
```

Use `/webdav-sync restore latest --yes` to revert to the latest local backup. Backups and plugin config are excluded from sync.

## Security boundary

This MVP has no client-side encryption. Secret-bearing allowlist files such as `auth.json`, `models.json`, and `mcp.json` can be included in `latest.zip`; the WebDAV service can see zip contents. Command output prints paths, counts, sizes, and hash prefixes only, not file contents or password values.

Path safety checks reject unsafe zip entries (`..`, absolute paths, Windows drive paths, backslashes, and duplicate entries). Restore writes only under the agent directory and only from manifest-validated archive entries.
