import { runWebdavSyncCommand, type SnapshotChoice } from "./commands.js";

type CommandUiContext = {
	ui?: {
		notify?: (message: string, level?: "info" | "error" | "warning") => unknown;
		select?: (message: string, choices: string[]) => Promise<string | undefined>;
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

function register(pi: PiLike, name: string, description: string, command: "push" | "pull"): void {
	pi.registerCommand?.(name, {
		description,
		handler: async (args, ctx) => {
			const input = [command, ...commandInput(args)];
			const result = await runWebdavSyncCommand(input, {
				selectSnapshot: ctx?.ui?.select
					? async (choices: SnapshotChoice[]) => {
							const labels = choices.map((choice) => choice.label);
							const selected = await ctx.ui?.select?.("Select WebDAV snapshot:", labels);
							return choices.find((choice) => choice.label === selected)?.id;
						}
					: undefined,
			});
			ctx?.ui?.notify?.(result.text, result.ok ? "info" : "error");
			return result.text;
		},
	});
}

function commandInput(args: unknown): string[] {
	if (typeof args === "string") return splitArgs(args);
	if (Array.isArray(args) && args.every((item) => typeof item === "string")) return args;
	if (args && typeof args === "object") {
		const record = args as Record<string, unknown>;
		if (Array.isArray(record.args) && record.args.every((item) => typeof item === "string")) return record.args;
		if (typeof record.input === "string") return splitArgs(record.input);
		if (typeof record.prompt === "string") return splitArgs(record.prompt);
	}
	return [];
}

function splitArgs(input: string): string[] {
	return input.trim().split(/\s+/).filter(Boolean);
}

export default activate;
