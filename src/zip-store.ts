import { unzipSync, zipSync } from "fflate";
import {
	isAllowlistedRelativePath,
	isSafeZipPath,
	safeRelativePath,
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

export function createLatestZip(
	entries: Map<string, Uint8Array>,
	manifest: SyncManifest,
): ZipBuildResult {
	const zipInput: Record<string, Uint8Array> = {};
	const seen = new Set<string>();
	for (const [entryPath, bytes] of entries) {
		const safePath = validateZipEntryPath(entryPath);
		if (seen.has(safePath)) throw new Error(`Duplicate zip entry: ${safePath}`);
		seen.add(safePath);
		zipInput[safePath] = bytes;
	}
	if (!seen.has("manifest.json")) {
		throw new Error("Zip is missing manifest.json");
	}
	const zipBytes = zipSync(zipInput, {
		level: 6,
		mtime: new Date("1980-01-01T00:00:00Z"),
	});
	return { zipBytes, latest: createLatestIndex(manifest, zipBytes) };
}

export function listZipEntries(zipBytes: Uint8Array): string[] {
	const unzipped = unzipSync(zipBytes);
	return Object.keys(unzipped).map(validateZipEntryPath).sort();
}

export function parseArchive(
	zipBytes: Uint8Array,
	expectedZipSha256?: string,
): ParsedArchive {
	if (expectedZipSha256 && sha256Bytes(zipBytes) !== expectedZipSha256) {
		throw new Error("Downloaded zipSha256 does not match latest.json");
	}
	const unzipped = unzipSync(zipBytes);
	const entries = new Map<string, Buffer>();
	for (const [entryPath, bytes] of Object.entries(unzipped)) {
		const safePath = validateZipEntryPath(entryPath);
		if (entries.has(safePath))
			throw new Error(`Duplicate zip entry: ${safePath}`);
		entries.set(safePath, Buffer.from(bytes));
	}
	const manifestBytes = entries.get("manifest.json");
	if (!manifestBytes) throw new Error("Zip is missing manifest.json");
	const manifest = validateManifest(JSON.parse(manifestBytes.toString("utf8")));
	validateArchiveEntries(entries, manifest);
	return { entries, manifest };
}

export function validateZipEntryPath(entryPath: string): string {
	if (entryPath.includes("\\"))
		throw new Error(`Unsafe zip path: ${entryPath}`);
	if (!isSafeZipPath(entryPath))
		throw new Error(`Unsafe zip path: ${entryPath}`);
	return safeRelativePath(entryPath);
}

function validateManifest(value: unknown): SyncManifest {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("manifest.json must be an object");
	const manifest = value as SyncManifest;
	if (manifest.schemaVersion !== 1 || manifest.formatVersion !== 1)
		throw new Error("Unsupported manifest version");
	if (
		!Array.isArray(manifest.files) ||
		!Array.isArray(manifest.externalResources)
	)
		throw new Error("Invalid manifest entries");
	for (const file of manifest.files) {
		const safePath = validateZipEntryPath(file.path);
		if (!isAllowlistedRelativePath(safePath))
			throw new Error(`Manifest file is not allowlisted: ${file.path}`);
		validateZipEntryPath(`files/${safePath}`);
	}
	for (const resource of manifest.externalResources) {
		if (!resource.id || !Array.isArray(resource.files))
			throw new Error("Invalid external resource entry");
		for (const file of resource.files) validateZipEntryPath(file.path);
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
