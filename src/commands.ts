import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import {
	createLocalBackup,
	applyArchiveToAgent,
	diffArchiveAgainstLocal,
	loadBackup,
} from "./backup.js";
import { collectAgentArchive } from "./collector.js";
import {
	configPath,
	defaultConfig,
	readConfig,
	type WebdavSyncConfig,
	writeConfig,
} from "./config.js";
import { createLatestIndex, type LatestIndex, shortHash } from "./manifest.js";
import { getAgentDir } from "./paths.js";
import { missingInstallSpecs, redactPackageSpec } from "./package-specs.js";
import {
	createLatestZip,
	parseArchive,
	type ParsedArchive,
} from "./zip-store.js";
import { createWebdavBackend } from "./backends/webdav.js";
import type { SyncBackend } from "./backends/types.js";

export type CommandResult = {
	ok: boolean;
	text: string;
	data?: unknown;
};

export type CommandContext = {
	agentDir?: string;
	args?: string[];
	backend?: SyncBackend;
};

type Flags = Set<string>;

export async function runWebdavSyncCommand(
	input: string | string[] = [],
	context: CommandContext = {},
): Promise<CommandResult> {
	const args = Array.isArray(input) ? input : splitArgs(input);
	const subcommand = args[0] || "help";
	const rest = args.slice(1);
	const flags = new Set(args.filter((arg) => arg.startsWith("--")));
	const agentDir = getAgentDir(context.agentDir);

	try {
		if (subcommand === "help" || subcommand === "--help" || subcommand === "-h")
			return ok(helpText());
		if (subcommand === "init") return await commandInit(agentDir, rest, flags);
		if (subcommand === "status")
			return await commandStatus(agentDir, flags, context.backend);
		if (subcommand === "push")
			return await commandPush(agentDir, flags, context.backend);
		if (subcommand === "pull")
			return await commandPull(agentDir, flags, context.backend);
		if (subcommand === "restore")
			return await commandRestore(agentDir, rest, flags);
		return fail(
			`Unknown /webdav-sync subcommand: ${subcommand}\n\n${helpText()}`,
		);
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
}

export async function handleWebdavSyncCommand(
	...args: unknown[]
): Promise<string> {
	const input = extractInput(args);
	const result = await runWebdavSyncCommand(input);
	return result.text;
}

async function commandInit(
	agentDir: string,
	args: string[],
	flags: Flags,
): Promise<CommandResult> {
	const assignments = parseAssignments(args);
	const path = configPath(agentDir);
	if (!Object.keys(assignments).length) {
		const sample = {
			...defaultConfig(),
			remoteBaseUrl: "https://dav.example.com/pi-agent-sync/",
			username: "user",
			passwordEnv: "PI_WEBDAV_PASSWORD",
		};
		return ok(
			[
				`Config path: ${path}`,
				"Edit this file or run:",
				"/webdav-sync init url=https://dav.example.com/pi-agent-sync/ username=user passwordEnv=PI_WEBDAV_PASSWORD remoteDir=/",
				"",
				"Example config:",
				JSON.stringify(sample, null, 2),
			].join("\n"),
		);
	}
	const current = (await readConfig(agentDir)) || defaultConfig();
	const next: WebdavSyncConfig = { ...current };
	if (assignments.url) next.remoteBaseUrl = assignments.url;
	if (assignments.remoteBaseUrl) next.remoteBaseUrl = assignments.remoteBaseUrl;
	if (assignments.username) next.username = assignments.username;
	if (assignments.passwordEnv) next.passwordEnv = assignments.passwordEnv;
	if (assignments.password) next.password = assignments.password;
	if (assignments.remoteDir) next.remoteDir = assignments.remoteDir;
	if (
		assignments.installMissingPackages &&
		isInstallPolicy(assignments.installMissingPackages)
	)
		next.installMissingPackages = assignments.installMissingPackages;
	if (assignments.backupRetention)
		next.backupRetention = Number.parseInt(assignments.backupRetention, 10);
	await writeConfig(next, agentDir);
	const warnings = next.password
		? ["warning: password is stored in ~/.pi-webdav-sync/config.json; passwordEnv is safer."]
		: [];
	if (flags.has("--json"))
		return ok(JSON.stringify({ configPath: path, warnings }, null, 2), {
			configPath: path,
			warnings,
		});
	return ok([`Wrote WebDAV sync config: ${path}`, ...warnings].join("\n"));
}

async function commandStatus(
	agentDir: string,
	flags: Flags,
	backendOverride?: SyncBackend,
): Promise<CommandResult> {
	const local = await buildLocalSummary(agentDir);
	const config = await readConfig(agentDir);
	const remote = config
		? await readRemoteLatest(config, backendOverride).catch((error) => ({
				error: errorMessage(error),
			}))
		: undefined;
	const summary = {
		...local,
		configPath: configPath(agentDir),
		configured: Boolean(config),
		remote,
		comparison: compareRemote(local.contentSha256, remote),
	};
	if (flags.has("--json")) return ok(JSON.stringify(summary, null, 2), summary);
	const lines = [formatSummary("Local status", local)];
	if (!config)
		lines.push(
			`No WebDAV config found. Run /webdav-sync init or edit ${configPath(agentDir)}`,
		);
	else lines.push(formatRemote(remote));
	return ok(lines.join("\n"), summary);
}

async function commandPush(
	agentDir: string,
	flags: Flags,
	backendOverride?: SyncBackend,
): Promise<CommandResult> {
	const dryRun = flags.has("--dry-run");
	const summary = await buildLocalSummary(agentDir);
	if (dryRun) {
		if (flags.has("--json"))
			return ok(JSON.stringify(summary, null, 2), summary);
		return ok(formatSummary("Dry-run push (no upload)", summary), summary);
	}
	if (!flags.has("--yes")) return fail("push requires --yes or --dry-run");
	const config = await requireConfig(agentDir);
	const backend = backendOverride || createWebdavBackend(config);
	const collected = await collectAgentArchive(agentDir);
	const zip = createLatestZip(collected.zipEntries, collected.manifest);
	await backend.putBytes("latest.zip", zip.zipBytes);
	await backend.putJson("latest.json", zip.latest);
	const result = {
		fileCount: zip.latest.fileCount,
		externalResourceCount: zip.latest.externalResourceCount,
		contentSha256: zip.latest.contentSha256,
		zipSha256: zip.latest.zipSha256,
	};
	if (flags.has("--json")) return ok(JSON.stringify(result, null, 2), result);
	return ok(
		[
			"Uploaded latest.zip and latest.json",
			`files: ${result.fileCount}`,
			`externalResources: ${result.externalResourceCount}`,
			`contentSha256: ${shortHash(result.contentSha256)}`,
			`zipSha256: ${shortHash(result.zipSha256)}`,
		].join("\n"),
		result,
	);
}

async function commandPull(
	agentDir: string,
	flags: Flags,
	backendOverride?: SyncBackend,
): Promise<CommandResult> {
	const dryRun = flags.has("--dry-run");
	if (!dryRun && !flags.has("--yes"))
		return fail("pull requires --yes or --dry-run");
	const config = await requireConfig(agentDir);
	const backend = backendOverride || createWebdavBackend(config);
	const latest = await backend.getJson<LatestIndex>("latest.json");
	const zipBytes = await backend.getBytes("latest.zip");
	const archive = parseArchive(zipBytes, latest.zipSha256);
	validateLatestMatchesManifest(latest, archive);
	const diff = await diffArchiveAgainstLocal(agentDir, archive);
	const packages = missingInstallSpecs(await settingsJsonFromArchive(archive));
	const summary = { remote: latest, diff, packageSpecs: packages };
	if (dryRun) {
		if (flags.has("--json"))
			return ok(JSON.stringify(summary, null, 2), summary);
		return ok(
			formatPullPlan("Dry-run pull (no changes)", latest, diff, packages),
			summary,
		);
	}
	const backup = await createLocalBackup(agentDir, config.backupRetention ?? 5);
	const applied = await applyArchiveToAgent(agentDir, archive);
	const installResults =
		flags.has("--install-missing") || config.installMissingPackages === "always"
			? await installPackages(packages)
			: [];
	const result = { backup, applied, packageSpecs: packages, installResults };
	const lines = [
		"Pulled and applied latest WebDAV archive",
		`backup: ${backup.id}`,
		`filesWritten: ${applied.filesWritten}`,
		`externalFilesWritten: ${applied.externalFilesWritten}`,
		`contentSha256: ${shortHash(archive.manifest.contentSha256)}`,
	];
	if (packages.length && !installResults.length)
		lines.push(
			`Missing packages not installed. Run: ${packages.map((spec) => `pi install ${redactPackageSpec(spec)}`).join(" && ")}`,
		);
	for (const item of installResults)
		lines.push(
			`pi install ${redactPackageSpec(item.spec)}: ${item.ok ? "ok" : `failed (${item.code ?? "unknown"})`}`,
		);
	return ok(lines.join("\n"), result);
}

async function commandRestore(
	agentDir: string,
	args: string[],
	flags: Flags,
): Promise<CommandResult> {
	const id = args.find((arg) => !arg.startsWith("--")) || "latest";
	const dryRun = flags.has("--dry-run");
	if (!dryRun && !flags.has("--yes"))
		return fail("restore requires --yes or --dry-run");
	const { record, archive } = await loadBackup(agentDir, id);
	const diff = await diffArchiveAgainstLocal(agentDir, archive);
	if (dryRun)
		return ok(
			formatPullPlan(
				`Dry-run restore ${record.id} (no changes)`,
				createLatestIndex(archive.manifest, await fs.readFile(record.zipPath)),
				diff,
				[],
			),
			{ backup: record, diff },
		);
	const applied = await applyArchiveToAgent(agentDir, archive);
	return ok(
		[
			`Restored backup: ${record.id}`,
			`filesWritten: ${applied.filesWritten}`,
			`externalFilesWritten: ${applied.externalFilesWritten}`,
		].join("\n"),
		{ backup: record, applied },
	);
}

async function buildLocalSummary(agentDirInput?: string) {
	const agentDir = getAgentDir(agentDirInput);
	const collected = await collectAgentArchive(agentDir);
	const zip = createLatestZip(collected.zipEntries, collected.manifest);
	return {
		agentDir,
		fileCount: collected.manifest.files.length,
		externalResourceCount: collected.manifest.externalResources.length,
		warningCount: collected.warnings.length,
		contentSha256: collected.manifest.contentSha256,
		contentHash: shortHash(collected.manifest.contentSha256),
		zipSha256: zip.latest.zipSha256,
		zipHash: shortHash(zip.latest.zipSha256),
		zipBytes: zip.zipBytes.byteLength,
		packageSpecs: collected.manifest.packageSpecs,
		files: collected.manifest.files.map((file) => ({
			path: file.path,
			size: file.size,
			sha256: shortHash(file.sha256),
		})),
		externalResources: collected.manifest.externalResources.map((resource) => ({
			id: resource.id,
			baseName: resource.baseName,
			fileCount: resource.files.length,
		})),
		warnings: collected.warnings,
	};
}

function formatSummary(
	title: string,
	summary: Awaited<ReturnType<typeof buildLocalSummary>>,
): string {
	const lines = [
		title,
		`agentDir: ${summary.agentDir}`,
		`files: ${summary.fileCount}`,
		`externalResources: ${summary.externalResourceCount}`,
		`zipBytes: ${summary.zipBytes}`,
		`contentSha256: ${summary.contentHash}`,
		`zipSha256: ${summary.zipHash}`,
	];
	if (summary.packageSpecs.length)
		lines.push(
			`packageSpecs: ${summary.packageSpecs.map(redactPackageSpec).join(", ")}`,
		);
	if (summary.warnings.length)
		lines.push(
			`warnings:\n${summary.warnings.map((warning) => `- ${warning}`).join("\n")}`,
		);
	return lines.join("\n");
}

function formatPullPlan(
	title: string,
	latest: LatestIndex,
	diff: Awaited<ReturnType<typeof diffArchiveAgainstLocal>>,
	packages: string[],
): string {
	const lines = [
		title,
		`remoteCreatedAt: ${latest.createdAt}`,
		`files: ${latest.fileCount}`,
		`externalResources: ${latest.externalResourceCount}`,
		`contentSha256: ${shortHash(latest.contentSha256)}`,
		`add: ${diff.add.length}`,
		`modify: ${diff.modify.length}`,
		`remove: ${diff.remove.length}`,
		`externalAdd: ${diff.externalAdd.length}`,
		`externalModify: ${diff.externalModify.length}`,
		`externalRemove: ${diff.externalRemove.length}`,
	];
	if (packages.length)
		lines.push(`packageSpecs: ${packages.map(redactPackageSpec).join(", ")}`);
	return lines.join("\n");
}

async function readRemoteLatest(
	config: WebdavSyncConfig,
	backendOverride?: SyncBackend,
): Promise<LatestIndex | { empty: true }> {
	const backend = backendOverride || createWebdavBackend(config);
	if (!(await backend.exists("latest.json"))) return { empty: true };
	return backend.getJson<LatestIndex>("latest.json");
}

function formatRemote(remote: unknown): string {
	if (!remote) return "remote: not checked";
	if (typeof remote === "object" && "error" in remote)
		return `remote error: ${(remote as { error: string }).error}`;
	if (typeof remote === "object" && "empty" in remote) return "remote: empty";
	const latest = remote as LatestIndex;
	return [
		`remoteCreatedAt: ${latest.createdAt}`,
		`remoteFiles: ${latest.fileCount}`,
		`remoteExternalResources: ${latest.externalResourceCount}`,
		`remoteContentSha256: ${shortHash(latest.contentSha256)}`,
		`remoteZipSha256: ${shortHash(latest.zipSha256)}`,
	].join("\n");
}

function compareRemote(localHash: string, remote: unknown): string {
	if (!remote || typeof remote !== "object" || !("contentSha256" in remote))
		return "unknown";
	return (remote as LatestIndex).contentSha256 === localHash
		? "same"
		: "different";
}

async function requireConfig(agentDir: string): Promise<WebdavSyncConfig> {
	const config = await readConfig(agentDir);
	if (!config)
		throw new Error(
			`WebDAV config not found. Run /webdav-sync init or edit ${configPath(agentDir)}`,
		);
	if (!config.remoteBaseUrl)
		throw new Error("config.remoteBaseUrl is required");
	return config;
}

function validateLatestMatchesManifest(
	latest: LatestIndex,
	archive: ParsedArchive,
): void {
	const expected = createLatestIndex(archive.manifest, new Uint8Array());
	const mismatches: string[] = [];
	if (latest.contentSha256 !== expected.contentSha256)
		mismatches.push("contentSha256");
	if (latest.fileCount !== expected.fileCount) mismatches.push("fileCount");
	if (latest.externalResourceCount !== expected.externalResourceCount)
		mismatches.push("externalResourceCount");
	if (
		JSON.stringify(latest.packageSpecs) !==
		JSON.stringify(expected.packageSpecs)
	)
		mismatches.push("packageSpecs");
	if (mismatches.length)
		throw new Error(
			`latest.json does not match archive manifest: ${mismatches.join(", ")}`,
		);
}

async function settingsJsonFromArchive(
	archive: ParsedArchive,
): Promise<unknown> {
	const bytes = archive.entries.get("files/settings.json");
	if (!bytes) return undefined;
	return JSON.parse(bytes.toString("utf8"));
}

async function installPackages(
	specs: string[],
): Promise<Array<{ spec: string; ok: boolean; code: number | null }>> {
	const results = [];
	for (const spec of specs) {
		const code = await runPiInstall(spec);
		results.push({ spec, ok: code === 0, code });
	}
	return results;
}

function runPiInstall(spec: string): Promise<number | null> {
	return new Promise((resolve) => {
		const child = spawn("pi", ["install", spec], {
			stdio: "ignore",
			shell: process.platform === "win32",
		});
		child.on("error", () => resolve(-1));
		child.on("close", (code) => resolve(code));
	});
}

function parseAssignments(args: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const arg of args) {
		if (arg.startsWith("--")) continue;
		const index = arg.indexOf("=");
		if (index <= 0) continue;
		out[arg.slice(0, index)] = arg.slice(index + 1);
	}
	return out;
}

