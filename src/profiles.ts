import { scopedBackend } from "./backends/scoped.js";
import type { SyncBackend } from "./backends/types.js";

/** Name of the profile used when none is selected; it is an ordinary directory. */
export const DEFAULT_PROFILE = "default";

/** Marker written at remoteDir once a remote uses the profiles/ layout. */
export const LAYOUT_MARKER = "layout.json";
const LAYOUT_VERSION = 2;

/** Sentinel id for the "create a new profile" entry in a profile picker. */
const CREATE_PROFILE_ID = "__new__";

/**
 * Names become a single remote path segment, so the rules are deliberately
 * strict: lowercase only (no case-insensitive collisions across servers or
 * filesystems), no separators or traversal, and no Windows device names.
 */
const PROFILE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
/**
 * Windows reserves device names with any extension (con.txt, nul.json, com1.backup),
 * so the check matches the basename like the project's path validator does.
 */
const WINDOWS_DEVICE_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/;
/**
 * "latest" stays reserved because it doubles as the snapshot alias in
 * /webdav-sync:pull; every other valid name, including "default", is ordinary.
 */
const RESERVED_PROFILE_NAMES = new Set(["latest"]);

function isProfileName(value: string): boolean {
	try {
		normalizeProfileName(value);
		return true;
	} catch {
		return false;
	}
}

export function normalizeProfileName(value: string): string {
	if (!value) throw new Error("Profile name must not be empty");
	if (value.length > 64)
		throw new Error("Profile name must be at most 64 characters");
	if (!PROFILE_NAME_PATTERN.test(value))
		throw new Error(
			`Profile name must be lowercase letters, digits, dot, dash, or underscore: ${value}`,
		);
	if (WINDOWS_DEVICE_NAME_PATTERN.test(value))
		throw new Error(`Profile name is reserved on Windows: ${value}`);
	if (RESERVED_PROFILE_NAMES.has(value))
		throw new Error(`Profile name is reserved: ${value}`);
	return value;
}

/** Remote directory prefix for a profile; every profile is a directory. */
export function profilePrefix(name: string): string {
	return `profiles/${name}`;
}

export type RemoteLayout = {
	/** True when a version 2 marker is present. */
	marked: boolean;
	/** Root objects from the pre-profile layout that still need migrating. */
	legacy: boolean;
};

/**
 * Reads the remote layout marker and the legacy root data. A marker from a newer
 * version is refused so an older client cannot corrupt a newer remote.
 */
export async function readRemoteLayout(
	backend: SyncBackend,
): Promise<RemoteLayout> {
	let marked = false;
	if (await backend.exists(LAYOUT_MARKER)) {
		const marker = await backend.getJson<{ layoutVersion?: number }>(
			LAYOUT_MARKER,
		);
		const version = marker?.layoutVersion;
		if (typeof version === "number" && version > LAYOUT_VERSION)
			throw new Error(
				`Remote layout version ${version} was written by a newer pi-webdav-sync; update this package first`,
			);
		marked = true;
	}
	return { marked, legacy: await backend.exists("latest.json") };
}

/**
 * Refuses to touch a remote written by a newer version. Every command that talks
 * to the remote calls this so an older client can never modify a newer remote.
 */
export async function assertSupportedLayout(backend: SyncBackend): Promise<void> {
	await readRemoteLayout(backend);
}

/**
 * Writes the layout marker unless legacy root data is still present: keeping the
 * marker absent keeps the legacy default profile detectable and migratable.
 */
export async function writeLayoutMarker(
	backend: SyncBackend,
	layout: RemoteLayout,
): Promise<void> {
	if (layout.marked || layout.legacy) return;
	await backend.putJson(LAYOUT_MARKER, {
		tool: "pi-webdav-sync",
		layoutVersion: LAYOUT_VERSION,
	});
	layout.marked = true;
}

export type ProfileChoice = {
	id: string;
	/** Picker label: the display name plus the latest timestamp when known. */
	label: string;
	/** Display name including any explanation, without metadata. */
	name?: string;
	/** Present when the list offers creating a new profile. */
	isCreate?: boolean;
	/** True when the remote directory name is not a supported profile name. */
	unsupported?: boolean;
	createdAt?: string;
	fileCount?: number;
};

export function withCreateChoice(profiles: ProfileChoice[]): ProfileChoice[] {
	return [
		...profiles.filter((profile) => !profile.unsupported),
		{ id: CREATE_PROFILE_ID, label: "＋ Create profile…", isCreate: true },
	];
}

export function selectableProfiles(profiles: ProfileChoice[]): ProfileChoice[] {
	return profiles.filter((profile) => !profile.unsupported);
}

/** Metadata reads for a picker are capped so a remote with many profiles stays responsive. */
const MAX_ENRICHED_PROFILES = 20;

export type ProfileObject = {
	/** Path relative to the profile prefix, e.g. "latest.zip" or "snapshots/x.json". */
	path: string;
};

