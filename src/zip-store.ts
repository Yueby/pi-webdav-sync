import { unzipSync, zipSync } from "fflate";
import {
	isAllowlistedRelativePath,
	isExcludedRelativePath,
	isSafeZipPath,
	safeRelativePath,
	type SyncPathOptions,
} from "./paths.js";
import {
	createLatestIndex,
	type LatestIndex,
	sha256Bytes,
	type SyncManifest,
} from "./manifest.js";

export type ZipBuildResult = {
	zipBytes: Uint8Array;
	latest: LatestIndex;
};

export type ParsedArchive = {
	entries: Map<string, Buffer>;
	manifest: SyncManifest;
};

export type ArchiveLimits = {
	maxEntries: number;
	maxFileBytes: number;
	maxTotalBytes: number;
	maxCompressedBytes: number;
};

/**
 * Bounds for reading and writing sync archives: entry count, per-file and total
 * declared sizes, and compressed input size. The declared-size checks reject
 * oversized archives before inflation (the installed fflate truncates output to
 * the declared size, so a forged smaller declaration fails the later hash check
 * instead of inflating further), and the compressed-size cap bounds the input
 * itself. ZIP64 and other malformed header shapes are not specifically handled;
 * anything failing these checks or the manifest hashes is rejected outright.
 */
export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
	maxEntries: 20_000,
	maxFileBytes: 64 * 1024 * 1024,
	maxTotalBytes: 256 * 1024 * 1024,
	maxCompressedBytes: 32 * 1024 * 1024,
};

export function createLatestZip(
	entries: Map<string, Uint8Array>,
	manifest: SyncManifest,
	limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): ZipBuildResult {
	const zipInput: Record<string, Uint8Array> = {};
	const seen = new Set<string>();
	let totalBytes = 0;
	for (const [entryPath, bytes] of entries) {
		const safePath = validateZipEntryPath(entryPath);
		if (seen.has(safePath)) throw new Error(`Duplicate zip entry: ${safePath}`);
		seen.add(safePath);
		zipInput[safePath] = bytes;
		totalBytes += bytes.byteLength;
		if (bytes.byteLength > limits.maxFileBytes)
			throw new Error(
				`Archive entry is too large: ${safePath} (limit ${limits.maxFileBytes} bytes)`,
			);
	}
	if (!seen.has("manifest.json")) {
		throw new Error("Zip is missing manifest.json");
	}
	assertWithinLimits(seen.size, totalBytes, limits);
	const zipBytes = zipSync(zipInput, {
		level: 6,
		mtime: new Date("1980-01-01T00:00:00Z"),
	});
	if (zipBytes.byteLength > limits.maxCompressedBytes)
		throw new Error(
			`Archive exceeds the compressed size limit (${limits.maxCompressedBytes} bytes); remove large files from the sync set`,
		);
	return { zipBytes, latest: createLatestIndex(manifest, zipBytes) };
}

function assertWithinLimits(
	entryCount: number,
	totalBytes: number,
	limits: ArchiveLimits,
): void {
	if (entryCount > limits.maxEntries)
		throw new Error(`Archive has too many entries (limit ${limits.maxEntries})`);
	if (totalBytes > limits.maxTotalBytes)
		throw new Error(
			`Archive exceeds the uncompressed size limit (${limits.maxTotalBytes} bytes); remove large files from the sync set`,
		);
}

export function listZipEntries(zipBytes: Uint8Array): string[] {
	const unzipped = unzipSync(zipBytes);
	return Object.keys(unzipped).map(validateZipEntryPath).sort();
}

