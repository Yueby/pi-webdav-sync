export type PackageEntry =
	| string
	| { source?: unknown; [key: string]: unknown };

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

export function missingInstallSpecs(settings: unknown): string[] {
	return extractPackageSpecs(settings);
}
