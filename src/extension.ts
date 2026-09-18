import { redactPackageSpec } from "./package-specs.js";
import type { ProfileChoice } from "./profiles.js";
import type { TreePickerTheme } from "./tree-picker.js";
import {
	runWebdavSyncCommand,
	type InstallProgress,
	type ProfileDeletePreview,
	type ProfileMigratePreview,
	type PushPreview,
	type RestorePreview,
	type SnapshotChoice,
} from "./commands.js";

type CommandUiContext = {
	ui?: {
		notify?: (message: string, level?: "info" | "error" | "warning") => unknown;
		select?: (
			message: string,
			choices: string[],
		) => Promise<string | undefined>;
		input?: (
			message: string,
			placeholder?: string,
		) => Promise<string | undefined>;
		confirm?: (title: string, message: string) => Promise<boolean>;
		setStatus?: (key: string, text: string | undefined) => void;
	};
};

type PiLike = {
	registerCommand?: (
		name: string,
		definition: {
			description?: string;
			handler: (args?: unknown, ctx?: CommandUiContext) => unknown;
		},
	) => unknown;
};

export function activate(pi: PiLike): void {
	register(
		pi,
		"webdav-sync:init",
		"Create WebDAV sync config template",
		"init",
	);
	register(
		pi,
		"webdav-sync:push",
		"Upload Pi config to a WebDAV profile",
		"push",
	);
	register(
		pi,
		"webdav-sync:pull",
		"Download Pi config from a WebDAV profile",
		"pull",
	);
	register(
		pi,
		"webdav-sync:restore",
		"Restore local WebDAV sync backup",
		"restore",
	);
	register(
		pi,
		"webdav-sync:status",
		"Compare local Pi config with a WebDAV profile",
		"status",
	);
	register(pi, "webdav-sync:profiles", "Manage WebDAV sync profiles (interactive menu)", "profiles");
}

function register(
	pi: PiLike,
	name: string,
	description: string,
	command: "init" | "push" | "pull" | "restore" | "status" | "profiles",
): void {
	pi.registerCommand?.(name, {
		description,
		handler: async (args, ctx) => {
			const input = [command, ...commandInput(args)];
			const statusKey = "webdav-sync";
			const setStatus = (text: string | undefined) =>
				ctx?.ui?.setStatus?.(statusKey, text);
			try {
				const result = await runWebdavSyncCommand(input, {
					confirmPush:
						command === "push" && ctx?.ui?.confirm
							? async (preview: PushPreview) =>
									ctx.ui?.confirm?.(
										`Push Pi config to profile ${preview.profile}?`,
										formatPushPreview(preview),
									) ?? false
							: undefined,
					confirmOverwriteConfig:
						command === "init" && ctx?.ui?.confirm
							? async (path: string) =>
									ctx.ui?.confirm?.(
										"Overwrite WebDAV config?",
										`Config already exists:\n${path}\n\nOverwrite it with the template?`,
							) ?? false
						: undefined,
					confirmProfileMigrate:
						command === "profiles" && ctx?.ui?.confirm
							? async (preview: ProfileMigratePreview) =>
									ctx.ui?.confirm?.(
										"Migrate the remote to the profiles/ layout?",
										formatProfileMigratePreview(preview),
									) ?? false
							: undefined,
					confirmProfileDelete:
						command === "profiles" && ctx?.ui?.confirm
							? async (preview: ProfileDeletePreview) =>
									ctx.ui?.confirm?.(
										`Delete remote profile ${preview.profile}?`,
										formatProfileDeletePreview(preview),
									) ?? false
							: undefined,
					confirmRestore:
						command === "restore" && ctx?.ui?.confirm
							? async (preview: RestorePreview) =>
									ctx.ui?.confirm?.(
										"Restore local WebDAV sync backup?",
										formatRestorePreview(preview),
									) ?? false
							: undefined,
					selectProfile: ctx?.ui?.select
						? async (choices: ProfileChoice[], message?: string) => {
								const labels = choices.map((choice) => choice.label);
								const selected = await ctx.ui?.select?.(
									message ?? "Select WebDAV profile:",
									labels,
								);
								return choices.find((choice) => choice.label === selected)?.id;
							}
						: undefined,
					inputProfileName: ctx?.ui?.input
						? async (existing: string[]) =>
								(await ctx.ui?.input?.(
									"New WebDAV profile name:",
									existing.length
										? `existing: ${existing.join(", ")}`
										: "lowercase letters, digits, dot, dash, underscore",
								)) ?? undefined
						: undefined,
					choosePaths:
						ctx?.ui
							? async (profileName: string, files: string[]) => {
									// Space selects, Enter expands/enters, Esc cancels.
									const { createTreePickerComponent } = await import(
										"./tree-picker.js"
									);
									const ui = ctx.ui as unknown as {
										custom?: <T>(
											factory: (
												tui: unknown,
												theme: unknown,
												keybindings: unknown,
												done: (value: T) => void,
											) => {
												render(width: number): string[];
												handleInput?(data: string): void;
												invalidate(): void;
											},
										) => Promise<T | undefined>;
									};
									if (!ui.custom) return undefined;
									return await ui.custom<string[] | undefined>(
										(tui, theme, _keybindings, done) => {
											const rows = (tui as { terminal?: { rows?: number } })
												?.terminal?.rows;
											return createTreePickerComponent(
												profileName,
												files,
												done,
												{
													theme: theme as TreePickerTheme,
													height:
														typeof rows === "number" && rows > 0
															? rows
															: undefined,
												},
											);
										},
									);
								}
							: undefined,
					selectSnapshot: ctx?.ui?.select
						? async (choices: SnapshotChoice[]) => {
								const labels = choices.map((choice) => choice.label);
								const selected = await ctx.ui?.select?.(
									"Select WebDAV snapshot:",
									labels,
								);
								return choices.find((choice) => choice.label === selected)?.id;
							}
						: undefined,
					confirmInstallPackages: ctx?.ui?.confirm
						? async (specs: string[]) =>
								ctx.ui?.confirm?.(
									"Install Pi packages this machine is missing?",
									formatInstallPrompt(specs),
								) ?? false
						: undefined,
					onInstallProgress: (progress) =>
						setStatus(formatInstallProgress(progress)),
				});
				ctx?.ui?.notify?.(result.text, result.ok ? "info" : "error");
				return result.text;
			} finally {
				setStatus(undefined);
			}
		},
	});
}

