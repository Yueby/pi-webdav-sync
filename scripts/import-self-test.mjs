import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runWebdavSyncCommand } from "../dist/src/commands.js";
import { pluginImportChoices, mergePluginImport } from "../dist/src/plugin-import.js";
import { createImportArchive, importCatalog, jsonBytes } from "../dist/src/import-plan.js";
import { createTreePickerComponent } from "../dist/src/tree-picker.js";
import { choosePathsFallback } from "../dist/src/path-select.js";
import { createLatestZip, parseArchive } from "../dist/src/zip-store.js";
import { collectAgentArchive } from "../dist/src/collector.js";
import { applyArchivePaths } from "../dist/src/backup.js";
import { packageIdentity } from "../dist/src/package-specs.js";

export async function runImportSelfTests({ MemoryBackend }) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-import-test-"));
	const json = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
	const config = {
		backend: "webdav", remoteBaseUrl: "https://example.invalid/dav/",
		installMissingPackages: "ask", backupRetention: 5,
		extraFiles: ["plugin-config.json"],
	};
	const init = async (dir, settings = {}) => {
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "settings.webdav.json"), jsonBytes(config));
		await fs.writeFile(path.join(dir, "settings.json"), jsonBytes(settings));
		await fs.mkdir(path.join(dir, ".webdav-sync"), { recursive: true });
		await fs.writeFile(path.join(dir, ".webdav-sync", "state.json"), jsonBytes({ currentProfile: "mine" }));
	};
	const source = path.join(root, "source");
	const target = path.join(root, "target");
	const external = path.join(root, "local-plugin");
	try {
		await fs.mkdir(external, { recursive: true });
		await fs.writeFile(path.join(external, "index.js"), "plugin payload\n");
		await init(source, {
			packages: ["npm:foo@2", { source: "npm:new-pkg", extensions: ["main.js"] }, external, "npm:unselected"],
			foo: { changed: "source", nested: { imported: true }, items: [2] },
			defaultModel: "source-model",
		});
		await fs.writeFile(path.join(source, "plugin-config.json"), jsonBytes({ enabled: true }));
		await fs.writeFile(path.join(source, "AGENTS.md"), "unselected source rules\n");
		await fs.mkdir(path.join(source, "extensions", "free"), { recursive: true });
		await fs.writeFile(path.join(source, "extensions", "free", "index.js"), "independent plugin payload\n");
		await fs.writeFile(path.join(source, "models.json"), jsonBytes({ providers: {
			demo: { baseUrl: "https://source.invalid/v1", api: "openai-completions", apiKey: "SOURCE_TEST_ONLY", models: [
				{ id: "shared", name: "Source model", contextWindow: 12345 }, { id: "new", name: "New model" },
			] },
			other: { baseUrl: "https://other.invalid", models: [{ id: "shared", name: "Other provider" }] },
		} }));
		await fs.writeFile(path.join(source, "auth.json"), jsonBytes({ demo: { type: "api_key", key: "SOURCE_AUTH_TEST_ONLY" }, unrelated: { key: "UNSELECTED_TEST_ONLY" } }));
		const backend = new MemoryBackend();
		const pushed = await runWebdavSyncCommand(["push", "--create-profile", "source"], { agentDir: source, backend, confirmPush: async () => true });
		assert.equal(pushed.ok, true, pushed.text);
		await init(target, { packages: ["foo@1", "npm:keep"], foo: { changed: "local", nested: { preserved: true }, items: [1] }, defaultModel: "local-model", shellPath: "/local/shell" });
		await fs.writeFile(path.join(target, "AGENTS.md"), "local rules\n");
		let installed = [];
		let presentation;
		let review;
		const pluginResult = await runWebdavSyncCommand(["pull", "--plugins", "--profile", "source", "latest"], {
			agentDir: target, backend,
			choosePaths: async (_profile, files, options) => {
				presentation = options;
				return files.filter((file) => file.startsWith("Packages/") && !file.includes("unselected") || file === "Settings (manual)/foo" || file === "Supplemental files (manual)/plugin-config.json");
			},
			selectProfile: async (_choices, message) => { review = message; return "apply"; },
			confirmInstallPackages: async (specs, mode) => { assert.equal(mode, "import"); assert.deepEqual(specs, ["npm:foo@2", "npm:new-pkg"]); return true; },
			installPackage: async (spec) => { installed.push(spec); return 0; },
		});
		assert.equal(pluginResult.ok, true, pluginResult.text);
		assert.match(pluginResult.text, /mode: plugins import/);
		assert.match(presentation.title, /plugins and configuration/);
		assert.equal(presentation.actionLabel, "Review");
		assert.match(review, /dependency files: 1/);
		assert.match(review, /replace: settings.json/);
		assert(!review.includes("SOURCE_AUTH_TEST_ONLY"));
		const merged = await json(path.join(target, "settings.json"));
		assert.deepEqual(merged.foo, { changed: "source", nested: { preserved: true, imported: true }, items: [2] });
		assert.equal(merged.defaultModel, "local-model");
		assert.equal(merged.shellPath, "/local/shell");
		assert.equal(merged.packages.filter((entry) => typeof entry === "string" && entry.startsWith("npm:foo")).length, 1);
		assert(merged.packages.includes("npm:keep"));
		assert(!merged.packages.includes("foo@1"));
		assert(!merged.packages.includes("npm:unselected"));
		assert.deepEqual(merged.packages.find((entry) => entry.source === "npm:new-pkg"), { source: "npm:new-pkg", extensions: ["main.js"] });
		assert.deepEqual(installed, ["npm:foo@2", "npm:new-pkg"]);
		const externalReference = merged.packages.find((entry) => typeof entry === "string" && entry.startsWith("./external-resources/"));
		assert(externalReference);
		assert.equal(await fs.readFile(path.join(target, externalReference, "index.js"), "utf8"), "plugin payload\n");
		assert.equal(await fs.readFile(path.join(target, "AGENTS.md"), "utf8"), "local rules\n");
		assert.deepEqual(await json(path.join(target, "plugin-config.json")), { enabled: true });
		assert.equal((await json(path.join(target, ".webdav-sync", "state.json"))).currentProfile, "mine");

		// Cancel the review, not just the picker: no backups or writes may occur.
		const cancelled = path.join(root, "cancelled");
		await init(cancelled, { packages: [] });
		const beforeCancel = await fs.readFile(path.join(cancelled, "settings.json"), "utf8");
		const cancelResult = await runWebdavSyncCommand(["pull", "--plugins", "--profile", "source", "latest"], {
			agentDir: cancelled, backend, choosePaths: async () => ["Packages"], selectProfile: async () => undefined,
		});
		assert.equal(cancelResult.data.cancelled, true);
		assert.equal(await fs.readFile(path.join(cancelled, "settings.json"), "utf8"), beforeCancel);
		await assert.rejects(fs.access(path.join(cancelled, ".webdav-sync", "backups")));
		assert.equal((await json(path.join(cancelled, ".webdav-sync", "state.json"))).currentProfile, "mine");

		// Models: same provider/id replaces; sibling models and settings survive.
		const localModels = { $schema: "local-schema", providers: {
			demo: { baseUrl: "https://local.invalid/v1", api: "openai-completions", apiKey: "LOCAL_TEST_ONLY", models: [
				{ id: "shared", name: "Local old", obsolete: true }, { id: "keep", name: "Keep me" },
			] },
			other: { models: [{ id: "shared", name: "Local other provider" }] },
		} };
		await fs.writeFile(path.join(target, "models.json"), jsonBytes(localModels));
		await fs.writeFile(path.join(target, "auth.json"), jsonBytes({ demo: { key: "LOCAL_AUTH_TEST_ONLY" }, keep: { key: "KEEP_AUTH_TEST_ONLY" } }));
		let conflicts = 0;
		const modelResult = await runWebdavSyncCommand(["pull", "--models", "--profile", "source", "latest"], {
			agentDir: target, backend,
			choosePaths: async (_profile, files) => files.filter((file) => file.includes("demo") && file.includes("shared")),
			selectProfile: async (_choices, message) => {
				assert(!/SOURCE_AUTH_TEST_ONLY|LOCAL_AUTH_TEST_ONLY|SOURCE_TEST_ONLY|LOCAL_TEST_ONLY/.test(message));
				if (message.startsWith("Provider ")) { conflicts++; return "local"; }
				return "apply";
			},
			installPackage: async () => { throw new Error("Model import must not install packages"); },
		});
		assert.equal(modelResult.ok, true, modelResult.text);
		assert.equal(conflicts, 1);
		const afterModel = await json(path.join(target, "models.json"));
		assert.equal(afterModel.$schema, "local-schema");
		assert.equal(afterModel.providers.demo.baseUrl, "https://local.invalid/v1");
		assert.deepEqual(afterModel.providers.demo.models.find((model) => model.id === "shared"), { id: "shared", name: "Source model", contextWindow: 12345 });
		assert.deepEqual(afterModel.providers.demo.models.find((model) => model.id === "keep"), { id: "keep", name: "Keep me" });
		assert.equal(afterModel.providers.demo.models.some((model) => model.id === "new"), false);
		assert.equal(afterModel.providers.other.models[0].name, "Local other provider");
		assert.equal((await json(path.join(target, "auth.json"))).demo.key, "LOCAL_AUTH_TEST_ONLY");
		assert.equal((await json(path.join(target, ".webdav-sync", "state.json"))).currentProfile, "mine");
		assert.deepEqual(await json(path.join(target, "settings.json")), merged);

		const sourceConnectionResult = await runWebdavSyncCommand(["pull", "--models", "--profile", "source", "latest"], {
			agentDir: target, backend,
			choosePaths: async (_profile, files) => files.filter((file) => file.includes("demo") && file.includes("shared")),
			selectProfile: async (_choices, message) => message.startsWith("Provider ") ? "source" : "apply",
		});
		assert.equal(sourceConnectionResult.ok, true, sourceConnectionResult.text);
		assert.equal((await json(path.join(target, "models.json"))).providers.demo.baseUrl, "https://source.invalid/v1");
		const afterAuth = await json(path.join(target, "auth.json"));
		assert.equal(afterAuth.demo.key, "SOURCE_AUTH_TEST_ONLY");
		assert.equal(afterAuth.keep.key, "KEEP_AUTH_TEST_ONLY");
		assert.equal(afterAuth.unrelated, undefined);

		// The interactive category menu reaches the same import path as the flag.
		let categories;
		const menuResult = await runWebdavSyncCommand(["pull", "--profile", "source", "latest"], {
			agentDir: target, backend,
			choosePaths: async (_profile, files) => files.filter((file) => file.includes("demo") && file.includes("shared")),
			selectProfile: async (offered, message) => {
				if (message.includes("what should be applied")) { categories = offered.map((choice) => choice.id); return "models"; }
				if (message.startsWith("Provider ")) return "local";
				return "apply";
			},
		});
		assert.equal(menuResult.ok, true, menuResult.text);
		assert.deepEqual(categories, ["all", "models", "plugins"]);
		assert.match(menuResult.text, /mode: models import/);

		// Selecting one independent plugin file leaves settings and package installation alone.
		const settingsBeforeFile = await fs.readFile(path.join(target, "settings.json"), "utf8");
		const fileOnly = await runWebdavSyncCommand(["pull", "--plugins", "--profile", "source", "latest"], {
			agentDir: target, backend,
			choosePaths: async () => ["Supplemental files (manual)/extensions/free"],
			selectProfile: async () => "apply",
			confirmInstallPackages: async () => { throw new Error("File-only import must not offer packages"); },
		});
		assert.equal(fileOnly.ok, true, fileOnly.text);
		assert.equal(await fs.readFile(path.join(target, "settings.json"), "utf8"), settingsBeforeFile);
		assert.equal(await fs.readFile(path.join(target, "extensions", "free", "index.js"), "utf8"), "independent plugin payload\n");
		assert.equal((await json(path.join(target, ".webdav-sync", "state.json"))).currentProfile, "mine");

		// Custom and fallback pickers both carry import presentation without changing key semantics.
		const component = createTreePickerComponent("source", ["Models/demo/model-id"], () => {}, { title: "Import models from source", actionLabel: "Review" });
		component.handleInput(" ");
		const rendered = component.render(80).join("\n");
		assert.match(rendered, /Import models from source/);
		assert.match(rendered, /Review 1 selection/);
		let fallbackStep = 0;
		const fallback = await choosePathsFallback(async (offered, title) => {
			assert.match(title, /^Import models from source/);
			fallbackStep++;
			if (fallbackStep === 1) return "Models";
			if (fallbackStep === 2) return offered.find((choice) => choice.label.includes("whole directory"))?.id;
			return offered.find((choice) => choice.label.startsWith("✓ Review"))?.id;
		}, "source", importCatalog(["Models/demo/model-id"]), { title: "Import models from source", actionLabel: "Review" });
		assert.deepEqual(fallback, ["Models/demo/model-id"]);

		// Bad JSON is never treated as an empty config in an import.
		await fs.writeFile(path.join(cancelled, "settings.json"), "{bad json");
		const badResult = await runWebdavSyncCommand(["pull", "--plugins", "--profile", "source", "latest"], {
			agentDir: cancelled, backend, choosePaths: async () => ["Packages"], selectProfile: async () => "apply",
		});
		assert.equal(badResult.ok, false);
		assert.match(badResult.text, /Local settings.json must contain valid JSON/);
		assert.equal(await fs.readFile(path.join(cancelled, "settings.json"), "utf8"), "{bad json");

		// A derived archive validates updated settings and selects only explicit payloads.
		const collected = await collectAgentArchive(source, config);
		const zip = createLatestZip(collected.zipEntries, collected.manifest);
		const archive = parseArchive(zip.zipBytes, zip.latest.zipSha256, config);
		const picks = pluginImportChoices(archive);
		assert(!picks.some((choice) => choice.file === "models.json" || choice.file === "auth.json"));
		assert.throws(() => mergePluginImport(archive, {}, ["Packages/not-offered"]), /Unknown plugin import/);
		const rulesAndGit = createImportArchive(archive, [], new Map([["settings.json", jsonBytes({
			packages: [{ source: "git:github.com/example/plugin@v2", extensions: ["chosen.ts"] }],
			extensions: ["-builtin:mcp", "!extensions/**/*.ts"],
		})]]), config);
		const ruleChoices = pluginImportChoices(rulesAndGit);
		const rulePlan = mergePluginImport(rulesAndGit, {
			packages: [{ source: "https://github.com/example/plugin.git@v1", extensions: ["old.ts"] }],
			extensions: ["builtin:mcp"],
		}, ruleChoices.filter((choice) => choice.kind !== "file").map((choice) => choice.path));
		assert.deepEqual(rulePlan.settings.packages, [{ source: "git:github.com/example/plugin@v2", extensions: ["chosen.ts"] }]);
		assert.deepEqual(rulePlan.settings.extensions, ["-builtin:mcp", "!extensions/**/*.ts"]);
		assert.equal(rulePlan.dependencyCount, 0);
		assert.equal(packageIdentity("git:git@github.com:example/plugin.git@feature/next"), packageIdentity("https://github.com/example/plugin@v2"));
		assert.equal(packageIdentity("git:github.com/example/plugin#v1"), packageIdentity("git:github.com/example/plugin#v2"));
		const derived = createImportArchive(archive, ["plugin-config.json", "extensions/free/index.js"], new Map([["settings.json", jsonBytes({ keep: true })]]), config);
		assert.equal(derived.entries.has("files/AGENTS.md"), false);
		assert.deepEqual(JSON.parse(derived.entries.get("files/settings.json")), { keep: true });
		assert.throws(() => createImportArchive(archive, ["not-in-archive.json"], new Map(), config), /outside the snapshot/);

		// Mid-write failure restores overwritten targets, removes new files, and
		// never writes merged settings before all referenced payloads are in place.
		const rollback = path.join(root, "rollback");
		await init(rollback, { original: true });
		await fs.writeFile(path.join(rollback, "plugin-config.json"), "original config");
		const writes = fs.writeFile;
		let failed = false;
		fs.writeFile = async (file, ...args) => {
			if (String(file) === path.join(rollback, "settings.json") && !failed) {
				failed = true;
				throw new Error("simulated import write failure");
			}
			return writes(file, ...args);
		};
		try {
			await assert.rejects(applyArchivePaths(rollback, derived, ["plugin-config.json", "extensions/free/index.js", "settings.json"], config, true), /rolled back/);
		} finally { fs.writeFile = writes; }
		assert.equal(await fs.readFile(path.join(rollback, "plugin-config.json"), "utf8"), "original config");
		assert.deepEqual(await json(path.join(rollback, "settings.json")), { original: true });
		await assert.rejects(fs.access(path.join(rollback, "extensions", "free", "index.js")));

		const unauthorized = path.join(root, "unauthorized");
		await init(unauthorized, { packages: [] });
		await fs.writeFile(path.join(unauthorized, "settings.webdav.json"), jsonBytes({ ...config, extraFiles: [] }));
		const rejected = await runWebdavSyncCommand(["pull", "--plugins", "--profile", "source", "latest"], {
			agentDir: unauthorized, backend, choosePaths: async () => ["Supplemental files (manual)/plugin-config.json"], selectProfile: async () => "apply",
		});
		assert.equal(rejected.ok, false);
		assert.match(rejected.text, /not allowlisted/);
		await assert.rejects(fs.access(path.join(unauthorized, "plugin-config.json")));

		// An explicitly selected latest declaration replaces a pinned install too.
		const latestSource = path.join(root, "latest-source");
		await init(latestSource, { packages: ["npm:foo@latest"] });
		const latestBackend = new MemoryBackend();
		assert.equal((await runWebdavSyncCommand(["push"], { agentDir: latestSource, backend: latestBackend, confirmPush: async () => true })).ok, true);
		const latestTarget = path.join(root, "latest-target");
		await init(latestTarget, { packages: ["npm:foo@1"] });
		const updates = [];
		const latestResult = await runWebdavSyncCommand(["pull", "--plugins", "latest"], {
			agentDir: latestTarget, backend: latestBackend, choosePaths: async () => ["Packages"], selectProfile: async () => "apply",
			confirmInstallPackages: async (specs) => { assert.deepEqual(specs, ["npm:foo@latest"]); return true; },
			installPackage: async (spec) => { updates.push(spec); return 0; },
		});
		assert.equal(latestResult.ok, true, latestResult.text);
		assert.deepEqual(updates, ["npm:foo@latest"]);
		assert.deepEqual((await json(path.join(latestTarget, "settings.json"))).packages, ["npm:foo@latest"]);

		for (const args of [["pull", "--models", "--plugins"], ["pull", "--models", "--select"], ["status", "--models"]]) {
			assert.equal((await runWebdavSyncCommand(args, { agentDir: target, backend })).ok, false);
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}
