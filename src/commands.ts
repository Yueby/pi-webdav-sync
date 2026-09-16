import { spawn } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
	applyArchiveWithRollback,
	archiveSettingsMode,
	createLocalBackup,
	diffArchiveAgainstLocal,
	loadBackup,
	saveRemoteArchiveBackup,
	type BackupRecord,
} from "./backup.js";
import { collectAgentArchive } from "./collector.js";
import {
	configDir,
	configPath,
	defaultConfig,
	readConfig,
	validateConfig,
	writeConfig,
	type WebdavSyncConfig,
} from "./config.js";
import { createLatestIndex, type LatestIndex, shortHash } from "./manifest.js";
import { getAgentDir, pathInside } from "./paths.js";
import { isInstallableSpec, missingInstallSpecs } from "./package-specs.js";
import {
	DEFAULT_PROFILE,
	LAYOUT_MARKER,
	assertSupportedLayout,
	describeProfile,
	legacyDefaultChoice,
	legacyMigrationOrder,
	listLegacyDefaultObjects,
	listProfileObjects,
	listRemoteProfiles,
	normalizeProfileName,
	profileHasContent,
	profilePrefix,
	readRemoteLayout,
	selectableProfiles,
	withCreateChoice,
	writeLayoutMarker,
	type ProfileChoice,
	type ProfileObject,
} from "./profiles.js";
import {
	createLatestZip,
	parseArchive,
	type ParsedArchive,
} from "./zip-store.js";
import { createWebdavBackend } from "./backends/webdav.js";
import { isMoveUnsupportedRemoteError } from "./backends/webdav.js";
import { scopedBackend } from "./backends/scoped.js";
import type { RemoteListEntry, SyncBackend } from "./backends/types.js";

export type CommandResult = {
	ok: boolean;
	text: string;
	data?: unknown;
};

export type CommandContext = {
	agentDir?: string;
	backend?: SyncBackend;
	selectSnapshot?: (choices: SnapshotChoice[]) => Promise<string | undefined>;
	selectProfile?: (
		choices: ProfileChoice[],
		message?: string,
	) => Promise<string | undefined>;
	inputProfileName?: (existing: string[]) => Promise<string | undefined>;
	confirmPush?: (preview: PushPreview) => Promise<boolean>;
	confirmOverwriteConfig?: (path: string) => Promise<boolean>;
	fetchRemoteConfig?: (url: string) => Promise<unknown>;
	confirmInstallPackages?: (specs: string[]) => Promise<boolean>;
	confirmRestore?: (preview: RestorePreview) => Promise<boolean>;
	confirmProfileDelete?: (preview: ProfileDeletePreview) => Promise<boolean>;
	confirmProfileMigrate?: (preview: ProfileMigratePreview) => Promise<boolean>;
	installPackage?: (spec: string) => Promise<number | null>;
	onInstallProgress?: (progress: InstallProgress) => void;
};

export type PushPreview = {
	profile: string;
	fileCount: number;
	externalResourceCount: number;
	packageSpecs: string[];
	hash: string;
	warnings: string[];
};

type ParsedArgs = {
	profile?: string;
	createProfile?: string;
	assumeYes?: boolean;
	positional: string[];
};

type ProfileTarget = {
	name: string;
	backend: SyncBackend;
	/** True when this command intends to create the profile. */
	created: boolean;
	/** True when the target is the pre-profile layout at the remote root. */
	legacyRoot?: boolean;
};

export type ProfileDeletePreview = {
	profile: string;
	objectCount: number;
	snapshotCount: number;
	lastUpdated?: string;
};

export type ProfileMigratePreview = {
	profile: string;
	objectCount: number;
	snapshotCount: number;
	lastUpdated?: string;
};

export type InstallProgress = {
	phase: "start" | "package_start" | "package_done" | "done";
	spec?: string;
	index?: number;
	total: number;
	ok?: boolean;
	code?: number | null;
};

export type SnapshotChoice = {
	id: string;
	label: string;
};

export type RestorePreview = {
	id: string;
	createdAt: string;
	/** Set when the backup was taken from a remote profile before it was deleted. */
	profile?: string;
	fileCount: number;
	externalResourceCount: number;
	changes: { add: number; modify: number; remove: number };
};

