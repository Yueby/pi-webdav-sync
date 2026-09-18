import { safeRelativePath, toPosixPath } from "./paths.js";
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
const BACK_ID = "__back__";
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
): Promise<string[] | undefined> {
	if (!select)
		throw new Error(
			"No picker is available; /webdav-sync:pull --select needs an interactive terminal",
		);
	const selected: string[] = [];
	const toggle = (value: string) => {
		const index = selected.indexOf(value);
		if (index === -1) selected.push(value);
		else selected.splice(index, 1);
	};
	let prefix = "";
	for (;;) {
		const children = archiveChildren(archive, prefix);
		const choices: Array<{ id: string; label: string }> = [];
		if (selected.length)
			choices.push({
				id: DONE_ID,
				label: `✓ Pull ${selected.length} selection(s) into the local config`,
			});
		if (prefix) {
			const wholeSelected = selected.includes(prefix);
			choices.push({
				id: `${USE_PREFIX}${prefix}`,
				label: `${wholeSelected ? "[x] " : "[ ] "}☑ whole directory ${prefix}/ (${archiveFileCount(archive, prefix)} ${archiveFileCount(archive, prefix) === 1 ? "file" : "files"})`,
			});
			choices.push({ id: BACK_ID, label: "↩ back to parent" });
		}
		for (const child of children) {
			const isSelected = selected.includes(child.path);
			choices.push({
				id: child.path,
				label:
					child.type === "directory"
						? `📁 ${isSelected ? "[x] " : "[ ] "}${child.path}/ (${child.files} ${child.files === 1 ? "file" : "files"})`
						: `📄 ${isSelected ? "[x] " : "[ ] "}${child.path}`,
			});
		}
		if (!choices.length) return selected.length ? selected : undefined;
		const scope = prefix ? `${profileName} / ${prefix}` : profileName;
		const picked = await select(
			choices,
			`Pull from ${scope} — ${selected.length} selected`,
		);
		if (!picked) return undefined;
		if (picked === DONE_ID) return selected;
		if (picked === BACK_ID) {
			prefix = prefix.includes("/")
				? prefix.slice(0, prefix.lastIndexOf("/"))
				: "";
			continue;
		}
		if (picked.startsWith(USE_PREFIX)) {
			toggle(picked.slice(USE_PREFIX.length));
			continue;
		}
		const entry = children.find((child) => child.path === picked);
		if (!entry) continue;
		if (entry.type === "directory") prefix = entry.path;
		else toggle(entry.path);
	}
}

/**
 * Expands path arguments — an exact file, a directory prefix, or a glob of `*`,
 * `**` and `?` — into archive file paths. A glob also matches whole directories,
 * so `extensions/my-plugin*` brings the entire subtree.
 */
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
