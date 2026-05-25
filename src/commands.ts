import { spawn } from "node:child_process";
import {
	createLocalBackup,
	applyArchiveToAgent,
	diffArchiveAgainstLocal,
} from "./backup.js";
import { collectAgentArchive } from "./collector.js";
import { configPath, readConfig, type WebdavSyncConfig } from "./config.js";
import { createLatestIndex, type LatestIndex, shortHash } from "./manifest.js";
import { getAgentDir } from "./paths.js";
import { missingInstallSpecs } from "./package-specs.js";
import { createLatestZip, parseArchive, type ParsedArchive } from "./zip-store.js";
import { createWebdavBackend } from "./backends/webdav.js";
import type { RemoteListEntry, SyncBackend } from "./backends/types.js";

export type CommandResult = {
	ok: boolean;
	text: string;
	data?: unknown;
};

export type CommandContext = {
	agentDir?: string;
	backend?: SyncBackend;
	selectSnapshot?: (choices: SnapshotChoice[]) => Promise<string | undefined>;
};

export type SnapshotChoice = {
	id: string;
	label: string;
};

type Flags = Set<string>;

export async function runWebdavSyncCommand(
	input: string | string[] = [],
	context: CommandContext = {},
): Promise<CommandResult> {
	const args = Array.isArray(input) ? input : splitArgs(input);
	const command = normalizeCommand(args[0] || "help");
	const flags = new Set(args.filter((arg) => arg.startsWith("--")));
	const agentDir = getAgentDir(context.agentDir);

	try {
		if (command === "push") return await commandPush(agentDir, flags, context.backend);
		if (command === "pull") return await commandPull(agentDir, flags, context);
		return ok(helpText());
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
}

export async function handleWebdavSyncCommand(...args: unknown[]): Promise<string> {
	const input = extractInput(args);
	const result = await runWebdavSyncCommand(input);
	return result.text;
}

async function commandPush(
	agentDir: string,
	flags: Flags,
	backendOverride?: SyncBackend,
): Promise<CommandResult> {
	const dryRun = flags.has("--dry-run");
	const collected = await collectAgentArchive(agentDir);
	const zip = createLatestZip(collected.zipEntries, collected.manifest);
	const result = pushSummary(zip.latest, zip.zipBytes.byteLength);
	if (dryRun) return ok(formatPush("push: dry-run", result), result);
	if (!flags.has("--yes")) return fail("push requires --yes or --dry-run");

	const config = await requireConfig(agentDir);
	const backend = backendOverride || createWebdavBackend(config);
	const snapshotId = snapshotIdFromDate(new Date(zip.latest.createdAt));
	const snapshotZip = `snapshots/${snapshotId}.zip`;
	const snapshotJson = `snapshots/${snapshotId}.json`;
	await backend.putBytes("latest.zip", zip.zipBytes);
	await backend.putJson("latest.json", zip.latest);
	await backend.putBytes(snapshotZip, zip.zipBytes);
	await backend.putJson(snapshotJson, { ...zip.latest, snapshotId, zip: snapshotZip });
	return ok(formatPush("push: ok", result), result);
}

async function commandPull(
	agentDir: string,
	flags: Flags,
	context: CommandContext,
): Promise<CommandResult> {
	const dryRun = flags.has("--dry-run");
	if (!dryRun && !flags.has("--yes")) return fail("pull requires --yes or --dry-run");
	const config = await requireConfig(agentDir);
	const backend = context.backend || createWebdavBackend(config);
	const snapshot = await chooseSnapshot(backend, flags, context.selectSnapshot);
	const latest = await backend.getJson<LatestIndex>(snapshot.jsonPath);
	const zipBytes = await backend.getBytes(snapshot.zipPath);
	const archive = parseArchive(zipBytes, latest.zipSha256);
	validateLatestMatchesManifest(latest, archive);
	const diff = await diffArchiveAgainstLocal(agentDir, archive);
	const packages = missingInstallSpecs(await settingsJsonFromArchive(archive));
	const summary = { snapshot: snapshot.id, remote: latest, diff, packageSpecs: packages };
	if (dryRun) return ok(formatPull("pull: dry-run", snapshot.id, latest, diff, packages), summary);

	const backup = await createLocalBackup(agentDir, config.backupRetention ?? 5);
	const applied = await applyArchiveToAgent(agentDir, archive);
	const installResults = flags.has("--install-missing") || config.installMissingPackages === "always"
		? await installPackages(packages)
		: [];
	const lines = [
		`pull: ${snapshot.id}`,
		`backup: ${backup.id}`,
		`files: ${applied.filesWritten}`,
		`external: ${applied.externalFilesWritten}`,
		`hash: ${shortHash(archive.manifest.contentSha256)}`,
	];
	if (packages.length && !installResults.length) lines.push(`packages: ${packages.length} not installed; rerun with --install-missing`);
	if (installResults.length) {
		const failed = installResults.filter((item) => !item.ok).length;
		lines.push(`packages: ${installResults.length - failed} installed, ${failed} failed`);
	}
	return ok(lines.join("\n"), { ...summary, backup, applied, installResults });
}

async function chooseSnapshot(
	backend: SyncBackend,
	flags: Flags,
	selectSnapshot?: (choices: SnapshotChoice[]) => Promise<string | undefined>,
): Promise<{ id: string; jsonPath: string; zipPath: string }> {
	const explicit = valueFlag(flags, "--snapshot");
	if (explicit) return snapshotPaths(explicit);
	const choices = await listSnapshots(backend);
	if (choices.length <= 1) return snapshotPaths("latest");
	if (!selectSnapshot) return snapshotPaths("latest");
	const selected = await selectSnapshot(choices.map(({ id, label }) => ({ id, label })));
	return snapshotPaths(selected || "latest");
}

async function listSnapshots(backend: SyncBackend): Promise<SnapshotChoice[]> {
	const out: SnapshotChoice[] = [{ id: "latest", label: "latest" }];
	let entries: RemoteListEntry[] = [];
	try {
		entries = await backend.list("snapshots");
	} catch {
		return out;
	}
	for (const entry of entries) {
		const name = entry.path.split(/[\\/]/).pop() || entry.path;
		if (!name.endsWith(".json")) continue;
		const id = name.slice(0, -5);
		out.push({ id, label: `${id}${entry.lastModified ? ` · ${entry.lastModified}` : ""}` });
	}
	return uniqueById(out).sort((a, b) => (a.id === "latest" ? -1 : b.id === "latest" ? 1 : b.id.localeCompare(a.id)));
}

function snapshotPaths(id: string): { id: string; jsonPath: string; zipPath: string } {
	if (id === "latest") return { id, jsonPath: "latest.json", zipPath: "latest.zip" };
	const safe = id.replace(/\.json$|\.zip$/g, "");
	return { id: safe, jsonPath: `snapshots/${safe}.json`, zipPath: `snapshots/${safe}.zip` };
}

function pushSummary(latest: LatestIndex, zipBytes: number) {
	return {
		fileCount: latest.fileCount,
		externalResourceCount: latest.externalResourceCount,
		packageCount: latest.packageSpecs.length,
		contentSha256: latest.contentSha256,
		zipBytes,
	};
}

function formatPush(title: string, result: ReturnType<typeof pushSummary>): string {
	return [
		title,
		`files: ${result.fileCount}`,
		`external: ${result.externalResourceCount}`,
		`packages: ${result.packageCount}`,
		`hash: ${shortHash(result.contentSha256)}`,
	].join("\n");
}

function formatPull(
	title: string,
	snapshot: string,
	latest: LatestIndex,
	diff: Awaited<ReturnType<typeof diffArchiveAgainstLocal>>,
	packages: string[],
): string {
	return [
		title,
		`snapshot: ${snapshot}`,
		`files: ${latest.fileCount}`,
		`external: ${latest.externalResourceCount}`,
		`changes: +${diff.add.length}/~${diff.modify.length}/-${diff.remove.length}`,
		`externalChanges: +${diff.externalAdd.length}/~${diff.externalModify.length}/-${diff.externalRemove.length}`,
		`packages: ${packages.length}`,
		`hash: ${shortHash(latest.contentSha256)}`,
	].join("\n");
}

async function requireConfig(agentDir: string): Promise<WebdavSyncConfig> {
	const config = await readConfig(agentDir);
	if (!config) throw new Error(`WebDAV config not found. Create ${configPath(agentDir)}`);
	if (!config.remoteBaseUrl) throw new Error("config.remoteBaseUrl is required");
	return config;
}

function validateLatestMatchesManifest(latest: LatestIndex, archive: ParsedArchive): void {
	const expected = createLatestIndex(archive.manifest, new Uint8Array());
	const mismatches: string[] = [];
	if (latest.contentSha256 !== expected.contentSha256) mismatches.push("contentSha256");
	if (latest.fileCount !== expected.fileCount) mismatches.push("fileCount");
	if (latest.externalResourceCount !== expected.externalResourceCount) mismatches.push("externalResourceCount");
	if (JSON.stringify(latest.packageSpecs) !== JSON.stringify(expected.packageSpecs)) mismatches.push("packageSpecs");
	if (mismatches.length) throw new Error(`latest.json does not match archive manifest: ${mismatches.join(", ")}`);
}

async function settingsJsonFromArchive(archive: ParsedArchive): Promise<unknown> {
	const bytes = archive.entries.get("files/settings.json");
	if (!bytes) return undefined;
	return JSON.parse(bytes.toString("utf8"));
}

async function installPackages(specs: string[]): Promise<Array<{ spec: string; ok: boolean; code: number | null }>> {
	const results = [];
	for (const spec of specs) {
		const code = await runPiInstall(spec);
		results.push({ spec, ok: code === 0, code });
	}
	return results;
}

function runPiInstall(spec: string): Promise<number | null> {
	return new Promise((resolve) => {
		const child = spawn("pi", ["install", spec], { stdio: "ignore", shell: process.platform === "win32" });
		child.on("error", () => resolve(-1));
		child.on("close", (code) => resolve(code));
	});
}

function valueFlag(flags: Flags, name: string): string | undefined {
	for (const flag of flags) {
		if (flag.startsWith(`${name}=`)) return flag.slice(name.length + 1);
	}
	return undefined;
}

function normalizeCommand(raw: string): "push" | "pull" | "help" {
	const value = raw.replace(/^webdav-sync:/, "").replace(/^:/, "");
	if (value === "push") return "push";
	if (value === "pull") return "pull";
	return "help";
}

function uniqueById(items: SnapshotChoice[]): SnapshotChoice[] {
	const seen = new Set<string>();
	return items.filter((item) => {
		if (seen.has(item.id)) return false;
		seen.add(item.id);
		return true;
	});
}

function snapshotIdFromDate(date: Date): string {
	return date.toISOString().replace(/[:.]/g, "-");
}

function ok(text: string, data?: unknown): CommandResult {
	return { ok: true, text, data };
}

function fail(text: string): CommandResult {
	return { ok: false, text };
}

function helpText(): string {
	return [
		"/webdav-sync:push --dry-run",
		"/webdav-sync:push --yes",
		"/webdav-sync:pull --dry-run",
		"/webdav-sync:pull --yes [--install-missing] [--snapshot=<id>]",
	].join("\n");
}

function splitArgs(input: string): string[] {
	return input.trim().split(/\s+/).filter(Boolean);
}

function extractInput(args: unknown[]): string[] {
	for (const arg of args) {
		if (Array.isArray(arg) && arg.every((item) => typeof item === "string")) return arg;
		if (typeof arg === "string") return splitArgs(arg);
		if (arg && typeof arg === "object") {
			const record = arg as Record<string, unknown>;
			if (Array.isArray(record.args) && record.args.every((item) => typeof item === "string")) return record.args;
			if (typeof record.input === "string") return splitArgs(record.input);
			if (typeof record.prompt === "string") return splitArgs(record.prompt);
		}
	}
	return [];
}
