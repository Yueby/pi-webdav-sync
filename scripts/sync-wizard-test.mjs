import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runWebdavSyncCommand } from "../dist/src/commands.js";
import { parseArchive, createLatestZip } from "../dist/src/zip-store.js";
import { jsonBytes, createImportArchive, importArchivePaths, mergeRemoteArchive } from "../dist/src/import-plan.js";
import { createTreePickerComponent, createTreePickerState, SYNC_BACK, SYNC_CANCEL, stripAnsi, visibleWidth } from "../dist/src/tree-picker.js";
import { createSyncMenuComponent } from "../dist/src/sync-menu.js";

export async function runSyncWizardTests({ MemoryBackend }) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sync-wizard-"));
	const config = { backend: "webdav", remoteBaseUrl: "https://example.invalid/dav/", installMissingPackages: "ask" };
	const json = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
	const exists = async (file) => { try { await fs.access(file); return true; } catch { return false; } };
	const seed = async (dir, side) => {
		await fs.mkdir(path.join(dir, "extensions"), { recursive: true });
		await fs.writeFile(path.join(dir, "settings.webdav.json"), jsonBytes(config));
		await fs.writeFile(path.join(dir, "settings.json"), jsonBytes({ packages: [`npm:${side}-pkg`], pluginConfig: { [side]: true }, defaultModel: `${side}-default` }));
		await fs.writeFile(path.join(dir, "AGENTS.md"), `${side} rules\n`);
		await fs.writeFile(path.join(dir, "extensions", `${side}.js`), `${side} extension\n`);
		await fs.writeFile(path.join(dir, "models.json"), jsonBytes({ providers: { demo: {
			baseUrl: `https://${side}.invalid/v1`, api: "openai-completions", models: [{ id: "shared", name: `${side} model` }, { id: `${side}-only` }],
		}, other: { models: [{ id: "shared", name: `${side} other` }] } } }));
		await fs.writeFile(path.join(dir, "auth.json"), jsonBytes({ demo: { key: `${side}_TEST_ONLY` }, other: { key: `${side}_OTHER_TEST_ONLY` } }));
		await fs.mkdir(path.join(dir, ".webdav-sync"), { recursive: true });
		await fs.writeFile(path.join(dir, ".webdav-sync", "state.json"), jsonBytes({ currentProfile: "mine" }));
	};
	const local = path.join(root, "local");
	const remoteSeed = path.join(root, "remote-seed");
	try {
		await seed(local, "local");
		await seed(remoteSeed, "remote");
		const backend = new MemoryBackend();
		const originalPush = await runWebdavSyncCommand(["push", "--create-profile", "remote"], { agentDir: remoteSeed, backend, confirmPush: async () => true });
		assert.equal(originalPush.ok, true, originalPush.text);
		const remoteArchive = () => {
			const latest = JSON.parse(backend.files.get("profiles/remote/latest.json"));
			return parseArchive(backend.files.get("profiles/remote/latest.zip"), latest.zipSha256);
		};
		const archiveJson = (archive, file) => JSON.parse(archive.entries.get(`files/${file}`));
		let conflicts = 0;
		const pushedModels = await runWebdavSyncCommand(["push", "--models", "--profile", "remote"], {
			agentDir: local, backend,
			choosePaths: async (_profile, files, presentation) => {
				assert.match(presentation.title, /^Upload models to remote/);
				assert.match(presentation.destinationLabel, /remote profile remote/);
				return files.filter((file) => file.includes("demo") && file.includes("shared"));
			},
			selectProfile: async (choices, message) => {
				assert(!message.includes("local_TEST_ONLY") && !message.includes("remote_TEST_ONLY"));
				if (message.startsWith("Provider ")) {
					conflicts++;
					assert.match(choices[0].label, /destination profile/);
					return "local";
				}
				return "apply";
			},
			confirmInstallPackages: async () => { throw new Error("Push must not offer local installs"); },
		});
		assert.equal(pushedModels.ok, true, pushedModels.text);
		assert.equal(conflicts, 1);
		assert.match(pushedModels.text, /mode: models upload/);
		let remote = remoteArchive();
		let models = archiveJson(remote, "models.json");
		assert.equal(models.providers.demo.baseUrl, "https://remote.invalid/v1");
		assert.equal(models.providers.demo.models.find((model) => model.id === "shared").name, "local model");
		assert(models.providers.demo.models.some((model) => model.id === "remote-only"));
		assert(!models.providers.demo.models.some((model) => model.id === "local-only"));
		assert.equal(models.providers.other.models[0].name, "remote other");
		assert.equal(archiveJson(remote, "auth.json").demo.key, "remote_TEST_ONLY");
		assert.equal(remote.entries.get("files/AGENTS.md").toString(), "remote rules\n");
		assert.deepEqual(archiveJson(remote, "settings.json").packages, ["npm:remote-pkg"]);
		assert(remote.entries.has("files/extensions/remote.js"));
		assert(!remote.entries.has("files/extensions/local.js"));
		assert.equal((await json(path.join(local, ".webdav-sync", "state.json"))).currentProfile, "mine");

		const pushedPlugins = await runWebdavSyncCommand(["push", "--plugins", "--profile", "remote"], {
			agentDir: local, backend,
			choosePaths: async (_profile, files) => files.filter((file) => file.startsWith("Packages/") || file === "Settings (manual)/pluginConfig"),
			selectProfile: async () => "apply",
			installPackage: async () => { throw new Error("Push must not install packages"); },
		});
		assert.equal(pushedPlugins.ok, true, pushedPlugins.text);
		remote = remoteArchive();
		const mergedSettings = archiveJson(remote, "settings.json");
		assert.deepEqual(mergedSettings.packages, ["npm:remote-pkg", "npm:local-pkg"]);
		assert.deepEqual(mergedSettings.pluginConfig, { remote: true, local: true });
		assert.equal(mergedSettings.defaultModel, "remote-default");
		assert.equal(remote.manifest.settingsMode, "rewrite");
		assert.equal(remote.entries.get("files/AGENTS.md").toString(), "remote rules\n");
		assert.deepEqual(archiveJson(remote, "models.json"), models);
		assert.equal((await json(path.join(local, ".webdav-sync", "state.json"))).currentProfile, "mine");

		const pushedFile = await runWebdavSyncCommand(["push", "--select", "--profile", "remote"], {
			agentDir: local, backend, choosePaths: async () => ["extensions/local.js"], selectProfile: async () => "apply",
		});
		assert.equal(pushedFile.ok, true, pushedFile.text);
		remote = remoteArchive();
		assert(remote.entries.has("files/extensions/local.js"));
		assert(remote.entries.has("files/extensions/remote.js"));
		assert.equal(remote.entries.get("files/AGENTS.md").toString(), "remote rules\n");
		assert(backend.files.size > 10, "uploads keep full historical snapshots");
		// Restore the local association so import navigation can demonstrate invariance.
		await fs.writeFile(path.join(local, ".webdav-sync", "state.json"), jsonBytes({ currentProfile: "mine" }));

		const beforeCancel = [...backend.files.keys()].sort();
		const cancelledNew = await runWebdavSyncCommand(["push", "--create-profile", "cancelled", "--models"], {
			agentDir: local, backend, choosePaths: async () => ["Models"], selectProfile: async () => undefined,
		});
		assert.equal(cancelledNew.data.cancelled, true);
		assert(!backend.directories.has("profiles/cancelled"));
		assert.deepEqual([...backend.files.keys()].sort(), beforeCancel);

		// The actual step adapter replays only confirmed earlier answers. Esc back
		// from review -> provider -> picker, and switching category retains drafts.
		const beforeLocalSettings = await fs.readFile(path.join(local, "settings.json"), "utf8");
		let categories = 0, modelTrees = 0, providerPrompts = 0, reviews = 0;
		let rememberedChoice;
		const navigated = await runWebdavSyncCommand(["pull", "--profile", "remote", "latest"], {
			agentDir: local, backend,
			selectStep: async (choices, message, initialId) => {
				if (message.includes("what should be applied")) {
					categories++;
					if (categories > 1) assert.equal(initialId, categories === 2 ? "models" : "plugins");
					return categories === 2 ? "plugins" : "models";
				}
				if (message.startsWith("Provider ")) {
					providerPrompts++;
					if (providerPrompts === 2) { assert.equal(initialId, "local"); return SYNC_BACK; }
					return "local";
				}
				if (message.startsWith("Review ")) {
					reviews++;
					assert.equal(await exists(path.join(local, ".webdav-sync", "backups")), false);
					return reviews === 1 ? SYNC_BACK : "apply";
				}
				throw new Error(`Unexpected wizard menu: ${message}`);
			},
			choosePaths: async (_profile, files, presentation) => {
				assert.equal(presentation.allowBack, true);
				if (presentation.title.includes("plugins")) {
					presentation.state.selected = [files.find((file) => file.startsWith("Packages/"))];
					return SYNC_BACK;
				}
				modelTrees++;
				if (modelTrees === 1) {
					rememberedChoice = files.find((file) => file.includes("demo") && file.includes("shared"));
					presentation.state.selected = [rememberedChoice];
					presentation.state.expanded.push(rememberedChoice.slice(0, rememberedChoice.lastIndexOf("/")));
					presentation.state.index = 1;
					return SYNC_BACK;
				}
				assert.deepEqual(presentation.state.selected, [rememberedChoice]);
				assert.equal(presentation.state.index, 1);
				return [rememberedChoice];
			},
		});
		assert.equal(navigated.ok, true, navigated.text);
		assert.match(navigated.text, /mode: models import/);
		assert.equal(categories, 3);
		assert.equal(modelTrees, 3);
		assert.equal(providerPrompts, 3);
		assert.equal(reviews, 2);
		assert.equal(await fs.readFile(path.join(local, "settings.json"), "utf8"), beforeLocalSettings);
		assert.equal((await json(path.join(local, ".webdav-sync", "state.json"))).currentProfile, "mine");

		// Snapshot Esc reopens the profile picker, preserving its previous choice.
		assert.equal((await runWebdavSyncCommand(["push", "--create-profile", "other-profile"], { agentDir: remoteSeed, backend, confirmPush: async () => true })).ok, true);
		let profileVisits = 0, snapshotVisits = 0;
		const cancelledNavigation = await runWebdavSyncCommand(["pull"], {
			agentDir: local, backend,
			selectStep: async (_choices, message, initialId) => {
				if (message === "Select WebDAV profile:") { profileVisits++; if (profileVisits > 1) assert.equal(initialId, "remote"); return "remote"; }
				if (message === "Select WebDAV snapshot:") { snapshotVisits++; return snapshotVisits === 1 ? SYNC_BACK : snapshotVisits === 2 ? "latest" : SYNC_CANCEL; }
				if (message.includes("what should be applied")) return SYNC_BACK;
				throw new Error(`Unexpected menu: ${message}`);
			},
		});
		assert.equal(cancelledNavigation.data.cancelled, true);
		assert.equal(profileVisits, 2);
		assert.equal(snapshotVisits, 3);

		let rootVisits = 0;
		const beforeRootBack = [...backend.files.keys()].sort();
		const rootBack = await runWebdavSyncCommand(["push", "--profile", "remote"], {
			agentDir: local, backend,
			selectStep: async () => { rootVisits++; return SYNC_BACK; },
		});
		assert.equal(rootVisits, 1);
		assert.equal(rootBack.data.cancelled, true);
		assert.deepEqual([...backend.files.keys()].sort(), beforeRootBack);

		// Esc from review -> tree -> category -> closed. No confirmation is replayed
		// into a write, and the explicit selection survives the intermediate return.
		const escTarget = path.join(root, "esc-close");
		await seed(escTarget, "esc-target");
		const escBefore = await fs.readFile(path.join(escTarget, "settings.json"), "utf8");
		let escCategories = 0, escTrees = 0, escReviews = 0;
		let escSelection;
		const escClosed = await runWebdavSyncCommand(["pull", "--profile", "remote", "latest"], {
			agentDir: escTarget, backend,
			selectStep: async (choices, message) => {
				assert(choices.every((choice) => !["cancel", SYNC_BACK, SYNC_CANCEL].includes(choice.id)));
				if (message.includes("what should be applied")) return ++escCategories === 1 ? "plugins" : SYNC_BACK;
				if (message.startsWith("Review ")) { escReviews++; return SYNC_BACK; }
				throw new Error(`Unexpected Esc-close menu: ${message}`);
			},
			choosePaths: async (_profile, files, options) => {
				if (++escTrees === 1) { escSelection = files.filter((file) => file.startsWith("Packages/")); return escSelection; }
				assert.deepEqual(options.state.selected, escSelection);
				return SYNC_BACK;
			},
		});
		assert.equal(escClosed.data.cancelled, true);
		assert.equal(escCategories, 2);
		assert.equal(escTrees, 2);
		assert.equal(escReviews, 1);
		assert.equal(await fs.readFile(path.join(escTarget, "settings.json"), "utf8"), escBefore);
		assert.equal(await exists(path.join(escTarget, ".webdav-sync", "backups")), false);

		// Cancelling before confirmation does not create a profile or migrate legacy data.
		const legacy = new MemoryBackend();
		for (const [file, bytes] of backend.files) {
			if (file.startsWith("profiles/remote/")) legacy.files.set(file.slice("profiles/remote/".length), Buffer.from(bytes));
		}
		const legacyBefore = [...legacy.files.keys()].sort();
		const abortedLegacy = await runWebdavSyncCommand(["push"], { agentDir: local, backend: legacy, selectStep: async () => SYNC_CANCEL });
		assert.equal(abortedLegacy.data.cancelled, true);
		assert.deepEqual([...legacy.files.keys()].sort(), legacyBefore);
		assert(!legacy.files.has("layout.json"));

		const sourceConnectionPush = await runWebdavSyncCommand(["push", "--models", "--profile", "remote"], {
			agentDir: local, backend,
			choosePaths: async (_profile, files) => files.filter((file) => file.includes("demo") && file.includes("shared")),
			selectProfile: async (_choices, message) => message.startsWith("Provider ") ? "source" : "apply",
		});
		assert.equal(sourceConnectionPush.ok, true, sourceConnectionPush.text);
		remote = remoteArchive();
		assert.equal(archiveJson(remote, "models.json").providers.demo.baseUrl, "https://local.invalid/v1");
		assert.equal(archiveJson(remote, "auth.json").demo.key, "local_TEST_ONLY");
		assert.equal(archiveJson(remote, "auth.json").other.key, "remote_OTHER_TEST_ONLY");
		assert.equal((await json(path.join(local, ".webdav-sync", "state.json"))).currentProfile, "mine");

		// A selected upload to a fresh profile publishes a complete, valid snapshot,
		// without copying unrelated local files or adopting that profile.
		const fresh = await runWebdavSyncCommand(["push", "--create-profile", "fresh", "--plugins"], {
			agentDir: local, backend, choosePaths: async () => ["Packages"], selectProfile: async () => "apply",
		});
		assert.equal(fresh.ok, true, fresh.text);
		const freshIndex = JSON.parse(backend.files.get("profiles/fresh/latest.json"));
		const freshArchive = parseArchive(backend.files.get("profiles/fresh/latest.zip"), freshIndex.zipSha256);
		assert.deepEqual(archiveJson(freshArchive, "settings.json").packages, ["npm:local-pkg"]);
		assert(!freshArchive.entries.has("files/AGENTS.md"));
		assert.equal(freshArchive.manifest.settingsMode, "rewrite");
		assert.equal((await json(path.join(local, ".webdav-sync", "state.json"))).currentProfile, "mine");

		// A concurrent writer during review is never overwritten by our stale plan.
		let writerZip;
		let changed = false;
		const conflictResult = await runWebdavSyncCommand(["push", "--models", "--profile", "remote"], {
			agentDir: local, backend,
			choosePaths: async (_profile, files) => files.filter((file) => file.includes("demo") && file.includes("shared")),
			selectProfile: async (_choices, message) => {
				if (message.startsWith("Provider ")) return "local";
				if (!changed) {
					changed = true;
					const before = remoteArchive();
					const patch = createImportArchive(before, [], new Map([["AGENTS.md", Buffer.from("concurrent writer rules\n")]]), config);
					const writerArchive = mergeRemoteArchive(before, patch, config);
					writerZip = createLatestZip(writerArchive.entries, writerArchive.manifest);
					await backend.putBytes("profiles/remote/latest.zip", writerZip.zipBytes);
					await backend.putJson("profiles/remote/latest.json", writerZip.latest);
				}
				return "apply";
			},
		});
		assert.equal(conflictResult.ok, false);
		assert.match(conflictResult.text, /Destination profile changed/);
		assert.equal(JSON.parse(backend.files.get("profiles/remote/latest.json")).zipSha256, writerZip.latest.zipSha256);
		assert.equal(remoteArchive().entries.get("files/AGENTS.md").toString(), "concurrent writer rules\n");

		// Remote local-safety archives cannot silently become portable source profiles.
		const raw = createImportArchive(remoteArchive(), importArchivePaths(remoteArchive()), new Map(), config);
		const rawZip = createLatestZip(raw.entries, raw.manifest);
		await backend.putBytes("profiles/raw/latest.zip", rawZip.zipBytes);
		await backend.putJson("profiles/raw/latest.json", rawZip.latest);
		const rawResult = await runWebdavSyncCommand(["push", "--models", "--profile", "raw"], {
			agentDir: local, backend, choosePaths: async () => ["Models"], selectProfile: async () => "apply",
		});
		assert.equal(rawResult.ok, false);
		assert.match(rawResult.text, /raw backup profile/);
		assert.equal(JSON.parse(backend.files.get("profiles/raw/latest.json")).zipSha256, rawZip.latest.zipSha256);

		// Selecting settings.json carries its external references on upload and download.
		const externalSkill = path.join(root, "shared-skill");
		await fs.mkdir(externalSkill, { recursive: true });
		await fs.writeFile(path.join(externalSkill, "SKILL.md"), "portable skill payload\n");
		const externalSource = path.join(root, "external-source");
		await seed(externalSource, "external");
		await fs.writeFile(path.join(externalSource, "settings.json"), jsonBytes({ packages: [], skills: [externalSkill] }));
		const externalPush = await runWebdavSyncCommand(["push", "--create-profile", "external-profile", "--select"], {
			agentDir: externalSource, backend, choosePaths: async () => ["settings.json"], selectProfile: async (_choices, message) => {
				assert.match(message, /dependency files: 1/);
				return "apply";
			},
		});
		assert.equal(externalPush.ok, true, externalPush.text);
		const externalIndex = JSON.parse(backend.files.get("profiles/external-profile/latest.json"));
		const externalArchive = parseArchive(backend.files.get("profiles/external-profile/latest.zip"), externalIndex.zipSha256);
		assert.equal(externalArchive.manifest.externalResources[0].files.length, 1);
		const receiver = path.join(root, "external-receiver");
		await seed(receiver, "receiver");
		const externalPull = await runWebdavSyncCommand(["pull", "--profile", "external-profile", "--select", "latest"], {
			agentDir: receiver, backend, choosePaths: async () => ["settings.json"], selectProfile: async () => "apply",
		});
		assert.equal(externalPull.ok, true, externalPull.text);
		const skillReference = (await json(path.join(receiver, "settings.json"))).skills[0];
		assert.match(skillReference, /^\.\/external-resources\//);
		assert.equal(await fs.readFile(path.join(receiver, skillReference, "SKILL.md"), "utf8"), "portable skill payload\n");
		assert.equal(await fs.readFile(path.join(receiver, "AGENTS.md"), "utf8"), "receiver rules\n");

		let creationStep = 0;
		const beforeCreationAbort = [...backend.files.keys()].sort();
		const abortedCreationWizard = await runWebdavSyncCommand(["push"], {
			agentDir: local, backend, inputProfileName: async () => "never-created",
			selectStep: async () => ++creationStep === 1 ? "__new__" : SYNC_CANCEL,
		});
		assert.equal(abortedCreationWizard.data.cancelled, true);
		assert(!backend.directories.has("profiles/never-created"));
		assert.deepEqual([...backend.files.keys()].sort(), beforeCreationAbort);

		// Even package-install decisions are made before local writes, so Ctrl+C
		// there cannot leave an applied configuration behind.
		const installCancelledTarget = path.join(root, "install-cancelled");
		await seed(installCancelledTarget, "cancel-target");
		const beforeInstallCancel = await fs.readFile(path.join(installCancelledTarget, "settings.json"), "utf8");
		let sawInstallPrompt = false;
		const installCancelled = await runWebdavSyncCommand(["pull", "--profile", "remote", "--plugins", "latest"], {
			agentDir: installCancelledTarget, backend, choosePaths: async () => ["Packages"],
			selectStep: async (_choices, message) => {
				if (message.startsWith("Review ")) return "apply";
				if (message.startsWith("Install or update")) { sawInstallPrompt = true; return SYNC_CANCEL; }
				throw new Error(`Unexpected package menu: ${message}`);
			},
			installPackage: async () => { throw new Error("A cancelled import must not install packages"); },
		});
		assert.equal(sawInstallPrompt, true);
		assert.equal(installCancelled.data.cancelled, true);
		assert.equal(await fs.readFile(path.join(installCancelledTarget, "settings.json"), "utf8"), beforeInstallCancel);
		assert.equal(await exists(path.join(installCancelledTarget, ".webdav-sync", "backups")), false);

		// An empty category offers navigation instead of terminating the wizard.
		const emptySource = path.join(root, "empty-models");
		await seed(emptySource, "empty");
		await fs.writeFile(path.join(emptySource, "models.json"), jsonBytes({ providers: {} }));
		let emptyCategories = 0, emptyScreens = 0;
		const emptyBack = await runWebdavSyncCommand(["push", "--profile", "remote"], {
			agentDir: emptySource, backend,
			selectStep: async (_choices, message) => {
				if (message.includes("what should be applied")) return ++emptyCategories === 1 ? "models" : SYNC_CANCEL;
				if (message.startsWith("The source has no models")) { emptyScreens++; return SYNC_BACK; }
				throw new Error(`Unexpected empty-category menu: ${message}`);
			},
		});
		assert.equal(emptyBack.data.cancelled, true);
		assert.equal(emptyCategories, 2);
		assert.equal(emptyScreens, 1);

		// Raw TUI key contracts and mutable state are exercised without a terminal.
		const treeState = createTreePickerState(["folder/file.ts"]);
		let treeResult;
		const tree = createTreePickerComponent("remote", treeState.files, (value) => { treeResult = value; }, { allowBack: true, state: treeState });
		tree.handleInput(" "); tree.handleInput("\x1b");
		assert.equal(treeResult, SYNC_BACK);
		assert.deepEqual(treeState.selected, ["folder/file.ts"]);
		const resumed = createTreePickerComponent("remote", treeState.files, (value) => { treeResult = value; }, { allowBack: true, state: treeState });
		assert(resumed.render(60).some((line) => line.includes("[x]")));
		resumed.handleInput("\x03");
		assert.equal(treeResult, undefined);
		let menuResult;
		const menu = createSyncMenuComponent("Step", [{ id: "one", label: "One" }, { id: "two", label: "Two" }], (value) => { menuResult = value; }, { initialId: "two", height: 12 });
		const menuLines = menu.render(60).map(stripAnsi);
		assert(!menuLines.some((line) => /^(?:❯\s*)?(?:Back|Cancel)$/.test(line.trim())));
		menu.handleInput("end"); menu.handleInput("\r"); assert.equal(menuResult, "two");
		menu.handleInput("\x1b"); assert.equal(menuResult, SYNC_BACK);
		menu.handleInput("\x03"); assert.equal(menuResult, SYNC_CANCEL);
		let emptyMenuResult = "untouched";
		const emptyMenu = createSyncMenuComponent("No items. Esc goes back.", [], (value) => { emptyMenuResult = value; });
		emptyMenu.handleInput("down"); emptyMenu.handleInput("up"); emptyMenu.handleInput("\r");
		assert.equal(emptyMenuResult, "untouched");
		emptyMenu.handleInput("\x1b"); assert.equal(emptyMenuResult, SYNC_BACK);
		emptyMenu.handleInput("\x03"); assert.equal(emptyMenuResult, SYNC_CANCEL);
		const longMenu = createSyncMenuComponent(Array.from({ length: 50 }, (_, i) => `Detail ${i}`).join("\n"), [{ id: "apply", label: "Apply" }], () => {}, { height: 12 });
		const first = longMenu.render(35);
		assert(first.length <= 12);
		assert(first.every((line) => visibleWidth(line) <= 35));
		assert(first.some((line) => stripAnsi(line).includes("❯")));
		longMenu.handleInput("\x1b[6~");
		assert.notDeepEqual(longMenu.render(35), first);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}
