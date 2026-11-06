const REMOTE_SPEC_PREFIXES = [
	"npm:",
	"git:",
	"http://",
	"https://",
	"ssh://",
	"git://",
];

const LOCAL_SPEC_PREFIXES = [
	"./",
	"../",
	"/",
	"~/",
	"~\\",
	"file:",
	"path:",
	"glob:",
];

export function isRemotePackageSpec(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed) return false;
	if (REMOTE_SPEC_PREFIXES.some((prefix) => trimmed.startsWith(prefix)))
		return true;
	return isBareNpmPackageSpec(trimmed);
}

function isBareNpmPackageSpec(value: string): boolean {
	if (LOCAL_SPEC_PREFIXES.some((prefix) => value.startsWith(prefix)))
		return false;
	if (/^[A-Za-z]:[\\/]/.test(value)) return false;
	if (value.includes("\\")) return false;
	if (/[*?[\]{}]/.test(value)) return false;
	if (value.includes("/")) {
		return /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:@[^\s/]+)?$/i.test(
			value,
		);
	}
	return /^[a-z0-9][a-z0-9._-]*(?:@[^\s/]+)?$/i.test(value);
}

export function stripListPrefix(value: string): {
	prefix: "" | "!" | "+" | "-";
	body: string;
} {
	const first = value.charAt(0);
	if (first === "!" || first === "+" || first === "-") {
		return { prefix: first, body: value.slice(1) };
	}
	return { prefix: "", body: value };
}

export function withListPrefix(prefix: string, body: string): string {
	return `${prefix}${body}`;
}

/**
 * The npm package name inside an `npm:` spec, or undefined for specs Pi installs
 * elsewhere (git, local paths). Version suffixes and the `!`/`+`/`-` list prefixes
 * are stripped; names that could escape the install root are rejected.
 */
export function npmPackageName(spec: string): string | undefined {
	const { body } = stripListPrefix(spec.trim());
	if (!body.startsWith("npm:")) return undefined;
	const match = /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@[^\s/]+)?$/i.exec(
		body.slice(4),
	);
	return match ? match[1] : undefined;
}

/** Package identity follows Pi: npm name, git repository without ref, or local source. */
export function packageIdentity(spec: string): string {
	const { body } = stripListPrefix(spec.trim());
	const npmName = npmPackageName(body) ?? (isBareNpmPackageSpec(body) ? npmPackageName(`npm:${body}`) : undefined);
	if (npmName) return `npm:${npmName.toLowerCase()}`;
	if (/^(git:|https?:\/\/|ssh:\/\/)/i.test(body)) {
		let source = body.startsWith("git:") && !body.startsWith("git://") ? body.slice(4) : body;
		// Normalize scp-style SSH locations and the git:host/owner/repo shorthand.
		if (!source.includes("://")) {
			const scp = /^([^/@]+@)?([^/:]+):(.+)$/.exec(source);
			source = scp ? `ssh://${scp[1] ?? ""}${scp[2]}/${scp[3]}` : `https://${source}`;
		}
		try {
			const url = new URL(source);
			// Refs follow the repo path, not the userinfo @ in the authority.
			let repo = url.pathname.split("@")[0].replace(/\/+$/, "").replace(/\.git$/, "");
			if (url.hostname.toLowerCase() === "github.com") repo = repo.toLowerCase();
			return `git:${url.host.toLowerCase()}${repo}`;
		} catch {
			// Invalid specs retain their identity; installation validation handles them.
		}
	}
	return body.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function extractPackageSpecs(settings: unknown): string[] {
	if (!settings || typeof settings !== "object") return [];
	const packages = (settings as { packages?: unknown }).packages;
	if (!Array.isArray(packages)) return [];
	const specs: string[] = [];
	for (const entry of packages) {
		const source =
			typeof entry === "string"
				? entry
				: entry && typeof entry === "object"
					? (entry as { source?: unknown }).source
					: undefined;
		if (typeof source !== "string") continue;
		const { body } = stripListPrefix(source);
		if (isRemotePackageSpec(body)) specs.push(body);
	}
	return [...new Set(specs)].sort();
}

export function redactPackageSpec(spec: string): string {
	return spec.replace(
		/([a-z][a-z0-9+.-]*:\/\/)([^/@\s:]+(?::[^/@\s]*)?@)/gi,
		"$1***@",
	);
}

const MAX_INSTALL_SPEC_LENGTH = 2048;

/**
 * Install specs cross a process boundary, so they must be single, flag-free
 * tokens: a leading "-" would be read as a CLI flag, and whitespace or control
 * characters could be used to smuggle additional arguments.
 */
function isSafeInstallSpec(spec: string): boolean {
	if (!spec || spec.length > MAX_INSTALL_SPEC_LENGTH) return false;
	if (spec.startsWith("-")) return false;
	return !/[\u0000-\u001f\u007f\s"']/.test(spec);
}

export function isInstallableSpec(spec: string): boolean {
	return isRemotePackageSpec(spec) && isSafeInstallSpec(spec);
}

export function clonePackageEntryWithSource(
	entry: unknown,
	source: string,
): unknown {
	if (typeof entry === "string") return source;
	if (entry && typeof entry === "object" && !Array.isArray(entry)) {
		return { ...(entry as Record<string, unknown>), source };
	}
	return entry;
}