async function listObjectsIn(scoped: SyncBackend): Promise<ProfileObject[]> {
	const objects: ProfileObject[] = [];
	for (const path of ["latest.zip", "latest.json"]) {
		if (await scoped.exists(path)) objects.push({ path });
	}
	const entries = await scoped.listIfExists("snapshots");
	for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
		if (entry.type !== "file") continue;
		const base = remoteBaseName(entry.path);
		if (!base.endsWith(".zip") && !base.endsWith(".json")) continue;
		objects.push({ path: `snapshots/${base}` });
	}
	return objects;
}

/**
 * Every object the tool manages inside one profile, in write order: the zip
 * before its index, then snapshots. Used by delete and by the rename fallback.
 */
export async function listProfileObjects(
	backend: SyncBackend,
	name: string,
): Promise<ProfileObject[]> {
	return await listObjectsIn(scopedBackend(backend, profilePrefix(name)));
}

/** Objects of the pre-profile layout, which lived at the remote root. */
export async function listLegacyDefaultObjects(
	backend: SyncBackend,
): Promise<ProfileObject[]> {
	return await listObjectsIn(backend);
}

/**
 * The legacy root profile as a picker entry. Management actions (delete, rename)
 * offer it so pre-profile data can be handled before migrating, while push, pull
 * and status keep their pickers free of it and raise the migration hint instead.
 * Ordering puts the index last so a migrated destination is readable only once
 * its archive and snapshots are in place.
 */
export async function legacyMigrationOrder(
	backend: SyncBackend,
): Promise<ProfileObject[]> {
	const objects = await listLegacyDefaultObjects(backend);
	const index = objects.filter((object) => object.path === "latest.json");
	const rest = objects.filter((object) => object.path !== "latest.json");
	return [...rest, ...index];
}

/**
 * True when the profile has anything at all, including a directory without an
 * index (an interrupted creation) so it can still be deleted or renamed.
 */
export async function profileHasContent(
	backend: SyncBackend,
	name: string,
): Promise<boolean> {
	if (await backend.exists(profilePrefix(name))) return true;
	return (await listProfileObjects(backend, name)).length > 0;
}

/**
 * Lists profile directories under profiles/, enriched with the latest index
 * metadata of each profile. A missing profiles/ collection means "no profiles";
 * any other listing failure propagates so a network or authentication problem is
 * never reported as an empty remote.
 */
export async function listRemoteProfiles(
	backend: SyncBackend,
): Promise<ProfileChoice[]> {
	const entries = await backend.listIfExists("profiles");
	const profiles: ProfileChoice[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const name = remoteBaseName(entry.path);
		if (!name || entry.type === "file" || seen.has(name)) continue;
		seen.add(name);
		profiles.push({ id: name, name, label: name });
	}

	let enriched = 0;
	for (const profile of profiles) {
		if (profile.unsupported) continue;
		if (!isProfileName(profile.id)) {
			profile.unsupported = true;
			profile.name = `${profile.id} (unsupported name)`;
			profile.label = profile.name;
			continue;
		}
		if (enriched >= MAX_ENRICHED_PROFILES) continue;
		await enrichProfile(backend, profile);
		enriched += 1;
	}
	return profiles.sort((a, b) => {
		if (!!a.unsupported !== !!b.unsupported) return a.unsupported ? 1 : -1;
		if (a.id === DEFAULT_PROFILE) return -1;
		if (b.id === DEFAULT_PROFILE) return 1;
		return a.id.localeCompare(b.id);
	});
}

async function enrichProfile(
	backend: SyncBackend,
	profile: ProfileChoice,
): Promise<void> {
	const scoped = scopedBackend(backend, profilePrefix(profile.id));
	try {
		const latest = await scoped.getJson<{
			createdAt?: string;
			fileCount?: number;
		}>("latest.json");
		profile.createdAt = latest.createdAt;
		profile.fileCount = latest.fileCount;
		const base = profile.name || profile.id;
		profile.label = latest.createdAt ? `${base} · ${latest.createdAt}` : base;
	} catch {
		// Keep it listed (a transient failure must not hide a profile), but say that
		// its index could not be read; a pull will surface the real error.
		const base = profile.name || profile.id;
		profile.name = `${base} (no readable latest index)`;
		profile.label = profile.name;
	}
}

/** The legacy root profile as a picker entry, when the root still holds data. */
export async function legacyDefaultChoice(
	backend: SyncBackend,
): Promise<ProfileChoice | undefined> {
	const layout = await readRemoteLayout(backend);
	if (!layout.legacy) return undefined;
	return {
		id: DEFAULT_PROFILE,
		name: `${DEFAULT_PROFILE} (legacy root layout)`,
		label: `${DEFAULT_PROFILE} (legacy root layout)`,
	};
}

/** Last path segment of a remote path, tolerating trailing separators. */
function remoteBaseName(remotePath: string): string {
	const trimmed = remotePath.replace(/[\\/]+$/, "");
	const segments = trimmed.split(/[\\/]/);
	return segments[segments.length - 1] || "";
}

export function describeProfile(profile: ProfileChoice): string {
	const base = profile.label || profile.name || profile.id;
	return profile.fileCount === undefined
		? base
		: `${base} · ${profile.fileCount} file(s)`;
}
