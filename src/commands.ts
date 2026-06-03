import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import {
	createLocalBackup,
	applyArchiveToAgent,
	diffArchiveAgainstLocal,
} from "./backup.js";
import { collectAgentArchive } from "./collector.js";
import {
	configDir,
	configPath,
	readConfig,
	validateConfig,
	writeConfig,
	type WebdavSyncConfig,
} from "./config.js";
import { createLatestIndex, type LatestIndex, shortHash } from "./manifest.js";
import { getAgentDir } from "./paths.js";
import { missingInstallSpecs } from "./package-specs.js";
import {
	createLatestZip,
	parseArchive,
	type ParsedArchive,
} from "./zip-store.js";
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
	confirmPush?: (preview: PushPreview) => Promise<boolean>;
	confirmOverwriteConfig?: (path: string) => Promise<boolean>;
	fetchRemoteConfig?: (url: string) => Promise<unknown>;
	confirmInstallPackages?: (specs: string[]) => Promise<boolean>;
	installPackage?: (spec: string) => Promise<number | null>;
	onInstallProgress?: (progress: InstallProgress) => void;
};

export type PushPreview = {
	fileCount: number;
	externalResourceCount: number;
	packageSpecs: string[];
	hash: string;
	warnings: string[];
};

export type InstallProgress = {
	phase: "start" | "package_start" | "package_done" | "done";
	spec?: string;
	index?: number;
	total: number;
	ok?: boolean;
	code?: number | null;
};

export type SnapshotChoice = {
	id: string;
	label: string;
};

export async function runWebdavSyncCommand(
	input: string | string[] = [],
	context: CommandContext = {},
): Promise<CommandResult> {
	const inputArgs = Array.isArray(input) ? input : splitArgs(input);
	const command = normalizeCommand(inputArgs[0]);
	const commandArgs = inputArgs.slice(1);
	const agentDir = getAgentDir(context.agentDir);
	try {
		if (command === "init")
			return await commandInit(agentDir, context, commandArgs);
		if (command === "push") return await commandPush(agentDir, context);
		if (command === "pull") return await commandPull(agentDir, context);
		return ok(helpText());
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
	context: CommandContext,
	args: string[],
): Promise<CommandResult> {
	const target = configPath(agentDir);
	const remoteUrl = args[0];
	const exists = await fileExists(target);
	if (exists) {
		const overwrite = context.confirmOverwriteConfig
			? await context.confirmOverwriteConfig(target)
			: false;
		if (!overwrite) return ok(["init: exists", `config: ${target}`].join("\n"));
	}
	if (remoteUrl) {
		await writeRemoteConfigText(
			agentDir,
			await loadRemoteInitConfigText(remoteUrl, context),
		);
	} else {
		await writeConfig(templateConfig(), agentDir);
	}
	return ok(
		[
			exists ? "init: overwritten" : "init: created",
			`config: ${target}`,
			remoteUrl ? "source: remote config" : "source: template",
			remoteUrl
				? "Review the config before push/pull."
				: "Edit this file with your WebDAV credentials before push/pull.",
		].join("\n"),
	);
}

async function commandPush(
	agentDir: string,
	context: CommandContext,
): Promise<CommandResult> {
	const collected = await collectAgentArchive(agentDir);
	const zip = createLatestZip(collected.zipEntries, collected.manifest);
	const preview: PushPreview = {
		fileCount: zip.latest.fileCount,
		externalResourceCount: zip.latest.externalResourceCount,
		packageSpecs: zip.latest.packageSpecs,
		hash: shortHash(zip.latest.contentSha256),
		warnings: collected.warnings,
	};
	if (context.confirmPush && !(await context.confirmPush(preview))) {
		return ok(
			[
				"push: cancelled",
				`files: ${preview.fileCount}`,
				`external: ${preview.externalResourceCount}`,
				`packages: ${preview.packageSpecs.length}`,
				`hash: ${preview.hash}`,
			].join("\n"),
			preview,
		);
	}
	const config = await requireConfig(agentDir);
	const backend = context.backend || createWebdavBackend(config);
	const snapshotId = snapshotIdFromDate(new Date(zip.latest.createdAt));
	const snapshotZip = `snapshots/${snapshotId}.zip`;
	const snapshotJson = `snapshots/${snapshotId}.json`;
	await backend.putBytes("latest.zip", zip.zipBytes);
	await backend.putJson("latest.json", zip.latest);
	await backend.putBytes(snapshotZip, zip.zipBytes);
	await backend.putJson(snapshotJson, {
		...zip.latest,
		snapshotId,
		zip: snapshotZip,
	});
	return ok(
		[
			"push: ok",
			`files: ${zip.latest.fileCount}`,
			`external: ${zip.latest.externalResourceCount}`,
			`packages: ${zip.latest.packageSpecs.length}`,
			`hash: ${shortHash(zip.latest.contentSha256)}`,
		].join("\n"),
		zip.latest,
	);
}

async function commandPull(
	agentDir: string,
	context: CommandContext,
): Promise<CommandResult> {
	const config = await requireConfig(agentDir);
	const backend = context.backend || createWebdavBackend(config);
	const snapshot = await chooseSnapshot(backend, context.selectSnapshot);
	const latest = await backend.getJson<LatestIndex>(snapshot.jsonPath);
	const zipBytes = await backend.getBytes(snapshot.zipPath);
	const archive = parseArchive(zipBytes, latest.zipSha256);
	validateLatestMatchesManifest(latest, archive);
	const diff = await diffArchiveAgainstLocal(agentDir, archive);
	const packages = missingInstallSpecs(await settingsJsonFromArchive(archive));
	const backup = await createLocalBackup(agentDir, config.backupRetention ?? 5);
	const applied = await applyArchiveToAgent(agentDir, archive);
	const shouldInstall = await shouldInstallPackages(
		packages,
		config,
		context.confirmInstallPackages,
	);
	const installResults = shouldInstall
		? await installPackages(
				packages,
				context.installPackage,
				context.onInstallProgress,
			)
		: [];
	const lines = [
		`pull: ${snapshot.id}`,
		`backup: ${backup.id}`,
		`files: ${applied.filesWritten}`,
		`external: ${applied.externalFilesWritten}`,
		`changes: +${diff.add.length}/~${diff.modify.length}/-${diff.remove.length}`,
		`hash: ${shortHash(archive.manifest.contentSha256)}`,
	];
	if (packages.length && !installResults.length)
		lines.push(`packages: ${packages.length} not installed`);
	if (installResults.length) {
		const failed = installResults.filter((item) => !item.ok).length;
		lines.push(
			`packages: ${installResults.length - failed} installed, ${failed} failed`,
		);
	}
	return ok(lines.join("\n"), {
		snapshot: snapshot.id,
		backup,
		applied,
		packages,
	});
}

async function chooseSnapshot(
	backend: SyncBackend,
	selectSnapshot?: (choices: SnapshotChoice[]) => Promise<string | undefined>,
): Promise<{ id: string; jsonPath: string; zipPath: string }> {
	const choices = await listSnapshots(backend);
	if (choices.length <= 1 || !selectSnapshot) return snapshotPaths("latest");
	const selected = await selectSnapshot(choices);
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
		out.push({
			id,
			label: `${id}${entry.lastModified ? ` · ${entry.lastModified}` : ""}`,
		});
	}
	return uniqueById(out).sort((a, b) =>
		a.id === "latest" ? -1 : b.id === "latest" ? 1 : b.id.localeCompare(a.id),
	);
}

