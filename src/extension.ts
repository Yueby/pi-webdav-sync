import { runWebdavSyncCommand } from "./commands.js";

type CommandUiContext = {
	ui?: {
		notify?: (message: string, level?: "info" | "error" | "warning") => unknown;
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
	pi.registerCommand?.("webdav-sync", {
		description: "Sync Pi agent settings via WebDAV",
		handler: async (args, ctx) => {
			const result = await runWebdavSyncCommand(commandInput(args));
			ctx?.ui?.notify?.(result.text, result.ok ? "info" : "error");
			return result.text;
		},
	});
}

function commandInput(args: unknown): string | string[] {
	if (typeof args === "string") return args;
	if (Array.isArray(args) && args.every((item) => typeof item === "string"))
		return args;
	if (args && typeof args === "object") {
		const record = args as Record<string, unknown>;
		if (
			Array.isArray(record.args) &&
			record.args.every((item) => typeof item === "string")
		)
			return record.args;
		if (typeof record.input === "string") return record.input;
		if (typeof record.prompt === "string") return record.prompt;
	}
	return [];
}

export default activate;
