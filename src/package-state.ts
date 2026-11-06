import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	extractPackageSpecs,
	npmPackageName,
	packageIdentity,
} from "./package-specs.js";

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

async function readJson(path: string, kind: "settings" | "metadata" = "settings"): Promise<unknown> {
	try {
		return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (error instanceof SyntaxError || code === "ENOENT" ||
			(kind === "metadata" && (code === "ENOTDIR" || code === "EISDIR")))
			return undefined;
		// Do not include file contents (which may contain credentials) in errors.
		throw new Error("Unable to read package installation state.");
	}
}

function npmSource(spec: string): { name: string; intent: string } | undefined {
	const source = spec.trim().startsWith("npm:") ? spec.trim() : `npm:${spec.trim()}`;
	const name = npmPackageName(source);
	if (!name) return undefined;
	return { name, intent: source.slice(4 + name.length + 1) || "latest" };
}

// Recognize only full version literals, not ranges or tag resolution.
function exactVersion(value: string): string | undefined {
	const match = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(value);
	return match?.[1];
}

interface GitLocation {
	host: string;
	path: string;
	ref: string;
}

/**
 * Pi 1.5 user clones use git/<host>/<path>, without a ref suffix. Mirror the
 * explicit URL, scp and host/owner/repo forms, not hosted-git-info's entire
 * shorthand grammar. An unrecognized/unsafe form remains a missing candidate.
 */
function gitLocation(spec: string): GitLocation | undefined {
	if (/[\\\u0000]/.test(spec)) return undefined;
	let source = spec.startsWith("git:") && !spec.startsWith("git://")
		? spec.slice(4) : spec;
	if (!source.includes("://")) {
		const scp = /^git@([^/:]+):(.+)$/.exec(source);
		source = scp ? `ssh://${scp[1]}/${scp[2]}` : `https://${source}`;
	}
	try {
		const url = new URL(source);
		if (!/^(https?|ssh|git):$/.test(url.protocol) || url.search) return undefined;
		const host = url.hostname;
		let path = url.pathname.replace(/^\//, "");
		const refIndex = path.indexOf("@");
		let ref = refIndex < 0 ? "" : path.slice(refIndex + 1);
		if (refIndex >= 0) path = path.slice(0, refIndex);
		if (url.hash) {
			if (ref || !["github.com", "gitlab.com", "bitbucket.org"].includes(host))
				return undefined;
			ref = url.hash.slice(1);
		}
		path = path.replace(/\.git$/, "");
		const parts = path.split("/");
		if (!/^[a-z0-9.-]+$/i.test(host) || parts.length < 2 ||
			parts.some((part) => !/^[a-z0-9._~-]+$/i.test(part) || part === "." || part === ".."))
			return undefined;
		return { host, path, ref };
	} catch {
		return undefined;
	}
}

function inside(root: string, path: string): boolean {
	const suffix = relative(root, path);
	return suffix !== "" && !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
}

async function gitPresent(agentDir: string, location: GitLocation): Promise<boolean> {
	const root = resolve(agentDir, "git");
	const path = resolve(root, location.host, location.path);
	if (!inside(root, path)) return false;
	try {
		// Do not follow a clone symlink out of managed storage.
		if (!inside(await realpath(root), await realpath(path))) return false;
		if (!(await stat(path)).isDirectory()) return false;
		const metadata = await stat(join(path, ".git"));
		if (!metadata.isDirectory() && !metadata.isFile()) return false;
		await readdir(path); // A usable directory, not only a settings entry.
		return true;
	} catch (error) {
		if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
			return false;
		throw new Error("Unable to read package installation state.");
	}
}

/**
 * Return original requested specs needing a personal install (or, when enabled,
 * an offline update). Declarations are intent, never evidence of installation.
 *
 * Updates check exact npm versions against package metadata. For tags/ranges we
 * compare canonical configured intent, falling back to npm/package.json's
 * dependency declaration when intent is unknown. This is NOT semver satisfaction
 * or a registry freshness check. Unknown intent is conservatively offered.
 * Git checks metadata presence and configured ref intent, not HEAD or remotes;
 * unresolved clone mappings are returned rather than trusted or scanned for.
 */
export async function missingInstalledPackages(
	agentDir: string,
	requestedSettings: unknown,
	options: { includeUpdates?: boolean; localSettings?: unknown } = {},
): Promise<string[]> {
	const requested = extractPackageSpecs(requestedSettings);
	const local = extractPackageSpecs(Object.hasOwn(options, "localSettings")
		? options.localSettings : await readJson(join(agentDir, "settings.json")));
	const missing: string[] = [];
	let npmRoot: Record<string, unknown> | undefined;
	let npmRootRead = false;
	for (const spec of requested) {
		const configured = local.filter((entry) => packageIdentity(entry) === packageIdentity(spec));
		const npm = npmSource(spec);
		if (npm) {
			const metadata = record(await readJson(join(agentDir, "npm", "node_modules", npm.name, "package.json"), "metadata"));
			if (metadata?.name !== npm.name || typeof metadata.version !== "string" || !metadata.version.trim()) {
				missing.push(spec);
				continue;
			}
			if (!options.includeUpdates) continue;
			const exact = exactVersion(npm.intent);
			if (exact) {
				if (exactVersion(metadata.version) !== exact) missing.push(spec);
				continue;
			}
			const intents = configured.map((entry) => npmSource(entry)?.intent);
			if (intents.length) {
				if (!intents.includes(npm.intent)) missing.push(spec);
				continue;
			}
			if (!npmRootRead) {
				npmRoot = record(await readJson(join(agentDir, "npm", "package.json"), "metadata"));
				npmRootRead = true;
			}
			const dependency = record(npmRoot?.dependencies)?.[npm.name];
			if (typeof dependency !== "string" || dependency !== npm.intent) missing.push(spec);
			continue;
		}
		const git = gitLocation(spec);
		if (!git || !await gitPresent(agentDir, git) ||
			(options.includeUpdates && !configured.some((entry) => gitLocation(entry)?.ref === git.ref)))
			missing.push(spec);
	}
	return missing;
}
