/**
 * Interactive profile-file picker: Space selects, Enter expands/enters, Esc cancels.
 *
 * Renders an indented tree with folder file counts, checkboxes, viewport
 * windowing for long lists, and full-width highlight rows matching the native Pi TUI.
 *
 * The pure state logic stays import-free of TUI packages so navigation and selection
 * can be tested without a terminal.
 */

export const DONE_PATH = "\u0000done";
const DONE_ID = "done";

export const TREE_PICKER_HELP =
	"Space select · Enter expand · ←→ collapse · Esc cancel";

export type TreePickerState = {
	files: string[];
	expanded: string[];
	selected: string[];
	index: number;
};

export type TreePickerRow = {
	path: string;
	name: string;
	depth: number;
	type: "file" | "directory" | "action";
	files: number;
};

export type TreePickerAction =
	| "up"
	| "down"
	| "space"
	| "enter"
	| "left"
	| "right"
	| "cancel";

export type TreePickerTheme = {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
	dim?(text: string): string;
	italic?(text: string): string;
	underline?(text: string): string;
};

export type TreePickerOptions = {
	theme?: TreePickerTheme;
	height?: number;
};

export type TreePickerComponent = {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
};

export function createTreePickerState(files: string[]): TreePickerState {
	const top = new Set<string>();
	for (const file of files) {
		const slash = file.indexOf("/");
		if (slash !== -1) top.add(file.slice(0, slash));
	}
	return {
		files: [...files].sort(),
		expanded: [...top],
		selected: [],
		index: 0,
	};
}

type ChildEntry = {
	path: string;
	name: string;
	type: "file" | "directory";
	files: number;
};

function childrenOf(state: TreePickerState, prefix: string): ChildEntry[] {
	const base = prefix ? `${prefix}/` : "";
	const counted = new Map<string, ChildEntry>();
	for (const file of state.files) {
		if (base !== "" && !file.startsWith(base)) continue;
		const rest = file.slice(base.length);
		if (!rest) continue;
		const slash = rest.indexOf("/");
		const name = slash === -1 ? rest : rest.slice(0, slash);
		const path = `${base}${name}`;
		const existing = counted.get(path);
		if (existing) {
			existing.files += 1;
			continue;
		}
		counted.set(path, {
			path,
			name,
			type: slash === -1 ? "file" : "directory",
			files: 1,
		});
	}
	return [...counted.values()].sort((a, b) =>
		a.type === b.type
			? a.path.localeCompare(b.path)
			: a.type === "directory"
				? -1
				: 1,
	);
}

/** Rows currently in the tree, followed by the Done row when something is selected. */
export function treePickerRows(state: TreePickerState): TreePickerRow[] {
	const rows: TreePickerRow[] = [];
	const walk = (prefix: string, depth: number) => {
		for (const child of childrenOf(state, prefix)) {
			const expanded =
				child.type === "directory" && state.expanded.includes(child.path);
			rows.push({
				path: child.path,
				name: child.name,
				depth,
				type: child.type,
				files: child.files,
			});
			if (expanded) walk(child.path, depth + 1);
		}
	};
	walk("", 0);
	if (state.selected.length) {
		rows.push({
			path: DONE_PATH,
			name: "done",
			depth: 0,
			type: "action",
			files: state.selected.length,
		});
	}
	return rows;
}

export function treePickerSelection(state: TreePickerState): string[] {
	return [...state.selected].sort();
}