/**
 * Body of the package confirmation: only specs that this machine is missing reach
 * here, so the wording never claims the snapshot simply lists them.
 */
export function formatInstallPrompt(specs: string[]): string {
	return [
		`The snapshot lists ${specs.length} package(s) that are not installed here:`,
		...specs.map(redactPackageSpec),
	].join("\n");
}

function formatPushPreview(preview: PushPreview): string {
	const lines = [
		"This will overwrite latest.zip/latest.json and create a new snapshot.",
		`Files: ${preview.fileCount}`,
		`External resources: ${preview.externalResourceCount}`,
		`Packages: ${preview.packageSpecs.length}`,
		`Hash: ${preview.hash}`,
	];
	if (preview.warnings.length) {
		lines.push("", "Warnings:", ...preview.warnings.slice(0, 5));
		if (preview.warnings.length > 5) {
			lines.push(`...and ${preview.warnings.length - 5} more warning(s)`);
		}
	}
	return lines.join("\n");
}

function formatProfileMigratePreview(preview: ProfileMigratePreview): string {
	return [
		`This moves the pre-profile data at the remote root into "${preview.profile}".`,
		`Objects: ${preview.objectCount}`,
		`Snapshots: ${preview.snapshotCount}`,
		preview.lastUpdated ? `Last updated: ${preview.lastUpdated}` : undefined,
		"A local backup is stored first, and unrelated files at the remote root are not touched.",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

function formatProfileDeletePreview(preview: ProfileDeletePreview): string {
	return [
		`This deletes the remote profile "${preview.profile}" from the WebDAV server.`,
		`Objects: ${preview.objectCount}`,
		`Snapshots: ${preview.snapshotCount}`,
		preview.lastUpdated ? `Last updated: ${preview.lastUpdated}` : undefined,
		"Local Pi files are not touched.",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

function formatRestorePreview(preview: RestorePreview): string {
	return [
		`This will overwrite the local allowlist state with backup ${preview.id}.`,
		`Backup created: ${preview.createdAt}`,
		preview.profile ? `Source profile: ${preview.profile}` : undefined,
		`Files: ${preview.fileCount}`,
		`External resources: ${preview.externalResourceCount}`,
		`Changes: +${preview.changes.add}/~${preview.changes.modify}/-${preview.changes.remove}`,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

export function formatInstallProgress(progress: InstallProgress): string {
	const done = completedInstallCount(progress);
	const bar = progressBar(done, progress.total);
	if (progress.phase === "start") {
		return `${bar} 0/${progress.total} installing packages`;
	}
	if (progress.phase === "done") {
		return `${bar} ${progress.total}/${progress.total} packages installed`;
	}
	const current = (progress.index ?? 0) + 1;
	if (progress.phase === "package_start") {
		return `${bar} ${done}/${progress.total} installing ${current}: ${redactedSpec(progress)}`;
	}
	const marker = progress.ok ? "ok" : "failed";
	return `${bar} ${done}/${progress.total} ${marker}: ${redactedSpec(progress)}`;
}

function redactedSpec(progress: InstallProgress): string {
	return redactPackageSpec(progress.spec ?? "");
}

function completedInstallCount(progress: InstallProgress): number {
	if (progress.phase === "done") return progress.total;
	if (progress.phase === "package_done") return (progress.index ?? 0) + 1;
	return progress.index ?? 0;
}

function progressBar(done: number, total: number): string {
	const width = 12;
	const safeTotal = Math.max(total, 1);
	const filled = Math.max(
		0,
		Math.min(width, Math.round((done / safeTotal) * width)),
	);
	return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function commandInput(args: unknown): string[] {
	if (typeof args === "string") return splitArgs(args);
	if (Array.isArray(args) && args.every((item) => typeof item === "string"))
		return args;
	if (args && typeof args === "object") {
		const record = args as Record<string, unknown>;
		if (
			Array.isArray(record.args) &&
			record.args.every((item) => typeof item === "string")
		)
			return record.args;
		if (typeof record.input === "string") return splitArgs(record.input);
		if (typeof record.prompt === "string") return splitArgs(record.prompt);
	}
	return [];
}

function splitArgs(input: string): string[] {
	return input.trim().split(/\s+/).filter(Boolean);
}

export default activate;
