import type { CommandContext, CommandResult, InstallProgress } from "./commands.js";
import { normalizeProfileName } from "./profiles.js";
import { createSyncSession, type SyncSession } from "./sync-session.js";
import { interruptSyncNavigation } from "./sync-navigation.js";
import type { TreePickerTheme } from "./tree-picker.js";

export type SyncRootComponent = {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
	dispose?(): void;
};

export type SyncCustomUi = {
	custom<T>(factory: (
		tui: { requestRender(): void; terminal?: { rows?: number } },
		theme: unknown,
		keybindings: unknown,
		done: (value: T) => void,
	) => SyncRootComponent): Promise<T | undefined>;
};

/** Own exactly one host custom screen for the whole asynchronous sync command. */
export async function runPersistentSync(
	ui: SyncCustomUi,
	direction: "push" | "pull",
	base: CommandContext,
	execute: (context: CommandContext) => Promise<CommandResult>,
): Promise<CommandResult> {
	let session: SyncSession | undefined;
	let operation: Promise<CommandResult> | undefined;
	let hostClosed = false;
	let disposed = false;
	let started = false;
	let finished = false;
	const cancelled = (): CommandResult => ({ ok: true, text: `${direction}: cancelled; nothing was synchronized`, data: { cancelled: true } });
	let value: CommandResult | undefined;
	try {
		value = await ui.custom<CommandResult>((tui, theme, _keybindings, done) => {
			session = createSyncSession({
				direction,
				theme: theme as TreePickerTheme,
				height: () => tui.terminal?.rows,
				requestRender: () => { if (!hostClosed && !disposed) tui.requestRender(); },
				interrupt: interruptSyncNavigation,
				validateName: normalizeProfileName,
			});
			const current = session;
			const finish = (result: CommandResult) => {
				if (finished) return;
				finished = true;
				current.dispose();
				if (!hostClosed && !disposed) done(result);
			};
			const context: CommandContext = {
				...base,
				selectStep: (choices, message, initialId) => current.selectStep(choices, message, initialId),
				choosePaths: (profile, files, presentation) => current.choosePaths(profile, files, presentation),
				inputProfileName: (existing, initialValue) => current.inputProfileName(existing, initialValue),
				onSyncPhase: (phase, message) => {
					current.onPhase(phase, message);
					base.onSyncPhase?.(phase, message);
				},
				onInstallProgress: (progress: InstallProgress) => {
					current.setProgress(`Packages: ${progress.phase}${progress.index === undefined ? "" : ` ${progress.index + 1}/${progress.total}`}`);
					base.onInstallProgress?.(progress);
				},
			};
			const start = () => {
				if (hostClosed || disposed) return;
				operation = Promise.resolve().then(() => hostClosed || disposed ? cancelled() : execute(context)).catch((error: unknown): CommandResult => ({
					ok: false,
					text: error instanceof Error ? error.message : "Synchronization failed",
				}));
				void operation.then(finish);
			};
			return {
				render(width) {
					const lines = current.component.render(width);
					// Start only after the host has rendered the mounted root, never from
					// the factory or synchronously from render itself.
					if (!started) { started = true; queueMicrotask(start); }
					return lines;
				},
				handleInput: (data) => current.component.handleInput(data),
				invalidate: () => current.component.invalidate(),
				dispose() { disposed = true; current.dispose(); },
			};
		});
	} catch (error) {
		hostClosed = true;
		session?.dispose();
		// If the host tears down a running screen, wait for its cancellation gate
		// or an already-started commit; never report a fictitious rollback.
		if (operation) return await operation;
		return { ok: false, text: error instanceof Error ? error.message : "Unable to open synchronization interface" };
	} finally {
		hostClosed = true;
		session?.dispose();
	}
	return value ?? (operation ? await operation : cancelled());
}
