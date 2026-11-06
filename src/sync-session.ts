import {
	createSyncMenuComponent,
	type SyncMenuOptions,
} from "./sync-menu.js";
import {
	createTreePickerComponent,
	ROW_RESET,
	SYNC_BACK,
	SYNC_CANCEL,
	truncateToWidth,
	type PickerPresentation,
	type PickerSelection,
	type TreePickerOptions,
	type TreePickerTheme,
} from "./tree-picker.js";

export { SYNC_BACK, SYNC_CANCEL };

export type SyncSessionOptions = {
	direction: "push" | "pull";
	theme?: TreePickerTheme;
	height?: () => number | undefined;
	requestRender: () => void;
	interrupt: (action: "back" | "cancel") => never;
	validateName?: (value: string) => string;
};

export type SyncSession = {
	component: {
		render(width: number): string[];
		handleInput(data: string): void;
		invalidate(): void;
	};
	selectStep(
		choices: Array<{ id: string; label: string }>,
		message: string,
		initialId?: string,
	): Promise<string | undefined>;
	choosePaths(
		profileName: string,
		files: string[],
		presentation?: PickerPresentation,
	): Promise<PickerSelection>;
	inputProfileName(
		existing: string[],
		initialValue?: string,
	): Promise<string | undefined>;
	onPhase(phase: "planning" | "committing", message?: string): void;
	setProgress(message: string): void;
	dispose(): void;
};

type ActiveView =
	| { type: "loading" }
	| {
			type: "menu";
			render: (width: number) => string[];
			handleInput: (data: string) => void;
			options?: SyncMenuOptions;
	  }
	| {
			type: "tree";
			render: (width: number) => string[];
			handleInput: (data: string) => void;
			options?: TreePickerOptions;
	  }
	| { type: "input" };

