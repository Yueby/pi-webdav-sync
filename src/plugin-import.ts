import {
	assertSafeJson,
	importArchivePaths,
	importLabel,
	isJsonObject,
	parseImportJson,
	type JsonObject,
} from "./import-plan.js";
import { isRemotePackageSpec, packageIdentity, redactPackageSpec, stripListPrefix } from "./package-specs.js";
import { safeRelativePath } from "./paths.js";
import type { ParsedArchive } from "./zip-store.js";

export type PluginChoice = {
	path: string;
	kind: "package" | "setting" | "file";
	index?: number;
	key?: string;
	file?: string;
};

const RESOURCE_KEYS = new Set(["extensions", "skills", "prompts", "themes"]);
const LOCAL_ONLY_KEYS = new Set(["shellPath", "npmCommand", "sessionDir"]);

/** Ownership of arbitrary plugin configuration is explicit, never inferred. */
export function pluginImportChoices(archive: ParsedArchive): PluginChoice[] {
	const settings = parseImportJson(archive.entries.get("files/settings.json"), "Snapshot settings.json");
	const choices: PluginChoice[] = [];
	for (const [index, entry] of packageEntries(settings).entries()) {
		const source = packageSource(entry);
		choices.push({
			path: `Packages/${String(index + 1).padStart(3, "0")} · ${importLabel(redactPackageSpec(source))}`,
			kind: "package",
			index,
		});
	}
	for (const key of Object.keys(settings).sort()) {
		if (key === "packages" || LOCAL_ONLY_KEYS.has(key) || key.startsWith("$")) continue;
		if (RESOURCE_KEYS.has(key)) {
			choices.push({ path: `Resources/${importLabel(key)}`, kind: "setting", key });
		}
	}
	for (const key of Object.keys(settings).sort()) {
		if (key === "packages" || LOCAL_ONLY_KEYS.has(key) || key.startsWith("$")) continue;
		if (!RESOURCE_KEYS.has(key)) {
			choices.push({ path: `Settings (manual)/${importLabel(key)}`, kind: "setting", key });
		}
	}
	for (const file of importArchivePaths(archive)) {
		// Model credentials/configuration belong to the separate Models import.
		if (["settings.json", "models.json", "auth.json"].includes(file)) continue;
		choices.push({ path: `Supplemental files (manual)/${file}`, kind: "file", file });
	}
	if (new Set(choices.map((choice) => choice.path)).size !== choices.length)
		throw new Error("Snapshot configuration names cannot be distinguished in the picker");
	return choices;
}

export function mergePluginImport(
	archive: ParsedArchive,
	localSettings: JsonObject,
	pickedPaths: string[],
): { settings?: JsonObject; paths: string[]; packages: unknown[]; packageCount: number; settingCount: number; dependencyCount: number } {
	assertSafeJson(localSettings);
	const incoming = parseImportJson(archive.entries.get("files/settings.json"), "Snapshot settings.json");
	const catalog = new Map(pluginImportChoices(archive).map((choice) => [choice.path, choice]));
	const choices = pickedPaths.map((entry) => {
		const choice = catalog.get(entry);
		if (!choice) throw new Error("Unknown plugin import selection");
		return choice;
	});
	const packages = choices.filter((choice) => choice.kind === "package")
		.map((choice) => packageEntries(incoming)[choice.index!]);
	const keys = choices.filter((choice) => choice.kind === "setting").map((choice) => choice.key!);
	const paths = new Set(choices.filter((choice) => choice.kind === "file").map((choice) => choice.file!));
	const settings: JsonObject = { ...localSettings };
	if (packages.length) settings.packages = mergeEntries(packageEntries(localSettings), packages);
	for (const key of keys) {
		if (RESOURCE_KEYS.has(key)) {
			if (!Array.isArray(incoming[key]) || (settings[key] !== undefined && !Array.isArray(settings[key])))
				throw new Error(`Resource list ${key} must be an array`);
			settings[key] = mergeEntries((settings[key] as unknown[]) ?? [], incoming[key] as unknown[]);
		} else {
			settings[key] = mergeJson(settings[key], incoming[key]);
		}
	}
	const explicitCount = paths.size;
	const allFiles = importArchivePaths(archive);
	const includeReference = (value: string) => {
		const { prefix, body } = stripListPrefix(value);
		// Exclusions and built-in toggles configure loading; they are not payload paths.
		if (prefix === "!" || prefix === "-" || body.startsWith("builtin:")) return;
		if (!body || isRemotePackageSpec(body)) return;
		if (/[\*?\[\]{}]/.test(body)) throw new Error("Imported resource has an unresolved glob; select explicit files instead");
		const relative = safeRelativePath(body.replace(/^\.\//, ""));
		const matches = allFiles.filter((file) => file === relative || file.startsWith(`${relative}/`));
		if (!matches.length) throw new Error("An imported local plugin/resource is missing from the snapshot");
		for (const file of matches) paths.add(file);
	};
	for (const entry of packages) includeReference(packageSource(entry));
	for (const key of keys) {
		if (!RESOURCE_KEYS.has(key)) continue;
		for (const entry of incoming[key] as unknown[]) {
			if (typeof entry !== "string") throw new Error(`Resource list ${key} must contain strings`);
			includeReference(entry);
		}
	}
	return {
		settings: packages.length || keys.length ? settings : undefined,
		paths: [...paths].sort(),
		packages,
		packageCount: packages.length,
		settingCount: keys.length,
		dependencyCount: paths.size - explicitCount,
	};
}

/** A whole settings.json carries its local resource references in either direction. */
export function includeSettingsDependencies(archive: ParsedArchive, paths: string[]): string[] {
	if (!paths.includes("settings.json")) return paths;
	const settingsChoices = pluginImportChoices(archive).filter((choice) =>
		choice.kind === "package" || (choice.kind === "setting" && RESOURCE_KEYS.has(choice.key!)));
	const dependencies = mergePluginImport(archive, {}, settingsChoices.map((choice) => choice.path)).paths;
	return [...new Set([...paths, ...dependencies])].sort();
}

function packageEntries(settings: JsonObject): unknown[] {
	if (settings.packages === undefined) return [];
	if (!Array.isArray(settings.packages)) throw new Error("settings.json packages must be an array");
	for (const entry of settings.packages) packageSource(entry);
	return settings.packages;
}

function packageSource(entry: unknown): string {
	const value = typeof entry === "string" ? entry : isJsonObject(entry) ? entry.source : undefined;
	if (typeof value !== "string" || !value.trim()) throw new Error("A package entry must have a nonempty source");
	return value;
}

function entryIdentity(entry: unknown): string {
	return packageIdentity(packageSource(entry));
}

function mergeEntries(local: unknown[], incoming: unknown[]): unknown[] {
	const result = [...local];
	for (const entry of incoming) {
		const identity = entryIdentity(entry);
		const index = result.findIndex((current) => entryIdentity(current) === identity);
		if (index < 0) result.push(entry);
		else result[index] = entry;
	}
	return result;
}

/** Merge selected objects only; incoming scalar/array leaves replace local ones. */
function mergeJson(local: unknown, incoming: unknown): unknown {
	if (!isJsonObject(incoming)) return incoming;
	const merged: JsonObject = isJsonObject(local) ? { ...local } : {};
	for (const [key, value] of Object.entries(incoming)) merged[key] = mergeJson(merged[key], value);
	return merged;
}
