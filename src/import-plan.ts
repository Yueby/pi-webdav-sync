import { createManifest, sha256Bytes, type ManifestFileEntry } from "./manifest.js";
import { safeRelativePath, type SyncPathOptions } from "./paths.js";
import { extractPackageSpecs } from "./package-specs.js";
import { createLatestZip, parseArchive, type ParsedArchive } from "./zip-store.js";

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Never echo configuration values: these files may contain credentials. */
export function parseImportJson(bytes: Buffer | undefined, label: string): JsonObject {
	if (!bytes) return {};
	let value: unknown;
	try {
		value = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new Error(`${label} must contain valid JSON`);
	}
	if (!isJsonObject(value)) throw new Error(`${label} must be a JSON object`);
	assertSafeJson(value);
	return value;
}

export function assertSafeJson(value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) assertSafeJson(item);
	} else if (isJsonObject(value)) {
		for (const [key, item] of Object.entries(value)) {
			if (["__proto__", "constructor", "prototype"].includes(key))
				throw new Error("Configuration contains an unsafe object key");
			assertSafeJson(item);
		}
	}
}

export function jsonBytes(value: unknown): Buffer {
	return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

/** A virtual file list for the existing picker; these paths are never written. */
export function importCatalog(paths: string[]): ParsedArchive {
	return {
		entries: new Map(),
		manifest: createManifest({
			files: paths.map((entry) => fileEntry(entry, Buffer.alloc(0))),
			externalResources: [],
			packageSpecs: [],
			warnings: [],
		}),
	};
}

export function importArchivePaths(archive: ParsedArchive): string[] {
	return [
		...archive.manifest.files.map((file) => file.path),
		...archive.manifest.externalResources.flatMap((resource) =>
			resource.files.map((file) => file.path),
		),
	].sort();
}

/** Derived archives use fresh hashes and pass the same validation as downloads. */
export function createImportArchive(
	source: ParsedArchive,
	paths: string[],
	replacements: Map<string, Buffer>,
	pathOptions: SyncPathOptions,
): ParsedArchive {
	const selected = new Set(paths.map(safeRelativePath));
	for (const key of replacements.keys()) selected.add(safeRelativePath(key));
	const entries = new Map<string, Buffer>();
	const files: ManifestFileEntry[] = [];
	for (const file of source.manifest.files) {
		if (!selected.has(file.path) || replacements.has(file.path)) continue;
		const bytes = source.entries.get(`files/${file.path}`);
		if (!bytes) throw new Error(`Archive is missing: ${file.path}`);
		entries.set(`files/${file.path}`, bytes);
		files.push(fileEntry(file.path, bytes, file.mode));
		selected.delete(file.path);
	}
	const externalResources = source.manifest.externalResources.flatMap((resource) => {
		const included = resource.files.filter((file) => selected.has(file.path));
		for (const file of included) {
			const bytes = source.entries.get(file.path);
			if (!bytes) throw new Error(`Archive is missing: ${file.path}`);
			entries.set(file.path, bytes);
			selected.delete(file.path);
		}
		return included.length ? [{ ...resource, files: included }] : [];
	});
	for (const [logicalPath, bytes] of replacements) {
		const filePath = safeRelativePath(logicalPath);
		const original = source.manifest.files.find((file) => file.path === filePath);
		entries.set(`files/${filePath}`, bytes);
		files.push(fileEntry(filePath, bytes, original?.mode));
		selected.delete(filePath);
	}
	if (selected.size) throw new Error("Import contains a file outside the snapshot");
	const manifest = createManifest({
		files,
		externalResources,
		packageSpecs: extractPackageSpecs(parseImportJson(entries.get("files/settings.json"), "Imported settings.json")),
		warnings: [],
		settingsMode: "raw",
	});
	entries.set("manifest.json", jsonBytes(manifest));
	const zip = createLatestZip(entries, manifest);
	return parseArchive(zip.zipBytes, zip.latest.zipSha256, pathOptions);
}

function fileEntry(filePath: string, bytes: Buffer, mode?: number): ManifestFileEntry {
	return { path: safeRelativePath(filePath), type: "file", size: bytes.length, sha256: sha256Bytes(bytes), mode };
}

/** Labels carry identifiers only, not values or terminal control sequences. */
export function importLabel(value: string): string {
	return value.replace(/[\\/]/g, "∕").replace(/[\u0000-\u001f\u007f]/g, " ");
}

/** Compose a complete remote snapshot, replacing only the patch's logical paths. */
export function mergeRemoteArchive(
	destination: ParsedArchive | undefined,
	patch: ParsedArchive,
	pathOptions: SyncPathOptions,
): ParsedArchive {
	const validate = (archive: ParsedArchive): ParsedArchive => {
		const zip = createLatestZip(archive.entries, archive.manifest);
		const checked = parseArchive(zip.zipBytes, zip.latest.zipSha256, pathOptions);
		if (JSON.stringify(checked.manifest) !== JSON.stringify(archive.manifest))
			throw new Error("Archive manifest does not match its entry map");
		const paths = importArchivePaths(checked).map(safeRelativePath);
		const unique = new Set(paths);
		if (unique.size !== paths.length) throw new Error("Archive contains duplicate logical paths");
		for (const entry of paths) {
			const parts = entry.split("/");
			while (parts.length > 1) {
				parts.pop();
				if (unique.has(parts.join("/"))) throw new Error("Archive contains conflicting logical paths");
			}
		}
		const ids = checked.manifest.externalResources.map((resource) => resource.id);
		if (new Set(ids).size !== ids.length) throw new Error("Archive contains duplicate resource ids");
		return checked;
	};
	const previous = destination ? validate(destination) : undefined;
	const incoming = validate(patch);
	const replaced = new Set(importArchivePaths(incoming));
	const entries = new Map(previous?.entries);
	for (const entry of replaced) {
		entries.delete(`files/${entry}`);
		entries.delete(entry);
	}
	for (const [entry, bytes] of incoming.entries) {
		if (entry !== "manifest.json") entries.set(entry, bytes);
	}
	const files = [
		...(previous?.manifest.files ?? []).filter((file) => !replaced.has(file.path)),
		...incoming.manifest.files,
	].map((file) => fileEntry(file.path, entries.get(`files/${file.path}`)!, file.mode));
	const resources = new Map((previous?.manifest.externalResources ?? []).map((resource) => [
		resource.id, { ...resource, files: resource.files.filter((file) => !replaced.has(file.path)) },
	]));
	for (const resource of incoming.manifest.externalResources) {
		resources.set(resource.id, {
			...resource,
			files: [...(resources.get(resource.id)?.files ?? []), ...resource.files],
		});
	}
	const externalResources = [...resources.values()].map((resource) => ({
		...resource,
		files: resource.files.map((file) => fileEntry(file.path, entries.get(file.path)!, file.mode)),
	}));
	const manifest = createManifest({
		files,
		externalResources,
		packageSpecs: extractPackageSpecs(parseImportJson(entries.get("files/settings.json"), "Remote settings.json")),
		warnings: [...new Set([...(previous?.manifest.warnings ?? []), ...incoming.manifest.warnings])],
		settingsMode: previous?.manifest.settingsMode ?? "rewrite",
	});
	entries.set("manifest.json", jsonBytes(manifest));
	return validate({ entries, manifest });
}
