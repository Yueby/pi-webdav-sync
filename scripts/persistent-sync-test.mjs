import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runWebdavSyncCommand } from "../dist/src/commands.js";
import { runPersistentSync } from "../dist/src/persistent-sync.js";
import { runSyncNavigation } from "../dist/src/sync-navigation.js";

function deferred() {
	let resolve;
	const promise = new Promise((done) => { resolve = done; });
	return { promise, resolve };
}

/** A fake host that mounts once and redraws the exact same root component. */
function host() {
	let root;
	let mounted = false;
	let outerResolve;
	let customCalls = 0, doneCalls = 0, renderRequests = 0;
	let lines = [];
	const frames = [];
	const watchers = new Set();
	function draw() {
		if (!mounted || !root) return;
		lines = root.render(80);
		frames.push([...lines]);
		for (const watcher of [...watchers]) watcher();
	}
	const ui = {
		custom(factory) {
			customCalls++;
			return new Promise((resolve) => {
				outerResolve = resolve;
				root = factory({ terminal: { rows: 24 }, requestRender() { renderRequests++; draw(); } }, undefined, {}, (result) => {
					assert(mounted, "outer done is called only after host mount");
					doneCalls++;
					mounted = false;
					root.dispose?.();
					resolve(result);
					for (const watcher of [...watchers]) watcher();
				});
				mounted = true;
				draw();
			});
		},
	};
	return {
		ui,
		get root() { return root; },
		get mounted() { return mounted; },
		get customCalls() { return customCalls; },
		get doneCalls() { return doneCalls; },
		get renderRequests() { return renderRequests; },
		get lines() { return lines; },
		frames,
		send(data) { assert(mounted); root.handleInput(data); draw(); },
		waitFor(text) {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => { watchers.delete(check); reject(new Error(`UI did not display ${text}: ${lines.join(" | ")}`)); }, 5000);
				function check() {
					if (lines.some((line) => line.includes(text))) { clearTimeout(timer); watchers.delete(check); resolve(); }
				}
				watchers.add(check); check();
			});
		},
		detach() { mounted = false; root.dispose?.(); outerResolve(undefined); },
	};
}