export function createSyncSession(options: SyncSessionOptions): SyncSession {
	const theme = options.theme;
	let disposed = false;
	let committing = false;
	let ticket = 0;

	// Queued navigation actions received while in loading state with no active page prompt
	let queuedBackCount = 0;
	let queuedCancel = false;

	// Navigation resolution callbacks for the currently active prompt
	let pendingResolver:
		| ((value: string | PickerSelection | undefined) => void)
		| null = null;
	let activeView: ActiveView = { type: "loading" };

	// Loading view state
	let subtitle = "Loading…";

	// Profile name input state
	let nameDraft = "";
	let nameCursor = 0;
	let nameError: string | null = null;
	let currentExistingNames: string[] = [];

	function currentHeight(): number {
		return options.height?.() ?? 24;
	}

	function renderLoading(width: number): string[] {
		const totalHeight = Math.max(4, currentHeight());
		const lines: string[] = [];
		const headlineText = `WebDAV sync (${options.direction})`;
		const headLine = theme ? theme.bold(headlineText) : headlineText;
		lines.push(truncateToWidth(` ${headLine}`, width, "…", ROW_RESET));
		lines.push("");

		if (committing) {
			const status = "Synchronizing…";
			lines.push(
				truncateToWidth(
					` ${theme?.bold ? theme.bold(status) : status}`,
					width,
					"…",
					ROW_RESET,
				),
			);
			const progText = subtitle || "Applying changes…";
			lines.push(
				truncateToWidth(
					` ${theme?.fg ? theme.fg("dim", progText) : progText}`,
					width,
					"…",
					ROW_RESET,
				),
			);
			const hint = "Write in progress · Cancellation unavailable";
			lines.push(
				truncateToWidth(
					` ${theme?.fg ? theme.fg("dim", hint) : hint}`,
					width,
					"…",
					ROW_RESET,
				),
			);
		} else {
			const subDisplay = theme?.fg ? theme.fg("dim", subtitle) : subtitle;
			lines.push(truncateToWidth(` ${subDisplay}`, width, "…", ROW_RESET));
			if (queuedCancel) {
				const cancelMsg = "Cancellation pending…";
				lines.push(
					truncateToWidth(
						theme?.fg ? theme.fg("accent", cancelMsg) : cancelMsg,
						width,
						"…",
						ROW_RESET,
					),
				);
			} else if (queuedBackCount > 0) {
				const backMsg = `Returning to previous step… (${queuedBackCount})`;
				lines.push(
					truncateToWidth(
						theme?.fg ? theme.fg("dim", backMsg) : backMsg,
						width,
						"…",
						ROW_RESET,
					),
				);
			}
			lines.push("");
			const footer = "Esc back / close · Ctrl+C cancel";
			lines.push(
				truncateToWidth(
					` ${theme?.fg ? theme.fg("dim", footer) : footer}`,
					width,
					"…",
					ROW_RESET,
				),
			);
		}

		return lines.slice(0, totalHeight);
	}

	function renderInput(width: number): string[] {
		const totalHeight = Math.max(6, currentHeight());
		const lines: string[] = [];

		const title = `Enter new profile name for ${options.direction}:`;
		const headLine = theme ? theme.bold(title) : title;
		lines.push(truncateToWidth(` ${headLine}`, width, "…", ROW_RESET));
		lines.push("");

		// Draw input row with cursor
		const left = nameDraft.slice(0, nameCursor);
		const underCursor = nameDraft[nameCursor] ?? " ";
		const right = nameCursor < nameDraft.length ? nameDraft.slice(nameCursor + 1) : "";

		const cursorChar = theme?.bg
			? theme.bg("selectedBg", underCursor)
			: `[${underCursor}]`;
		const inputDisplay = ` ❯ ${left}${cursorChar}${right}`;
		lines.push(truncateToWidth(inputDisplay, width, "…", ROW_RESET));

		if (nameError) {
			const errText = ` ✖ ${nameError}`;
			lines.push(
				truncateToWidth(
					theme?.fg ? theme.fg("accent", errText) : errText,
					width,
					"…",
					ROW_RESET,
				),
			);
		} else {
			const hintText = " Allowed: a-z, 0-9, dot (.), dash (-), underscore (_), <= 64 chars";
			lines.push(
				truncateToWidth(
					theme?.fg ? theme.fg("dim", hintText) : hintText,
					width,
					"…",
					ROW_RESET,
				),
			);
		}

		lines.push("");
		const footerText = " Enter submit · Esc back · Ctrl+C cancel";
		lines.push(
			truncateToWidth(
				theme?.fg ? theme.fg("dim", footerText) : footerText,
				width,
				"…",
				ROW_RESET,
			),
		);

		return lines.slice(0, totalHeight);
	}

	function handleInputKeys(data: string): void {
		if (data === "\x03" || data === "ctrl+c") {
			nameError = null;
			resolvePage(SYNC_CANCEL);
			return;
		}
		if (data === "\x1b" || data === "escape") {
			nameError = null;
			resolvePage(SYNC_BACK);
			return;
		}
		if (data === "\r" || data === "\n" || data === "enter" || data === "return") {
			let val = nameDraft.trim();
			if (!val) {
				nameError = "Name cannot be empty";
				options.requestRender();
				return;
			}
			if (val.length > 64) {
				nameError = "Name must be <= 64 characters";
				options.requestRender();
				return;
			}
			if (!/^[a-z0-9._-]+$/.test(val)) {
				nameError = "Lowercase letters, digits, '.', '-', '_' only";
				options.requestRender();
				return;
			}
			if (currentExistingNames.includes(val)) {
				nameError = `Profile "${val}" already exists`;
				options.requestRender();
				return;
			}
			if (options.validateName) {
				try {
					const res = options.validateName(val);
					if (typeof res === "string") {
						val = res.trim();
						if (!val) {
							nameError = "Normalized name cannot be empty";
							options.requestRender();
							return;
						}
					}
				} catch (err) {
					nameError = err instanceof Error ? err.message : String(err);
					options.requestRender();
					return;
				}
			}
			nameError = null;
			resolvePage(val);
			return;
		}
		if (data === "\x1b[D" || data === "left") {
			if (nameCursor > 0) {
				nameCursor--;
				options.requestRender();
			}
			return;
		}
		if (data === "\x1b[C" || data === "right") {
			if (nameCursor < nameDraft.length) {
				nameCursor++;
				options.requestRender();
			}
			return;
		}
		if (data === "\x1b[H" || data === "home") {
			nameCursor = 0;
			options.requestRender();
			return;
		}
		if (data === "\x1b[F" || data === "end") {
			nameCursor = nameDraft.length;
			options.requestRender();
			return;
		}
		if (data === "\x08" || data === "\x7f" || data === "backspace") {
			if (nameCursor > 0) {
				nameDraft = nameDraft.slice(0, nameCursor - 1) + nameDraft.slice(nameCursor);
				nameCursor--;
				nameError = null;
				options.requestRender();
			}
			return;
		}
		if (data === "\x1b[3~" || data === "delete") {
			if (nameCursor < nameDraft.length) {
				nameDraft = nameDraft.slice(0, nameCursor) + nameDraft.slice(nameCursor + 1);
				nameError = null;
				options.requestRender();
			}
			return;
		}

		// Handle typed/pasted input (including bracketed paste)
		let text = data;
		if (text.startsWith("\x1b[200~")) {
			text = text.replace(/^\x1b\[200~/, "").replace(/\x1b\[201~$/, "");
		}
		if (text.startsWith("\x1b")) return;

		text = text.toLowerCase();
		if (!/^[a-z0-9._-]+$/.test(text)) {
			nameError = "Invalid character in profile name";
			options.requestRender();
			return;
		}
		const available = 64 - nameDraft.length;
		if (available <= 0) {
			nameError = "Name must be <= 64 characters";
			options.requestRender();
			return;
		}
		const insert = text.slice(0, available);
		nameDraft = nameDraft.slice(0, nameCursor) + insert + nameDraft.slice(nameCursor);
		nameCursor += insert.length;
		nameError = null;
		options.requestRender();
	}

	function resolvePage(value: string | PickerSelection | undefined): void {
		if (!pendingResolver) return;
		ticket++;
		const resolver = pendingResolver;
		pendingResolver = null;
		activeView = { type: "loading" };
		options.requestRender();
		resolver(value);
	}

	function checkQueuedNavigation(): "back" | "cancel" | null {
		if (queuedCancel) {
			queuedCancel = false;
			queuedBackCount = 0;
			return "cancel";
		}
		if (queuedBackCount > 0) {
			queuedBackCount--;
			return "back";
		}
		return null;
	}

	const component = {
		render(width: number): string[] {
			if (disposed || width <= 0) return [];
			const h = currentHeight();
			if (activeView.type === "menu") {
				if (activeView.options) activeView.options.height = h;
				const rendered = activeView.render(width);
				return rendered.slice(0, h);
			}
			if (activeView.type === "tree") {
				if (activeView.options) activeView.options.height = h;
				const rendered = activeView.render(width);
				return rendered.slice(0, h);
			}
			if (activeView.type === "input") {
				return renderInput(width);
			}
			return renderLoading(width);
		},
		handleInput(data: string): void {
			if (disposed) return;
			if (committing) {
				// Once committing, ignore navigation and user input
				return;
			}

			// If no prompt is pending, we are in loading/background state
			if (!pendingResolver || activeView.type === "loading") {
				if (data === "\x03" || data === "ctrl+c") {
					queuedCancel = true;
					queuedBackCount = 0;
					options.requestRender();
					return;
				}
				if (data === "\x1b" || data === "escape") {
					queuedBackCount++;
					subtitle = "Returning to previous step…";
					options.requestRender();
					return;
				}
				return;
			}

			// Active page handles input
			if (activeView.type === "menu" || activeView.type === "tree") {
				activeView.handleInput(data);
				options.requestRender();
			} else if (activeView.type === "input") {
				handleInputKeys(data);
			}
		},
		invalidate(): void {
			// Stateless rendering
		},
	};

	return {
		component,

		async selectStep(
			choices: Array<{ id: string; label: string }>,
			message: string,
			initialId?: string,
		): Promise<string | undefined> {
			if (disposed) return SYNC_CANCEL;
			if (committing) throw new Error("Cannot select steps while committing");

			// Consume queued navigation first before opening the page
			const queued = checkQueuedNavigation();
			if (queued === "cancel") return SYNC_CANCEL;
			if (queued === "back") return SYNC_BACK;

			const myTicket = ++ticket;
			subtitle = message.split("\n")[0] || "Loading…";

			return new Promise<string | undefined>((resolve) => {
				const menuOptions: SyncMenuOptions = {
					theme,
					height: currentHeight(),
					initialId,
				};
				const child = createSyncMenuComponent(
					message,
					choices,
					(id) => {
						if (ticket !== myTicket || disposed) return;
						resolvePage(id);
					},
					menuOptions,
				);

				activeView = {
					type: "menu",
					render: (w) => child.render(w),
					handleInput: (d) => child.handleInput(d),
					options: menuOptions,
				};
				pendingResolver = (val) => resolve(val as string | undefined);
				options.requestRender();
			});
		},

		async choosePaths(
			profileName: string,
			files: string[],
			presentation?: PickerPresentation,
		): Promise<PickerSelection> {
			if (disposed) return undefined;
			if (committing) throw new Error("Cannot choose paths while committing");

			const queued = checkQueuedNavigation();
			if (queued === "cancel") return undefined;
			if (queued === "back") return SYNC_BACK;

			const myTicket = ++ticket;
			subtitle = presentation?.title || `Selecting files from ${profileName}…`;

			return new Promise<PickerSelection>((resolve) => {
				const treeOptions: TreePickerOptions = {
					...presentation,
					allowBack: true,
					theme,
					height: currentHeight(),
				};

				const child = createTreePickerComponent(
					profileName,
					files,
					(selection) => {
						if (ticket !== myTicket || disposed) return;
						resolvePage(selection);
					},
					treeOptions,
				);

				activeView = {
					type: "tree",
					render: (w) => child.render(w),
					handleInput: (d) => child.handleInput(d),
					options: treeOptions,
				};
				pendingResolver = (val) => resolve(val as PickerSelection);
				options.requestRender();
			});
		},

		async inputProfileName(
			existing: string[],
			initialValue?: string,
		): Promise<string | undefined> {
			if (disposed) return SYNC_CANCEL;
			if (committing) throw new Error("Cannot input profile name while committing");

			const queued = checkQueuedNavigation();
			if (queued === "cancel") return SYNC_CANCEL;
			if (queued === "back") return SYNC_BACK;

			subtitle = "Enter profile name…";
			currentExistingNames = existing;

			if (initialValue !== undefined && !nameDraft) {
				nameDraft = initialValue;
				nameCursor = nameDraft.length;
			}
			nameError = null;

			return new Promise<string | undefined>((resolve) => {
				activeView = { type: "input" };
				pendingResolver = (val) => resolve(val as string | undefined);
				options.requestRender();
			});
		},

		onPhase(phase: "planning" | "committing", message?: string): void {
			if (phase === "committing") {
				if (disposed) {
					if (!committing) options.interrupt("cancel");
					return;
				}
				// Must consume queued navigation first by calling options.interrupt(action), which throws
				if (queuedCancel) {
					queuedCancel = false;
					queuedBackCount = 0;
					options.interrupt("cancel");
				}
				if (queuedBackCount > 0) {
					queuedBackCount--;
					options.interrupt("back");
				}
				committing = true;
				subtitle = message || "Synchronizing…";
				activeView = { type: "loading" };
				options.requestRender();
				return;
			}
			if (disposed) return;
			if (phase === "planning") {
				committing = false;
				subtitle = message || "Planning…";
				options.requestRender();
			}
		},

		setProgress(message: string): void {
			if (disposed) return;
			subtitle = message;
			options.requestRender();
		},

		dispose(): void {
			if (disposed) return;
			disposed = true;
			ticket++;
			if (pendingResolver) {
				const resolver = pendingResolver;
				pendingResolver = null;
				resolver(activeView.type === "tree" ? undefined : SYNC_CANCEL);
			}
			activeView = { type: "loading" };
		},
	};
}
