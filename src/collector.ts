import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	ALLOWLIST_DIRS,
	ALLOWLIST_FILES,
	isExcludedRelativePath,
	normalizeConfiguredPath,
	normalizeSyncPaths,
	pathHasSymlinkAncestor,
	pathInside,
	relativeToAgent,
	resolveConfiguredPath,
	safeRelativePath,
	toPosixPath,
	type SyncPathOptions,
} from "./paths.js";
import {
	createManifest,
	type ExternalResourceEntry,
	type ManifestFileEntry,
	sha256Bytes,
	sha256String,
	type SyncManifest,
} from "./manifest.js";
import { rewriteSettingsFile } from "./settings-rewriter.js";

export type CollectedArchive = {
	agentDir: string;
	zipEntries: Map<string, Buffer>;
	manifest: SyncManifest;
	warnings: string[];
};

type MutableExternalResource = {
	id: string;
	originalPathHash: string;
	baseName: string;
	files: ManifestFileEntry[];
};

type CollectState = {
	agentDir: string;
	zipEntries: Map<string, Buffer>;
	manifestFiles: ManifestFileEntry[];
	externalResources: MutableExternalResource[];
	packageSpecs: string[];
	warnings: string[];
	includedAbsolutePaths: Map<string, string>;
};

export async function collectAgentArchive(
	agentDir: string,
	pathOptions: SyncPathOptions = {},
): Promise<CollectedArchive> {
	const resolvedAgentDir = path.resolve(agentDir);
	const state: CollectState = {
		agentDir: resolvedAgentDir,
		zipEntries: new Map(),
		manifestFiles: [],
		externalResources: [],
		packageSpecs: [],
		warnings: [],
		includedAbsolutePaths: new Map(),
	};

	for (const fileName of ALLOWLIST_FILES) {
		const absolutePath = path.join(resolvedAgentDir, fileName);
		if (await exists(absolutePath)) {
			if (fileName === "settings.json") {
				await addRewrittenSettings(state, absolutePath);
			} else {
				await addAllowlistFile(state, absolutePath, fileName);
			}
		}
	}

	for (const dirName of ALLOWLIST_DIRS) {
		const absolutePath = path.join(resolvedAgentDir, dirName);
		if (!(await exists(absolutePath))) continue;
		const stat = await fs.lstat(absolutePath);
		if (stat.isSymbolicLink()) {
			state.warnings.push(`Skipping symlink: ${dirName}`);
		} else if (!stat.isDirectory()) {
			state.warnings.push(`Allowlist directory is not a directory: ${dirName}`);
		} else {
			await walkAllowlistPath(state, absolutePath);
		}
	}

	const extraPaths = normalizeSyncPaths(pathOptions);
	for (const fileName of extraPaths.extraFiles) {
		await collectConfiguredPath(state, fileName, "file");
	}
	for (const dirName of extraPaths.extraDirs) {
		await collectConfiguredPath(state, dirName, "directory");
	}

	const manifest = createManifest({
		files: state.manifestFiles,
		externalResources: state.externalResources as ExternalResourceEntry[],
		packageSpecs: state.packageSpecs,
		warnings: state.warnings,
	});
	state.zipEntries.set(
		"manifest.json",
		Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
	);

	return {
		agentDir: resolvedAgentDir,
		zipEntries: new Map(
			[...state.zipEntries.entries()].sort(([a], [b]) => a.localeCompare(b)),
		),
		manifest,
		warnings: manifest.warnings,
	};
}

