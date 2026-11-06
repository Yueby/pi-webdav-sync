import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distUrl = (p) => pathToFileURL(path.join(root, "dist/src", p)).href;

export async function runTreeSelectionTests() {
	const {
		createTreePickerState,
		treePickerRows,
		treePickerSelection,
		reduceTreePicker,
		alignPickerState,
		createTreePickerComponent,
		visibleWidth,
		DONE_PATH,
		SYNC_BACK,
	} = await import(distUrl("tree-picker.js"));

	const { choosePathsFallback } = await import(distUrl("path-select.js"));

	const files = [
		"src/a.ts",
		"src/b.ts",
		"src/sub/c.ts",
		"README.md",
	];

	// 1. Select root then remove one leaf => effective selection excludes leaf
	// Space on folder does not expand folder.
	const state = createTreePickerState(files);
	const srcRowIndex = treePickerRows(state).findIndex((r) => r.path === "src");
	state.index = srcRowIndex;
	assert.equal(reduceTreePicker(state, "space"), "changed");
	assert.deepEqual(treePickerSelection(state), ["src/a.ts", "src/b.ts", "src/sub/c.ts"]);
	assert.equal(state.expanded.includes("src"), true); // was top-level expanded; unchanged by space

	// Expand src/sub to reach c.ts
	const subRowIndex = treePickerRows(state).findIndex((r) => r.path === "src/sub");
	state.index = subRowIndex;
	reduceTreePicker(state, "enter"); // enter expands folder
	const cRowIndex = treePickerRows(state).findIndex((r) => r.path === "src/sub/c.ts");
	state.index = cRowIndex;
	// Deselect c.ts
	reduceTreePicker(state, "space");
	assert.deepEqual(treePickerSelection(state), ["src/a.ts", "src/b.ts"]);

	// 2. Parent partial marker display
	const comp = createTreePickerComponent("test", files, () => {}, { state });
	const rendered = comp.render(80).join("\n");
	assert.match(rendered, /\[-\]\s*src\//, "src folder displays partial marker [-]");
	assert.match(rendered, /\[ \]\s*sub\//, "sub folder displays none marker [ ] because all its children are unselected");

	// 3. Add leaf returns full
	state.index = cRowIndex;
	reduceTreePicker(state, "space"); // re-select c.ts
	assert.deepEqual(treePickerSelection(state), ["src/a.ts", "src/b.ts", "src/sub/c.ts"]);
	const renderedFull = comp.render(80).join("\n");
	assert.match(renderedFull, /\[x\]\s*src\//, "src folder displays full marker [x]");

	// 4. Folder clears all
	state.index = treePickerRows(state).findIndex((r) => r.path === "src");
	reduceTreePicker(state, "space"); // Space on full folder clears all
	assert.deepEqual(treePickerSelection(state), []);
	assert.equal(treePickerRows(state).some((r) => r.path === DONE_PATH), false);

	// 5. Nesting overlaps dedup
	state.selected = ["src/a.ts", "src/a.ts", "src/b.ts"];
	assert.deepEqual(treePickerSelection(state), ["src/a.ts", "src/b.ts"]);

	// 6. State aligns old prefix picks, retains index/expansion valid
	const legacyState = {
		files: ["old.ts"],
		expanded: ["src", "deletedDir"],
		selected: ["src", "deleted.ts", "README.md"],
		index: 99,
	};
	alignPickerState(legacyState, files);
	assert.deepEqual(legacyState.selected, ["README.md", "src/a.ts", "src/b.ts", "src/sub/c.ts"]);
	assert.deepEqual(legacyState.expanded, ["src"]);
	assert.equal(legacyState.index, 99);

	// 7. Fallback full folder then deselect one leaf, Esc/back preserved
	const mockArchive = {
		entries: new Map(files.map((f) => [`files/${f}`, Buffer.from("data")])),
		manifest: { files: files.map((f) => ({ path: f, type: "file", size: 4 })) },
	};
	let fallbackSteps = 0;
	const fallbackState = { files, expanded: [], selected: [], index: 0 };
	const selectedLeaves = await choosePathsFallback(
		async (choices) => {
			assert(choices.every((choice) => !["__back__", "__sync_back__", "__sync_cancel__", "cancel"].includes(choice.id)));
			fallbackSteps++;
			if (fallbackSteps === 1) return "src"; // enter folder
			if (fallbackSteps === 2) return choices.find((c) => c.id.startsWith("__use__"))?.id; // select whole folder
			if (fallbackSteps === 3) return "src/a.ts"; // deselect a.ts
			return choices.find((c) => c.id === "__done__")?.id;
		},
		"test",
		mockArchive,
		{ state: fallbackState, allowBack: true },
	);
	assert.deepEqual(selectedLeaves.sort(), ["src/b.ts", "src/sub/c.ts"]);
	assert.deepEqual(fallbackState.selected.sort(), ["src/b.ts", "src/sub/c.ts"]);

	// Esc / back preservation in fallback
	let backSteps = 0;
	const backRes = await choosePathsFallback(
		async () => {
			backSteps++;
			return SYNC_BACK;
		},
		"test",
		mockArchive,
		{ state: fallbackState, allowBack: true },
	);
	assert.equal(backRes, SYNC_BACK);
	assert.deepEqual(fallbackState.selected.sort(), ["src/b.ts", "src/sub/c.ts"]);

	// 8. Colors and width remain intact
	const stubTheme = {
		fg: (color, text) => `\x1b[38;5;${color === "accent" ? 80 : color === "success" ? 78 : 245}m${text}\x1b[39m`,
		bg: (color, text) => `\x1b[48;5;${color === "selectedBg" ? 236 : 232}m${text}\x1b[49m`,
		bold: (text) => `\x1b[1m${text}\x1b[22m`,
	};
	const themedComp = createTreePickerComponent("test", files, () => {}, { theme: stubTheme, height: 12 });
	const lines = themedComp.render(50);
	for (const line of lines) {
		assert(visibleWidth(line) <= 50, `Line fits max width: "${line}"`);
	}
}
