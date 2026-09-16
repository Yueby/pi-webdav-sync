import fs from "node:fs/promises";
import path from "node:path";
import {
	externalResourceZipRoot,
	isAllowlistedRelativePath,
	pathInside,
	relativeToAgent,
	resolveMaybeRelativePath,
	safeRelativePath,
	toPosixPath,
} from "./paths.js";
import {
	clonePackageEntryWithSource,
	extractPackageSpecs,
	isRemotePackageSpec,
	stripListPrefix,
	withListPrefix,
} from "./package-specs.js";
import { sha256String } from "./manifest.js";

export type ExternalReference = {
	id: string;
	sourcePath: string;
	zipRoot: string;
	settingsPath: string;
};

export type SettingsRewriteResult = {
	content: Buffer;
	externalReferences: ExternalReference[];
	packageSpecs: string[];
	warnings: string[];
	rewritten: boolean;
};

type RewriteContext = {
	agentDir: string;
	settingsDir: string;
	externalReferences: Map<string, ExternalReference>;
	warnings: string[];
};

const RESOURCE_KEYS = ["extensions", "skills", "prompts", "themes"] as const;
const LOCAL_ONLY_SETTINGS_KEYS = [
	"shellPath",
	"npmCommand",
	"sessionDir",
] as const;

export async function rewriteSettingsFile(
	agentDir: string,
	settingsPath: string,
): Promise<SettingsRewriteResult> {
	const raw = await fs.readFile(settingsPath);
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.toString("utf8"));
	} catch (error) {
		throw new Error(
			`settings.json is not valid JSON; fix it before push/backup: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(
			"settings.json root must be an object; fix it before push/backup",
		);
	}

	const ctx: RewriteContext = {
		agentDir,
		settingsDir: path.dirname(settingsPath),
		externalReferences: new Map(),
		warnings: [],
	};
	const root = { ...(parsed as Record<string, unknown>) };
	for (const key of LOCAL_ONLY_SETTINGS_KEYS) delete root[key];

	if (Array.isArray(root.packages)) {
		root.packages = root.packages.map((entry) =>
			rewritePackageEntry(entry, ctx),
		);
	}

	for (const key of RESOURCE_KEYS) {
		if (Array.isArray(root[key])) {
			root[key] = root[key].map((entry) =>
				typeof entry === "string" ? rewriteLocalReference(entry, ctx) : entry,
			);
		}
	}

	const content = Buffer.from(`${JSON.stringify(root, null, 2)}\n`, "utf8");
	return {
		content,
		externalReferences: [...ctx.externalReferences.values()].sort((a, b) =>
			a.id.localeCompare(b.id),
		),
		packageSpecs: extractPackageSpecs(root),
		warnings: ctx.warnings,
		rewritten: content.compare(raw) !== 0,
	};
}

function rewritePackageEntry(entry: unknown, ctx: RewriteContext): unknown {
	const source =
		typeof entry === "string"
			? entry
			: entry && typeof entry === "object"
				? (entry as { source?: unknown }).source
				: undefined;
	if (typeof source !== "string") return entry;
	const { prefix, body } = stripListPrefix(source);
	if (isRemotePackageSpec(body)) return entry;
	const rewritten = rewriteLocalReference(source, ctx);
	return clonePackageEntryWithSource(
		entry,
		rewritten === source
			? source
			: withListPrefix(prefix, stripListPrefix(rewritten).body),
	);
}

function rewriteLocalReference(value: string, ctx: RewriteContext): string {
	const { prefix, body } = stripListPrefix(value);
	if (!body || isRemotePackageSpec(body)) return value;
	if (hasGlob(body)) {
		ctx.warnings.push(
			`Skipping unresolved glob reference in settings.json: ${value}`,
		);
		return value;
	}

	const resolved = resolveMaybeRelativePath(body, ctx.settingsDir);
	const relative = pathInside(ctx.agentDir, resolved)
		? relativeToAgent(ctx.agentDir, resolved)
		: undefined;
	if (relative && isAllowlistedRelativePath(relative)) {
		return value;
	}
	if (relative && isExternalResourceRelativePath(relative)) {
		const id = externalResourceId(relative);
		const zipRoot = safeRelativePath(relative);
		const key = `external:${zipRoot}`;
		if (!ctx.externalReferences.has(key)) {
			ctx.externalReferences.set(key, {
				id,
				sourcePath: resolved,
				zipRoot,
				settingsPath: withListPrefix(prefix, value),
			});
		}
		return value;
	}
	if (relative) {
		ctx.warnings.push(
			`Skipping agent-internal non-allowlisted settings path: ${relative}`,
		);
		return value;
	}

	const id = stableResourceId(resolved);
	const baseName = path.basename(resolved) || "resource";
	const zipRoot = externalResourceZipRoot(id, baseName);
	const settingsPath = `./${zipRoot}`;
	if (!ctx.externalReferences.has(id)) {
		ctx.externalReferences.set(id, {
			id,
			sourcePath: resolved,
			zipRoot,
			settingsPath,
		});
	}
	return withListPrefix(prefix, settingsPath);
}

function isExternalResourceRelativePath(relativePath: string): boolean {
	const safe = safeRelativePath(relativePath);
	return safe.startsWith("external-resources/") && safe.split("/").length >= 2;
}

function externalResourceId(relativePath: string): string {
	return (
		safeRelativePath(relativePath).split("/")[1] ||
		stableResourceId(relativePath)
	);
}

function stableResourceId(absolutePath: string): string {
	return sha256String(
		toPosixPath(path.resolve(absolutePath)).toLowerCase(),
	).slice(0, 16);
}

function hasGlob(value: string): boolean {
	return /[*?[\]{}]/.test(value);
}
