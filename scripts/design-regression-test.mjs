import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runWebdavSyncCommand } from "../dist/src/commands.js";
import { SYNC_BACK, SYNC_CANCEL } from "../dist/src/tree-picker.js";
import { jsonBytes } from "../dist/src/import-plan.js";

export async function runDesignRegressionTests({ MemoryBackend }) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-design-regression-"));
	const config = { backend: "webdav", remoteBaseUrl: "https://example.invalid/dav/", installMissingPackages: "never" };
	const json = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
	const exists = async (file) => { try { await fs.access(file); return true; } catch { return false; } };
	const init = async (dir, settings = {}) => {
		await fs.mkdir(path.join(dir, ".webdav-sync"), { recursive: true });
		await fs.writeFile(path.join(dir, "settings.webdav.json"), jsonBytes(config));
		await fs.writeFile(path.join(dir, "settings.json"), jsonBytes(settings));
		await fs.writeFile(path.join(dir, ".webdav-sync", "state.json"), jsonBytes({ currentProfile: "mine" }));
	};
	const source = path.join(root, "source");
	const backend = new MemoryBackend();
	const modelConfig = (side) => ({ providers: { demo: {
		baseUrl: `https://${side}.invalid/v1`, api: "openai-completions",
		models: [{ id: "shared", name: side }],
	} } });
	try {
		const skill = path.join(root, "external-skill");
		await fs.mkdir(skill);
		await fs.writeFile(path.join(skill, "SKILL.md"), "source dependency\n");
		await init(source, { packages: ["npm:design-test-pkg"], skills: [skill], pluginConfig: { source: true } });
		for (const name of ["a", "b"]) {
			await fs.writeFile(path.join(source, "models.json"), jsonBytes(modelConfig(name)));
			await fs.writeFile(path.join(source, "auth.json"), jsonBytes({ demo: { key: `${name}_ARTIFICIAL_TEST_ONLY` } }));
			const pushed = await runWebdavSyncCommand(["push", "--create-profile", name], { agentDir: source, backend, confirmPush: async () => true });
			assert.equal(pushed.ok, true, pushed.text);
		}
		await fs.writeFile(path.join(source, "models.json"), jsonBytes(modelConfig("a-second")));
		assert.equal((await runWebdavSyncCommand(["push", "--profile", "a"], { agentDir: source, backend, confirmPush: async () => true })).ok, true);

		// Stale local merge: unrelated changes made in the review must survive.
		const race = path.join(root, "local-race");
		await init(race, { packages: ["npm:existing"], untouched: "before" });
		const raced = await runWebdavSyncCommand(["pull", "--plugins", "--profile", "a", "latest"], {
			agentDir: race, backend, choosePaths: async () => ["Packages"],
			selectProfile: async () => {
				await fs.writeFile(path.join(race, "settings.json"), jsonBytes({ packages: ["npm:existing", "npm:concurrent"], untouched: "concurrent edit" }));
				return "apply";
			},
		});
		assert.equal(raced.ok, false);
		assert.match(raced.text, /changed during selection.*restart/);
		assert.deepEqual(await json(path.join(race, "settings.json")), { packages: ["npm:existing", "npm:concurrent"], untouched: "concurrent edit" });
		assert.equal(await exists(path.join(race, ".webdav-sync", "backups")), false);
		assert.equal((await json(path.join(race, ".webdav-sync", "state.json"))).currentProfile, "mine");

		// Missing-file state matters too: an intervening new models.json is not overwritten.
		const createdDuringReview = path.join(root, "missing-models");
		await init(createdDuringReview);
		const intervening = { providers: { unrelated: { models: [{ id: "keep" }] } } };
		const missingRace = await runWebdavSyncCommand(["pull", "--models", "--profile", "a", "latest"], {
			agentDir: createdDuringReview, backend, choosePaths: async () => ["Models"],
			selectProfile: async () => { await fs.writeFile(path.join(createdDuringReview, "models.json"), jsonBytes(intervening)); return "apply"; },
		});
		assert.equal(missingRace.ok, false);
		assert.match(missingRace.text, /models.json changed during selection/);
		assert.deepEqual(await json(path.join(createdDuringReview, "models.json")), intervening);
		assert.equal(await exists(path.join(createdDuringReview, "auth.json")), false);

		// A retained credential is an input to the plan even when auth.json isn't written.
		const authRace = path.join(root, "auth-race");
		await init(authRace);
		await fs.writeFile(path.join(authRace, "models.json"), jsonBytes(modelConfig("target")));
		await fs.writeFile(path.join(authRace, "auth.json"), jsonBytes({ demo: { key: "OLD_ARTIFICIAL" } }));
		const authRaced = await runWebdavSyncCommand(["pull", "--models", "--profile", "a", "latest"], {
			agentDir: authRace, backend, choosePaths: async () => ["Models"],
			selectProfile: async (_choices, message) => {
				if (message.startsWith("Provider ")) return "local";
				await fs.writeFile(path.join(authRace, "auth.json"), jsonBytes({ demo: { key: "NEW_ARTIFICIAL" } }));
				return "apply";
			},
		});
		assert.equal(authRaced.ok, false);
		assert.match(authRaced.text, /auth.json changed during selection/);
		assert.deepEqual(await json(path.join(authRace, "models.json")), modelConfig("target"));
		assert.equal((await json(path.join(authRace, "auth.json"))).demo.key, "NEW_ARTIFICIAL");

		// The same provider question in B must not inherit A's Use source default.
		const drafts = path.join(root, "drafts");
		await init(drafts);
		await fs.writeFile(path.join(drafts, "models.json"), jsonBytes(modelConfig("target")));
		await fs.writeFile(path.join(drafts, "auth.json"), jsonBytes({ demo: { key: "TARGET_ARTIFICIAL" } }));
		let profileVisits = 0, snapshotsA = 0, categoriesA = 0, treesA = 0, conflictsA = 0;
		let activeProfile = "a", checkedB = false;
		const switched = await runWebdavSyncCommand(["pull"], {
			agentDir: drafts, backend,
			selectStep: async (_choices, message, initialId) => {
				if (message === "Select WebDAV profile:") { activeProfile = ++profileVisits === 1 ? "a" : "b"; return activeProfile; }
				if (message === "Select WebDAV snapshot:") return activeProfile === "a" && ++snapshotsA > 1 ? SYNC_BACK : "latest";
				if (message.includes("what should be applied")) return activeProfile === "a" && ++categoriesA > 1 ? SYNC_BACK : "models";
				if (message.startsWith("Provider ")) {
					if (activeProfile === "a") { conflictsA++; if (conflictsA === 2) { assert.equal(initialId, "source"); return SYNC_BACK; } return "source"; }
					checkedB = true; assert.equal(initialId, undefined); return SYNC_CANCEL;
				}
				if (message.startsWith("Review ")) return SYNC_BACK;
				throw new Error(`Unexpected draft menu: ${message}`);
			},
			choosePaths: async (_profile, files, options) => {
				if (activeProfile === "a" && ++treesA > 1) return SYNC_BACK;
				if (activeProfile === "b") assert.deepEqual(options.state.selected, []);
				return files.filter((file) => file.includes("shared"));
			},
		});
		assert.equal(switched.data.cancelled, true);
		assert.equal(profileVisits, 2);
		assert.equal(checkedB, true);
		assert.equal(await exists(path.join(drafts, ".webdav-sync", "backups")), false);

		// Same profile, different snapshot: even an identical catalogue gets a fresh tree draft.
		let snapshotVisits = 0, categoryVisits = 0, treeVisits = 0;
		const snapshotSwitch = await runWebdavSyncCommand(["pull", "--profile", "a"], {
			agentDir: drafts, backend,
			selectStep: async (choices, message, initialId) => {
				if (message === "Select WebDAV snapshot:") return ++snapshotVisits === 1 ? "latest" : choices.at(-1).id;
				if (message.includes("what should be applied")) {
					categoryVisits++;
					if (categoryVisits === 2) return SYNC_BACK;
					if (categoryVisits === 3) assert.equal(initialId, undefined);
					return "models";
				}
				throw new Error(`Unexpected snapshot menu: ${message}`);
			},
			choosePaths: async (_profile, files, options) => {
				treeVisits++;
				if (treeVisits === 1) { options.state.selected = [files[0]]; options.state.index = 2; return SYNC_BACK; }
				assert.deepEqual(options.state.selected, []); assert.equal(options.state.index, 0); return undefined;
			},
		});
		assert.equal(snapshotSwitch.data.cancelled, true);
		assert.equal(snapshotVisits, 2);
		assert.equal(treeVisits, 2);

		// settings.json's implicit payloads are reviewed; backing out preserves the
		// original explicit selection and creates no backup or local payloads.
		const dependent = path.join(root, "dependency-review");
		await init(dependent, { packages: [], kept: true });
		let filePicks = 0, dependencyReviews = 0;
		const dependencyCancelled = await runWebdavSyncCommand(["pull", "--select", "--profile", "a", "latest"], {
			agentDir: dependent, backend,
			choosePaths: async (_profile, _files, options) => {
				if (++filePicks > 1) assert.deepEqual(options.state.selected, ["settings.json"]);
				return ["settings.json"];
			},
			selectStep: async (_choices, message) => {
				assert.match(message, /^Review selected files/);
				assert.match(message, /dependency files: 1/);
				assert.match(message, /external-resources\//);
				assert.equal(await exists(path.join(dependent, ".webdav-sync", "backups")), false);
				return ++dependencyReviews === 1 ? SYNC_BACK : SYNC_CANCEL;
			},
		});
		assert.equal(dependencyCancelled.data.cancelled, true);
		assert.equal(dependencyReviews, 2);
		assert.equal(filePicks, 2);
		assert.deepEqual(await json(path.join(dependent, "settings.json")), { packages: [], kept: true });
		assert.equal(await exists(path.join(dependent, "external-resources")), false);

		// Skipping an install doesn't turn a desired declaration into an actual package.
		const skipped = path.join(root, "skipped-install");
		await init(skipped, { packages: [] });
		await fs.writeFile(path.join(skipped, "settings.webdav.json"), jsonBytes({ ...config, installMissingPackages: "ask" }));
		let installPrompts = 0;
		for (let attempt = 0; attempt < 2; attempt++) {
			const imported = await runWebdavSyncCommand(["pull", "--plugins", "--profile", "a", "latest"], {
				agentDir: skipped, backend, choosePaths: async () => ["Packages"], selectProfile: async () => "apply",
				confirmInstallPackages: async (specs) => { installPrompts++; assert.deepEqual(specs, ["npm:design-test-pkg"]); return false; },
				installPackage: async () => { throw new Error("Declined installation must not execute"); },
			});
			assert.equal(imported.ok, true, imported.text);
		}
		assert.equal(installPrompts, 2);
		assert.equal(await exists(path.join(skipped, "npm", "node_modules", "design-test-pkg")), false);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}