async function addRewrittenSettings(
	state: CollectState,
	absolutePath: string,
): Promise<void> {
	const rewrite = await rewriteSettingsFile(state.agentDir, absolutePath);
	for (const warning of rewrite.warnings) state.warnings.push(warning);
	state.packageSpecs.push(...rewrite.packageSpecs);

	const relativePath = "settings.json";
	addZipEntry(state, `files/${relativePath}`, rewrite.content);
	const resolvedAbsolutePath = absolutePathValue(absolutePath);
	state.includedAbsolutePaths.set(
		absolutePathKey(resolvedAbsolutePath),
		resolvedAbsolutePath,
	);
	state.manifestFiles.push(
		fileEntry(relativePath, rewrite.content, await modeOf(absolutePath)),
	);

	for (const reference of rewrite.externalReferences) {
		if (!(await exists(reference.sourcePath))) {
			state.warnings.push(
				`External settings path does not exist: ${reference.sourcePath}`,
			);
			continue;
		}
		const resource: MutableExternalResource = {
			id: reference.id,
			originalPathHash: sha256String(toPosixPath(reference.sourcePath)),
			baseName: externalResourceBaseName(reference),
			files: [],
		};
		await walkExternalResource(
			state,
			reference.sourcePath,
			reference.zipRoot,
			resource,
		);
		state.externalResources.push(resource);
	}
}

async function walkAllowlistPath(
	state: CollectState,
	absolutePath: string,
): Promise<void> {
	const stat = await fs.lstat(absolutePath);
	const relativePath = relativeToAgent(state.agentDir, absolutePath);
	if (stat.isSymbolicLink()) {
		state.warnings.push(`Skipping symlink: ${relativePath}`);
		return;
	}
	if (isExcludedRelativePath(relativePath, stat.isDirectory())) return;
	if (stat.isDirectory()) {
		const children = await fs.readdir(absolutePath);
		children.sort();
		for (const child of children) {
			await walkAllowlistPath(state, path.join(absolutePath, child));
		}
		return;
	}
	if (stat.isFile()) {
		await addAllowlistFile(state, absolutePath, relativePath);
	}
}

async function collectConfiguredPath(
	state: CollectState,
	configuredPath: string,
	expectedType: "file" | "directory",
): Promise<void> {
	const archivePath = normalizeConfiguredPath(configuredPath);
	const absolutePath = resolveConfiguredPath(archivePath, state.agentDir);
	const configuredRoot = archivePath.startsWith("~/") ? os.homedir() : state.agentDir;
	if (expectedType === "directory" && pathInside(absolutePath, state.agentDir)) {
		throw new Error(`Configured directory cannot contain the agent directory: ${archivePath}`);
	}
	if (await pathHasSymlinkAncestor(configuredRoot, absolutePath)) {
		state.warnings.push(`Skipping configured path through symlink: ${archivePath}`);
		return;
	}
	let stat;
	try {
		stat = await fs.lstat(absolutePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			state.warnings.push(`Configured ${expectedType} does not exist: ${archivePath}`);
			return;
		}
		throw error;
	}
	if (stat.isSymbolicLink()) {
		state.warnings.push(`Skipping configured symlink: ${archivePath}`);
		return;
	}
	if (expectedType === "file") {
		if (!stat.isFile()) {
			state.warnings.push(`Configured file is not a file: ${archivePath}`);
			return;
		}
		await addAllowlistFile(state, absolutePath, archivePath);
		return;
	}
	if (!stat.isDirectory()) {
		state.warnings.push(`Configured directory is not a directory: ${archivePath}`);
		return;
	}
	await walkConfiguredDirectory(state, absolutePath, archivePath);
}

async function walkConfiguredDirectory(
	state: CollectState,
	absolutePath: string,
	archivePath: string,
): Promise<void> {
	if (isExcludedRelativePath(archivePath, true)) return;
	const children = await fs.readdir(absolutePath);
	children.sort();
	for (const child of children) {
		const childPath = path.join(absolutePath, child);
		const childArchivePath = safeRelativePath(path.posix.join(archivePath, child));
		const stat = await fs.lstat(childPath);
		if (stat.isSymbolicLink()) {
			state.warnings.push(`Skipping configured symlink: ${childArchivePath}`);
			continue;
		}
		if (isExcludedRelativePath(childArchivePath, stat.isDirectory())) continue;
		if (stat.isDirectory()) {
			await walkConfiguredDirectory(state, childPath, childArchivePath);
		} else if (stat.isFile()) {
			await addAllowlistFile(state, childPath, childArchivePath);
		}
	}
}