export async function runWebdavSyncCommand(
	input: string | string[] = [],
	context: CommandContext = {},
): Promise<CommandResult> {
	const inputArgs = Array.isArray(input) ? input : splitArgs(input);
	const command = normalizeCommand(inputArgs[0]);
	const commandArgs = inputArgs.slice(1);
	const agentDir = getAgentDir(context.agentDir);
	try {
		if (command === "init")
			return await commandInit(agentDir, context, commandArgs);
		if (command === "push")
			return await commandPush(agentDir, context, commandArgs);
		if (command === "pull")
			return await commandPull(agentDir, context, commandArgs);
		if (command === "restore")
			return await commandRestore(agentDir, context, commandArgs);
		if (command === "status")
			return await commandStatus(agentDir, context, commandArgs);
		if (command === "profiles")
			return await commandProfiles(agentDir, context, commandArgs);
		return ok(helpText());
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
}

async function commandInit(
	agentDir: string,
	context: CommandContext,
	args: string[],
): Promise<CommandResult> {
	const parsed = parseCommandArgs("init", args);
	requireNoProfileFlag("init", parsed);
	if (parsed.positional.length > 1)
		throw new Error("init accepts at most one remote config URL");
	const target = configPath(agentDir);
	const remoteUrl = parsed.positional[0];
	const exists = await fileExists(target);
	if (exists) {
		const overwrite = context.confirmOverwriteConfig
			? await context.confirmOverwriteConfig(target)
			: false;
		if (!overwrite) return ok(["init: exists", `config: ${target}`].join("\n"));
	}
	if (remoteUrl) {
		await writeRemoteConfigText(
			agentDir,
			await loadRemoteInitConfigText(remoteUrl, context),
		);
	} else {
		await writeConfig(templateConfig(), agentDir);
	}
	return ok(
		[
			exists ? "init: overwritten" : "init: created",
			`config: ${target}`,
			remoteUrl ? "source: remote config" : "source: template",
			remoteUrl
				? "Review the config before push/pull."
				: "Edit this file with your WebDAV credentials before push/pull.",
		].join("\n"),
	);
}

async function commandPush(
	agentDir: string,
	context: CommandContext,
	args: string[],
): Promise<CommandResult> {
	const parsed = parseCommandArgs("push", args);
	if (parsed.positional.length)
		throw new Error("push accepts no positional arguments; use --profile or --create-profile");
	const config = await requireConfig(agentDir);
	const rootBackend = context.backend || createWebdavBackend(config);
	await assertSupportedLayout(rootBackend);
	const notes: string[] = [];
	const migrated = await autoMigrateLegacyLayout(
		rootBackend,
		agentDir,
		config,
		notes,
	);
	if (migrated && parsed.createProfile === DEFAULT_PROFILE) {
		// Migrating just created the default profile, so this is an update, not a create.
		parsed.profile = DEFAULT_PROFILE;
		parsed.createProfile = undefined;
	}
	const target = await resolveProfileTarget(rootBackend, context, parsed, {
		allowCreate: true,
		requireExisting: false,
	});
	if (!target)
		return ok(
			["push: cancelled", "nothing was uploaded", ...notes].join("\n"),
			{ cancelled: true },
		);

	const collected = await collectAgentArchive(agentDir, config);
	const zip = createLatestZip(collected.zipEntries, collected.manifest);
	const preview: PushPreview = {
		profile: target.name,
		fileCount: zip.latest.fileCount,
		externalResourceCount: zip.latest.externalResourceCount,
		packageSpecs: zip.latest.packageSpecs,
		hash: shortHash(zip.latest.contentSha256),
		warnings: collected.warnings,
	};
	if (context.confirmPush && !(await context.confirmPush(preview))) {
		return ok(
			[
				"push: cancelled",
				`profile: ${preview.profile}`,
				`files: ${preview.fileCount}`,
				`external: ${preview.externalResourceCount}`,
				`packages: ${preview.packageSpecs.length}`,
				`hash: ${preview.hash}`,
			].join("\n"),
			preview,
		);
	}
	const backend = target.backend;
	if (target.created && (await backend.exists("latest.json")))
		throw new Error(
			`Profile already exists: ${target.name} (created by another writer while this push was pending); re-run with --profile ${target.name} to update it`,
		);
	const snapshotId = snapshotIdFromDate(new Date(zip.latest.createdAt));
	const snapshotZip = `snapshots/${snapshotId}.zip`;
	const snapshotJson = `snapshots/${snapshotId}.json`;
	await backend.putBytes("latest.zip", zip.zipBytes);
	await backend.putJson("latest.json", zip.latest);
	await backend.putBytes(snapshotZip, zip.zipBytes);
	await backend.putJson(snapshotJson, {
		...zip.latest,
		snapshotId,
		zip: snapshotZip,
	});
	const lines = [
		"push: ok",
		`profile: ${target.name}`,
		`files: ${zip.latest.fileCount}`,
		`external: ${zip.latest.externalResourceCount}`,
		`packages: ${zip.latest.packageSpecs.length}`,
		`hash: ${shortHash(zip.latest.contentSha256)}`,
	];
	appendPasswordWarning(lines, config);
	lines.push(...notes);
	try {
		// Mark the remote as profile-layout based once it no longer holds legacy data.
		await writeLayoutMarker(rootBackend, await readRemoteLayout(rootBackend));
	} catch (error) {
		lines.push(
			`layout marker not written: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		const pruned = await pruneRemoteSnapshots(
			backend,
			config.snapshotRetention ?? 5,
		);
		if (pruned.length) lines.push(`pruned: ${pruned.length} old snapshot(s)`);
	} catch (error) {
		lines.push(
			`snapshot prune failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return ok(lines.join("\n"), { ...zip.latest, profile: target.name });
}

async function commandPull(
	agentDir: string,
	context: CommandContext,
	args: string[],
): Promise<CommandResult> {
	const parsed = parseCommandArgs("pull", args);
	if (parsed.positional.length > 1)
		throw new Error("pull accepts at most one snapshot id");
	const config = await requireConfig(agentDir);
	const rootBackend = context.backend || createWebdavBackend(config);
	await assertSupportedLayout(rootBackend);
	const notes: string[] = [];
	await autoMigrateLegacyLayout(rootBackend, agentDir, config, notes);
	const target = await resolveProfileTarget(rootBackend, context, parsed, {
		allowCreate: false,
		requireExisting: true,
	});
	if (!target)
		return ok(
			["pull: cancelled", "nothing was downloaded or applied"].join("\n"),
			{ cancelled: true },
		);
	const backend = target.backend;
	const snapshot = await chooseSnapshot(
		backend,
		context.selectSnapshot,
		parsed.positional[0],
	);
	if (!snapshot)
		return ok(
			["pull: cancelled", "nothing was downloaded or applied"].join("\n"),
			{ cancelled: true },
		);
	const latest = await backend.getJson<LatestIndex>(snapshot.jsonPath);
	const zipBytes = await backend.getBytes(snapshot.zipPath);
	const archive = parseArchive(zipBytes, latest.zipSha256, config);
	validateLatestMatchesManifest(latest, archive);
	const diff = await diffArchiveAgainstLocal(agentDir, archive, config);
	const packages = missingInstallSpecs(await settingsJsonFromArchive(archive));
	const backup = await createLocalBackup(
		agentDir,
		config.backupRetention ?? 5,
		config,
	);
	const applied = await applyArchiveWithRollback(
		agentDir,
		archive,
		backup.id,
		config,
	);
	const shouldInstall = await shouldInstallPackages(
		packages,
		config,
		context.confirmInstallPackages,
	);
	const installResults = shouldInstall
		? await installPackages(
				packages,
				context.installPackage,
				context.onInstallProgress,
			)
		: [];
	const lines = [
		`pull: ${target.name === DEFAULT_PROFILE ? snapshot.id : `${target.name}/${snapshot.id}`}`,
		`profile: ${target.name}`,
		`backup: ${backup.id}`,
		`files: ${applied.filesWritten}`,
		`external: ${applied.externalFilesWritten}`,
		`changes: +${diff.add.length}/~${diff.modify.length}/-${diff.remove.length}`,
		`hash: ${shortHash(archive.manifest.contentSha256)}`,
		...notes,
	];
	appendPasswordWarning(lines, config);
	if (packages.length && !installResults.length)
		lines.push(`packages: ${packages.length} not installed`);
	if (installResults.length) {
		const failed = installResults.filter((item) => !item.ok).length;
		lines.push(
			`packages: ${installResults.length - failed} installed, ${failed} failed`,
		);
	}
	const unsafe = installResults.filter((item) => item.skipped);
	if (unsafe.length)
		lines.push(
			`packages: ${unsafe.length} unsafe spec(s) skipped; review the snapshot settings.json`,
		);
	const unresolved = installResults.filter(
		(item) => !item.skipped && item.code === null,
	);
	if (unresolved.length)
		lines.push(
			`packages: ${unresolved.length} not installed (pi CLI not found; run "pi install <spec>" manually)`,
		);
	return ok(lines.join("\n"), {
		profile: target.name,
		snapshot: snapshot.id,
		backup,
		applied,
		packages,
	});
}

export async function pruneRemoteSnapshots(
	backend: SyncBackend,
	retention: number,
): Promise<string[]> {
	// retention 0 (or less) disables pruning, matching local backup retention.
	if (!Number.isInteger(retention) || retention <= 0) return [];
	const entries = await backend.list("snapshots");
	const ids: string[] = [];
	for (const entry of entries) {
		const name = entry.path.split(/[\\/]/).pop() || entry.path;
		if (entry.type !== "file" || !name.endsWith(".zip")) continue;
		ids.push(name.slice(0, -4));
	}
	ids.sort((a, b) => b.localeCompare(a));
	const pruned: string[] = [];
	for (const id of ids.slice(retention)) {
		await backend.delete(`snapshots/${id}.zip`);
		await backend.delete(`snapshots/${id}.json`);
		pruned.push(id);
	}
	return pruned;
}

async function commandRestore(
	agentDir: string,
	context: CommandContext,
	args: string[],
): Promise<CommandResult> {
	const parsed = parseCommandArgs("restore", args);
	requireNoProfileFlag("restore", parsed);
	if (parsed.positional.length > 1)
		throw new Error("restore accepts at most one backup id");
	const config = (await readConfig(agentDir)) ?? defaultConfig();
	const idOrLatest = parsed.positional[0] || "latest";
	const { record, archive } = await loadBackup(agentDir, idOrLatest, config);
	const settingsMode = archiveSettingsMode(archive);
	const diff = await diffArchiveAgainstLocal(agentDir, archive, config, {
		settingsMode,
	});
	const preview: RestorePreview = {
		id: record.id,
		createdAt: record.createdAt,
		profile: record.profile,
		fileCount: archive.manifest.files.length,
		externalResourceCount: archive.manifest.externalResources.length,
		changes: {
			add: diff.add.length,
			modify: diff.modify.length,
			remove: diff.remove.length,
		},
	};
	if (context.confirmRestore && !(await context.confirmRestore(preview))) {
		return ok(
			[`restore: cancelled`, `backup: ${record.id}`].join("\n"),
			preview,
		);
	}
	const backup = await createLocalBackup(
		agentDir,
		config.backupRetention ?? 5,
		config,
	);
	const applied = await applyArchiveWithRollback(
		agentDir,
		archive,
		backup.id,
		config,
	);
	return ok(
		[
			`restore: ${record.id}`,
			record.profile ? `source profile: ${record.profile}` : undefined,
			`safety backup: ${backup.id}`,
			`files: ${applied.filesWritten}`,
			`external: ${applied.externalFilesWritten}`,
			`changes: +${preview.changes.add}/~${preview.changes.modify}/-${preview.changes.remove}`,
		]
			.filter((line): line is string => line !== undefined)
			.join("\n"),
		{ backup, applied, profile: record.profile },
	);
}

async function commandStatus(
	agentDir: string,
	context: CommandContext,
	args: string[],
): Promise<CommandResult> {
	const parsed = parseCommandArgs("status", args);
	if (parsed.positional.length)
		throw new Error("status accepts no positional arguments");
	const config = await requireConfig(agentDir);
	const rootBackend = context.backend || createWebdavBackend(config);
	await assertSupportedLayout(rootBackend);
	const target = await resolveProfileTarget(rootBackend, context, parsed, {
		allowCreate: false,
		requireExisting: false,
	});
	if (!target) return ok("status: cancelled", { cancelled: true });
	const backend = target.backend;
	if (!(await backend.exists("latest.json"))) {
		return ok(
			`status: no remote snapshot for profile ${target.name} (push first)`,
			{ profile: target.name },
		);
	}
	const latest = await backend.getJson<LatestIndex>("latest.json");
	const zipBytes = await backend.getBytes("latest.zip");
	const archive = parseArchive(zipBytes, latest.zipSha256, config);
	validateLatestMatchesManifest(latest, archive);
	const diff = await diffArchiveAgainstLocal(agentDir, archive, config);
	const clean =
		!diff.add.length &&
		!diff.modify.length &&
		!diff.remove.length &&
		!diff.externalAdd.length &&
		!diff.externalModify.length &&
		!diff.externalRemove.length;
	const lines = [
		`status: ${clean ? "up to date" : "local differs from remote"}`,
		`profile: ${target.name}`,
		...(target.legacyRoot
			? [
					"layout: legacy root (migrated automatically on the next push or pull)",
				]
			: []),
		`remote hash: ${shortHash(archive.manifest.contentSha256)}`,
		`changes: +${diff.add.length}/~${diff.modify.length}/-${diff.remove.length}`,
	];
	if (
		diff.externalAdd.length ||
		diff.externalModify.length ||
		diff.externalRemove.length
	) {
		lines.push(
			`external: +${diff.externalAdd.length}/~${diff.externalModify.length}/-${diff.externalRemove.length}`,
		);
	}
	appendPasswordWarning(lines, config);
	return ok(lines.join("\n"), {
		profile: target.name,
		hash: archive.manifest.contentSha256,
		diff,
	});
}

async function commandProfiles(
	agentDir: string,
	context: CommandContext,
	args: string[],
): Promise<CommandResult> {
	const parsed = parseCommandArgs("profiles", args);
	requireNoProfileFlag("profiles", parsed);
	const [subcommand, ...rest] = parsed.positional;
	const config = await requireConfig(agentDir);
	const backend = context.backend || createWebdavBackend(config);
	if (subcommand === "delete")
		return await deleteProfile(
			context,
			backend,
			agentDir,
			config,
			parsed,
			rest,
		);
	if (subcommand === "rename")
		return await renameProfile(context, backend, parsed, rest);
	if (subcommand === "migrate")
		return await migrateLegacyRoot(
			context,
			backend,
			agentDir,
			config,
			parsed,
			rest,
		);
	if (subcommand)
		throw new Error(
			`Unknown profiles subcommand: ${subcommand} (use delete <name>, or rename <old> <new>)`,
		);
	if (parsed.assumeYes)
		throw new Error("--yes is only valid for /webdav-sync:profiles delete");

	const layout = await readRemoteLayout(backend);
	// Bare /webdav-sync:profiles opens an action menu in a TUI so managing profiles
	// never requires remembering the subcommand syntax; "List profiles" falls
	// through to the plain listing below.
	if (context.selectProfile) {
		const actions = layout.legacy
			? [
					...PROFILE_ACTIONS,
					{ id: PROFILE_ACTION_MIGRATE, label: "Migrate legacy layout…" },
				]
			: PROFILE_ACTIONS;
		const action = await context.selectProfile(actions, "WebDAV profiles:");
		if (!action) return ok("profiles: cancelled", { cancelled: true });
		if (action === PROFILE_ACTION_DELETE)
			return await deleteProfile(
				context,
				backend,
				agentDir,
				config,
				parsed,
				[],
			);
		if (action === PROFILE_ACTION_RENAME)
			return await renameProfile(context, backend, parsed, []);
		if (action === PROFILE_ACTION_MIGRATE)
			return await migrateLegacyRoot(
				context,
				backend,
				agentDir,
				config,
				parsed,
				[],
			);
		if (action !== PROFILE_ACTION_LIST)
			throw new Error(`Unknown profiles action: ${action}`);
	}
	const profiles = await listRemoteProfiles(backend);
	if (!profiles.length && !layout.legacy)
		return ok(
			'profiles: none remote yet (use /webdav-sync:push --create-profile <name>)',
			{ profiles },
		);
	const lines = [
		`profiles: ${selectableProfiles(profiles).length}`,
		...profiles.map((profile) => `- ${describeProfile(profile)}`),
	];
	if (layout.legacy)
		lines.push(
			`legacy: ${DEFAULT_PROFILE} data still sits at the remote root; it migrates automatically on the next push or pull (/webdav-sync:profiles migrate to do it now)`,
		);
	return ok(lines.join("\n"), { profiles, layout });
}

async function deleteProfile(
	context: CommandContext,
	rootBackend: SyncBackend,
	agentDir: string,
	config: WebdavSyncConfig,
	parsed: ParsedArgs,
	args: string[],
): Promise<CommandResult> {
	if (args.length > 1)
		throw new Error("profiles delete accepts at most one profile name");
	const pickedName = args.length
		? undefined
		: await pickProfileName(
				rootBackend,
				context,
				"Select the profile to delete:",
			);
	if (args.length === 0 && !pickedName)
		return ok("profiles delete: cancelled", { cancelled: true });
	const target = await resolveProfileWithContent(
		rootBackend,
		pickedName ?? args[0],
	);

	const objects = await profileObjectsFor(rootBackend, target);
	const snapshots = objects.filter((object) =>
		object.path.startsWith("snapshots/"),
	).length;
	let lastUpdated: string | undefined;
	try {
		const latest = await target.backend.getJson<{ createdAt?: string }>(
			"latest.json",
		);
		lastUpdated = latest.createdAt;
	} catch {
		// The preview just omits the timestamp when the index is unreadable.
	}
	const preview: ProfileDeletePreview = {
		profile: target.name,
		objectCount: objects.length,
		snapshotCount: snapshots,
		lastUpdated,
	};
	if (!parsed.assumeYes) {
		if (!context.confirmProfileDelete)
			throw new Error(
				`Deleting profile ${target.name} requires confirmation; re-run with --yes`,
			);
		if (!(await context.confirmProfileDelete(preview)))
			return ok(`profiles delete: cancelled (${target.name})`, preview);
	}

	// Deleting remote data is irreversible, so keep a local, restorable copy of the
	// profile's latest snapshot first; a failed download aborts the delete.
	let backup: BackupRecord | undefined;
	if (
		objects.some((object) => object.path === "latest.zip") &&
		objects.some((object) => object.path === "latest.json")
	) {
		const latest = await target.backend.getJson<unknown>("latest.json");
		const zipBytes = await target.backend.getBytes("latest.zip");
		backup = await saveRemoteArchiveBackup(
			agentDir,
			Buffer.from(zipBytes),
			latest,
			config.backupRetention ?? 5,
			target.name,
		);
	}

	// A profile owns everything inside its directory; the legacy root profile owns
	// only the objects this tool wrote at the remote root, never the root itself.
	await deleteProfileObjects(rootBackend, target, objects);
	return ok(
		[
			`profiles delete: ${target.name}`,
			`objects: ${objects.length}`,
			`snapshots: ${snapshots}`,
			...(backup ? [`backup: ${backup.id}`] : []),
		].join("\n"),
		{ ...preview, backup },
	);
}

async function renameProfile(
	context: CommandContext,
	rootBackend: SyncBackend,
	parsed: ParsedArgs,
	args: string[],
): Promise<CommandResult> {
	if (parsed.assumeYes)
		throw new Error("--yes is only valid for /webdav-sync:profiles delete");
	if (args.length > 2)
		throw new Error("profiles rename accepts at most two profile names");
	const pickedSource = args[0]
		? undefined
		: await pickProfileName(
				rootBackend,
				context,
				"Select the profile to rename:",
			);
	if (!args[0] && !pickedSource)
		return ok("profiles rename: cancelled", { cancelled: true });
	let destinationName = args[1];
	if (!destinationName) {
		if (!context.inputProfileName)
			throw new Error(
				"No profile name input is available; pass the new name as an argument",
			);
		const known = await listRemoteProfiles(rootBackend);
		const input = await context.inputProfileName(
			known.map((profile) => profile.id),
		);
		if (input === undefined)
			return ok("profiles rename: cancelled", { cancelled: true });
		destinationName = input;
	}
	const source = await resolveProfileWithContent(
		rootBackend,
		pickedSource ?? args[0],
	);
	const destination = normalizeProfileName(destinationName);
	if (destination === source.name)
		throw new Error("profiles rename needs two different names");
	if (destination === DEFAULT_PROFILE) {
		const layout = await readRemoteLayout(rootBackend);
		if (layout.legacy) throw new Error(legacyLayoutMessage(destination));
	}
	if (await profileHasContent(rootBackend, destination))
		throw new Error(`Profile already exists: ${destination}`);

	const objects = await profileObjectsFor(rootBackend, source);
	const targetBackend = scopedBackend(rootBackend, profilePrefix(destination));
	// Every profile except the legacy root layout is one directory, so a rename is
	// a single MOVE; the legacy root is copied object by object and servers without
	// MOVE fall back to copy+delete as well.
	let method: "move" | "copy" = "copy";
	if (!source.legacyRoot) {
		try {
			await rootBackend.move(
				profilePrefix(source.name),
				profilePrefix(destination),
			);
			method = "move";
		} catch (error) {
			if (!isMoveUnsupportedRemoteError(error)) throw error;
		}
	}
	if (method === "copy") {
		// Copy every object first and delete the source only once all copies exist.
		for (const object of objects)
			await copyObjectVerified(source.backend, targetBackend, object.path);
		await deleteProfileObjects(rootBackend, source, objects);
	}
	return ok(
		[
			`profiles rename: ${source.name} -> ${destination}`,
			`method: ${method}`,
			`objects: ${objects.length}`,
		].join("\n"),
		{ from: source.name, to: destination, method, objectCount: objects.length },
	);
}

type MigrationOutcome = {
	objects: number;
	snapshots: number;
	method: "move" | "copy";
	backup?: BackupRecord;
};

/**
 * True when the destination copy exists and has the same size as the source.
 * Used to decide whether a leftover object from an interrupted run is usable.
 */
async function sameSize(
	source: SyncBackend,
	target: SyncBackend,
	remotePath: string,
): Promise<boolean> {
	try {
		const expected = await source.getBytes(remotePath);
		const copied = await target.getBytes(remotePath);
		return expected.byteLength === copied.byteLength;
	} catch {
		return false;
	}
}

/**
 * Copies one object and verifies the copy before its source may be removed: the
 * MOVE-less fallback is the only path that deletes data it just wrote.
 */
async function copyObjectVerified(
	source: SyncBackend,
	target: SyncBackend,
	remotePath: string,
): Promise<void> {
	const bytes = await source.getBytes(remotePath);
	await target.putBytes(remotePath, bytes);
	const copied = await target.getBytes(remotePath);
	if (copied.byteLength !== bytes.byteLength)
		throw new Error(
			`copy verification failed for ${remotePath}: wrote ${bytes.byteLength} bytes but read back ${copied.byteLength}`,
		);
}

/**
 * Moves the pre-profile root layout into profiles/default/, one object at a time,
 * idempotently and with latest.json last so the destination only becomes readable
 * once its archive and snapshots are there. A source object is dropped only after a
 * size-verified destination exists, and unrelated root files are never touched.
 */
async function migrateLegacyLayout(
	rootBackend: SyncBackend,
	agentDir: string,
	config: WebdavSyncConfig,
): Promise<MigrationOutcome | undefined> {
	const layout = await readRemoteLayout(rootBackend);
	if (!layout.legacy) return undefined;
	const target = scopedBackend(rootBackend, profilePrefix(DEFAULT_PROFILE));
	if (await target.exists("latest.json"))
		throw new Error(
			"profiles/default already has data while the remote root still holds pre-profile data; delete or rename one of them before continuing",
		);

	const objects = await legacyMigrationOrder(rootBackend);
	const snapshots = objects.filter((object) =>
		object.path.startsWith("snapshots/"),
	).length;

	// Keep a local, restorable copy of the archive before moving anything.
	let backup: BackupRecord | undefined;
	if (
		objects.some((object) => object.path === "latest.zip") &&
		objects.some((object) => object.path === "latest.json")
	) {
		const latest = await rootBackend.getJson<unknown>("latest.json");
		const zipBytes = await rootBackend.getBytes("latest.zip");
		backup = await saveRemoteArchiveBackup(
			agentDir,
			Buffer.from(zipBytes),
			latest,
			config.backupRetention ?? 5,
			DEFAULT_PROFILE,
		);
	}

	let method: "move" | "copy" | undefined;
	let migrated = 0;
	for (const object of objects) {
		if (
			(await target.exists(object.path)) &&
			!(await sameSize(rootBackend, target, object.path))
		) {
			// A previous attempt may have left a partial object; drop it and copy again.
			await target.delete(object.path);
		}
		if (!(await target.exists(object.path))) {
			if (method !== "copy") {
				try {
					await rootBackend.move(
						object.path,
						`${profilePrefix(DEFAULT_PROFILE)}/${object.path}`,
					);
					method = "move";
				} catch (error) {
					if (!isMoveUnsupportedRemoteError(error)) throw error;
					method = "copy";
				}
			}
			if (method === "copy")
				await copyObjectVerified(rootBackend, target, object.path);
			migrated += 1;
		}
		// Drop the source only once a verified destination exists.
		if (await target.exists(object.path))
			await rootBackend.delete(object.path);
	}
	await writeLayoutMarker(rootBackend, { marked: layout.marked, legacy: false });
	return { objects: migrated, snapshots, method: method ?? "copy", backup };
}

/**
 * Migrates the pre-profile layout transparently before a task that already writes
 * to the remote, so nobody has to run the migration command themselves.
 */
async function autoMigrateLegacyLayout(
	rootBackend: SyncBackend,
	agentDir: string,
	config: WebdavSyncConfig,
	lines: string[],
): Promise<boolean> {
	const outcome = await migrateLegacyLayout(rootBackend, agentDir, config);
	if (!outcome) return false;
	lines.push(
		`migrated: default -> ${profilePrefix(DEFAULT_PROFILE)} (${outcome.objects} object(s))`,
	);
	if (outcome.backup) lines.push(`backup: ${outcome.backup.id}`);
	return true;
}

async function migrateLegacyRoot(
	context: CommandContext,
	rootBackend: SyncBackend,
	agentDir: string,
	config: WebdavSyncConfig,
	parsed: ParsedArgs,
	args: string[],
): Promise<CommandResult> {
	if (args.length)
		throw new Error("profiles migrate accepts no arguments");
	const layout = await readRemoteLayout(rootBackend);
	if (!layout.legacy)
		return ok("profiles migrate: nothing to migrate (no data at the remote root)", {
			migrated: 0,
		});
	const objects = await legacyMigrationOrder(rootBackend);
	const preview: ProfileMigratePreview = {
		profile: DEFAULT_PROFILE,
		objectCount: objects.length,
		snapshotCount: objects.filter((object) =>
			object.path.startsWith("snapshots/"),
		).length,
		lastUpdated: await legacyLastUpdated(rootBackend),
	};
	if (!parsed.assumeYes) {
		if (!context.confirmProfileMigrate)
			throw new Error(
				"Migrating the remote layout requires confirmation; re-run with --yes",
			);
		if (!(await context.confirmProfileMigrate(preview)))
			return ok("profiles migrate: cancelled", preview);
	}
	const outcome = await migrateLegacyLayout(rootBackend, agentDir, config);
	if (!outcome)
		return ok("profiles migrate: nothing to migrate (no data at the remote root)", {
			migrated: 0,
		});
	return ok(
		[
			"profiles migrate: done",
			`method: ${outcome.method}`,
			`objects: ${outcome.objects}`,
			`snapshots: ${outcome.snapshots}`,
			...(outcome.backup ? [`backup: ${outcome.backup.id}`] : []),
			`marker: ${LAYOUT_MARKER}`,
		].join("\n"),
		{ ...preview, migrated: outcome.objects, method: outcome.method, backup: outcome.backup },
	);
}

async function legacyLastUpdated(rootBackend: SyncBackend): Promise<string | undefined> {
	try {
		const latest = await rootBackend.getJson<{ createdAt?: string }>("latest.json");
		return latest.createdAt;
	} catch {
		return undefined;
	}
}


async function resolveProfileWithContent(
	rootBackend: SyncBackend,
	name: string,
): Promise<ProfileTarget> {
	const normalized = normalizeProfileName(name);
	if (normalized === DEFAULT_PROFILE) {
		const layout = await readRemoteLayout(rootBackend);
		if (layout.legacy)
			return { name: normalized, backend: rootBackend, created: false, legacyRoot: true };
	}
	if (!(await profileHasContent(rootBackend, normalized)))
		throw new Error(`Profile not found: ${normalized}`);
	return {
		name: normalized,
		backend: scopedBackend(rootBackend, profilePrefix(normalized)),
		created: false,
	};
}

async function profileObjectsFor(
	rootBackend: SyncBackend,
	target: ProfileTarget,
): Promise<ProfileObject[]> {
	return target.legacyRoot
		? await listLegacyDefaultObjects(rootBackend)
		: await listProfileObjects(rootBackend, target.name);
}

async function deleteProfileObjects(
	rootBackend: SyncBackend,
	target: ProfileTarget,
	objects: ProfileObject[],
): Promise<void> {
	if (target.legacyRoot) {
		for (const object of objects) await rootBackend.delete(object.path);
		return;
	}
	await rootBackend.delete(profilePrefix(target.name));
}

const PROFILE_ACTION_LIST = "list";
const PROFILE_ACTION_DELETE = "delete";
const PROFILE_ACTION_RENAME = "rename";
const PROFILE_ACTION_MIGRATE = "migrate";

const PROFILE_ACTIONS: ProfileChoice[] = [
	{ id: PROFILE_ACTION_LIST, label: "List profiles" },
	{ id: PROFILE_ACTION_DELETE, label: "Delete a profile…" },
	{ id: PROFILE_ACTION_RENAME, label: "Rename a profile…" },
];

/**
 * Picks a profile that exists remotely, including directories without a readable
 * index, so an interrupted profile can still be deleted or renamed from the UI.
 */
async function pickProfileName(
	rootBackend: SyncBackend,
	context: CommandContext,
	message: string,
): Promise<string | undefined> {
	if (!context.selectProfile)
		throw new Error(
			"No profile picker is available; pass the profile name as an argument",
		);
	const selectable = selectableProfiles(await listRemoteProfiles(rootBackend));
	const legacy = await legacyDefaultChoice(rootBackend);
	const choices = legacy ? [legacy, ...selectable] : selectable;
	if (!choices.length)
		throw new Error(
			"No selectable remote profile; run /webdav-sync:profiles to see what exists",
		);
	const selectedId = await context.selectProfile(choices, message);
	if (!selectedId) return undefined;
	const selected = choices.find((profile) => profile.id === selectedId);
	if (!selected) throw new Error(`Unknown profile selection: ${selectedId}`);
	return selected.id;
}

/**
 * Resolves the profile a command works on. Explicit flags win; otherwise an
 * available picker is used when the choice is ambiguous (or when a new profile
 * may be created); otherwise the root-backed default profile is used.
 */
async function resolveProfileTarget(
	rootBackend: SyncBackend,
	context: CommandContext,
	parsed: ParsedArgs,
	options: { allowCreate: boolean; requireExisting: boolean },
): Promise<ProfileTarget | undefined> {
	if (parsed.createProfile) {
		return await claimNewProfile(rootBackend, parsed.createProfile);
	}
	if (parsed.profile) return await existingProfileTarget(rootBackend, parsed.profile);

	// A remote whose only usable profile is not "default" must stay reachable
	// without knowing its name, so the sole profile replaces the legacy fallback.
	let soleSelectable: string | undefined;
	if (context.selectProfile) {
		const profiles = await listRemoteProfiles(rootBackend);
		const selectable = selectableProfiles(profiles);
		if (selectable.length === 1) soleSelectable = selectable[0].id;
		if (selectable.length > 1 || options.allowCreate) {
			// Unsupported remote names are reported by /webdav-sync:profiles, never
			// offered here: a row that can only fail is worse than an explained gap.
			const choices = options.allowCreate
				? withCreateChoice(profiles)
				: selectable;
			const selectedId = await context.selectProfile(choices);
			if (!selectedId) return undefined;
			const selected = choices.find((choice) => choice.id === selectedId);
			if (!selected) throw new Error(`Unknown profile selection: ${selectedId}`);
			if (selected.isCreate)
				return await createProfileFromInput(rootBackend, context, profiles);
			if (selected.unsupported)
				throw new Error(`Profile name is not supported: ${selected.id}`);
			return await existingProfileTarget(rootBackend, selected.id);
		}
	}
	return await existingProfileTarget(rootBackend, soleSelectable ?? DEFAULT_PROFILE, {
		requireExisting: options.requireExisting,
	});
}

async function existingProfileTarget(
	rootBackend: SyncBackend,
	name: string,
	options: { requireExisting?: boolean } = {},
): Promise<ProfileTarget> {
	const normalized = normalizeProfileName(name);
	const backend = scopedBackend(rootBackend, profilePrefix(normalized));
	if (normalized === DEFAULT_PROFILE) {
		const layout = await readRemoteLayout(rootBackend);
		// Reading the legacy root in place keeps status read-only; push and pull
		// migrate it first, so they never see this branch.
		if (layout.legacy)
			return {
				name: normalized,
				backend: rootBackend,
				created: false,
				legacyRoot: true,
			};
	}
	if (options.requireExisting !== false && !(await backend.exists("latest.json"))) {
		const hint =
			normalized === DEFAULT_PROFILE
				? await defaultProfileHint(rootBackend)
				: "";
		throw new Error(`Profile not found: ${normalized}${hint}`);
	}
	return { name: normalized, backend, created: false };
}

/** The pre-profile layout kept the default profile at the remote root. */
function legacyLayoutMessage(name: string): string {
	return `The remote still holds pre-profile data at its root for "${name}"; the next push or pull migrates it automatically (or run /webdav-sync:profiles migrate now, or delete it with /webdav-sync:profiles delete ${name} --yes)`;
}

async function defaultProfileHint(rootBackend: SyncBackend): Promise<string> {
	try {
		const others = (await listRemoteProfiles(rootBackend)).filter(
			(profile) => !profile.unsupported,
		);
		if (others.length)
			return ` (remote profiles: ${others
				.map((profile) => profile.id)
				.join(", ")} — pass --profile <name>)`;
	} catch {
		// Fall back to the plain message when the listing itself fails.
	}
	return "";
}

async function createProfileFromInput(
	rootBackend: SyncBackend,
	context: CommandContext,
	knownProfiles: ProfileChoice[],
): Promise<ProfileTarget | undefined> {
	if (!context.inputProfileName)
		throw new Error(
			"No profile name input is available; pass --create-profile <name>",
		);
	const input = await context.inputProfileName(
		knownProfiles.map((profile) => profile.id),
	);
	if (input === undefined) return undefined;
	return await claimNewProfile(rootBackend, normalizeProfileName(input));
}

/**
 * Claims a profile name before anything is uploaded. Every profile is a single
 * directory, so one MKCOL decides the race and exactly one writer can win.
 */
async function claimNewProfile(
	rootBackend: SyncBackend,
	name: string,
): Promise<ProfileTarget> {
	if (name === DEFAULT_PROFILE) {
		const layout = await readRemoteLayout(rootBackend);
		if (layout.legacy) throw new Error(legacyLayoutMessage(name));
	}
	const backend = scopedBackend(rootBackend, profilePrefix(name));
	if (!(await rootBackend.createDirectory(profilePrefix(name))))
		throw new Error(
			`Profile already exists: ${name} (delete it first with /webdav-sync:profiles delete ${name})`,
		);
	return { name, backend, created: true };
}

function appendPasswordWarning(
	lines: string[],
	config: WebdavSyncConfig,
): void {
	if (config.password && !config.passwordEnv) {
		lines.push("warning: config.password is plaintext; prefer passwordEnv");
	}
}

const SNAPSHOT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

async function chooseSnapshot(
	backend: SyncBackend,
	selectSnapshot: ((choices: SnapshotChoice[]) => Promise<string | undefined>) | undefined,
	requestedId?: string,
): Promise<{ id: string; jsonPath: string; zipPath: string } | undefined> {
	if (requestedId) {
		if (!SNAPSHOT_ID_PATTERN.test(requestedId))
			throw new Error(`Invalid snapshot id: ${requestedId}`);
		const requested = snapshotPaths(requestedId);
		if (
			!(await backend.exists(requested.jsonPath)) ||
			!(await backend.exists(requested.zipPath))
		)
			throw new Error(`Snapshot not found: ${requestedId}`);
		return requested;
	}
	// Without a picker the caller must name the snapshot: a listing failure or a
	// single visible snapshot must never turn into a silent destructive pull.
	if (!selectSnapshot)
		throw new Error(
			"No snapshot picker is available; pass an explicit id: /webdav-sync:pull latest or /webdav-sync:pull <id>",
		);
	const choices = await listSnapshots(backend);
	if (choices.length <= 1) return snapshotPaths("latest");
	const selected = await selectSnapshot(choices);
	if (!selected) return undefined;
	if (!SNAPSHOT_ID_PATTERN.test(selected))
		throw new Error(`Invalid snapshot id: ${selected}`);
	return snapshotPaths(selected);
}

async function listSnapshots(backend: SyncBackend): Promise<SnapshotChoice[]> {
	const out: SnapshotChoice[] = [{ id: "latest", label: "latest" }];
	let entries: RemoteListEntry[] = [];
	try {
		entries = await backend.list("snapshots");
	} catch {
		return out;
	}
	for (const entry of entries) {
		const name = entry.path.split(/[\\/]/).pop() || entry.path;
		if (!name.endsWith(".json")) continue;
		const id = name.slice(0, -5);
		out.push({
			id,
			label: `${id}${entry.lastModified ? ` · ${entry.lastModified}` : ""}`,
		});
	}
	return uniqueById(out).sort((a, b) =>
		a.id === "latest" ? -1 : b.id === "latest" ? 1 : b.id.localeCompare(a.id),
	);
}

function snapshotPaths(id: string): {
	id: string;
	jsonPath: string;
	zipPath: string;
} {
	if (id === "latest")
		return { id, jsonPath: "latest.json", zipPath: "latest.zip" };
	const safe = id.replace(/\.json$|\.zip$/g, "");
	return {
		id: safe,
		jsonPath: `snapshots/${safe}.json`,
		zipPath: `snapshots/${safe}.zip`,
	};
}

async function requireConfig(agentDir: string): Promise<WebdavSyncConfig> {
	const config = await readConfig(agentDir);
	if (!config)
		throw new Error(`WebDAV config not found. Create ${configPath(agentDir)}`);
	if (!config.remoteBaseUrl)
		throw new Error("config.remoteBaseUrl is required");
	return config;
}

function validateLatestMatchesManifest(
	latest: LatestIndex,
	archive: ParsedArchive,
): void {
	const expected = createLatestIndex(archive.manifest, new Uint8Array());
	const mismatches: string[] = [];
	if (latest.contentSha256 !== expected.contentSha256)
		mismatches.push("contentSha256");
	if (latest.fileCount !== expected.fileCount) mismatches.push("fileCount");
	if (latest.externalResourceCount !== expected.externalResourceCount)
		mismatches.push("externalResourceCount");
	if (
		JSON.stringify(latest.packageSpecs) !==
		JSON.stringify(expected.packageSpecs)
	)
		mismatches.push("packageSpecs");
	if (mismatches.length)
		throw new Error(
			`latest.json does not match archive manifest: ${mismatches.join(", ")}`,
		);
}

async function settingsJsonFromArchive(
	archive: ParsedArchive,
): Promise<unknown> {
	const bytes = archive.entries.get("files/settings.json");
	if (!bytes) return undefined;
	return JSON.parse(bytes.toString("utf8"));
}

async function shouldInstallPackages(
	specs: string[],
	config: WebdavSyncConfig,
	confirmInstallPackages?: (specs: string[]) => Promise<boolean>,
): Promise<boolean> {
	if (!specs.length) return false;
	if (config.installMissingPackages === "always") return true;
	if (config.installMissingPackages === "never") return false;
	return confirmInstallPackages ? confirmInstallPackages(specs) : false;
}

type InstallResult = {
	spec: string;
	ok: boolean;
	code: number | null;
	skipped?: boolean;
};

async function installPackages(
	specs: string[],
	installPackage = runPiInstall,
	onProgress?: (progress: InstallProgress) => void,
): Promise<InstallResult[]> {
	const results: InstallResult[] = [];
	onProgress?.({ phase: "start", total: specs.length });
	for (const [index, spec] of specs.entries()) {
		onProgress?.({ phase: "package_start", spec, index, total: specs.length });
		if (!isInstallableSpec(spec)) {
			// Specs come from a remote snapshot; never hand an unsafe one to the CLI.
			results.push({ spec, ok: false, code: null, skipped: true });
			onProgress?.({
				phase: "package_done",
				spec,
				index,
				total: specs.length,
				ok: false,
				code: null,
			});
			continue;
		}
		const code = await installPackage(spec);
		const ok = code === 0;
		results.push({ spec, ok, code });
		onProgress?.({
			phase: "package_done",
			spec,
			index,
			total: specs.length,
			ok,
			code,
		});
	}
	onProgress?.({ phase: "done", total: specs.length });
	return results;
}

function templateConfig(): WebdavSyncConfig {
	return {
		...defaultConfig(),
		remoteBaseUrl: "https://dav.example.com/dav/",
		username: "your-email@example.com",
		passwordEnv: "PI_WEBDAV_PASSWORD",
		remoteDir: "/pi-agent-sync",
		extraFiles: [],
		extraDirs: [],
	};
}

async function loadRemoteInitConfigText(
	url: string,
	context: CommandContext,
): Promise<string> {
	if (!/^https?:\/\//i.test(url)) {
		throw new Error(
			"init remote config URL must start with http:// or https://",
		);
	}
	const value = context.fetchRemoteConfig
		? await context.fetchRemoteConfig(url)
		: await fetchRemoteText(url);
	return remoteConfigText(value);
}

async function fetchRemoteText(url: string): Promise<string> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to fetch remote config: HTTP ${response.status}`);
	}
	return response.text();
}

function remoteConfigText(value: unknown): string {
	if (typeof value === "string") {
		try {
			return `${JSON.stringify(validateConfig(JSON.parse(value)), null, 2)}\n`;
		} catch {
			return value.endsWith("\n") ? value : `${value}\n`;
		}
	}
	return `${JSON.stringify(validateConfig(value), null, 2)}\n`;
}

async function writeRemoteConfigText(
	agentDir: string,
	content: string,
): Promise<void> {
	await fs.mkdir(configDir(agentDir), { recursive: true });
	await fs.writeFile(configPath(agentDir), content, "utf8");
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

const PI_PACKAGE_NAMES = new Set([
	"@earendil-works/pi-coding-agent",
	"@mariozechner/pi-coding-agent",
]);

export type PiInvocation = { command: string; args: string[] };

/**
 * Resolves the pi CLI from verified package metadata instead of trusting
 * process.argv[1]: in SDK, test, or wrapper contexts that path can belong to an
 * unrelated host program, and re-running it with "install" arguments would be
 * both wrong and potentially recursive. Fails closed when the candidate is not
 * part of a known pi package, and callers then report that the install has to be
 * run manually.
 */
export function resolvePiInvocation(
	candidate: string | undefined = process.argv[1],
): PiInvocation | undefined {
	if (!candidate) return undefined;
	const entry = realFileOf(candidate);
	if (!entry) return undefined;
	const pkg = piPackageOf(path.dirname(entry));
	if (!pkg || !PI_PACKAGE_NAMES.has(pkg.name)) return undefined;
	if (!pkg.bin) return undefined;
	const declared = path.resolve(pkg.dir, pkg.bin);
	if (!pathInside(pkg.dir, declared)) return undefined;
	const declaredEntry = realFileOf(declared);
	if (!declaredEntry || !samePath(declaredEntry, entry)) return undefined;
	// The declared entry may itself be a symlink; it must still resolve inside the
	// package after realpath, otherwise the package could point outside itself.
	const realPackageDir = realDirOf(pkg.dir);
	if (!realPackageDir) return undefined;
	if (!pathInside(realPackageDir, declaredEntry)) return undefined;
	return { command: process.execPath, args: [entry] };
}

function realFileOf(candidate: string): string | undefined {
	try {
		const resolved = realpathSync(candidate);
		return statSync(resolved).isFile() ? resolved : undefined;
	} catch {
		return undefined;
	}
}

function realDirOf(directory: string): string | undefined {
	try {
		return realpathSync(directory);
	} catch {
		return undefined;
	}
}

type PiPackage = { name: string; dir: string; bin?: string };

/**
 * Finds the nearest package.json above the candidate. Only that package's
 * declared CLI entry may be executed, so an unrelated script inside a pi
 * checkout (or a bin pointing outside the package) is rejected.
 */
function piPackageOf(startDir: string): PiPackage | undefined {
	let current = path.resolve(startDir);
	for (let depth = 0; depth < 40; depth += 1) {
		try {
			const parsed = JSON.parse(
				readFileSync(path.join(current, "package.json"), "utf8"),
			) as { name?: unknown; bin?: unknown };
			if (typeof parsed.name !== "string") return undefined;
			return {
				name: parsed.name,
				dir: current,
				bin: binEntryOf(parsed.bin),
			};
		} catch {
			// Keep walking up towards the filesystem root.
		}
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
	return undefined;
}

function binEntryOf(bin: unknown): string | undefined {
	// Object form is npm's usual shape; the command must be named "pi".
	if (bin && typeof bin === "object" && !Array.isArray(bin)) {
		const value = (bin as Record<string, unknown>).pi;
		return typeof value === "string" ? value : undefined;
	}
	// String shorthand means "the package's single CLI entry".
	return typeof bin === "string" ? bin : undefined;
}

function samePath(a: string, b: string): boolean {
	return process.platform === "win32"
		? a.toLowerCase() === b.toLowerCase()
		: a === b;
}

function runPiInstall(spec: string): Promise<number | null> {
	return runPiInstallWith(spec, resolvePiInvocation());
}

/** Runs "pi install <spec>" with an explicit invocation, never through a shell. */
export function runPiInstallWith(
	spec: string,
	invocation: PiInvocation | undefined,
): Promise<number | null> {
	if (!invocation) return Promise.resolve(null);
	return new Promise((resolve) => {
		const child = spawn(
			invocation.command,
			[...invocation.args, "install", spec],
			{ stdio: "ignore", shell: false },
		);
		child.on("error", () => resolve(-1));
		child.on("close", (code) => resolve(code));
	});
}

function parseCommandArgs(command: string, args: string[]): ParsedArgs {
	const parsed: ParsedArgs = { positional: [] };
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--profile") {
			const value = args[index + 1];
			if (!value || value.startsWith("-"))
				throw new Error("--profile requires a profile name");
			if (parsed.profile !== undefined)
				throw new Error("--profile was given more than once");
			parsed.profile = normalizeProfileName(value);
			index += 1;
			continue;
		}
		if (arg === "--create-profile") {
			if (command !== "push")
				throw new Error(
					"--create-profile is only valid for /webdav-sync:push",
				);
			const value = args[index + 1];
			if (!value || value.startsWith("-"))
				throw new Error("--create-profile requires a profile name");
			if (parsed.createProfile !== undefined)
				throw new Error("--create-profile was given more than once");
			parsed.createProfile = normalizeProfileName(value);
			index += 1;
			continue;
		}
		if (arg === "--yes") {
			if (command !== "profiles")
				throw new Error("--yes is only valid for /webdav-sync:profiles delete");
			parsed.assumeYes = true;
			continue;
		}
		if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
		parsed.positional.push(arg);
	}
	if (parsed.profile && parsed.createProfile)
		throw new Error("--profile and --create-profile cannot be combined");
	return parsed;
}

function requireNoProfileFlag(command: string, parsed: ParsedArgs): void {
	if (parsed.profile)
		throw new Error(
			`/webdav-sync:${command} is not profile-scoped; remove --profile`,
		);
}

function normalizeCommand(
	raw?: string,
): "init" | "push" | "pull" | "restore" | "status" | "profiles" | "help" {
	const value = (raw || "").replace(/^webdav-sync:/, "").replace(/^:/, "");
	if (value === "init") return "init";
	if (value === "push") return "push";
	if (value === "pull") return "pull";
	if (value === "restore") return "restore";
	if (value === "status") return "status";
	if (value === "profiles") return "profiles";
	return "help";
}

function uniqueById(items: SnapshotChoice[]): SnapshotChoice[] {
	const seen = new Set<string>();
	return items.filter((item) => {
		if (seen.has(item.id)) return false;
		seen.add(item.id);
		return true;
	});
}

function snapshotIdFromDate(date: Date): string {
	return date.toISOString().replace(/[:.]/g, "-");
}

function ok(text: string, data?: unknown): CommandResult {
	return { ok: true, text, data };
}

function fail(text: string): CommandResult {
	return { ok: false, text };
}

function helpText(): string {
	return [
		"/webdav-sync:init [https-url]",
		"/webdav-sync:push [--profile <name> | --create-profile <name>]",
		"/webdav-sync:pull [--profile <name>] [snapshot-id|latest]",
		"/webdav-sync:restore [backup-id]",
		"/webdav-sync:status [--profile <name>]",
		"/webdav-sync:profiles [delete <name> [--yes] | rename <old> [new] | migrate [--yes]]",
	].join("\n");
}

function splitArgs(input: string): string[] {
	return input.trim().split(/\s+/).filter(Boolean);
}