export function reduceTreePicker(
	state: TreePickerState,
	action: TreePickerAction,
): "changed" | "done" | "cancel" {
	const rows = treePickerRows(state);
	if (action === "cancel") return "cancel";
	if (!rows.length) return "changed";
	const index = Math.min(Math.max(state.index, 0), rows.length - 1);
	const row = rows[index];
	if (action === "up") {
		state.index = index > 0 ? index - 1 : rows.length - 1;
		return "changed";
	}
	if (action === "down") {
		state.index = index < rows.length - 1 ? index + 1 : 0;
		return "changed";
	}
	if (row.path === DONE_PATH)
		return action === "space" || action === "enter" ? "done" : "changed";
	if (action === "space") {
		toggle(state.selected, row.path);
		anchorIndex(state, row.path);
		return "changed";
	}
	if (action === "enter") {
		// Enter operates: it expands a folder, or selects a file.
		if (row.type === "directory") toggle(state.expanded, row.path);
		else toggle(state.selected, row.path);
		anchorIndex(state, row.path);
		return "changed";
	}
	if (action === "right" && row.type === "directory") {
		if (!state.expanded.includes(row.path)) state.expanded.push(row.path);
		anchorIndex(state, row.path);
		return "changed";
	}
	if (action === "left") {
		if (row.type === "directory" && state.expanded.includes(row.path)) {
			remove(state.expanded, row.path);
			anchorIndex(state, row.path);
			return "changed";
		}
		const parent = row.path.includes("/")
			? row.path.slice(0, row.path.lastIndexOf("/"))
			: undefined;
		if (parent) {
			const parentIndex = rows.findIndex((entry) => entry.path === parent);
			if (parentIndex >= 0) state.index = parentIndex;
		}
	}
	return "changed";
}

/** Raw key sequences, so the component needs no TUI imports to handle input. */
export function pickerActionFor(data: string): TreePickerAction | undefined {
	if (data === " " || data === "space") return "space";
	if (data === "\r" || data === "\n" || data === "enter" || data === "return")
		return "enter";
	if (data === "\x1b[A" || data === "up") return "up";
	if (data === "\x1b[B" || data === "down") return "down";
	if (data === "\x1b[C" || data === "right") return "right";
	if (data === "\x1b[D" || data === "left") return "left";
	if (data === "\x1b" || data === "\x03" || data === "escape") return "cancel";
	return undefined;
}

const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

/**
 * Closes colour and bold without clearing an enclosing background: a full
 * `\x1b[0m` would end the highlight bar mid-row, leaving the rest unpainted.
 */
const ROW_RESET = "\x1b[39m\x1b[22m";

export function stripAnsi(str: string): string {
	return str.replace(ANSI_REGEX, "");
}

export function visibleWidth(str: string): number {
	const clean = stripAnsi(str);
	let width = 0;
	for (const char of clean) {
		const code = char.codePointAt(0) ?? 0;
		if (code >= 0x20 && code <= 0x7e) {
			width += 1;
		} else if (
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe10 && code <= 0xfe19) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6) ||
			(code >= 0x20000 && code <= 0x3ffff)
		) {
			width += 2;
		} else if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
			// Non-printable control characters take 0 visual width
		} else {
			width += 1;
		}
	}
	return width;
}

