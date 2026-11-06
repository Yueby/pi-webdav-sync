/**
 * Single-selection step menu for the sync wizard.
 *
 * Provides a clean TUI selector with keyboard navigation (Up/Down, Enter),
 * full-row selection highlighting matching native Pi,
 * and safe multiline title truncation.
 */

import {
	computeViewport,
	ROW_RESET,
	SYNC_BACK,
	SYNC_CANCEL,
	truncateToWidth,
	visibleWidth,
	type TreePickerTheme,
} from "./tree-picker.js";

export type SyncMenuChoice = {
	id: string;
	label: string;
};

export type SyncMenuOptions = {
	theme?: TreePickerTheme;
	height?: number;
	initialId?: string;
};

export type SyncMenuComponent = {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
};

export function createSyncMenuComponent(
	title: string,
	choices: Array<{ id: string; label: string }>,
	done: (id: string | undefined) => void,
	options?: SyncMenuOptions,
): SyncMenuComponent {
	const items: SyncMenuChoice[] = [...choices];

	let selectedIndex = 0;
	if (options?.initialId) {
		const found = items.findIndex((item) => item.id === options.initialId);
		if (found >= 0) selectedIndex = found;
	}

	let scrollOffset = 0;
	let titleOffset = 0;

	return {
		invalidate() {
			/* stateless - theme styling is applied during render() */
		},
		render(width: number): string[] {
			if (width <= 0) return [];
			const theme = options?.theme;
			const lines: string[] = [];
			const totalHeight = options?.height ?? 24;

			// Clamped highlight position
			selectedIndex = Math.min(
				Math.max(selectedIndex, 0),
				Math.max(items.length - 1, 0),
			);

			// 1. Multiline title with safe truncation and bounded height
			const rawTitleLines = title.split("\n");
			// Reserve: blank before menu (1), min 3 menu rows, blank before footer (1), footer text (1) = 6
			const reservedMenuAndFooter = 6;
			const maxTitleHeight = Math.max(1, totalHeight - reservedMenuAndFooter);

			const overflows = rawTitleLines.length > maxTitleHeight;
			// If overflowing, reserve 1 line for omitted count indicator
			const visibleTitleBudget = overflows
				? Math.max(1, maxTitleHeight - 1)
				: maxTitleHeight;

			const maxTitleOffset = Math.max(0, rawTitleLines.length - visibleTitleBudget);
			titleOffset = Math.min(Math.max(titleOffset, 0), maxTitleOffset);

			const sliceStart = titleOffset;
			const sliceEnd = Math.min(rawTitleLines.length, sliceStart + visibleTitleBudget);
			const visibleTitle = rawTitleLines.slice(sliceStart, sliceEnd);

			for (const rawLine of visibleTitle) {
				const formatted = theme ? theme.bold(rawLine) : rawLine;
				lines.push(truncateToWidth(` ${formatted}`, width, "…", ROW_RESET));
			}

			if (overflows) {
				const omitted = rawTitleLines.length - visibleTitle.length;
				const omitText = ` [${omitted} title line${omitted === 1 ? "" : "s"} omitted · PgUp/PgDn to scroll]`;
				lines.push(
					truncateToWidth(
						theme?.fg ? theme.fg("dim", omitText) : omitText,
						width,
						"…",
						ROW_RESET,
					),
				);
			}
			lines.push("");

			// 2. Viewport calculation (footer occupies 2 lines)
			const chromeLines = lines.length + 2;
			const maxItemLines = Math.max(3, totalHeight - chromeLines);

			const viewport = computeViewport(
				items.length,
				maxItemLines,
				selectedIndex,
				scrollOffset,
			);
			scrollOffset = viewport.offset;

			if (viewport.hasAbove) {
				const aboveText = `    ▲ ${viewport.aboveCount} more`;
				lines.push(
					truncateToWidth(
						theme?.fg ? theme.fg("dim", aboveText) : aboveText,
						width,
					),
				);
			}

			for (
				let i = viewport.offset;
				i < viewport.offset + viewport.count;
				i++
			) {
				const item = items[i];
				const isHighlighted = i === selectedIndex;
				const gutterText = isHighlighted
					? theme?.fg
						? ` ${theme.fg("accent", "❯")}  `
						: " ❯  "
					: "    ";

				const labelText = isHighlighted
					? theme?.bold
						? theme.bold(item.label)
						: item.label
					: item.label;

				let rowContent = `${gutterText}${labelText}`;
				if (visibleWidth(rowContent) > width) {
					rowContent = truncateToWidth(rowContent, width, "…", ROW_RESET);
				}
				if (isHighlighted && theme?.bg) {
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
					truncateToWidth(
						theme?.fg ? theme.fg("dim", belowText) : belowText,
						width,
					),
				);
			}

			// 3. Footer help line
			lines.push("");
			const detailsHint = overflows ? "PgUp/PgDn details · " : "";
			const footerText = ` ${detailsHint}Esc back / close · Ctrl+C cancel`;
			const formattedFooter = theme?.fg
				? theme.fg("dim", footerText)
				: footerText;
			lines.push(truncateToWidth(formattedFooter, width, "…"));

			return lines.slice(0, totalHeight);
		},
		handleInput(data: string) {
			if (data === "\x1b[5~" || data === "pageup" || data === "pgup") {
				titleOffset = Math.max(0, titleOffset - 5);
				return;
			}
			if (data === "\x1b[6~" || data === "pagedown" || data === "pgdn") {
				titleOffset += 5;
				return;
			}
			if (data === "\x1b" || data === "escape") {
				done(SYNC_BACK);
				return;
			}
			if (data === "\x03" || data === "ctrl+c") {
				done(SYNC_CANCEL);
				return;
			}
			if (!items.length) return;
			if (
				data === "\r" ||
				data === "\n" ||
				data === "enter" ||
				data === "return"
			) {
				done(items[selectedIndex]?.id);
				return;
			}
			if (data === "\x1b[A" || data === "up") {
				selectedIndex =
					selectedIndex > 0 ? selectedIndex - 1 : items.length - 1;
				return;
			}
			if (data === "\x1b[B" || data === "down") {
				selectedIndex =
					selectedIndex < items.length - 1 ? selectedIndex + 1 : 0;
				return;
			}
			if (data === "\x1b[H" || data === "home") {
				selectedIndex = 0;
				return;
			}
			if (data === "\x1b[F" || data === "end") {
				selectedIndex = items.length - 1;
				return;
			}
		},
	};
}