async function addAllowlistFile(
	state: CollectState,
	absolutePath: string,
	relativePath: string,
): Promise<void> {
	const stat = await fs.lstat(absolutePath);
	if (stat.isSymbolicLink()) {
		state.warnings.push(`Skipping symlink: ${relativePath}`);
		return;
	}
	if (!stat.isFile() || isExcludedRelativePath(relativePath, false)) return;
	const safeRel = safeRelativePath(relativePath);
	const resolvedAbsolutePath = absolutePathValue(absolutePath);
	const absoluteKey = absolutePathKey(resolvedAbsolutePath);
	const existingPath = state.includedAbsolutePaths.get(absoluteKey);
	if (existingPath) {
		if (existingPath !== resolvedAbsolutePath) {
			throw new Error(
				`Collected paths may collide on this filesystem: ${existingPath}, ${resolvedAbsolutePath}`,
			);
		}
		return;
	}
	if (state.zipEntries.has(`files/${safeRel}`)) return;
	const bytes = await fs.readFile(absolutePath);
	addZipEntry(state, `files/${safeRel}`, bytes);
	state.includedAbsolutePaths.set(absoluteKey, resolvedAbsolutePath);
	state.manifestFiles.push(fileEntry(safeRel, bytes, stat.mode));
}

async function walkExternalResource(
	state: CollectState,
	absolutePath: string,
	zipPath: string,
	resource: MutableExternalResource,
): Promise<void> {
	const stat = await fs.lstat(absolutePath);
	if (stat.isSymbolicLink()) {
		state.warnings.push(
			`Skipping symlink in external resource: ${absolutePath}`,
		);
		return;
	}
	const relativeForExclude = toPosixPath(
		path.relative(path.dirname(path.resolve(absolutePath)), absolutePath),
	);
	if (isExcludedRelativePath(relativeForExclude, stat.isDirectory())) return;
	if (stat.isDirectory()) {
		const children = await fs.readdir(absolutePath);
		children.sort();
		for (const child of children) {
			const childPath = path.join(absolutePath, child);
			const childZipPath = safeRelativePath(path.posix.join(zipPath, child));
			if (isExcludedRelativePath(child, true)) continue;
			await walkExternalResource(state, childPath, childZipPath, resource);
		}
		return;
	}
	if (stat.isFile()) {
		if (isExcludedRelativePath(path.basename(absolutePath), false)) return;
		const bytes = await fs.readFile(absolutePath);
		addZipEntry(state, zipPath, bytes);
		resource.files.push(fileEntry(zipPath, bytes, stat.mode));
	}
}

function externalResourceBaseName(reference: {
	sourcePath: string;
	zipRoot: string;
}): string {
	const parts = safeRelativePath(reference.zipRoot).split("/");
	if (parts[0] === "external-resources" && parts.length >= 3) return parts[2];
	return path.basename(reference.sourcePath) || "resource";
}

function addZipEntry(
	state: CollectState,
	zipPath: string,
	bytes: Buffer,
): void {
	const safePath = safeRelativePath(zipPath);
	if (state.zipEntries.has(safePath)) {
		throw new Error(`Duplicate zip entry: ${safePath}`);
	}
	state.zipEntries.set(safePath, bytes);
}

function fileEntry(
	relativePath: string,
	bytes: Buffer,
	mode?: number,
): ManifestFileEntry {
	return {
		path: safeRelativePath(relativePath),
		type: "file",
		size: bytes.byteLength,
		sha256: sha256Bytes(bytes),
		mode,
	};
}

async function exists(absolutePath: string): Promise<boolean> {
	try {
		await fs.lstat(absolutePath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function modeOf(absolutePath: string): Promise<number | undefined> {
	try {
		return (await fs.stat(absolutePath)).mode;
	} catch {
		return undefined;
	}
}

function absolutePathValue(value: string): string {
	return toPosixPath(path.resolve(value));
}

function absolutePathKey(value: string): string {
	const resolved = absolutePathValue(value);
	if (process.platform === "darwin") return resolved.normalize("NFD").toLowerCase();
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
