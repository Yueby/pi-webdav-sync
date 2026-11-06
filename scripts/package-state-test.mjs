import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export async function runPackageStateTests() {
	const { missingInstalledPackages } = await import("../dist/src/package-state.js");
	const root = await mkdtemp(join(tmpdir(), "pi-package-state-"));
	const tests = [];
	const test = (name, run) => tests.push({ name, run });
	const settings = (...packages) => ({ packages });
	const json = async (path, value) => {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(value));
	};
	const install = (dir, name, version = "1.2.3", metadata = { name, version }) =>
		json(join(dir, "npm", "node_modules", name, "package.json"), metadata);
	const clone = async (dir, host, path, fileMarker = false) => {
		const target = join(dir, "git", host, path);
		await mkdir(target, { recursive: true });
		if (fileMarker) await writeFile(join(target, ".git"), "gitdir: fake-test-metadata\n");
		else await mkdir(join(target, ".git"));
		return target;
	};
	const detect = (dir, spec, options) => missingInstalledPackages(dir, settings(spec), options);

	test("a declaration without an npm install remains missing after declining", async (dir) => {
		const spec = "npm:missing@latest";
		await json(join(dir, "settings.json"), settings(spec));
		assert.deepEqual(await detect(dir, spec), [spec]);
		// Import records the same intent after the installation prompt was declined.
		await json(join(dir, "settings.json"), settings(spec));
		assert.deepEqual(await detect(dir, spec), [spec]);
		assert.deepEqual(await detect(dir, spec, { includeUpdates: true }), [spec]);
	});

	test("an incomplete npm directory is not an install", async (dir) => {
		await mkdir(join(dir, "npm", "node_modules", "incomplete"), { recursive: true });
		assert.deepEqual(await detect(dir, "npm:incomplete", { localSettings: settings("npm:incomplete") }), ["npm:incomplete"]);
	});

	test("scoped and bare npm specs use personal managed metadata", async (dir) => {
		await install(dir, "@scope/tool");
		await install(dir, "plain");
		assert.deepEqual(await missingInstalledPackages(dir, settings("npm:@scope/tool@1.2.3", "plain", { source: "@scope/tool@latest" })), []);
		assert.deepEqual(await detect(dir, "plain@latest", {
			includeUpdates: true, localSettings: settings("npm:plain"),
		}), []);
	});

	test("exact versions check disk even with identical configured intent", async (dir) => {
		const spec = "npm:plain@2.0.0";
		await install(dir, "plain", "1.2.3");
		const localSettings = settings(spec);
		assert.deepEqual(await detect(dir, spec, { localSettings, includeUpdates: false }), []);
		assert.deepEqual(await detect(dir, spec, { localSettings, includeUpdates: true }), [spec]);
		await install(dir, "plain", "2.0.0");
		assert.deepEqual(await detect(dir, spec, { localSettings, includeUpdates: true }), []);
		assert.deepEqual(await detect(dir, "plain@v2.0.0", { includeUpdates: true }), []);
	});

	test("pinned to latest offers an update while unchanged latest skips", async (dir) => {
		await install(dir, "plain");
		await json(join(dir, "npm", "package.json"), { dependencies: { plain: "^1.2.3" } });
		assert.deepEqual(await detect(dir, "npm:plain@latest", {
			includeUpdates: true, localSettings: settings("npm:plain@1.2.3"),
		}), ["npm:plain@latest"]);
		assert.deepEqual(await detect(dir, "npm:plain@latest", {
			includeUpdates: true, localSettings: settings("plain@latest"),
		}), []);
		assert.deepEqual(await detect(dir, "npm:plain@next", {
			includeUpdates: true, localSettings: settings("plain@latest"),
		}), ["npm:plain@next"]);
	});

	test("ranges compare intent and fall back to managed dependency declarations", async (dir) => {
		await install(dir, "plain");
		const spec = "npm:plain@^1.0.0";
		assert.deepEqual(await detect(dir, spec, {
			includeUpdates: true, localSettings: settings("npm:plain@^2.0.0"),
		}), [spec]);
		assert.deepEqual(await detect(dir, spec, {
			includeUpdates: true, localSettings: settings(spec),
		}), []);
		await json(join(dir, "npm", "package.json"), { dependencies: { plain: "^1.0.0" } });
		assert.deepEqual(await detect(dir, spec, { includeUpdates: true }), []);
		await json(join(dir, "npm", "package.json"), { dependencies: { plain: "^2.0.0" } });
		assert.deepEqual(await detect(dir, spec, { includeUpdates: true }), [spec]);
		await rm(join(dir, "npm", "package.json"));
		assert.deepEqual(await detect(dir, spec, { includeUpdates: true }), [spec]);
	});

	test("project-only npm installs do not satisfy personal imports", async (dir) => {
		const cwd = process.cwd();
		const project = join(dir, "project");
		const personal = join(dir, "personal");
		await install(join(project, ".pi"), "plain");
		try {
			process.chdir(project);
			assert.deepEqual(await detect(personal, "npm:plain", { localSettings: settings("npm:plain") }), ["npm:plain"]);
		} finally {
			process.chdir(cwd);
		}
	});

	test("malformed or mismatched package metadata never proves presence", async (dir) => {
		const path = join(dir, "npm", "node_modules", "plain", "package.json");
		for (const metadata of [null, [], {}, { name: "other", version: "1.2.3" },
			{ name: "plain", version: "" }, { name: "plain", version: "  " }, { name: "plain", version: 1 }]) {
			await install(dir, "plain", undefined, metadata);
			assert.deepEqual(await detect(dir, "npm:plain"), ["npm:plain"]);
		}
		await writeFile(path, '{"private":"artificial-secret",');
		assert.deepEqual(await detect(dir, "npm:plain"), ["npm:plain"]);
		await rm(path);
		await mkdir(path);
		assert.deepEqual(await detect(dir, "npm:plain"), ["npm:plain"]);
		await rm(dirname(path), { recursive: true });
		await writeFile(dirname(path), "incomplete install");
		assert.deepEqual(await detect(dir, "npm:plain"), ["npm:plain"]);
	});

	test("missing and malformed settings are unknown, supplied settings bypass disk", async (dir) => {
		await install(dir, "plain");
		assert.deepEqual(await detect(dir, "npm:plain"), []);
		await writeFile(join(dir, "settings.json"), '{"private":"artificial-secret",');
		assert.deepEqual(await detect(dir, "npm:plain"), []);
		await rm(join(dir, "settings.json"));
		await mkdir(join(dir, "settings.json"));
		assert.deepEqual(await detect(dir, "npm:plain", { localSettings: undefined }), []);
		await assert.rejects(() => detect(dir, "npm:plain"), (error) => {
			assert.equal(error.message, "Unable to read package installation state.");
			return true;
		});
	});

	test("git declarations and bare clone directories are not installations", async (dir) => {
		const spec = "git:github.com/team/tool@main";
		await json(join(dir, "settings.json"), settings(spec));
		assert.deepEqual(await detect(dir, spec), [spec]);
		await mkdir(join(dir, "git", "github.com", "team", "tool"), { recursive: true });
		assert.deepEqual(await detect(dir, spec), [spec]);
		await clone(dir, "github.com", "team/tool");
		assert.deepEqual(await detect(dir, spec, { includeUpdates: true }), []);
	});

	test("git URL mapping shares clone roots and compares ref intent", async (dir) => {
		await clone(dir, "github.com", "team/tool", true);
		const old = settings("git:github.com/team/tool@main");
		for (const spec of ["https://github.com/team/tool.git@main", "git:git@github.com:team/tool.git@main",
			"ssh://git@github.com/team/tool@main", "git://github.com/team/tool@main", "https://github.com/team/tool.git#main"]) {
			assert.deepEqual(await detect(dir, spec, { includeUpdates: true, localSettings: old }), []);
		}
		const spec = "git:github.com/team/tool@release/v2";
		assert.deepEqual(await detect(dir, spec, { includeUpdates: true, localSettings: old }), [spec]);
		assert.deepEqual(await detect(dir, spec, { localSettings: old }), []);
		assert.deepEqual(await detect(dir, "https://github.com/team/tool", { includeUpdates: true, localSettings: old }), ["https://github.com/team/tool"]);
	});

	test("generic git URL clones map nested paths without port or ref suffix", async (dir) => {
		await clone(dir, "git.example.invalid", "group/nested/tool");
		const spec = "https://git.example.invalid:8443/group/nested/tool.git@v1";
		assert.deepEqual(await detect(dir, spec, { includeUpdates: true, localSettings: settings(spec) }), []);
	});

	test("unresolved git mappings are reported rather than trusting declarations", async (dir) => {
		const spec = "git:github:team/tool@main";
		await clone(dir, "github.com", "team/tool");
		assert.deepEqual(await detect(dir, spec, { localSettings: settings(spec) }), [spec]);
		const unsafe = "git:https://git.example.invalid/team/%2e%2e%2foutside";
		assert.deepEqual(await detect(dir, unsafe, { localSettings: settings(unsafe) }), [unsafe]);
	});

	test("git clone symlinks cannot escape managed storage", async (dir) => {
		const outside = join(dir, "outside");
		await mkdir(join(outside, ".git"), { recursive: true });
		const parent = join(dir, "git", "github.com", "team");
		await mkdir(parent, { recursive: true });
		await symlink(outside, join(parent, "tool"), "junction");
		const spec = "git:github.com/team/tool";
		assert.deepEqual(await detect(dir, spec, { localSettings: settings(spec) }), [spec]);
	});

	test("package entry objects and duplicate specs retain deterministic output", async (dir) => {
		const source = settings("npm:z", { source: "npm:a", extensions: [] }, "npm:z", "./local");
		const before = structuredClone(source);
		assert.deepEqual(await missingInstalledPackages(dir, source), ["npm:a", "npm:z"]);
		assert.deepEqual(source, before);
	});

	try {
		for (let i = 0; i < tests.length; i++) {
			const { name, run } = tests[i];
			const dir = join(root, String(i));
			await mkdir(dir);
			try { await run(dir); } catch (error) {
				throw new Error(`Package state test failed: ${name}`, { cause: error });
			}
		}
		return tests.length;
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