function snapshotPaths(id: string): {
	id: string;
	jsonPath: string;
	zipPath: string;
} {
	if (id === "latest")
		return { id, jsonPath: "latest.json", zipPath: "latest.zip" };
	const safe = id.replace(/\.json$|\.zip$/g, "");
	return {
		id: safe,
		jsonPath: `snapshots/${safe}.json`,
		zipPath: `snapshots/${safe}.zip`,
	};
}

async function requireConfig(agentDir: string): Promise<WebdavSyncConfig> {
	const config = await readConfig(agentDir);
	if (!config)
		throw new Error(`WebDAV config not found. Create ${configPath(agentDir)}`);
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

async function shouldInstallPackages(
	specs: string[],
	config: WebdavSyncConfig,
	confirmInstallPackages?: (specs: string[]) => Promise<boolean>,
): Promise<boolean> {
	if (!specs.length) return false;
	if (config.installMissingPackages === "always") return true;
	if (config.installMissingPackages === "never") return false;
	return confirmInstallPackages ? confirmInstallPackages(specs) : false;
}

async function installPackages(
	specs: string[],
	installPackage = runPiInstall,
	onProgress?: (progress: InstallProgress) => void,
): Promise<Array<{ spec: string; ok: boolean; code: number | null }>> {
	const results = [];
	onProgress?.({ phase: "start", total: specs.length });
	for (const [index, spec] of specs.entries()) {
		onProgress?.({ phase: "package_start", spec, index, total: specs.length });
		const code = await installPackage(spec);
		const ok = code === 0;
		results.push({ spec, ok, code });
		onProgress?.({
			phase: "package_done",
			spec,
			index,
			total: specs.length,
			ok,
			code,
		});
	}
	onProgress?.({ phase: "done", total: specs.length });
	return results;
}

function templateConfig(): WebdavSyncConfig {
	return {
		backend: "webdav",
		remoteBaseUrl: "https://dav.example.com/dav/",
		username: "your-email@example.com",
		passwordEnv: "PI_WEBDAV_PASSWORD",
		remoteDir: "/pi-agent-sync",
		installMissingPackages: "ask",
		backupRetention: 5,
	};
}

async function loadRemoteInitConfigText(
	url: string,
	context: CommandContext,
): Promise<string> {
	if (!/^https?:\/\//i.test(url)) {
		throw new Error(
			"init remote config URL must start with http:// or https://",
		);
	}
	const value = context.fetchRemoteConfig
		? await context.fetchRemoteConfig(url)
		: await fetchRemoteText(url);
	return remoteConfigText(value);
}

async function fetchRemoteText(url: string): Promise<string> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to fetch remote config: HTTP ${response.status}`);
	}
	return response.text();
}

function remoteConfigText(value: unknown): string {
	if (typeof value === "string") {
		try {
			return `${JSON.stringify(validateConfig(JSON.parse(value)), null, 2)}\n`;
		} catch {
			return value.endsWith("\n") ? value : `${value}\n`;
		}
	}
	return `${JSON.stringify(validateConfig(value), null, 2)}\n`;
}

async function writeRemoteConfigText(
	agentDir: string,
	content: string,
): Promise<void> {
	await fs.mkdir(configDir(agentDir), { recursive: true });
	await fs.writeFile(configPath(agentDir), content, "utf8");
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
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

function normalizeCommand(raw?: string): "init" | "push" | "pull" | "help" {
	const value = (raw || "").replace(/^webdav-sync:/, "").replace(/^:/, "");
	if (value === "init") return "init";
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
	return ["/webdav-sync:init", "/webdav-sync:push", "/webdav-sync:pull"].join(
		"\n",
	);
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
