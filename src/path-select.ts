import { safeRelativePath, toPosixPath } from "./paths.js";
import {
	SYNC_BACK,
	SYNC_CANCEL,
	type PickerPresentation,
	type PickerSelection,
	getDescendantLeaves,
	getDirectorySelectionState,
	alignPickerState,
} from "./tree-picker.js";
import {
	archiveChildren,
	archiveFileCount,
	archiveFilePaths,
	type ParsedArchive,
} from "./zip-store.js";

/** Minimal picker contract, matching CommandContext.selectProfile structurally. */
export type PickerSelect = (
	choices: Array<{ id: string; label: string }>,
	message?: string,
) => Promise<string | undefined>;

const USE_PREFIX = "__use__";
const DONE_ID = "__done__";

/**
 * Level-by-level picker used when no custom TUI component is available (RPC,
 * print). Enter descends into a folder, files toggle, and the row at the top of a
 * level selects everything below it. Returns undefined when the user cancels.
 */
export async function choosePathsFallback(
	select: PickerSelect | undefined,
	profileName: string,
	archive: ParsedArchive,
	presentation?: PickerPresentation,
): Promise<PickerSelection> {
	if (!select)
		throw new Error(
			"No picker is available; selective push/pull needs an interactive terminal",
		);
	if (presentation?.state && !presentation.state.selected) {
		presentation.state.selected = [];
	}
	const allArchiveFiles = archiveFilePaths(archive);
	if (presentation?.state) alignPickerState(presentation.state, allArchiveFiles);
	const selected: string[] = presentation?.state?.selected ?? [];

	const toggleLeaves = (targetPath: string) => {
		const leaves = getDescendantLeaves(allArchiveFiles, targetPath);
		const status = getDirectorySelectionState(allArchiveFiles, selected, targetPath);
		if (status === "all") {
			const removeSet = new Set(leaves);
			for (let i = selected.length - 1; i >= 0; i--) {
				if (removeSet.has(selected[i])) selected.splice(i, 1);
			}
		} else {
			const selSet = new Set(selected);
			for (const leaf of leaves) {
				if (!selSet.has(leaf)) {
					selected.push(leaf);
					selSet.add(leaf);
				}
			}
		}
	};
	let prefix = "";
	for (;;) {
		const children = archiveChildren(archive, prefix);
		const choices: Array<{ id: string; label: string }> = [];
		if (selected.length) {
			const action = presentation?.actionLabel ?? "Pull";
			const destination =
				presentation?.destinationLabel ?? "into the local config";
			choices.push({
				id: DONE_ID,
				label: `✓ ${action} ${selected.length} selection(s) ${destination}`,
			});
		}
		if (prefix) {
			const wholeStatus = getDirectorySelectionState(allArchiveFiles, selected, prefix);
			const marker = wholeStatus === "all" ? "[x] " : wholeStatus === "partial" ? "[-] " : "[ ] ";
			choices.push({
				id: `${USE_PREFIX}${prefix}`,
				label: `${marker}☑ whole directory ${prefix}/ (${archiveFileCount(archive, prefix)} ${archiveFileCount(archive, prefix) === 1 ? "file" : "files"})`,
			});
		}
		for (const child of children) {
			if (child.type === "directory") {
				const status = getDirectorySelectionState(allArchiveFiles, selected, child.path);
				const marker = status === "all" ? "[x] " : status === "partial" ? "[-] " : "[ ] ";
				choices.push({
					id: child.path,
					label: `📁 ${marker}${child.path}/ (${child.files} ${child.files === 1 ? "file" : "files"})`,
				});
			} else {
				const isSelected = selected.includes(child.path);
				choices.push({
					id: child.path,
					label: `📄 ${isSelected ? "[x] " : "[ ] "}${child.path}`,
				});
			}
		}
		if (!choices.length) return selected.length ? selected : undefined;
		const baseTitle = presentation?.title ?? `Pull from ${profileName}`;
		const promptTitle = prefix ? `${baseTitle} / ${prefix}` : baseTitle;
		const picked = await select(
			choices,
			`${promptTitle} — ${selected.length} selected`,
		);
		if (picked === SYNC_CANCEL) {
			return undefined;
		}
		if (picked === undefined || picked === SYNC_BACK) {
			if (presentation?.allowBack) {
				if (prefix) {
					prefix = prefix.includes("/")
						? prefix.slice(0, prefix.lastIndexOf("/"))
						: "";
					continue;
				}
				return SYNC_BACK;
			}
			return undefined;
		}
		if (picked === DONE_ID) return selected;
		if (picked.startsWith(USE_PREFIX)) {
			toggleLeaves(picked.slice(USE_PREFIX.length));
			continue;
		}
		const entry = children.find((child) => child.path === picked);
		if (!entry) continue;
		if (entry.type === "directory") {
			prefix = entry.path;
		} else {
			const idx = selected.indexOf(entry.path);
			if (idx === -1) selected.push(entry.path);
			else selected.splice(idx, 1);
		}
	}
}

/**
 * Expands picked archive paths — an exact file or a directory prefix — into the
 * file paths to write. Directory names come from the "whole directory" rows of
 * the picker, which stand for everything below them.
 */
export function selectArchivePaths(
	archive: ParsedArchive,
	picked: string[],
): string[] {
	const all = archiveFilePaths(archive);
	const selected = new Set<string>();
	for (const raw of picked) {
		const value = raw.trim();
		const target = toPosixPath(value)
			.replace(/\/+$/, "")
			.replace(/^\.\//, "");
		if (!target) continue;
		safeRelativePath(target);
		const matched = all.filter(
			(candidate) =>
				candidate === target || candidate.startsWith(`${target}/`),
		);
		if (!matched.length) throw new Error(`No files matched: ${value}`);
		for (const candidate of matched) selected.add(candidate);
	}
	if (!selected.size) throw new Error("No paths selected");
	return [...selected].sort();
}
