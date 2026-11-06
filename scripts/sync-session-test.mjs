import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distUrl = (rel) => pathToFileURL(path.join(root, "dist/src", rel)).href;

export async function runSyncSessionTests() {
	const { createSyncSession, SYNC_BACK, SYNC_CANCEL } = await import(distUrl("sync-session.js"));
	const { visibleWidth } = await import(distUrl("tree-picker.js"));

	let renderCount = 0;
	let interruptedAction = null;
	const dummyHeight = 16;

	function makeSession(direction = "push", validateName) {
		renderCount = 0;
		interruptedAction = null;
		return createSyncSession({
			direction,
			height: () => dummyHeight,
			requestRender: () => { renderCount++; },
			interrupt: (action) => {
				interruptedAction = action;
				throw new Error(`INTERRUPT:${action}`);
			},
			validateName,
		});
	}

	// 1. Root component reference is stable across transitions
	const session = makeSession("pull");
	const rootComp = session.component;
	assert(typeof rootComp.render === "function");
	assert(typeof rootComp.handleInput === "function");

	// Initial render is loading view
	let lines = rootComp.render(60);
	assert(lines.length > 0);
	assert(lines.some((l) => l.includes("WebDAV sync (pull)")));
	assert(lines.some((l) => l.includes("Loading")));

	// 2. selectStep: root reference stable, requestRender invoked, child Back resolves SYNC_BACK
	const menuPromise = session.selectStep([{ id: "opt1", label: "Option 1" }], "Choose option:");
	assert.equal(session.component, rootComp);
	assert(renderCount > 0);
	lines = rootComp.render(60);
	assert(lines.some((l) => l.includes("Choose option:")));

	// Esc triggers child back without disposing root
	rootComp.handleInput("\x1b");
	const menuRes = await menuPromise;
	assert.equal(menuRes, SYNC_BACK);
	// Root returns to loading view
	lines = rootComp.render(60);
	assert(lines.some((l) => l.includes("WebDAV sync (pull)")));

	// 3. choosePaths: tree picker step and selection/cancel
	const treePromise = session.choosePaths("demo", ["src/a.ts", "src/b.ts"]);
	lines = rootComp.render(60);
	assert(lines.some((l) => l.includes("demo")));
	// Select an item with Space, then Esc for SYNC_BACK
	rootComp.handleInput(" ");
	rootComp.handleInput("\x1b");
	const treeRes = await treePromise;
	assert.equal(treeRes, SYNC_BACK);

	// 4. Queued back/cancel while loading
	session.onPhase("planning");
	// User hits Esc twice while loading
	rootComp.handleInput("\x1b");
	rootComp.handleInput("\x1b");
	// First step consumes first back
	const step1 = await session.selectStep([{ id: "a", label: "A" }], "Step 1");
	assert.equal(step1, SYNC_BACK);
	// Second step consumes second back
	const step2 = await session.selectStep([{ id: "b", label: "B" }], "Step 2");
	assert.equal(step2, SYNC_BACK);

	// Ctrl+C queues cancel which supersedes back
	rootComp.handleInput("\x1b");
	rootComp.handleInput("\x03");
	const stepCancelled = await session.selectStep([{ id: "c", label: "C" }], "Step C");
	assert.equal(stepCancelled, SYNC_CANCEL);

	// 5. onPhase('committing') consumes queued navigation by calling interrupt (which throws)
	rootComp.handleInput("\x1b");
	assert.throws(
		() => session.onPhase("committing", "Committing changes"),
		/INTERRUPT:back/,
	);
	assert.equal(interruptedAction, "back");

	// Disposal before committing causes onPhase('committing') to call interrupt('cancel')
	const disposedPlanningSession = makeSession("push");
	disposedPlanningSession.dispose();
	assert.throws(
		() => disposedPlanningSession.onPhase("committing", "Committing after dispose"),
		/INTERRUPT:cancel/,
	);
	assert.equal(interruptedAction, "cancel");

	// Once committing, keys are ignored, progress message shown, cancellation unavailable
	session.onPhase("committing", "Writing snapshot #3");
	lines = rootComp.render(60);
	assert(lines.some((l) => l.includes("Synchronizing…")));
	assert(lines.some((l) => l.includes("Writing snapshot #3")));
	assert(lines.some((l) => l.includes("Cancellation unavailable")));
	rootComp.handleInput("\x03");
	rootComp.handleInput("\x1b");
	lines = rootComp.render(60);
	assert(lines.some((l) => l.includes("Synchronizing…")));
	await assert.rejects(
		() => session.selectStep([{ id: "x", label: "X" }], "Should fail"),
		/committing/,
	);

	// 6. Profile input: character insertion, preservation, cursor, validation
	const session2 = makeSession("push", (name) => {
		if (name === "reserved") throw new Error("Name 'reserved' is not allowed");
		return name.trim();
	});
	const namePromise = session2.inputProfileName(["already_there"], "initial");
	lines = session2.component.render(60);
	assert(lines.some((l) => l.includes("Enter new profile name")));

	// Type uppercase (should be lowercased), invalid char (sets error)
	session2.component.handleInput("\x1b[200~UPPER\x1b[201~"); // bracketed paste
	session2.component.handleInput("!"); // invalid character
	lines = session2.component.render(60);
	assert(lines.some((l) => l.includes("Invalid character")));

	// Type home and delete all
	session2.component.handleInput("home");
	for (let i = 0; i < 30; i++) session2.component.handleInput("delete");

	// Test validateName throws error
	session2.component.handleInput("reserved");
	session2.component.handleInput("\r");
	lines = session2.component.render(60);
	assert(lines.some((l) => l.includes("Name 'reserved' is not allowed")));

	// Test existing name error
	session2.component.handleInput("home");
	for (let i = 0; i < 20; i++) session2.component.handleInput("delete");
	session2.component.handleInput("already_there");
	session2.component.handleInput("\r");
	lines = session2.component.render(60);
	assert(lines.some((l) => l.includes("already exists")));

	// Hit Esc to cancel/back -> preserves draft when re-entering
	session2.component.handleInput("\x1b");
	const nameBack = await namePromise;
	assert.equal(nameBack, SYNC_BACK);

	// Re-enter inputProfileName, draft is preserved
	const namePromise2 = session2.inputProfileName(["already_there"]);
	lines = session2.component.render(60);
	assert(lines.some((l) => l.includes("already_there")));
	// Change to a valid new name
	session2.component.handleInput("home");
	for (let i = 0; i < 20; i++) session2.component.handleInput("delete");
	session2.component.handleInput("my-profile");
	session2.component.handleInput("\r");
	const finalName = await namePromise2;
	assert.equal(finalName, "my-profile");

	// 7. dispose cancels pending, returns [] on render, and does not requestRender
	const session3 = makeSession("push");
	const pendingStep = session3.selectStep([{ id: "1", label: "1" }], "Pending");
	const renderCountBeforeDispose = renderCount;
	session3.dispose();
	assert.equal(renderCount, renderCountBeforeDispose, "dispose must not request render");
	const cancelledVal = await pendingStep;
	assert.equal(cancelledVal, SYNC_CANCEL);
	assert.deepEqual(session3.component.render(60), [], "render must return [] when disposed");
	const postDispose = await session3.selectStep([{ id: "2", label: "2" }], "Post");
	assert.equal(postDispose, SYNC_CANCEL);

	// 8. Geometry checks: widths 40 & 80, heights 12 & 24
	for (const w of [40, 80]) {
		for (const h of [12, 24]) {
			const s = createSyncSession({
				direction: "pull",
				height: () => h,
				requestRender: () => {},
				interrupt: () => { throw new Error("interrupt"); },
			});
			// Loading view
			let r = s.component.render(w);
			assert(r.length <= h, `lines ${r.length} > height ${h}`);
			assert(r.every((line) => visibleWidth(line) <= w), `width overflow in loading at ${w}`);

			// Menu view
			const p = s.selectStep([{ id: "1", label: "Item 1" }, { id: "2", label: "Item 2" }], "Title");
			r = s.component.render(w);
			assert(r.length <= h, `lines ${r.length} > height ${h}`);
			assert(r.every((line) => visibleWidth(line) <= w), `width overflow in menu at ${w}`);
			s.component.handleInput("\x1b");
			await p;
		}
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await runSyncSessionTests();
	console.log("All sync session tests passed.");
}
