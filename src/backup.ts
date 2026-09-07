import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectAgentArchive } from "./collector.js";
import { stateDir } from "./config.js";
import {
	ALLOWLIST_DIRS,
	ALLOWLIST_FILES,
	isAllowlistedRelativePath,
	isExcludedRelativePath,
	normalizeSyncPaths,
	pathHasSymlinkAncestor,
	pathInside,
	resolveConfiguredPath,
	safeRelativePath,
	toPosixPath,
	validatePathForCurrentPlatform,
	type NormalizedSyncPaths,
	type SyncPathOptions,
} from "./paths.js";
import {
	createLatestZip,
	parseArchive,
	type ParsedArchive,
} from "./zip-store.js";

export type BackupRecord = {
	id: string;
	dir: string;
	zipPath: string;
	jsonPath: string;
	createdAt: string;
};

export type ApplySummary = {
	filesWritten: number;
	filesDeleted: number;
	externalFilesWritten: number;
};

export async function createLocalBackup(
	agentDir: string,
	retention = 5,
	pathOptions: SyncPathOptions = {},
): Promise<BackupRecord> {
	const collected = await collectAgentArchive(agentDir, pathOptions);
	const zip = createLatestZip(collected.zipEntries, collected.manifest);
	const id = timestampId();
	const dir = path.join(backupsDir(agentDir), id);
	await fs.mkdir(dir, { recursive: true });
	const zipPath = path.join(dir, "backup.zip");
	const jsonPath = path.join(dir, "backup.json");
	await fs.writeFile(zipPath, Buffer.from(zip.zipBytes));
	await fs.writeFile(
		jsonPath,
		`${JSON.stringify(zip.latest, null, 2)}\n`,
		"utf8",
	);
	await pruneBackups(agentDir, retention);
	return { id, dir, zipPath, jsonPath, createdAt: zip.latest.createdAt };
}

