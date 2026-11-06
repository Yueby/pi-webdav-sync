import type { CommandContext, CommandResult } from "./commands.js";
import { choosePathsFallback } from "./path-select.js";
import { importCatalog } from "./import-plan.js";
import { redactPackageSpec } from "./package-specs.js";
import { createTreePickerState, SYNC_BACK, SYNC_CANCEL, type TreePickerState } from "./tree-picker.js";

class NavigationSignal extends Error {
	constructor(readonly direction: "back" | "cancel") {
		super(direction);
	}
}

export function isNavigationSignal(error: unknown): boolean {
	return error instanceof NavigationSignal;
}

/** Used by the persistent UI to interrupt planning before any commit side effect. */
export function interruptSyncNavigation(direction: "back" | "cancel"): never {
	throw new NavigationSignal(direction);
}

/**
 * A command-local trail of visited prompts. Back replays read-only planning up
 * to the preceding prompt, while retaining each tree's selections and cursor.
 * Commit code must run only after the final prompt returns successfully.
 */
export async function runSyncNavigation(
	context: CommandContext,
	direction: "push" | "pull",
	operation: (navigable: CommandContext) => Promise<CommandResult>,
): Promise<CommandResult> {
	if (!context.selectStep) {
		context.onSyncPhase?.("planning");
		return operation(context);
	}
	const trail: Array<{ key: string; value: unknown; signature?: string }> = [];
	const previousAnswers = new Map<string, unknown>();
	const trees = new Map<string, TreePickerState>();
	let cursor = 0;
	let scope: Parameters<NonNullable<CommandContext["setSyncScope"]>>[0] = {};
	const scopeKey = () => JSON.stringify([direction, scope.profile, scope.snapshot, scope.sourceRevision, scope.destinationRevision, scope.category]);
	async function step<T>(key: string, ask: (previous: unknown) => Promise<T>, undefinedIsBack = false, signature?: string): Promise<T> {
		const position = cursor++;
		if (trail[position]?.key === key && trail[position].signature === signature) return trail[position].value as T;
		trail.length = position;
		const value = await ask(previousAnswers.get(key));
		if (value === SYNC_BACK || (value === undefined && undefinedIsBack)) throw new NavigationSignal("back");
		if (value === SYNC_CANCEL || value === undefined) throw new NavigationSignal("cancel");
		previousAnswers.set(key, value);
		trail[position] = { key, value, signature };
		trail.length = position + 1;
		return value;
	}
	const menu = async (choices: Array<{ id: string; label: string }>, message = "Select WebDAV profile:", stepId = "profile") =>
		step(`${scopeKey()}:menu:${stepId}:${choices.map((choice) => choice.id).join("\0")}`, (previous) =>
			context.selectStep!(choices, message, typeof previous === "string" ? previous : undefined), false, message);
	const navigable: CommandContext = {
		...context,
		setSyncScope: (patch) => { scope = { ...scope, ...patch }; },
		selectProfile: menu,
		selectSnapshot: (choices) => menu(choices, "Select WebDAV snapshot:", "snapshot"),
		inputProfileName: context.inputProfileName
			? (existing) => step(`${scopeKey()}:name:${existing.join("\0")}`, (previous) => context.inputProfileName!(existing, typeof previous === "string" ? previous : undefined), true)
			: undefined,
		confirmPush: async (preview) => (await menu([
			{ id: "apply", label: `✓ Upload to profile ${preview.profile}` },
		], [
			`Push Pi config to profile ${preview.profile}?`,
			`Files: ${preview.fileCount}; external resources: ${preview.externalResourceCount}; packages: ${preview.packageSpecs.length}`,
			`Hash: ${preview.hash}`,
			...preview.warnings,
		].join("\n"), "push-review")) === "apply",
		confirmInstallPackages: async (specs, mode) => (await menu([
			{ id: "install", label: "Install selected packages" },
			{ id: "skip", label: "Continue without installing packages" },
		], [mode === "import" ? "Install or update selected plugin packages?" : "Install missing Pi packages?", ...specs.map(redactPackageSpec)].join("\n"), "packages")) === "install",
		choosePaths: async (profileName, files, presentation) => {
			const key = `${scopeKey()}:tree:${profileName}:${files.join("\0")}`;
			let state = trees.get(key);
			if (!state) { state = createTreePickerState(files); trees.set(key, state); }
			const options = { ...presentation, allowBack: true, state };
			return step(key, async () => {
				let value;
				try {
					if (!context.choosePaths) throw new Error("Custom picker unavailable");
					value = await context.choosePaths(profileName, files, options);
				} catch (error) {
					if (!(error instanceof Error) || error.message !== "Custom picker unavailable") throw error;
					value = await choosePathsFallback(
						(choices, message) => context.selectStep!(choices, message ?? "Select files:"),
						profileName, importCatalog(files), options,
					);
				}
				if (Array.isArray(value)) state!.selected = [...value];
				return value;
			});
		},
	};
	for (;;) {
		cursor = 0;
		scope = {};
		try {
			context.onSyncPhase?.("planning");
			return await operation(navigable);
		}
		catch (error) {
			if (!(error instanceof NavigationSignal)) throw error;
			if (error.direction === "cancel" || trail.length === 0)
				return { ok: true, text: `${direction}: cancelled; nothing was synchronized`, data: { cancelled: true } };
			// Esc pops each visited step; one more Esc at the root closes the wizard.
			trail.pop();
		}
	}
}