export function parseArchive(
	zipBytes: Uint8Array,
	expectedZipSha256?: string,
	pathOptions: SyncPathOptions = {},
	limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): ParsedArchive {
	if (expectedZipSha256 && sha256Bytes(zipBytes) !== expectedZipSha256) {
		throw new Error("Downloaded zipSha256 does not match latest.json");
	}
	if (zipBytes.byteLength > limits.maxCompressedBytes) {
		throw new Error(
			`Zip exceeds the archive size limit: ${zipBytes.byteLength} bytes`,
		);
	}
	let declaredEntries = 0;
	let declaredTotal = 0;
	const seenEntries = new Set<string>();
	const unzipped = unzipSync(zipBytes, {
		filter: (file) => {
			declaredEntries += 1;
			if (declaredEntries > limits.maxEntries)
				throw new Error(
					`Zip has too many entries (limit ${limits.maxEntries})`,
				);
			const safePath = validateZipEntryPath(file.name);
			// unzipSync returns a plain object, so exact duplicates would silently
			// collapse into one key; reject them here, before anything is inflated.
			if (seenEntries.has(safePath))
				throw new Error(`Duplicate zip entry: ${safePath}`);
			seenEntries.add(safePath);
			if (file.originalSize > limits.maxFileBytes)
				throw new Error(`Zip entry is too large: ${safePath}`);
			declaredTotal += file.originalSize;
			if (declaredTotal > limits.maxTotalBytes)
				throw new Error(
					`Zip expands beyond the archive limit (${limits.maxTotalBytes} bytes)`,
				);
			return true;
		},
	});
	const entries = new Map<string, Buffer>();
	let actualTotal = 0;
	for (const [entryPath, bytes] of Object.entries(unzipped)) {
		const safePath = validateZipEntryPath(entryPath);
		if (entries.has(safePath))
			throw new Error(`Duplicate zip entry: ${safePath}`);
		actualTotal += bytes.byteLength;
		if (bytes.byteLength > limits.maxFileBytes)
			throw new Error(`Zip entry is too large: ${safePath}`);
		if (actualTotal > limits.maxTotalBytes)
			throw new Error(
				`Zip expands beyond the archive limit (${limits.maxTotalBytes} bytes)`,
			);
		entries.set(safePath, Buffer.from(bytes));
	}
	const manifestBytes = entries.get("manifest.json");
	if (!manifestBytes) throw new Error("Zip is missing manifest.json");
	const manifest = validateManifest(
		JSON.parse(manifestBytes.toString("utf8")),
		pathOptions,
	);
	validateArchiveEntries(entries, manifest);
	return { entries, manifest };
}

function validateZipEntryPath(entryPath: string): string {
	if (entryPath.includes("\\"))
		throw new Error(`Unsafe zip path: ${entryPath}`);
	if (!isSafeZipPath(entryPath))
		throw new Error(`Unsafe zip path: ${entryPath}`);
	return safeRelativePath(entryPath);
}

function validateManifest(
	value: unknown,
	pathOptions: SyncPathOptions,
): SyncManifest {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("manifest.json must be an object");
	const manifest = value as SyncManifest;
	if (manifest.schemaVersion !== 1 || manifest.formatVersion !== 1)
		throw new Error("Unsupported manifest version");
	if (
		manifest.settingsMode !== undefined &&
		manifest.settingsMode !== "rewrite" &&
		manifest.settingsMode !== "raw"
	)
		throw new Error(`Unsupported settingsMode: ${String(manifest.settingsMode)}`);
	if (
		!Array.isArray(manifest.files) ||
		!Array.isArray(manifest.externalResources)
	)
		throw new Error("Invalid manifest entries");
	for (const file of manifest.files) {
		const safePath = validateZipEntryPath(file.path);
		if (!isAllowlistedRelativePath(safePath, pathOptions))
			throw new Error(`Manifest file is not allowlisted: ${file.path}`);
		if (isExcludedRelativePath(safePath, false))
			throw new Error(
				`Manifest file is always excluded from sync: ${file.path}`,
			);
		validateZipEntryPath(`files/${safePath}`);
	}
	for (const resource of manifest.externalResources) {
		if (!resource.id || !Array.isArray(resource.files))
			throw new Error("Invalid external resource entry");
		for (const file of resource.files) {
			const safePath = validateZipEntryPath(file.path);
			if (isExcludedRelativePath(safePath, false))
				throw new Error(
					`External resource file is always excluded from sync: ${file.path}`,
				);
		}
	}
	return manifest;
}

function validateArchiveEntries(
	entries: Map<string, Buffer>,
	manifest: SyncManifest,
): void {
	const expectedContent = new Set<string>(["manifest.json"]);
	for (const file of manifest.files) {
		const entry = `files/${file.path}`;
		const bytes = entries.get(entry);
		if (!bytes) throw new Error(`Zip is missing manifest file entry: ${entry}`);
		if (bytes.byteLength !== file.size || sha256Bytes(bytes) !== file.sha256)
			throw new Error(`Zip file hash mismatch: ${entry}`);
		expectedContent.add(entry);
	}
	for (const resource of manifest.externalResources) {
		for (const file of resource.files) {
			const entry = file.path;
			const bytes = entries.get(entry);
			if (!bytes)
				throw new Error(`Zip is missing external resource entry: ${entry}`);
			if (!entry.startsWith(`external-resources/${resource.id}/`))
				throw new Error(`External resource path mismatch: ${entry}`);
			if (bytes.byteLength !== file.size || sha256Bytes(bytes) !== file.sha256)
				throw new Error(`Zip external resource hash mismatch: ${entry}`);
			expectedContent.add(entry);
		}
	}
	for (const entry of entries.keys()) {
		if (!expectedContent.has(entry))
			throw new Error(`Zip contains unmanifested entry: ${entry}`);
	}
}