export async function listBackups(agentDir: string): Promise<BackupRecord[]> {
	const root = backupsDir(agentDir);
	let entries: string[];
	try {
		entries = await fs.readdir(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const records: BackupRecord[] = [];
	for (const id of entries.sort()) {
		const dir = path.join(root, id);
		const zipPath = path.join(dir, "backup.zip");
		const jsonPath = path.join(dir, "backup.json");
		try {
			const json = JSON.parse(await fs.readFile(jsonPath, "utf8")) as {
				createdAt?: string;
			};
			await fs.access(zipPath);
			records.push({
				id,
				dir,
				zipPath,
				jsonPath,
				createdAt: json.createdAt || id,
			});
		} catch {
			// Ignore incomplete backup directories.
		}
	}
	return records.sort((a, b) => a.id.localeCompare(b.id));
}

export async function loadBackup(
	agentDir: string,
	idOrLatest: string,
	pathOptions: SyncPathOptions = {},
): Promise<{ record: BackupRecord; archive: ParsedArchive }> {
	const backups = await listBackups(agentDir);
	if (!backups.length) throw new Error("No local backups found");
	const record =
		idOrLatest === "latest"
			? backups[backups.length - 1]
			: backups.find((backup) => backup.id === idOrLatest);
	if (!record) throw new Error(`Backup not found: ${idOrLatest}`);
	const latest = JSON.parse(await fs.readFile(record.jsonPath, "utf8")) as {
		zipSha256?: string;
	};
	const zipBytes = await fs.readFile(record.zipPath);
	return {
		record,
		archive: parseArchive(zipBytes, latest.zipSha256, pathOptions),
	};
}

export async function applyArchiveToAgent(
	agentDir: string,
	archive: ParsedArchive,
	pathOptions: SyncPathOptions = {},
): Promise<ApplySummary> {
	const resolvedAgentDir = path.resolve(agentDir);
	preflightArchiveTargets(resolvedAgentDir, archive, pathOptions);
	await clearAllowlistedTargets(resolvedAgentDir, pathOptions);
	let filesWritten = 0;
	let externalFilesWritten = 0;
	for (const file of archive.manifest.files) {
		const bytes = archive.entries.get(`files/${file.path}`);
		if (!bytes) throw new Error(`Archive missing file: ${file.path}`);
		await writeAgentFile(
			resolvedAgentDir,
			file.path,
			bytes,
			file.mode,
			pathOptions,
		);
		filesWritten += 1;
	}
	for (const resource of archive.manifest.externalResources) {
		for (const file of resource.files) {
			const bytes = archive.entries.get(file.path);
			if (!bytes)
				throw new Error(`Archive missing external file: ${file.path}`);
			await writeAgentFile(resolvedAgentDir, file.path, bytes, file.mode);
			externalFilesWritten += 1;
		}
	}
	return { filesWritten, filesDeleted: 0, externalFilesWritten };
}

export type ArchiveDiff = {
	add: string[];
	modify: string[];
	remove: string[];
	externalAdd: string[];
	externalModify: string[];
	externalRemove: string[];
};

export async function diffArchiveAgainstLocal(
	agentDir: string,
	archive: ParsedArchive,
	pathOptions: SyncPathOptions = {},
): Promise<ArchiveDiff> {
	const local = await collectAgentArchive(agentDir, pathOptions);
	const regular = diffHashes(
		new Map(local.manifest.files.map((file) => [file.path, file.sha256])),
		new Map(archive.manifest.files.map((file) => [file.path, file.sha256])),
	);
	const external = diffHashes(
		externalResourceHashes(local.manifest.externalResources),
		externalResourceHashes(archive.manifest.externalResources),
	);
	return {
		...regular,
		externalAdd: external.add,
		externalModify: external.modify,
		externalRemove: external.remove,
	};
}

export function backupsDir(agentDir: string): string {
	return path.join(stateDir(agentDir), "backups");
}

type ResolvedTarget = {
	logicalPath: string;
	absolutePath: string;
	expectedType: "file" | "directory";
};

function preflightArchiveTargets(
	agentDir: string,
	archive: ParsedArchive,
	pathOptions: SyncPathOptions,
): void {
	const targets: ResolvedTarget[] = [];
	for (const file of archive.manifest.files) {
		if (!isAllowlistedRelativePath(file.path, pathOptions)) {
			throw new Error(`Restore path is not allowlisted: ${file.path}`);
		}
		if (!archive.entries.has(`files/${file.path}`)) {
			throw new Error(`Archive missing file: ${file.path}`);
		}
		targets.push({
			logicalPath: file.path,
			absolutePath: resolveRestoreTarget(agentDir, file.path).absolutePath,
			expectedType: "file",
		});
	}
	for (const resource of archive.manifest.externalResources) {
		for (const file of resource.files) {
			if (!archive.entries.has(file.path)) {
				throw new Error(`Archive missing external file: ${file.path}`);
			}
			targets.push({
				logicalPath: file.path,
				absolutePath: resolveRestoreTarget(agentDir, file.path).absolutePath,
				expectedType: "file",
			});
		}
	}

	validateResolvedTargetConflicts(targets, "Restore");
}

async function preflightConfiguredTargets(
	agentDir: string,
	extraPaths: NormalizedSyncPaths,
): Promise<void> {
	const targets: ResolvedTarget[] = [
		...extraPaths.extraFiles.map((logicalPath) => ({
			logicalPath,
			absolutePath: resolveConfiguredPath(logicalPath, agentDir),
			expectedType: "file" as const,
		})),
		...extraPaths.extraDirs.map((logicalPath) => ({
			logicalPath,
			absolutePath: resolveConfiguredPath(logicalPath, agentDir),
			expectedType: "directory" as const,
		})),
	];
	for (const target of targets) {
		if (
			target.expectedType === "directory"
			&& pathInside(target.absolutePath, agentDir)
		) {
			throw new Error(
				`Configured directory cannot contain the agent directory: ${target.logicalPath}`,
			);
		}
	}
	validateResolvedTargetConflicts(targets, "Configured");
	for (const target of targets) {
		const configuredRoot = target.logicalPath.startsWith("~/")
			? os.homedir()
			: agentDir;
		if (await pathHasSymlinkAncestor(configuredRoot, target.absolutePath)) {
			throw new Error(`Configured path traverses a symlink: ${target.logicalPath}`);
		}
		const stat = await lstatIfExists(target.absolutePath);
		if (!stat) continue;
		if (stat.isSymbolicLink()) {
			throw new Error(`Configured path is a symlink: ${target.logicalPath}`);
		}
		if (target.expectedType === "file" && !stat.isFile()) {
			throw new Error(`Configured file is not a file: ${target.logicalPath}`);
		}
		if (target.expectedType === "directory" && !stat.isDirectory()) {
			throw new Error(`Configured directory is not a directory: ${target.logicalPath}`);
		}
	}
}

function validateResolvedTargetConflicts(
	targets: ResolvedTarget[],
	label: "Restore" | "Configured",
): void {
	const targetsByPath = new Map<string, ResolvedTarget>();
	for (const target of targets) {
		const key = restorePathKey(target.absolutePath);
		const existing = targetsByPath.get(key);
		if (existing) {
			throw new Error(
				`${label} paths resolve to the same target: ${existing.logicalPath}, ${target.logicalPath}`,
			);
		}
		targetsByPath.set(key, target);
	}
	for (const target of targets) {
		let parent = path.dirname(target.absolutePath);
		while (parent !== path.dirname(parent)) {
			const parentEntry = targetsByPath.get(restorePathKey(parent));
			if (parentEntry?.expectedType === "file") {
				throw new Error(
					`${label} file conflicts with descendant path: ${parentEntry.logicalPath}, ${target.logicalPath}`,
				);
			}
			parent = path.dirname(parent);
		}
	}
}

async function clearAllowlistedTargets(
	agentDir: string,
	pathOptions: SyncPathOptions,
): Promise<void> {
	const extraPaths = normalizeSyncPaths(pathOptions);
	await preflightConfiguredTargets(agentDir, extraPaths);

	for (const file of ALLOWLIST_FILES)
		await fs.rm(path.join(agentDir, file), { force: true });
	for (const dir of ALLOWLIST_DIRS)
		await fs.rm(path.join(agentDir, dir), { recursive: true, force: true });
	await fs.rm(path.join(agentDir, "external-resources"), {
		recursive: true,
		force: true,
	});
	for (const file of extraPaths.extraFiles) {
		if (isExcludedRelativePath(file, false)) continue;
		await fs.rm(resolveConfiguredPath(file, agentDir), { force: true });
	}
	for (const dir of extraPaths.extraDirs) {
		if (isExcludedRelativePath(dir, true)) continue;
		await fs.rm(resolveConfiguredPath(dir, agentDir), {
			recursive: true,
			force: true,
		});
	}
}

async function writeAgentFile(
	agentDir: string,
	relativePath: string,
	bytes: Buffer,
	mode?: number,
	pathOptions: SyncPathOptions = {},
): Promise<void> {
	const safeRel = safeRelativePath(relativePath);
	if (!isAllowlistedRelativePath(safeRel, pathOptions) && !isExternalResourcePath(safeRel))
		throw new Error(`Restore path is not allowlisted: ${relativePath}`);
	const { absolutePath } = resolveRestoreTarget(agentDir, safeRel);
	await fs.mkdir(path.dirname(absolutePath), { recursive: true });
	await fs.writeFile(absolutePath, bytes);
	if (mode) await fs.chmod(absolutePath, mode & 0o777).catch(() => undefined);
}

function resolveRestoreTarget(
	agentDir: string,
	relativePath: string,
): { safePath: string; absolutePath: string } {
	const safePath = safeRelativePath(relativePath);
	validatePathForCurrentPlatform(safePath);
	const externalResource = isExternalResourcePath(safePath);
	const absolutePath = externalResource
		? path.resolve(agentDir, safePath)
		: resolveConfiguredPath(safePath, agentDir);
	const restoreRoot = safePath.startsWith("~/") ? os.homedir() : agentDir;
	if (!pathInside(restoreRoot, absolutePath)) {
		throw new Error(`Unsafe restore path: ${relativePath}`);
	}
	return { safePath, absolutePath };
}

function restorePathKey(value: string): string {
	const resolved = path.resolve(value);
	if (process.platform === "darwin") return resolved.normalize("NFD").toLowerCase();
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function lstatIfExists(absolutePath: string) {
	try {
		return await fs.lstat(absolutePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function diffHashes(
	localHashes: Map<string, string>,
	remoteHashes: Map<string, string>,
): { add: string[]; modify: string[]; remove: string[] } {
	const add: string[] = [];
	const modify: string[] = [];
	const remove: string[] = [];
	for (const [remotePath, remoteHash] of remoteHashes) {
		const localHash = localHashes.get(remotePath);
		if (!localHash) add.push(remotePath);
		else if (localHash !== remoteHash) modify.push(remotePath);
	}
	for (const localPath of localHashes.keys()) {
		if (!remoteHashes.has(localPath)) remove.push(localPath);
	}
	return { add: add.sort(), modify: modify.sort(), remove: remove.sort() };
}

function externalResourceHashes(
	resources: ParsedArchive["manifest"]["externalResources"],
): Map<string, string> {
	const hashes = new Map<string, string>();
	for (const resource of resources) {
		for (const file of resource.files) hashes.set(file.path, file.sha256);
	}
	return hashes;
}

function isExternalResourcePath(relativePath: string): boolean {
	return relativePath.startsWith("external-resources/");
}

async function pruneBackups(
	agentDir: string,
	retention: number,
): Promise<void> {
	if (retention <= 0) return;
	const backups = await listBackups(agentDir);
	const remove = backups.slice(0, Math.max(0, backups.length - retention));
	for (const backup of remove)
		await fs.rm(backup.dir, { recursive: true, force: true });
}

function timestampId(): string {
	return toPosixPath(new Date().toISOString()).replace(/[:.]/g, "-");
}