export async function runPersistentSyncTests({ MemoryBackend }) {
	// Menu -> tree -> Back -> menu stays within a single host custom lifecycle.
	const h = host();
	const commit = deferred();
	let writes = 0;
	const result = runPersistentSync(h.ui, "pull", {}, (context) => runSyncNavigation(context, "pull", async (nav) => {
		await nav.selectProfile([{ id: "next", label: "Continue" }], "Root page", "root");
		await nav.choosePaths("demo", ["folder/a.ts", "folder/b.ts"], { title: "Tree page" });
		await nav.selectProfile([{ id: "apply", label: "Apply" }], "Review page", "review");
		nav.onSyncPhase("committing", "Writing selected files");
		await commit.promise;
		writes++;
		return { ok: true, text: "completed" };
	}));
	const root = h.root;
	await h.waitFor("Root page");
	h.send("\r");
	assert(h.mounted); assert.equal(h.doneCalls, 0);
	await h.waitFor("Tree page");
	h.send(" ");
	h.send("\x1b");
	assert(h.mounted); assert.equal(h.root, root); assert.equal(h.doneCalls, 0);
	assert(h.lines.some((line) => line.includes("WebDAV sync")), "loading stays in the mounted root");
	await h.waitFor("Root page");
	h.send("\r");
	await h.waitFor("Tree page");
	assert(h.lines.some((line) => line.includes("[x]")), "Back preserved the tree selection");
	h.send("up"); h.send("\r");
	await h.waitFor("Review page");
	h.send("\x1b");
	assert(h.mounted); assert.equal(h.doneCalls, 0);
	await h.waitFor("Tree page");
	h.send("\r");
	await h.waitFor("Review page");
	h.send("\r");
	await h.waitFor("Synchronizing");
	h.send("\x1b"); h.send("\x03");
	assert(h.mounted, "an in-flight commit is not falsely cancelled");
	commit.resolve();
	assert.equal((await result).ok, true);
	assert.equal(writes, 1); assert.equal(h.customCalls, 1); assert.equal(h.doneCalls, 1);
	assert.equal(h.mounted, false); assert(h.renderRequests > 0);

	// The name editor is a child page, not a nested ui.input/custom invocation.
	const names = host();
	let builtInInputs = 0;
	const nameResult = runPersistentSync(names.ui, "push", { inputProfileName: async () => { builtInInputs++; throw new Error("Must not open a second UI"); } }, (context) => runSyncNavigation(context, "push", async (nav) => {
		await nav.selectProfile([{ id: "create", label: "Create" }], "Choose destination", "profile");
		const name = await nav.inputProfileName([]);
		await nav.selectProfile([{ id: "apply", label: name }], "Name review", "review");
		return { ok: true, text: "done" };
	}));
	await names.waitFor("Choose destination"); names.send("\r");
	await names.waitFor("Enter new profile name"); names.send("my-profile"); names.send("\x1b");
	assert.equal(names.doneCalls, 0);
	await names.waitFor("Choose destination"); names.send("\r");
	await names.waitFor("Enter new profile name");
	assert(names.lines.some((line) => line.includes("my-profile")));
	names.send("\r"); await names.waitFor("Name review"); names.send("\x03");
	assert.equal((await nameResult).data.cancelled, true);
	assert.equal(names.customCalls, 1); assert.equal(names.doneCalls, 1); assert.equal(builtInInputs, 0);

	// Pending reads never unmount or reopen the UI. Cancellation is latched until
	// the sequential command reaches its next prompt/precommit gate.
	for (const action of ["\x1b", "\x03"]) {
		const delayed = host(), read = deferred();
		let mutations = 0;
		const operation = runPersistentSync(delayed.ui, "push", {}, (context) => runSyncNavigation(context, "push", async (nav) => {
			await read.promise;
			await nav.selectProfile([{ id: "apply", label: "Should not appear" }], "After delayed read", "review");
			nav.onSyncPhase("committing"); mutations++;
			return { ok: true, text: "done" };
		}));
		await delayed.waitFor("Planning");
		delayed.send(action);
		assert(delayed.mounted); assert.equal(delayed.doneCalls, 0);
		read.resolve();
		assert.equal((await operation).data.cancelled, true);
		assert.equal(mutations, 0); assert.equal(delayed.customCalls, 1); assert.equal(delayed.doneCalls, 1);
		assert(!delayed.frames.some((frame) => frame.some((line) => line.includes("Should not appear"))));
	}

	// Cached prior decisions cannot bypass cancellation received while loading.
	const gate = host(), work = deferred();
	let gateWrites = 0;
	const gated = runPersistentSync(gate.ui, "push", {}, (context) => runSyncNavigation(context, "push", async (nav) => {
		await nav.selectProfile([{ id: "apply", label: "Approve" }], "Commit gate", "review");
		await work.promise;
		nav.onSyncPhase("committing"); gateWrites++;
		return { ok: true, text: "done" };
	}));
	await gate.waitFor("Commit gate"); gate.send("\r");
	gate.send("\x03"); work.resolve();
	assert.equal((await gated).data.cancelled, true); assert.equal(gateWrites, 0);

	// Unexpected host disposal must not let the command mutate data or paint a
	// later page after the custom promise has already settled.
	const detached = host(), pendingRead = deferred();
	let detachedWrites = 0;
	const detachedResult = runPersistentSync(detached.ui, "pull", {}, (context) => runSyncNavigation(context, "pull", async (nav) => {
		await pendingRead.promise;
		nav.onSyncPhase("committing"); detachedWrites++;
		return { ok: true, text: "done" };
	}));
	await detached.waitFor("Planning"); detached.detach();
	const previousRequests = detached.renderRequests;
	pendingRead.resolve();
	assert.equal((await detachedResult).data.cancelled, true);
	assert.equal(detachedWrites, 0); assert.equal(detached.renderRequests, previousRequests);
	assert.equal(detached.customCalls, 1); assert.equal(detached.doneCalls, 0);

	// Real command integration: async file/archive planning and Back still use
	// one custom host; upload mutation stays mounted until completion.
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pi-persistent-command-"));
	try {
		const source = path.join(temporary, "source"), target = path.join(temporary, "target");
		const config = { backend: "webdav", remoteBaseUrl: "https://example.invalid/dav/", installMissingPackages: "never" };
		for (const [dir, packages] of [[source, ["npm:session-test-plugin"]], [target, []]]) {
			await fs.mkdir(dir);
			await fs.writeFile(path.join(dir, "settings.webdav.json"), JSON.stringify(config));
			await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify({ packages }));
		}
		const backend = new MemoryBackend();
		assert.equal((await runWebdavSyncCommand(["push", "--create-profile", "source"], { agentDir: source, backend, confirmPush: async () => true })).ok, true);
		const pullHost = host();
		const pull = runPersistentSync(pullHost.ui, "pull", { agentDir: target, backend },
			(context) => runWebdavSyncCommand(["pull", "--profile", "source", "--plugins", "latest"], context));
		await pullHost.waitFor("Import plugins and configuration from source");
		pullHost.send(" "); pullHost.send("up"); pullHost.send("\r");
		await pullHost.waitFor("Review plugins import");
		pullHost.send("\x1b");
		assert(pullHost.mounted); assert.equal(pullHost.doneCalls, 0);
		await pullHost.waitFor("Import plugins and configuration from source");
		assert(pullHost.lines.some((line) => line.includes("[x]")));
		pullHost.send("\x1b");
		assert.equal((await pull).data.cancelled, true);
		assert.equal(pullHost.customCalls, 1); assert.equal(pullHost.doneCalls, 1);
		assert.deepEqual(JSON.parse(await fs.readFile(path.join(target, "settings.json"), "utf8")), { packages: [] });
		await assert.rejects(fs.access(path.join(target, ".webdav-sync", "backups")));

		const write = deferred();
		let pausedWrite = false;
		const put = backend.putBytes.bind(backend);
		backend.putBytes = async (key, bytes) => {
			if (!pausedWrite && key.includes("snapshots/") && key.endsWith(".zip")) { pausedWrite = true; await write.promise; }
			return put(key, bytes);
		};
		const pushHost = host();
		const push = runPersistentSync(pushHost.ui, "push", { agentDir: source, backend },
			(context) => runWebdavSyncCommand(["push", "--profile", "source", "--plugins"], context));
		await pushHost.waitFor("Upload plugins and configuration to source");
		pushHost.send(" "); pushHost.send("up"); pushHost.send("\r");
		await pushHost.waitFor("Review plugins upload"); pushHost.send("\r");
		await pushHost.waitFor("Synchronizing");
		assert(pushHost.mounted); assert.equal(pushHost.doneCalls, 0);
		pushHost.send("\x1b"); assert(pushHost.mounted);
		write.resolve();
		assert.equal((await push).ok, true);
		assert.equal(pushHost.customCalls, 1); assert.equal(pushHost.doneCalls, 1);
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}

	// A host may detach synchronously after first render, before start's queued
	// microtask runs. It must not receive a stale done or launch a command.
	const early = host();
	let earlyExecutions = 0;
	const earlyResult = runPersistentSync(early.ui, "push", {}, async () => {
		earlyExecutions++;
		return { ok: true, text: "must not run" };
	});
	early.detach();
	assert.equal((await earlyResult).data.cancelled, true);
	assert.equal(earlyExecutions, 0); assert.equal(early.doneCalls, 0); assert.equal(early.customCalls, 1);
	let resolvedEarlyExecutions = 0, resolvedEarlyDone = 0;
	const resolvedEarly = await runPersistentSync({ custom(factory) {
		const component = factory({ terminal: { rows: 24 }, requestRender() {} }, undefined, {}, () => { resolvedEarlyDone++; });
		component.render(80);
		return Promise.resolve(undefined);
	} }, "push", {}, async () => { resolvedEarlyExecutions++; return { ok: true, text: "must not run" }; });
	assert.equal(resolvedEarly.data.cancelled, true);
	assert.equal(resolvedEarlyExecutions, 0); assert.equal(resolvedEarlyDone, 0);

	// Immediate command completion and exceptions still finish the mounted host once.
	for (const ok of [true, false]) {
		const immediate = host();
		const value = await runPersistentSync(immediate.ui, "push", {}, async () => {
			if (!ok) throw new Error("synthetic failure");
			return { ok: true, text: "done" };
		});
		assert.equal(value.ok, ok); assert.equal(immediate.customCalls, 1); assert.equal(immediate.doneCalls, 1);
	}
}
