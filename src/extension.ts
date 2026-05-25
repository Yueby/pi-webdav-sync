import {
	runWebdavSyncCommand,
	type InstallProgress,
	type SnapshotChoice,
} from "./commands.js";

type CommandUiContext = {
	ui?: {
		notify?: (message: string, level?: "info" | "error" | "warning") => unknown;
		select?: (
			message: string,
			choices: string[],
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
	register(pi, "webdav-sync:push", "Upload Pi config to WebDAV", "push");
	register(pi, "webdav-sync:pull", "Download Pi config from WebDAV", "pull");
}

function register(
	pi: PiLike,
	name: string,
	description: string,
	command: "push" | "pull",
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
									"Install missing Pi packages?",
									[
										`Pull found ${specs.length} package(s) in the snapshot:`,
										...specs,
									].join("\n"),
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

function formatInstallProgress(progress: InstallProgress): string {
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
		return `${bar} ${done}/${progress.total} installing ${current}: ${progress.spec}`;
	}
	const marker = progress.ok ? "ok" : "failed";
	return `${bar} ${done}/${progress.total} ${marker}: ${progress.spec}`;
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
