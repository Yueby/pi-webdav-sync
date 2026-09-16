import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectAgentArchive, type CollectOptions } from "./collector.js";
import { stateDir } from "./config.js";
import {
	isAllowlistedRelativePath,
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
	/** Set when the backup came from a remote profile rather than local state. */
	profile?: string;
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
	// Local safety copies keep settings.json verbatim, so restoring one also
	// brings back the local-only keys and the original external references.
	const collected = await collectAgentArchive(agentDir, pathOptions, {
		settingsMode: "raw",
	});
	const zip = createLatestZip(collected.zipEntries, collected.manifest);
	return await writeBackupRecord(
		agentDir,
		Buffer.from(zip.zipBytes),
		zip.latest,
		retention,
	);
}

/**
 * Stores a remote snapshot as a local backup, used before an irreversible remote
 * operation such as deleting a profile. The downloaded archive is the same shape
 * as a local safety copy, so /webdav-sync:restore can bring it back.
 */
export async function saveRemoteArchiveBackup(
	agentDir: string,
	zipBytes: Buffer,
	latest: unknown,
	retention = 5,
	profile?: string,
): Promise<BackupRecord> {
	return await writeBackupRecord(agentDir, zipBytes, latest, retention, profile);
}

async function writeBackupRecord(
	agentDir: string,
	zipBytes: Buffer,
	latest: unknown,
	retention: number,
	profile?: string,
): Promise<BackupRecord> {
	const id = timestampId();
	const dir = path.join(backupsDir(agentDir), id);
	await fs.mkdir(dir, { recursive: true });
	const zipPath = path.join(dir, "backup.zip");
	const jsonPath = path.join(dir, "backup.json");
	await fs.writeFile(zipPath, zipBytes);
	const index =
		profile && latest && typeof latest === "object"
			? { ...(latest as Record<string, unknown>), profile }
			: latest;
	await fs.writeFile(jsonPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
	await pruneBackups(agentDir, retention);
	const createdAt =
		latest && typeof latest === "object" && "createdAt" in latest
			? String((latest as { createdAt?: unknown }).createdAt)
			: id;
	return { id, dir, zipPath, jsonPath, createdAt, profile };
}

async function listBackups(agentDir: string): Promise<BackupRecord[]> {
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
				profile?: string;
			};
			await fs.access(zipPath);
			records.push({
				id,
				dir,
				zipPath,
				jsonPath,
				createdAt: json.createdAt || id,
				profile: json.profile,
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
}type ArchiveTarget = {
	logicalPath: string;
	absolutePath: string;
	root: string;
	bytes: Buffer;
	mode?: number;
	external: boolean;
};

type RemovalPlan = {
	/** Absolute paths of collected files this apply replaces or drops. */
	files: string[];
	/** Absolute directories occupying an incoming file path. */
	dirs: string[];
	extraPaths: NormalizedSyncPaths;
};

export async function applyArchiveToAgent(
	agentDir: string,
	archive: ParsedArchive,
	pathOptions: SyncPathOptions = {},
): Promise<ApplySummary> {
	const resolvedAgentDir = path.resolve(agentDir);
	preflightArchiveTargets(resolvedAgentDir, archive, pathOptions);
	await preflightSymlinkFreeTargets(resolvedAgentDir, archive);
	const targets = archiveTargets(resolvedAgentDir, archive);
	const removals = await planRemovals(resolvedAgentDir, archive, pathOptions);
	const filesDeleted = await executeRemovals(resolvedAgentDir, removals);
	const written = await writeTargets(targets);
	return { filesDeleted, ...written };
}

/**
 * Applies an archive, and restores the given local safety backup if the apply
 * fails after it started modifying files. Both the primary apply and the rollback
 * work from plans computed before the first mutation, so a half-written
 * settings.json can never break recovery. The safety archive is loaded and
 * validated before anything is touched, and preflight failures propagate as-is.
 * Rollback is best-effort recovery, not crash-atomic: a process killed mid-apply
 * needs an explicit /webdav-sync:restore.
 */
export async function applyArchiveWithRollback(
	agentDir: string,
	archive: ParsedArchive,
	safetyBackupId: string,
	pathOptions: SyncPathOptions = {},
): Promise<ApplySummary> {
	const resolvedAgentDir = path.resolve(agentDir);
	preflightArchiveTargets(resolvedAgentDir, archive, pathOptions);
	const { archive: safety } = await loadBackup(
		resolvedAgentDir,
		safetyBackupId,
		pathOptions,
	);
	preflightArchiveTargets(resolvedAgentDir, safety, pathOptions);
	await preflightSymlinkFreeTargets(resolvedAgentDir, archive);
	await preflightSymlinkFreeTargets(resolvedAgentDir, safety);
	await preflightConfiguredPaths(resolvedAgentDir, pathOptions);

	const targets = archiveTargets(resolvedAgentDir, archive);
	const removals = await planRemovals(resolvedAgentDir, archive, pathOptions);
	const safetyTargets = archiveTargets(resolvedAgentDir, safety);
	try {
		const filesDeleted = await executeRemovals(resolvedAgentDir, removals);
		const written = await writeTargets(targets);
		return { filesDeleted, ...written };
	} catch (error) {
		const primary = errorMessage(error);
		let rollbackFailure: string | undefined;
		try {
			// Fixed plan: remove everything the failed apply could have touched that
			// the safety archive does not re-write, then write the safety bytes.
			const safetyKeys = new Set(
				safetyTargets.map((target) => restorePathKey(target.absolutePath)),
			);
			const rollbackRemovals: RemovalPlan = {
				files: [
					...new Set([
						...removals.files,
						...targets.map((target) => target.absolutePath),
					]),
				].filter((target) => !safetyKeys.has(restorePathKey(target))),
				dirs: removals.dirs.filter(
					(target) => !safetyKeys.has(restorePathKey(target)),
				),
				extraPaths: removals.extraPaths,
			};
			await executeRemovals(resolvedAgentDir, rollbackRemovals);
			await writeTargets(safetyTargets);
		} catch (rollbackError) {
			rollbackFailure = errorMessage(rollbackError);
		}
		if (!rollbackFailure)
			throw new Error(
				`apply failed and was rolled back from backup ${safetyBackupId}: ${primary}`,
			);
		throw new Error(
			`apply failed: ${primary}; rollback from backup ${safetyBackupId} also failed: ${rollbackFailure}`,
		);
	}
}

/** Absolute write targets derived from the archive alone, with no filesystem reads. */
function archiveTargets(agentDir: string, archive: ParsedArchive): ArchiveTarget[] {
	const targets: ArchiveTarget[] = [];
	for (const file of archive.manifest.files) {
		const bytes = archive.entries.get(`files/${file.path}`);
		if (!bytes) throw new Error(`Archive missing file: ${file.path}`);
		const { absolutePath, root } = resolveRestoreTarget(agentDir, file.path);
		targets.push({
			logicalPath: file.path,
			absolutePath,
			root,
			bytes,
			mode: file.mode,
			external: false,
		});
	}
	for (const resource of archive.manifest.externalResources) {
		for (const file of resource.files) {
			const bytes = archive.entries.get(file.path);
			if (!bytes)
				throw new Error(`Archive missing external file: ${file.path}`);
			const { absolutePath, root } = resolveRestoreTarget(agentDir, file.path);
			targets.push({
				logicalPath: file.path,
				absolutePath,
				root,
				bytes,
				mode: file.mode,
				external: true,
			});
		}
	}
	return targets;
}

/**
 * Computes the removal side of an apply before anything is mutated, so rollback
 * never has to re-read (possibly half-written) settings.json.
 */
async function planRemovals(
	agentDir: string,
	archive: ParsedArchive,
	pathOptions: SyncPathOptions,
): Promise<RemovalPlan> {
	const extraPaths = await preflightConfiguredPaths(agentDir, pathOptions);
	const incoming = new Set<string>();
	for (const target of archiveTargets(agentDir, archive))
		incoming.add(safeRelativePath(target.logicalPath));

	const local = await collectAgentArchive(agentDir, pathOptions);
	const files: string[] = [];
	const seen = new Set<string>();
	const addTarget = (logicalPath: string) => {
		if (incoming.has(safeRelativePath(logicalPath))) return;
		const { absolutePath } = resolveRestoreTarget(agentDir, logicalPath);
		const key = restorePathKey(absolutePath);
		if (seen.has(key)) return;
		seen.add(key);
		files.push(absolutePath);
	};
	for (const file of local.manifest.files) addTarget(file.path);
	for (const resource of local.manifest.externalResources)
		for (const file of resource.files) addTarget(file.path);

	// Directories sitting where the archive writes a file are only replaceable
	// while they are empty, otherwise the write fails and rollback takes over.
	const dirs: string[] = [];
	for (const target of archiveTargets(agentDir, archive)) {
		const stat = await lstatIfExists(target.absolutePath);
		if (stat?.isDirectory()) dirs.push(target.absolutePath);
	}
	return { files, dirs, extraPaths };
}

async function executeRemovals(
	agentDir: string,
	plan: RemovalPlan,
): Promise<number> {
	let deleted = 0;
	const parents = new Set<string>();
	for (const file of plan.files) {
		if (await removeFileIfPresent(file)) {
			deleted += 1;
			parents.add(path.dirname(file));
		}
	}
	for (const dir of plan.dirs) {
		try {
			await fs.rmdir(dir);
		} catch {
			continue;
		}
		parents.add(path.dirname(dir));
	}
	await pruneEmptyDirectories(agentDir, plan.extraPaths, parents);
	return deleted;
}

async function writeTargets(targets: ArchiveTarget[]): Promise<{
	filesWritten: number;
	externalFilesWritten: number;
}> {
	let filesWritten = 0;
	let externalFilesWritten = 0;
	for (const target of targets) {
		await assertWritePathIsUsable(
			target.root,
			target.absolutePath,
			target.logicalPath,
		);
		await fs.mkdir(path.dirname(target.absolutePath), { recursive: true });
		await fs.writeFile(target.absolutePath, target.bytes);
		if (target.mode)
			await fs.chmod(target.absolutePath, target.mode & 0o777).catch(
				() => undefined,
			);
		if (target.external) externalFilesWritten += 1;
		else filesWritten += 1;
	}
	return { filesWritten, externalFilesWritten };
}

/**
 * Raw local backups keep settings.json verbatim and still collect the external
 * resources it references; remote snapshots store the rewritten copy. The mode is
 * declared by the archive itself, and archives written before the field existed
 * are treated as rewritten.
 */
export function archiveSettingsMode(
	archive: ParsedArchive,
): "rewrite" | "raw" {
	return archive.manifest.settingsMode === "raw" ? "raw" : "rewrite";
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
	options: CollectOptions = {},
): Promise<ArchiveDiff> {
	const local = await collectAgentArchive(agentDir, pathOptions, options);
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

function backupsDir(agentDir: string): string {
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

async function preflightConfiguredPaths(
	agentDir: string,
	pathOptions: SyncPathOptions = {},
): Promise<NormalizedSyncPaths> {
	const extraPaths = normalizeSyncPaths(pathOptions);
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
	return extraPaths;
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

async function removeFileIfPresent(absolutePath: string): Promise<boolean> {
	const stat = await lstatIfExists(absolutePath);
	if (!stat || !stat.isFile()) return false;
	await fs.rm(absolutePath, { force: true });
	return true;
}

/** Removes empty directories left behind, bounded by the roots sync manages. */
async function pruneEmptyDirectories(
	agentDir: string,
	extraPaths: NormalizedSyncPaths,
	candidates: Set<string>,
): Promise<void> {
	const roots: Array<{ dir: string; inclusive: boolean }> = [
		{ dir: agentDir, inclusive: false },
		...extraPaths.extraDirs.map((dir) => ({
			dir: resolveConfiguredPath(dir, agentDir),
			inclusive: true,
		})),
		...extraPaths.extraFiles.map((file) => ({
			dir: path.dirname(resolveConfiguredPath(file, agentDir)),
			inclusive: false,
		})),
	];
	const protectedKeys = new Set([
		restorePathKey(agentDir),
		restorePathKey(os.homedir()),
	]);
	const canRemove = (directory: string): boolean => {
		const key = restorePathKey(directory);
		if (protectedKeys.has(key)) return false;
		return roots.some(
			(root) =>
				pathInside(root.dir, directory) &&
				(root.inclusive || restorePathKey(root.dir) !== key),
		);
	};
	const ordered = [...candidates].sort((a, b) => b.length - a.length);
	for (const start of ordered) {
		let current = start;
		while (canRemove(current)) {
			const stat = await lstatIfExists(current);
			if (!stat || !stat.isDirectory()) break;
			try {
				await fs.rmdir(current);
			} catch {
				break;
			}
			current = path.dirname(current);
		}
	}
}

/**
 * Refuses to write through a symlink. Collection skips symlinks, so without this
 * an archive could write outside the authorized roots through a pre-existing
 * symlink such as agentDir/AGENTS.md -> ~/.ssh/authorized_keys. Only symlinks are
 * rejected here; a non-directory ancestor may still be a managed file that this
 * same apply deletes before writing.
 */
async function assertPathHasNoSymlink(
	root: string,
	absolutePath: string,
	logicalPath: string,
): Promise<void> {
	const resolvedRoot = path.resolve(root);
	const resolvedTarget = path.resolve(absolutePath);
	if (!pathInside(resolvedRoot, resolvedTarget))
		throw new Error(`Unsafe restore path: ${logicalPath}`);
	const parts = path
		.relative(resolvedRoot, resolvedTarget)
		.split(path.sep)
		.filter(Boolean);
	let current = resolvedRoot;
	for (const part of parts) {
		current = path.join(current, part);
		const stat = await lstatIfExists(current);
		if (!stat) return;
		if (stat.isSymbolicLink())
			throw new Error(
				`Refusing to write through a symlink (${logicalPath}): ${current}`,
			);
		// Nothing below a non-directory can be a symlink; the write-time check
		// reports the ancestor itself when it is still unusable after removals.
		if (!stat.isDirectory()) return;
	}
}

/** Adds the write-time check that every existing ancestor is a directory. */
async function assertWritePathIsUsable(
	root: string,
	absolutePath: string,
	logicalPath: string,
): Promise<void> {
	await assertPathHasNoSymlink(root, absolutePath, logicalPath);
	const resolvedRoot = path.resolve(root);
	const parts = path
		.relative(resolvedRoot, path.resolve(absolutePath))
		.split(path.sep)
		.filter(Boolean);
	let current = resolvedRoot;
	for (const part of parts.slice(0, -1)) {
		current = path.join(current, part);
		const stat = await lstatIfExists(current);
		if (!stat) return;
		if (!stat.isDirectory())
			throw new Error(
				`Restore path has a non-directory parent (${logicalPath}): ${current}`,
			);
	}
}

async function preflightSymlinkFreeTargets(
	agentDir: string,
	archive: ParsedArchive,
): Promise<void> {
	for (const file of archive.manifest.files) {
		const target = resolveRestoreTarget(agentDir, file.path);
		await assertPathHasNoSymlink(target.root, target.absolutePath, file.path);
	}
	for (const resource of archive.manifest.externalResources) {
		for (const file of resource.files) {
			const target = resolveRestoreTarget(agentDir, file.path);
			await assertPathHasNoSymlink(target.root, target.absolutePath, file.path);
		}
	}
}

function resolveRestoreTarget(
	agentDir: string,
	relativePath: string,
): { safePath: string; absolutePath: string; root: string } {
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
	return { safePath, absolutePath, root: restoreRoot };
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
		// ENOTDIR: a parent component is a regular file, so this path cannot
		// exist on POSIX (Windows reports ENOENT for the same situation).
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function timestampId(): string {
	return toPosixPath(new Date().toISOString()).replace(/[:.]/g, "-");
}