function isInstallPolicy(value: string): value is "ask" | "always" | "never" {
	return value === "ask" || value === "always" || value === "never";
}

function ok(text: string, data?: unknown): CommandResult {
	return { ok: true, text, data };
}

function fail(text: string): CommandResult {
	return { ok: false, text };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function helpText(): string {
	return [
		"Usage: /webdav-sync <command>",
		"",
		"Commands:",
		"  init [key=value...]                 Show or write WebDAV config.",
		"  status [--json]                    Compare local manifest with remote latest.json when configured.",
		"  push --yes|--dry-run [--json]      Build latest.zip/latest.json and upload unless dry-run.",
		"  pull --yes [--install-missing]     Download, verify, backup, and apply remote archive.",
		"       [--dry-run]",
		"  restore latest|<id> --yes|--dry-run Restore from local backup only.",
	].join("\n");
}

function splitArgs(input: string): string[] {
	return input.trim().split(/\s+/).filter(Boolean);
}

function extractInput(args: unknown[]): string[] {
	for (const arg of args) {
		if (Array.isArray(arg) && arg.every((item) => typeof item === "string"))
			return arg;
		if (typeof arg === "string") return splitArgs(arg);
		if (arg && typeof arg === "object") {
			const record = arg as Record<string, unknown>;
			if (
				Array.isArray(record.args) &&
				record.args.every((item) => typeof item === "string")
			)
				return record.args;
			if (typeof record.input === "string") return splitArgs(record.input);
			if (typeof record.prompt === "string") return splitArgs(record.prompt);
		}
	}
	return [];
}