export function truncateToWidth(
	text: string,
	maxWidth: number,
	ellipsis = "…",
	reset = "\x1b[0m",
): string {
	if (maxWidth <= 0) return "";
	const totalWidth = visibleWidth(text);
	if (totalWidth <= maxWidth) return text;

	const ellipsisW = visibleWidth(ellipsis);
	if (ellipsisW >= maxWidth) {
		return ellipsis.slice(0, maxWidth);
	}
	const targetWidth = maxWidth - ellipsisW;

	let result = "";
	let currentWidth = 0;
	let index = 0;
	let activeAnsi = false;

	while (index < text.length) {
		if (text.charCodeAt(index) === 0x1b && text[index + 1] === "[") {
			const m = text.slice(index).match(/^\x1b\[[0-9;]*[a-zA-Z]/);
			if (m) {
				result += m[0];
				index += m[0].length;
				activeAnsi = true;
				continue;
			}
		}

		const char = text[index];
		const charW = visibleWidth(char);
		if (currentWidth + charW > targetWidth) break;
		result += char;
		currentWidth += charW;
		index++;
	}

	return activeAnsi ? `${result}${reset}${ellipsis}` : `${result}${ellipsis}`;
}

function computeViewport(
	total: number,
	maxRows: number,
	selectedIndex: number,
	currentOffset: number,
): {
	offset: number;
	count: number;
	hasAbove: boolean;
	hasBelow: boolean;
	aboveCount: number;
	belowCount: number;
} {
	if (total <= maxRows) {
		return {
			offset: 0,
			count: total,
			hasAbove: false,
			hasBelow: false,
			aboveCount: 0,
			belowCount: 0,
		};
	}

	let offset = Math.max(0, Math.min(currentOffset, total - 1));

	if (selectedIndex >= 0 && selectedIndex < total) {
		if (selectedIndex < offset) {
			offset = selectedIndex;
		}
	}

	let items = 1;
	while (items < total - offset) {
		const nextItems = items + 1;
		const hasAbove = offset > 0;
		const hasBelow = offset + nextItems < total;
		const neededLines = nextItems + (hasAbove ? 1 : 0) + (hasBelow ? 1 : 0);
		if (neededLines > maxRows) break;
		items = nextItems;
	}

	if (selectedIndex >= 0 && selectedIndex < total) {
		while (selectedIndex >= offset + items && offset + items < total) {
			offset++;
			items = 1;
			while (items < total - offset) {
				const nextItems = items + 1;
				const hasAbove = offset > 0;
				const hasBelow = offset + nextItems < total;
				const neededLines = nextItems + (hasAbove ? 1 : 0) + (hasBelow ? 1 : 0);
				if (neededLines > maxRows) break;
				items = nextItems;
			}
		}
	}

	const hasAbove = offset > 0;
	const hasBelow = offset + items < total;
	return {
		offset,
		count: items,
		hasAbove,
		hasBelow,
		aboveCount: offset,
		belowCount: total - (offset + items),
	};
}

export function createTreePickerComponent(
	profileName: string,
	files: string[],
	done: (value: string[] | undefined) => void,
	options?: TreePickerOptions,
): TreePickerComponent {
	const state = createTreePickerState(files);
	let scrollOffset = 0;
	const theme = options?.theme;

	return {
		invalidate() {
			/* stateless - theme styling is applied during render() */
		},
		render(width: number): string[] {
			const rows = treePickerRows(state);
			const selectedCount = state.selected.length;
			const treeRowsList = rows.filter((r) => r.path !== DONE_PATH);
			const hasDoneRow = selectedCount > 0;

			// Clamped highlight position
			state.index = Math.min(
				Math.max(state.index, 0),
				Math.max(rows.length - 1, 0),
			);
			const isDoneHighlighted = hasDoneRow && state.index === rows.length - 1;
			const highlightedTreeIndex = isDoneHighlighted ? -1 : state.index;

			// Calculate chrome and viewport
			const totalChrome = hasDoneRow ? 5 : 3;
			let maxTreeLines = 16;
			if (options?.height && options.height > totalChrome + 3) {
				maxTreeLines = options.height - totalChrome;
			}

			const viewport = computeViewport(
				treeRowsList.length,
				maxTreeLines,
				highlightedTreeIndex,
				scrollOffset,
			);
			scrollOffset = viewport.offset;

			const lines: string[] = [];

			// 1. Header
			const headerPrefix = ` Pull from ${profileName}`;
			const headerCount = ` · ${selectedCount} selected`;
			const headerLine = theme
				? ` Pull from ${theme.bold(profileName)} · ${theme.fg(selectedCount > 0 ? "accent" : "dim", `${selectedCount} selected`)}`
				: `${headerPrefix}${headerCount}`;
			lines.push(truncateToWidth(headerLine, width));

			// 2. Blank line after header
			lines.push("");

			// 3. Tree items
			if (viewport.hasAbove) {
				const aboveText = `    ▲ ${viewport.aboveCount} more`;
				lines.push(
					truncateToWidth(theme ? theme.fg("dim", aboveText) : aboveText, width),
				);
			}

			for (let i = viewport.offset; i < viewport.offset + viewport.count; i++) {
				const row = treeRowsList[i];
				const isHighlighted = i === highlightedTreeIndex;
				const gutterText = isHighlighted
					? theme
						? ` ${theme.fg("accent", "❯")}  `
						: " ❯  "
					: "    ";
				const indentText = "  ".repeat(row.depth);

				let rowContent = "";
				if (row.type === "directory") {
					const isExp = state.expanded.includes(row.path);
					const arrowChar = isExp ? "▾" : "▸";
					const arrowText =
						(theme ? theme.fg("dim", arrowChar) : arrowChar) + " ";
					const isSel = state.selected.includes(row.path);
					const markerText = isSel
						? theme
							? theme.fg("success", "[x]") + " "
							: "[x] "
						: "";
					const nameText = theme
						? theme.fg("accent", `${row.name}/`)
						: `${row.name}/`;
					const countPlain = `${row.files} ${row.files === 1 ? "file" : "files"}`;
					const countText = theme ? theme.fg("dim", countPlain) : countPlain;

					const leftPart = `${gutterText}${indentText}${arrowText}${markerText}${nameText}`;
					const leftWidth = visibleWidth(leftPart);
					const countWidth = visibleWidth(countText);

					if (leftWidth + 2 + countWidth <= width) {
						const pad = " ".repeat(width - leftWidth - countWidth);
						rowContent = `${leftPart}${pad}${countText}`;
					} else {
						rowContent = `${leftPart}  ${countText}`;
					}
				} else {
					const isSel = state.selected.includes(row.path);
					const checkText = isSel
						? theme
							? theme.fg("success", "[x]") + " "
							: "[x] "
						: theme
							? theme.fg("dim", "[ ]") + " "
							: "[ ] ";
					const nameText = theme
						? isSel
							? theme.fg("text", row.name)
							: theme.fg("dim", row.name)
						: row.name;
					rowContent = `${gutterText}${indentText}${checkText}${nameText}`;
				}

				if (visibleWidth(rowContent) > width) {
					rowContent = truncateToWidth(rowContent, width, "…", ROW_RESET);
				}
				if (isHighlighted && theme) {
					const vw = visibleWidth(rowContent);
					if (vw < width) {
						rowContent += " ".repeat(width - vw);
					}
					rowContent = theme.bg("selectedBg", rowContent);
				}
				lines.push(rowContent);
			}

			if (viewport.hasBelow) {
				const belowText = `    ▼ ${viewport.belowCount} more`;
				lines.push(
					truncateToWidth(theme ? theme.fg("dim", belowText) : belowText, width),
				);
			}

			// 4. Blank line before Done row
			lines.push("");

			// 5. Done row (when items are selected)
			if (hasDoneRow) {
				const gutterText = isDoneHighlighted
					? theme
						? ` ${theme.fg("accent", "❯")}  `
						: " ❯  "
					: "    ";
				const doneIcon = theme ? theme.fg("success", "✓") : "✓";
				const doneLabel = `Pull ${selectedCount} selection(s) into the local config`;
				const doneText = theme
					? theme.bold(theme.fg("success", doneLabel))
					: doneLabel;
				let doneContent = `${gutterText}${doneIcon} ${doneText}`;
				if (visibleWidth(doneContent) > width) {
					doneContent = truncateToWidth(doneContent, width, "…", ROW_RESET);
				}
				if (isDoneHighlighted && theme) {
					const vw = visibleWidth(doneContent);
					if (vw < width) {
						doneContent += " ".repeat(width - vw);
					}
					doneContent = theme.bg("selectedBg", doneContent);
				}
				lines.push(doneContent);
			}

			// 6. Footer help line
			const footerText = ` ${TREE_PICKER_HELP}`;
			const formattedFooter = theme ? theme.fg("dim", footerText) : footerText;
			lines.push(truncateToWidth(formattedFooter, width, "…"));

			return lines;
		},
		handleInput(data: string) {
			const action = pickerActionFor(data);
			if (!action) return;
			const result = reduceTreePicker(state, action);
			if (result === "done") {
				done(treePickerSelection(state));
				return;
			}
			if (result === "cancel") {
				done(undefined);
			}
		},
	};
}

function toggle(list: string[], value: string): void {
	const index = list.indexOf(value);
	if (index === -1) list.push(value);
	else list.splice(index, 1);
}

/**
 * Keeps the highlight on the row the user just acted on.
 */
function anchorIndex(state: TreePickerState, path: string): void {
	const rows = treePickerRows(state);
	const found = rows.findIndex((entry) => entry.path === path);
	state.index =
		found >= 0 ? found : Math.min(state.index, Math.max(rows.length - 1, 0));
}

function remove(list: string[], value: string): void {
	const index = list.indexOf(value);
	if (index !== -1) list.splice(index, 1);
}

export { DONE_ID };
