import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zipSync } from "fflate";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distUrl = (relativePath) =>
	pathToFileURL(path.join(root, "dist/src", relativePath)).href;
const { collectAgentArchive } = await import(distUrl("collector.js"));
const { validateConfig } = await import(distUrl("config.js"));
const { createManifest, sha256Bytes } = await import(distUrl("manifest.js"));
const { isRemotePackageSpec } = await import(distUrl("package-specs.js"));
const { createLatestZip, listZipEntries, parseArchive, DEFAULT_ARCHIVE_LIMITS } =
	await import(distUrl("zip-store.js"));
const { runWebdavSyncCommand, pruneRemoteSnapshots, resolvePiInvocation, runPiInstallWith } =
	await import(distUrl("commands.js"));
const { formatInstallProgress } = await import(distUrl("extension.js"));
const { scopedBackend } = await import(distUrl("backends/scoped.js"));
const { applyArchiveToAgent, applyArchiveWithRollback, createLocalBackup } =
	await import(distUrl("backup.js"));

class MemoryBackend {
	files = new Map();
	directories = new Set();
	async getJson(remotePath) {
		const bytes = await this.getBytes(remotePath);
		return JSON.parse(Buffer.from(bytes).toString("utf8"));
	}
	async getBytes(remotePath) {
		const bytes = this.files.get(remotePath);
		if (!bytes) throw new Error(`missing remote file: ${remotePath}`);
		return bytes;
	}
	async putJson(remotePath, data) {
		this.files.set(
			remotePath,
			Buffer.from(`${JSON.stringify(data, null, 2)}\n`, "utf8"),
		);
	}
	async putBytes(remotePath, bytes) {
		this.files.set(remotePath, Buffer.from(bytes));
	}
	async delete(remotePath) {
		// WebDAV DELETE on a collection is recursive.
		this.files.delete(remotePath);
		this.directories.delete(remotePath);
		for (const key of [...this.files.keys()]) {
			if (key.startsWith(`${remotePath}/`)) this.files.delete(key);
		}
		for (const dir of [...this.directories]) {
			if (dir.startsWith(`${remotePath}/`)) this.directories.delete(dir);
		}
	}
	async exists(remotePath) {
		return this.files.has(remotePath) || this.directories.has(remotePath);
	}
	async createDirectory(remotePath) {
		if (await this.exists(remotePath)) return false;
		for (const key of this.files.keys()) {
			if (key.startsWith(`${remotePath}/`)) return false;
		}
		this.directories.add(remotePath);
		return true;
	}
	async move(remotePath, destinationPath) {
		if (await this.exists(destinationPath)) {
			throw new Error(`destination already exists: ${destinationPath}`);
		}
		if (this.files.has(remotePath)) {
			this.files.set(destinationPath, this.files.get(remotePath));
			this.files.delete(remotePath);
			return;
		}
		const moved = [...this.files].filter(([key]) =>
			key.startsWith(`${remotePath}/`),
		);
		if (!moved.length && !this.directories.has(remotePath))
			throw new Error(`missing remote collection: ${remotePath}`);
		for (const [key, value] of moved) {
			this.files.delete(key);
			this.files.set(`${destinationPath}${key.slice(remotePath.length)}`, value);
		}
		for (const dir of [...this.directories]) {
			if (dir === remotePath || dir.startsWith(`${remotePath}/`)) {
				this.directories.delete(dir);
				this.directories.add(`${destinationPath}${dir.slice(remotePath.length)}`);
			}
		}
	}
	async list(remotePath = ".") {
		const prefix =
			!remotePath || remotePath === "."
				? ""
				: `${remotePath.replace(/\/+$/, "")}/`;
		const children = new Map();
		for (const key of [
			...this.files.keys(),
			...this.directories.values(),
		].sort()) {
			if (!key.startsWith(prefix)) continue;
			const rest = key.slice(prefix.length);
			if (!rest) continue;
			const slash = rest.indexOf("/");
			const name = slash === -1 ? rest : rest.slice(0, slash);
			const isDirectory = slash !== -1 || this.directories.has(key);
			if (!children.has(name))
				children.set(name, isDirectory ? "directory" : "file");
		}
		return [...children.entries()].map(([name, type]) => ({
			path: `${prefix}${name}`,
			type,
		}));
	}
	async listIfExists(remotePath = ".") {
		return await this.list(remotePath);
	}
}

const tempRoot = await fs.mkdtemp(
	path.join(os.tmpdir(), "pi-webdav-sync-test-"),
);
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const testHome = path.join(tempRoot, "home");
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
const sourceAgent = path.join(tempRoot, "source-agent");
const targetAgent = path.join(tempRoot, "target-agent");
const initAgent = path.join(tempRoot, "init-agent");
const externalDir = path.join(tempRoot, "external package");
const extraPaths = {
	extraFiles: ["hermes-memory-config.json", "~/.pi/web-search.json"],
	extraDirs: ["custom-config"],
};

try {
	const initCreated = await runWebdavSyncCommand(["init"], {
		agentDir: initAgent,
	});
	assert.equal(initCreated.ok, true, "init should create config template");
	const initConfigPath = path.join(initAgent, "settings.webdav.json");
	const initConfig = JSON.parse(await fs.readFile(initConfigPath, "utf8"));
	assert.equal(
		initConfig.backend,
		"webdav",
		"init template should be WebDAV config",
	);
	assert.equal(
		initConfig.passwordEnv,
		"PI_WEBDAV_PASSWORD",
		"init template should prefer passwordEnv",
	);
	assert.deepEqual(initConfig.extraFiles, [], "init template should include extraFiles");
	assert.deepEqual(initConfig.extraDirs, [], "init template should include extraDirs");
	assert.deepEqual(
		validateConfig({
			backend: "webdav",
			extraFiles: ["foo\\bar.json", "foo/bar.json"],
			extraDirs: ["~\\.config\\tool"],
		}).extraFiles,
		["foo/bar.json"],
		"configured paths should be normalized and deduplicated",
	);
	assert.deepEqual(
		validateConfig({
			backend: "webdav",
			extraDirs: ["~\\.config\\tool"],
		}).extraDirs,
		["~/.config/tool"],
		"home-relative configured paths should use portable separators",
	);
	assert.throws(
		() => validateConfig({ backend: "webdav", extraFiles: "file.json" }),
		/array of strings/,
		"extraFiles should require an array",
	);
	assert.throws(
		() => validateConfig({ backend: "webdav", extraFiles: ["../file.json"] }),
		/agent-relative or start with ~\//,
		"configured paths should reject traversal",
	);
	assert.throws(
		() => validateConfig({ backend: "webdav", extraFiles: ["C:\\file.json"] }),
		/agent-relative or start with ~\//,
		"configured paths should reject absolute paths",
	);
	assert.throws(
		() => validateConfig({ backend: "webdav", extraFiles: ["C:relative.json"] }),
		/agent-relative or start with ~\//,
		"configured paths should reject drive-relative paths",
	);
	assert.throws(
		() => validateConfig({ backend: "webdav", extraFiles: ["bad\0file.json"] }),
		/agent-relative or start with ~\//,
		"configured paths should reject NUL on every platform",
	);
	assert.throws(
		() =>
			validateConfig({
				backend: "webdav",
				extraFiles: ["custom"],
				extraDirs: ["custom/nested"],
			}),
		/conflicts with extra directory/,
		"an extra file should not contain an extra directory",
	);
	assert.throws(
		() => validateConfig({ backend: "webdav", extraDirs: ["cache"] }),
		/always excluded/,
		"configured paths should reject always-excluded directories",
	);
	if (process.platform === "win32") {
		for (const invalidPath of ["bad?.json", "file.txt:hidden", "CON.json"]) {
			assert.throws(
				() => validateConfig({ backend: "webdav", extraFiles: [invalidPath] }),
				/not valid on this platform/,
				`configured path should reject Windows-invalid name: ${invalidPath}`,
			);
		}
	}
	if (process.platform === "win32" || process.platform === "darwin") {
		assert.throws(
			() =>
				validateConfig({
					backend: "webdav",
					extraFiles: ["Custom"],
					extraDirs: ["custom/nested"],
				}),
			/conflicts with extra directory/,
			"configured paths should detect case-insensitive type conflicts",
		);
	}
	const initExisting = await runWebdavSyncCommand(["init"], {
		agentDir: initAgent,
	});
	assert.match(
		initExisting.text,
		/init: exists/,
		"init should not overwrite existing config by default",
	);
	initConfig.remoteDir = "/custom";
	await fs.writeFile(
		initConfigPath,
		`${JSON.stringify(initConfig, null, 2)}\n`,
		"utf8",
	);
	let askedOverwritePath;
	const initOverwrite = await runWebdavSyncCommand(["init"], {
		agentDir: initAgent,
		confirmOverwriteConfig: async (filePath) => {
			askedOverwritePath = filePath;
			return true;
		},
	});
	assert.match(
		initOverwrite.text,
		/init: overwritten/,
		"init should overwrite when confirmed",
	);
	assert.equal(
		askedOverwritePath,
		initConfigPath,
		"init overwrite should expose config path",
	);
	assert.notEqual(
		JSON.parse(await fs.readFile(initConfigPath, "utf8")).remoteDir,
		"/custom",
		"init overwrite should replace existing config",
	);
	const remoteInit = await runWebdavSyncCommand(
		["init", "https://example.invalid/pi-webdav.json"],
		{
			agentDir: initAgent,
			confirmOverwriteConfig: async () => true,
			fetchRemoteConfig: async (url) => ({
				backend: "webdav",
				remoteBaseUrl: url.replace("pi-webdav.json", "dav/"),
				username: "remote-user@example.com",
				passwordEnv: "REMOTE_WEBDAV_PASSWORD",
				remoteDir: "/remote-sync",
				installMissingPackages: "never",
				backupRetention: 3,
			}),
		},
	);
	assert.match(
		remoteInit.text,
		/source: remote config/,
		"init should report remote config source",
	);
	const remoteConfig = JSON.parse(await fs.readFile(initConfigPath, "utf8"));
	assert.equal(
		remoteConfig.remoteBaseUrl,
		"https://example.invalid/dav/",
		"init remote URL should write fetched config",
	);
	assert.equal(
		remoteConfig.passwordEnv,
		"REMOTE_WEBDAV_PASSWORD",
		"init remote URL should preserve fetched passwordEnv",
	);
	const remoteTextInit = await runWebdavSyncCommand(
		["init", "https://example.invalid/plain-config.txt"],
		{
			agentDir: initAgent,
			confirmOverwriteConfig: async () => true,
			fetchRemoteConfig: async () =>
				[
					"{",
					'  "backend": "webdav",',
					'  "remoteBaseUrl": "https://plain.example/dav/",',
					'  "username": "plain-user@example.com",',
					'  "passwordEnv": "PLAIN_WEBDAV_PASSWORD",',
					'  "remoteDir": "/plain-sync"',
					"}",
				].join("\n"),
		},
	);
	assert.match(
		remoteTextInit.text,
		/source: remote config/,
		"init should accept remote text config",
	);
	assert.equal(
		JSON.parse(await fs.readFile(initConfigPath, "utf8")).remoteBaseUrl,
		"https://plain.example/dav/",
		"init remote text should write fetched text",
	);
	const badRemoteInit = await runWebdavSyncCommand(
		["init", "file:///bad.json"],
		{
			agentDir: path.join(tempRoot, "bad-init-agent"),
		},
	);
	assert.equal(
		badRemoteInit.ok,
		false,
		"init should reject non-http remote config URLs",
	);

	await seedSourceAgent(sourceAgent, externalDir);

	const collected = await collectAgentArchive(sourceAgent);
	const zip = createLatestZip(collected.zipEntries, collected.manifest);
	const zipEntries = listZipEntries(zip.zipBytes);
	assert(
		isRemotePackageSpec("pi-skills"),
		"bare package names should be remote package specs",
	);
	assert(
		isRemotePackageSpec("@org/pkg"),
		"scoped package names should be remote package specs",
	);
	assert(
		!isRemotePackageSpec("./local-package"),
		"relative paths should not be remote package specs",
	);
	assert(
		collected.manifest.packageSpecs.includes("pi-skills"),
		"bare package names should enter manifest packageSpecs",
	);
	const manifestPaths = collected.manifest.files
		.map((file) => file.path)
		.sort();

	assert(
		manifestPaths.includes("AGENTS.md"),
		"allowlist file should enter manifest",
	);
	assert(
		manifestPaths.includes("auth.json"),
		"secret allowlist file should enter manifest",
	);
	assert(
		manifestPaths.includes("skills/good/skill.md"),
		"allowlist directory file should enter manifest",
	);
	assert(
		manifestPaths.includes("extensions/foo/index.js"),
		"allowlist extension file should enter manifest",
	);
	assert(
		!manifestPaths.includes("hermes-memory-config.json"),
		"unconfigured extra file should stay out of manifest",
	);
	assert(
		!manifestPaths.includes("custom-config/nested/config.json"),
		"unconfigured extra directory should stay out of manifest",
	);

	const allPaths = [...manifestPaths, ...zipEntries].join("\n");
	assert(
		!allPaths.includes("npm/pkg"),
		"npm install artifact should be excluded",
	);
	assert(
		!allPaths.includes("git/pkg"),
		"git install artifact should be excluded",
	);
	assert(
		!allPaths.includes("node_modules/bad"),
		"node_modules should be excluded",
	);
	assert(!allPaths.includes("sessions/session"), "sessions should be excluded");
	assert(
		!allPaths.includes(".webdav-sync/config"),
		"webdav-sync config should be excluded",
	);
	assert(!allPaths.includes("pi-crash.log"), "log files should be excluded");

	assert.equal(
		collected.manifest.externalResources.length,
		2,
		"settings external paths should be copied as external resources",
	);
	assert(
		zipEntries.some(
			(entry) =>
				entry.startsWith("external-resources/") &&
				entry.endsWith("package.json"),
		),
		"external package file should be in zip",
	);
	assert(
		zipEntries.some(
			(entry) =>
				entry.startsWith("external-resources/") &&
				entry.endsWith("src/index.js"),
		),
		"external nested file should be in zip",
	);

	const rewrittenSettings = collected.zipEntries
		.get("files/settings.json")
		.toString("utf8");
	assert(
		rewrittenSettings.includes("./external-resources/"),
		"settings external paths should be rewritten",
	);
	assert(
		rewrittenSettings.includes("npm:pi-web-access"),
		"remote npm package spec should be preserved",
	);
	assert(
		!rewrittenSettings.includes(externalDir),
		"rewritten settings should not keep external absolute path",
	);
	for (const key of ["shellPath", "npmCommand", "sessionDir"]) {
		assert(
			!rewrittenSettings.includes(key),
			`local-only ${key} should be omitted from rewritten settings`,
		);
	}

	for (const entry of zipEntries) {
		assert(!entry.startsWith("/"), `zip entry must not be absolute: ${entry}`);
		assert(
			!entry.includes(".."),
			`zip entry must not contain path traversal: ${entry}`,
		);
		assert(
			!entry.includes("\\"),
			`zip entry must not contain backslash: ${entry}`,
		);
	}
	assert.throws(
		() => parseArchive(zip.zipBytes, "0".repeat(64)),
		/zipSha256/,
		"zip hash mismatch should be rejected",
	);
	const badManifest = createManifest({
		files: [
			{
				path: ".webdav-sync/config.json",
				type: "file",
				size: 2,
				sha256:
					"44136fa355b3678a1146ad16f7e8649e94fb4f90eec5f8a7772cc7c5b5d50a14",
			},
		],
		externalResources: [],
		packageSpecs: [],
		warnings: [],
	});
	const badZip = createLatestZip(
		new Map([
			["files/.webdav-sync/config.json", Buffer.from("{}")],
			[
				"manifest.json",
				Buffer.from(`${JSON.stringify(badManifest, null, 2)}\n`, "utf8"),
			],
		]),
		badManifest,
	);
	assert.throws(
		() => parseArchive(badZip.zipBytes, badZip.latest.zipSha256),
		/not allowlisted/,
		"manifest paths outside allowlist should be rejected",
	);
	const nulZip = createUncheckedRegularFileZip([
		["custom-config/bad\0file.json", Buffer.from("unsafe\n")],
	]);
	assert.throws(
		() => parseArchive(nulZip, undefined, { extraDirs: ["custom-config"] }),
		/Unsafe zip path/,
		"incoming archives should reject NUL paths on every platform",
	);

	const homeExtraPath = "~/.config/rpiv-ask-user-question/config.json";
	const homeExtraBytes = Buffer.from("{\"enabled\":true}\n");
	const homeExtraManifest = createManifest({
		files: [
			{
				path: homeExtraPath,
				type: "file",
				size: homeExtraBytes.byteLength,
				sha256: sha256Bytes(homeExtraBytes),
			},
		],
		externalResources: [],
		packageSpecs: [],
		warnings: [],
	});
	const homeExtraZip = createLatestZip(
		new Map([
			[`files/${homeExtraPath}`, homeExtraBytes],
			[
				"manifest.json",
				Buffer.from(`${JSON.stringify(homeExtraManifest, null, 2)}\n`, "utf8"),
			],
		]),
		homeExtraManifest,
	);
	assert.throws(
		() => parseArchive(homeExtraZip.zipBytes, homeExtraZip.latest.zipSha256),
		/not allowlisted/,
		"custom manifest paths should require local authorization",
	);
	assert.doesNotThrow(
		() =>
			parseArchive(homeExtraZip.zipBytes, homeExtraZip.latest.zipSha256, {
				extraDirs: ["~/.config/rpiv-ask-user-question"],
			}),
		"an authorized custom directory should accept descendant manifest paths",
	);
	assert.throws(
		() =>
			parseArchive(homeExtraZip.zipBytes, homeExtraZip.latest.zipSha256, {
				extraFiles: ["~/.config/rpiv-ask-user-question/other.json"],
			}),
		/not allowlisted/,
		"extraFiles authorization should only match the exact path",
	);

	const directoryRootZip = createRegularFileZip([
		["custom-config", Buffer.from("not a directory\n")],
	]);
	assert.throws(
		() =>
			parseArchive(
				directoryRootZip.zipBytes,
				directoryRootZip.latest.zipSha256,
				{ extraDirs: ["custom-config"] },
			),
		/not allowlisted/,
		"an extra directory should not authorize replacing its root with a file",
	);

	const builtinArchive = parseArchive(zip.zipBytes, zip.latest.zipSha256);
	const typeMismatchAgent = path.join(tempRoot, "type-mismatch-agent");
	await fs.mkdir(path.join(typeMismatchAgent, "bad-file"), { recursive: true });
	await fs.writeFile(path.join(typeMismatchAgent, "AGENTS.md"), "must survive\n");
	await assert.rejects(
		() =>
			applyArchiveToAgent(typeMismatchAgent, builtinArchive, {
				extraFiles: ["bad-file"],
			}),
		/Configured file is not a file/,
		"a configured type mismatch should fail before clearing built-in files",
	);
	assert.equal(
		await fs.readFile(path.join(typeMismatchAgent, "AGENTS.md"), "utf8"),
		"must survive\n",
		"type preflight failure should leave built-in files untouched",
	);

	const symlinkAgent = path.join(tempRoot, "symlink-agent");
	const symlinkTarget = path.join(tempRoot, "symlink-target");
	await fs.mkdir(symlinkAgent, { recursive: true });
	await fs.mkdir(symlinkTarget, { recursive: true });
	await fs.writeFile(path.join(symlinkAgent, "AGENTS.md"), "must survive\n");
	const configuredLink = path.join(symlinkAgent, "linked-config");
	await fs.symlink(
		symlinkTarget,
		configuredLink,
		process.platform === "win32" ? "junction" : "dir",
	);
	await assert.rejects(
		() =>
			applyArchiveToAgent(symlinkAgent, builtinArchive, {
				extraDirs: ["linked-config"],
			}),
		/Configured path is a symlink/,
		"a configured leaf symlink should fail before clearing built-in files",
	);
	assert.equal(
		(await fs.lstat(configuredLink)).isSymbolicLink(),
		true,
		"symlink preflight failure should preserve the configured link",
	);
	assert.equal(
		await fs.readFile(path.join(symlinkAgent, "AGENTS.md"), "utf8"),
		"must survive\n",
		"symlink preflight failure should leave built-in files untouched",
	);

	const hierarchyZip = createRegularFileZip([
		["custom-config/node", Buffer.from("parent\n")],
		["custom-config/node/child.json", Buffer.from("child\n")],
	]);
	const hierarchyArchive = parseArchive(
		hierarchyZip.zipBytes,
		hierarchyZip.latest.zipSha256,
		{ extraDirs: ["custom-config"] },
	);
	const hierarchyAgent = path.join(tempRoot, "hierarchy-agent");
	await fs.mkdir(hierarchyAgent, { recursive: true });
	await fs.writeFile(path.join(hierarchyAgent, "AGENTS.md"), "must survive\n");
	await assert.rejects(
		() =>
			applyArchiveToAgent(hierarchyAgent, hierarchyArchive, {
				extraDirs: ["custom-config"],
			}),
		/conflicts with descendant path/,
		"parent-file conflicts should fail before clearing built-in files",
	);
	assert.equal(
		await fs.readFile(path.join(hierarchyAgent, "AGENTS.md"), "utf8"),
		"must survive\n",
		"archive target conflict should leave built-in files untouched",
	);

	const aliasAgent = path.join(testHome, "alias-agent");
	await fs.mkdir(aliasAgent, { recursive: true });
	await fs.writeFile(path.join(aliasAgent, "AGENTS.md"), "must survive\n");
	await assert.rejects(
		() =>
			applyArchiveToAgent(aliasAgent, builtinArchive, {
				extraFiles: ["shared"],
				extraDirs: ["~/alias-agent/shared/nested"],
			}),
		/Configured file conflicts with descendant path/,
		"resolved aliases in configured paths should be rejected before clearing",
	);
	assert.equal(
		await fs.readFile(path.join(aliasAgent, "AGENTS.md"), "utf8"),
		"must survive\n",
		"configured target conflict should leave built-in files untouched",
	);

	if (process.platform === "win32") {
		for (const invalidPath of [
			"custom-config/bad?.json",
			"custom-config/file.txt:hidden",
		]) {
			const unsafeZip = createUncheckedRegularFileZip([
				[invalidPath, Buffer.from("unsafe\n")],
			]);
			assert.throws(
				() => parseArchive(unsafeZip, undefined, { extraDirs: ["custom-config"] }),
				/Unsafe zip path/,
				`incoming archive should reject Windows-invalid path: ${invalidPath}`,
			);
		}
	}

	if (process.platform === "win32" || process.platform === "darwin") {
		const caseCollisionZip = createRegularFileZip([
			["custom-config/A.json", Buffer.from("upper\n")],
			["custom-config/a.json", Buffer.from("lower\n")],
		]);
		const caseCollisionArchive = parseArchive(
			caseCollisionZip.zipBytes,
			caseCollisionZip.latest.zipSha256,
			{ extraDirs: ["custom-config"] },
		);
		await assert.rejects(
			() =>
				applyArchiveToAgent(hierarchyAgent, caseCollisionArchive, {
					extraDirs: ["custom-config"],
				}),
			/resolve to the same target/,
			"case-insensitive target collisions should be rejected",
		);
		assert.equal(
			await fs.readFile(path.join(hierarchyAgent, "AGENTS.md"), "utf8"),
			"must survive\n",
			"case collision should leave built-in files untouched",
		);
		if (process.platform === "darwin") {
			const unicodeCollisionZip = createRegularFileZip([
				["custom-config/\u00e9.json", Buffer.from("nfc\n")],
				["custom-config/e\u0301.json", Buffer.from("nfd\n")],
			]);
			const unicodeCollisionArchive = parseArchive(
				unicodeCollisionZip.zipBytes,
				unicodeCollisionZip.latest.zipSha256,
				{ extraDirs: ["custom-config"] },
			);
			await assert.rejects(
				() =>
					applyArchiveToAgent(hierarchyAgent, unicodeCollisionArchive, {
						extraDirs: ["custom-config"],
					}),
				/resolve to the same target/,
				"Unicode-normalization collisions should be rejected on macOS",
			);
		}
	}

	await writeTestConfig(sourceAgent);
	const cancelledBackend = new MemoryBackend();
	let pushPreview;
	const cancelledPush = await runWebdavSyncCommand(["push"], {
		agentDir: sourceAgent,
		backend: cancelledBackend,
		confirmPush: async (preview) => {
			pushPreview = preview;
			return false;
		},
	});
	assert.equal(cancelledPush.ok, true, "cancelled push should return cleanly");
	assert.equal(
		cancelledBackend.files.size,
		0,
		"cancelled push should not upload",
	);
	assert.equal(
		pushPreview.fileCount,
		zip.latest.fileCount + 3,
		"push confirmation should include configured extra paths",
	);

	const backend = new MemoryBackend();
	const push = await runWebdavSyncCommand(["push"], {
		agentDir: sourceAgent,
		backend,
		confirmPush: async () => true,
	});
	assert.equal(push.ok, true, "confirmed push should upload to backend");
	const remoteKeys = [...backend.files.keys()].sort();
	assert.equal(
		remoteKeys.includes("profiles/default/latest.json"),
		true,
		"the default profile is a directory under profiles/",
	);
	assert.equal(
		remoteKeys.includes("profiles/default/latest.zip"),
		true,
		"the default profile keeps its archive there too",
	);
	assert.equal(
		remoteKeys.includes("layout.json"),
		true,
		"a push marks the remote as profile-layout based",
	);
	assert.equal(
		remoteKeys.some(
			(key) =>
				key === "latest.json" ||
				key === "latest.zip" ||
				key.startsWith("snapshots/"),
		),
		false,
		"the new layout must not write anything at the remote root",
	);
	assert.equal(
		remoteKeys.filter(
			(key) =>
				key.startsWith("profiles/default/snapshots/") &&
				key.endsWith(".json"),
		).length,
		1,
	);
	assert.equal(
		remoteKeys.filter(
			(key) =>
				key.startsWith("profiles/default/snapshots/") && key.endsWith(".zip"),
		).length,
		1,
	);

	const pruneBackend = new MemoryBackend();
	const fakeIds = [
		"2026-01-01T00-00-00-000Z",
		"2026-01-02T00-00-00-000Z",
		"2026-01-03T00-00-00-000Z",
		"2026-01-04T00-00-00-000Z",
		"2026-01-05T00-00-00-000Z",
		"2026-01-06T00-00-00-000Z",
		"2026-01-07T00-00-00-000Z",
		"2026-01-08T00-00-00-000Z",
	];
	for (const id of fakeIds) {
		pruneBackend.files.set(`snapshots/${id}.zip`, Buffer.from("zip"));
		pruneBackend.files.set(`snapshots/${id}.json`, Buffer.from("{}"));
	}
	const pruned = await pruneRemoteSnapshots(pruneBackend, 5);
	assert.deepEqual(
		pruned.sort(),
		fakeIds.slice(0, 3),
		"prune should drop oldest beyond retention",
	);
	assert.equal(
		[...pruneBackend.files.keys()].filter(
			(key) => key.startsWith("snapshots/") && key.endsWith(".zip"),
		).length,
		5,
		"retention should keep newest 5 snapshots",
	);
	assert.equal(
		pruneBackend.files.has("snapshots/2026-01-08T00-00-00-000Z.zip"),
		true,
		"newest snapshot should survive pruning",
	);
	assert.equal(
		pruneBackend.files.has("snapshots/2026-01-01T00-00-00-000Z.json"),
		false,
		"pruned snapshot json should be removed",
	);
	assert.equal(
		(await pruneRemoteSnapshots(pruneBackend, 0)).length,
		0,
		"retention 0 should disable snapshot pruning",
	);
	assert.equal(
		[...pruneBackend.files.keys()].filter(
			(key) => key.startsWith("snapshots/") && key.endsWith(".zip"),
		).length,
		5,
		"retention 0 should keep every snapshot",
	);

	await seedTargetAgent(targetAgent);
	await writeTestConfig(targetAgent);
	let selectedSnapshot;
	let askedToInstall;
	const installedSpecs = [];
	const pull = await runWebdavSyncCommand(["pull"], {
		agentDir: targetAgent,
		backend,
		selectSnapshot: async (choices) => {
			selectedSnapshot = choices[1]?.id;
			return selectedSnapshot;
		},
		confirmInstallPackages: async (specs) => {
			askedToInstall = specs;
			return true;
		},
		installPackage: async (spec) => {
			installedSpecs.push(spec);
			return 0;
		},
	});
	assert.equal(pull.ok, true, "pull should apply archive");
	assert(
		selectedSnapshot?.startsWith("20"),
		"pull should expose snapshot choices",
	);
	assert.deepEqual(
		askedToInstall,
		["npm:pi-web-access", "pi-skills"],
		"ask mode should prompt for snapshot packages",
	);
	assert.deepEqual(
		installedSpecs,
		["npm:pi-web-access", "pi-skills"],
		"ask mode should install packages when confirmed",
	);
	assert.equal(
		await fs.readFile(path.join(targetAgent, "AGENTS.md"), "utf8"),
		"agent rules\n",
		"pull should restore allowlist file",
	);
	assert.equal(
		await fs.readFile(
			path.join(targetAgent, "skills", "good", "skill.md"),
			"utf8",
		),
		"skill\n",
		"pull should restore skill",
	);
	assert.equal(
		await fs.readFile(path.join(targetAgent, "hermes-memory-config.json"), "utf8"),
		"source memory config\n",
		"pull should restore a configured extra file",
	);
	assert.equal(
		await fs.readFile(path.join(testHome, ".pi", "web-search.json"), "utf8"),
		"source home config\n",
		"pull should restore a configured home-relative file",
	);
	assert.equal(
		await fs.readFile(
			path.join(targetAgent, "custom-config", "nested", "config.json"),
			"utf8",
		),
		"source directory config\n",
		"pull should restore files under a configured extra directory",
	);
	assert.equal(
		await exists(path.join(targetAgent, "custom-config", "old-only.json")),
		false,
		"pull should replace a configured extra directory",
	);
	assert.equal(
		await exists(path.join(targetAgent, "old-only.txt")),
		true,
		"non-allowlisted file should not be touched",
	);
	assert.equal(
		await exists(path.join(targetAgent, "extensions", "old")),
		false,
		"allowlisted directory absent from remote should be replaced",
	);
	assert.equal(
		await exists(path.join(targetAgent, "external-resources")),
		true,
		"pull should restore external resources",
	);
	const backupAfterPull = await collectAgentArchive(targetAgent);
	assert(
		backupAfterPull.manifest.externalResources.length > 0,
		"backup collection should preserve restored external-resources references",
	);
	const pulledSettings = await fs.readFile(
		path.join(targetAgent, "settings.json"),
		"utf8",
	);
	assert(
		pulledSettings.includes("./external-resources/"),
		"pulled settings should reference restored external resources",
	);
	assert(
		!pulledSettings.includes(externalDir),
		"pulled settings should not contain source absolute external path",
	);
	for (const key of ["shellPath", "npmCommand", "sessionDir"]) {
		assert(
			!pulledSettings.includes(key),
			`pulled settings should not restore local-only ${key}`,
		);
	}

	const backups = await fs.readdir(
		path.join(targetAgent, ".webdav-sync", "backups"),
	);
	assert.equal(backups.length, 1, "pull should create one local backup");

	const statusEmpty = new MemoryBackend();
	const statusNone = await runWebdavSyncCommand(["status"], {
		agentDir: targetAgent,
		backend: statusEmpty,
	});
	assert.match(
		statusNone.text,
		/no remote snapshot/,
		"status should report missing remote snapshot",
	);

	const statusClean = await runWebdavSyncCommand(["status"], {
		agentDir: targetAgent,
		backend,
	});
	assert.equal(statusClean.ok, true, "status should work after pull");
	assert.match(
		statusClean.text,
		/up to date/,
		"status should report up to date right after pull",
	);

	await fs.writeFile(path.join(targetAgent, "AGENTS.md"), "locally edited\n");
	const statusDiff = await runWebdavSyncCommand(["status"], {
		agentDir: targetAgent,
		backend,
	});
	assert.match(
		statusDiff.text,
		/local differs from remote/,
		"status should report local edits",
	);

	const restoreCancelled = await runWebdavSyncCommand(["restore"], {
		agentDir: targetAgent,
		confirmRestore: async () => false,
	});
	assert.match(
		restoreCancelled.text,
		/restore: cancelled/,
		"cancelled restore should not apply anything",
	);
	assert.equal(
		(await fs.readdir(path.join(targetAgent, ".webdav-sync", "backups"))).length,
		1,
		"cancelled restore should not create a safety backup",
	);

	const restore = await runWebdavSyncCommand(["restore"], {
		agentDir: targetAgent,
		confirmRestore: async () => true,
	});
	assert.equal(restore.ok, true, "restore should apply latest backup");
	assert.match(restore.text, /safety backup: /, "restore should create a safety backup");
	assert.equal(
		(await fs.readdir(path.join(targetAgent, ".webdav-sync", "backups"))).length,
		2,
		"restore should add one safety backup",
	);

	const backupIds = (
		await fs.readdir(path.join(targetAgent, ".webdav-sync", "backups"))
	).sort();
	const restoreExplicit = await runWebdavSyncCommand(
		["restore", backupIds[0]],
		{
			agentDir: targetAgent,
			confirmRestore: async () => true,
		},
	);
	assert.equal(
		restoreExplicit.ok,
		true,
		"restore should accept an explicit backup id",
	);
	assert.match(
		restoreExplicit.text,
		new RegExp(`restore: ${backupIds[0]}`),
		"explicit restore should report the requested backup id",
	);

	const configPath = path.join(targetAgent, "settings.webdav.json");
	const originalConfig = await fs.readFile(configPath, "utf8");
	const plaintextConfig = JSON.parse(originalConfig);
	delete plaintextConfig.passwordEnv;
	plaintextConfig.password = "plain-secret";
	await fs.writeFile(configPath, JSON.stringify(plaintextConfig, null, 2));
	const statusWarn = await runWebdavSyncCommand(["status"], {
		agentDir: targetAgent,
		backend,
	});
	assert.match(
		statusWarn.text,
		/config.password is plaintext/,
		"status should warn about plaintext password",
	);
	await fs.writeFile(configPath, originalConfig);
	assert.equal(
		await fs.readFile(path.join(targetAgent, "AGENTS.md"), "utf8"),
		"old target\n",
		"restore should recover pre-pull file",
	);
	assert.equal(
		await exists(path.join(targetAgent, "extensions", "old", "old.js")),
		true,
		"restore should recover pre-pull allowlisted dir",
	);
	assert.equal(
		await fs.readFile(path.join(targetAgent, "hermes-memory-config.json"), "utf8"),
		"old target memory config\n",
		"restore should recover the pre-pull extra file",
	);
	assert.equal(
		await fs.readFile(path.join(testHome, ".pi", "web-search.json"), "utf8"),
		"old target home config\n",
		"restore should recover the pre-pull home-relative file",
	);
	assert.equal(
		await fs.readFile(path.join(targetAgent, "custom-config", "old-only.json"), "utf8"),
		"old directory config\n",
		"restore should recover the pre-pull extra directory",
	);

	// --- Archive limits -------------------------------------------------------
	const limitedZip = createRegularFileZip([
		["AGENTS.md", Buffer.alloc(4096)],
	]);
	assert.throws(
		() =>
			parseArchive(limitedZip.zipBytes, limitedZip.latest.zipSha256, {}, {
				...DEFAULT_ARCHIVE_LIMITS,
				maxTotalBytes: 1024,
			}),
		/archive limit/,
		"archive limits should reject an entry beyond the total budget",
	);
	assert.throws(
		() =>
			parseArchive(limitedZip.zipBytes, limitedZip.latest.zipSha256, {}, {
				...DEFAULT_ARCHIVE_LIMITS,
				maxCompressedBytes: 8,
			}),
		/exceeds the archive size limit/,
		"archive limits should reject oversized compressed input",
	);

	const excludedZip = createUncheckedRegularFileZip([
		["skills/node_modules/evil.js", Buffer.from("evil\n")],
	]);
	assert.throws(
		() => parseArchive(excludedZip),
		/always excluded from sync/,
		"manifest paths inside excluded directories should be rejected",
	);
	assert.throws(
		() =>
			createLatestZip(
				new Map([
					["manifest.json", Buffer.from("{}")],
					["files/skills/big.md", Buffer.alloc(64)],
				]),
				createManifest({
					files: [
						{
							path: "skills/big.md",
							type: "file",
							size: 64,
							sha256: sha256Bytes(Buffer.alloc(64)),
						},
					],
					externalResources: [],
					packageSpecs: [],
					warnings: [],
				}),
				{ ...DEFAULT_ARCHIVE_LIMITS, maxCompressedBytes: 16 },
			),
		/compressed size limit/,
		"archive limits should also apply when creating an archive",
	);

	// --- Precise, non-destructive apply --------------------------------------
	const preciseAgent = path.join(tempRoot, "precise-agent");
	await fs.mkdir(
		path.join(preciseAgent, "extensions", "keep", "node_modules", "dep"),
		{ recursive: true },
	);
	await fs.mkdir(path.join(preciseAgent, "skills", "old"), { recursive: true });
	await fs.writeFile(path.join(preciseAgent, "settings.json"), "{}\n");
	await fs.writeFile(
		path.join(preciseAgent, "extensions", "keep", "index.js"),
		"old ext\n",
	);
	await fs.writeFile(
		path.join(preciseAgent, "extensions", "keep", "node_modules", "dep", "index.js"),
		"dep\n",
	);
	await fs.writeFile(
		path.join(preciseAgent, "skills", "old", "old.md"),
		"old\n",
	);
	const preciseZip = createRegularFileZip([
		["settings.json", Buffer.from("{}\n")],
		["extensions/keep/index.js", Buffer.from("new ext\n")],
	]);
	const preciseSummary = await applyArchiveToAgent(
		preciseAgent,
		parseArchive(preciseZip.zipBytes, preciseZip.latest.zipSha256),
	);
	assert.equal(
		preciseSummary.filesDeleted,
		1,
		"apply should delete exactly the collected files absent from the archive",
	);
	assert.equal(
		await fs.readFile(
			path.join(preciseAgent, "extensions", "keep", "index.js"),
			"utf8",
		),
		"new ext\n",
		"apply should overwrite an allowlisted file",
	);
	assert.equal(
		await exists(
			path.join(
				preciseAgent,
				"extensions",
				"keep",
				"node_modules",
				"dep",
				"index.js",
			),
		),
		true,
		"an excluded subtree should survive a pull",
	);
	assert.equal(
		await exists(path.join(preciseAgent, "skills", "old")),
		false,
		"an allowlisted directory emptied by the pull should be pruned",
	);

	// --- Raw local backups ---------------------------------------------------
	const rawAgent = path.join(tempRoot, "raw-agent");
	await fs.mkdir(path.join(rawAgent, "skills"), { recursive: true });
	await fs.writeFile(
		path.join(rawAgent, "settings.json"),
		`${JSON.stringify(
			{
				packages: ["npm:pi-web-access"],
				shellPath: "/local/shell",
				npmCommand: ["local-node-manager", "npm"],
				sessionDir: "/local/sessions",
			},
			null,
			2,
		)}\n`,
	);
	await fs.writeFile(path.join(rawAgent, "skills", "s.md"), "s\n");
	await writeTestConfig(rawAgent);
	const rawBackup = await createLocalBackup(rawAgent, 5);
	const rawBackupEntries = parseArchive(
		await fs.readFile(
			path.join(
				rawAgent,
				".webdav-sync",
				"backups",
				rawBackup.id,
				"backup.zip",
			),
		),
		undefined,
		extraPaths,
	);
	const rawBackupSettingsJson = JSON.parse(
		rawBackupEntries.entries.get("files/settings.json").toString("utf8"),
	);
	assert.equal(
		rawBackupSettingsJson.shellPath,
		"/local/shell",
		"local backups should keep settings.json verbatim",
	);
	assert.equal(
		rawBackupEntries.manifest.externalResources.length,
		0,
		"a backup of settings without external references collects no external resources",
	);

	const rawBackend = new MemoryBackend();
	await runWebdavSyncCommand(["push"], {
		agentDir: rawAgent,
		backend: rawBackend,
		confirmPush: async () => true,
	});
	const wipedArchive = parseArchive(
		rawBackend.files.get("profiles/default/latest.zip"),
		JSON.parse(rawBackend.files.get("profiles/default/latest.json").toString("utf8"))
			.zipSha256,
		extraPaths,
	);
	await applyArchiveToAgent(rawAgent, wipedArchive, extraPaths);
	const wipedSettings = await fs.readFile(
		path.join(rawAgent, "settings.json"),
		"utf8",
	);
	assert(
		!wipedSettings.includes("shellPath"),
		"a remote snapshot should not carry local-only settings",
	);
	const rawRestore = await runWebdavSyncCommand(["restore"], {
		agentDir: rawAgent,
		confirmRestore: async () => true,
	});
	assert.equal(rawRestore.ok, true, "restore should apply a raw local backup");
	const restoredSettings = await fs.readFile(
		path.join(rawAgent, "settings.json"),
		"utf8",
	);
	assert(
		restoredSettings.includes("shellPath"),
		"restoring a local backup should bring back local-only settings",
	);

	// --- Pull cancellation and explicit snapshot selection --------------------
	const cancelAgent = path.join(tempRoot, "cancel-agent");
	await fs.mkdir(cancelAgent, { recursive: true });
	await fs.writeFile(path.join(cancelAgent, "AGENTS.md"), "keep me\n");
	await writeTestConfig(cancelAgent);
	let cancelChoiceCount;
	const cancelledPull = await runWebdavSyncCommand(["pull"], {
		agentDir: cancelAgent,
		backend: rawBackend,
		selectSnapshot: async (choices) => {
			cancelChoiceCount = choices.length;
			return undefined;
		},
	});
	assert.equal(cancelledPull.ok, true, "cancelled pull should return cleanly");
	assert.match(
		cancelledPull.text,
		/pull: cancelled/,
		"cancelled pull should report cancellation",
	);
	assert.equal(
		cancelChoiceCount,
		2,
		"multiple snapshots should be offered before cancelling",
	);
	assert.equal(
		await fs.readFile(path.join(cancelAgent, "AGENTS.md"), "utf8"),
		"keep me\n",
		"cancelled pull should not touch local files",
	);
	assert.equal(
		await exists(path.join(cancelAgent, ".webdav-sync")),
		false,
		"cancelled pull should not create a backup",
	);

	const noSelectorPull = await runWebdavSyncCommand(["pull"], {
		agentDir: cancelAgent,
		backend: rawBackend,
	});
	assert.equal(
		noSelectorPull.ok,
		false,
		"pull without a picker must not silently choose a snapshot",
	);
	assert.match(
		noSelectorPull.text,
		/No snapshot picker is available/,
		"pull should explain how to pick a snapshot explicitly",
	);

	const explicitPull = await runWebdavSyncCommand(["pull", "latest"], {
		agentDir: cancelAgent,
		backend: rawBackend,
		confirmInstallPackages: async () => false,
	});
	assert.equal(explicitPull.ok, true, "pull should accept an explicit snapshot id");
	assert.match(explicitPull.text, /pull: latest/, "explicit pull should use latest");
	const missingPull = await runWebdavSyncCommand(
		["pull", "1999-01-01T00-00-00-000Z"],
		{ agentDir: cancelAgent, backend: rawBackend },
	);
	assert.equal(missingPull.ok, false, "an unknown snapshot id should fail");
	assert.match(missingPull.text, /Snapshot not found/, "missing snapshot should be reported");
	const invalidPull = await runWebdavSyncCommand(["pull", "../secrets"], {
		agentDir: cancelAgent,
		backend: rawBackend,
	});
	assert.equal(invalidPull.ok, false, "an unsafe snapshot id should fail");
	assert.match(invalidPull.text, /Invalid snapshot id/, "unsafe snapshot ids should be rejected");

	// --- Package install hardening -------------------------------------------
	const unsafeAgent = path.join(tempRoot, "unsafe-agent");
	await fs.mkdir(unsafeAgent, { recursive: true });
	await fs.writeFile(
		path.join(unsafeAgent, "settings.json"),
		`${JSON.stringify(
			{
				packages: ["npm:x&echo INJECTED>marker", "npm:pi-web-access"],
			},
			null,
			2,
		)}\n`,
	);
	await writeTestConfig(unsafeAgent);
	const unsafeBackend = new MemoryBackend();
	await runWebdavSyncCommand(["push"], {
		agentDir: unsafeAgent,
		backend: unsafeBackend,
		confirmPush: async () => true,
	});
	const installTarget = path.join(tempRoot, "install-target");
	await fs.mkdir(installTarget, { recursive: true });
	const alwaysInstallConfig = JSON.parse(
		await fs.readFile(path.join(unsafeAgent, "settings.webdav.json"), "utf8"),
	);
	alwaysInstallConfig.installMissingPackages = "always";
	await fs.writeFile(
		path.join(installTarget, "settings.webdav.json"),
		`${JSON.stringify(alwaysInstallConfig, null, 2)}\n`,
	);
	const attemptedInstalls = [];
	const unsafePull = await runWebdavSyncCommand(["pull", "latest"], {
		agentDir: installTarget,
		backend: unsafeBackend,
		installPackage: async (spec) => {
			attemptedInstalls.push(spec);
			return 0;
		},
	});
	assert.equal(unsafePull.ok, true, "pull should survive an unsafe package spec");
	assert.deepEqual(
		attemptedInstalls,
		["npm:pi-web-access"],
		"unsafe specs must never reach the installer",
	);
	assert.match(
		unsafePull.text,
		/unsafe spec\(s\) skipped/,
		"pull should report skipped unsafe specs",
	);
	const commandsSource = await fs.readFile(
		path.join(root, "dist", "src", "commands.js"),
		"utf8",
	);
	assert(
		!/shell:\s*(true|process\.platform)/.test(commandsSource),
		"package installs must never spawn through a shell",
	);

	// --- Rollback of a failed apply ------------------------------------------
	const rollbackAgent = path.join(tempRoot, "rollback-agent");
	// An excluded (never collected) file keeps this directory non-empty, so the
	// incoming file cannot be written where the directory already is.
	await fs.mkdir(
		path.join(rollbackAgent, "skills", "evil.md", "node_modules"),
		{ recursive: true },
	);
	await fs.writeFile(
		path.join(rollbackAgent, "skills", "evil.md", "node_modules", "keep.txt"),
		"keep\n",
	);
	await fs.writeFile(path.join(rollbackAgent, "AGENTS.md"), "original\n");
	await fs.writeFile(path.join(rollbackAgent, "settings.json"), "{}\n");
	await writeTestConfig(rollbackAgent);
	const rollbackSafety = await createLocalBackup(rollbackAgent, 5);
	const incomingZip = createRegularFileZip([
		["AGENTS.md", Buffer.from("incoming\n")],
		["skills/evil.md", Buffer.from("boom\n")],
	]);
	await assert.rejects(
		() =>
			applyArchiveWithRollback(
				rollbackAgent,
				parseArchive(incomingZip.zipBytes, incomingZip.latest.zipSha256),
				rollbackSafety.id,
			),
		/apply failed and was rolled back/,
		"a failed apply should roll back from the safety backup",
	);
	assert.equal(
		await fs.readFile(path.join(rollbackAgent, "AGENTS.md"), "utf8"),
		"original\n",
		"rollback should restore the pre-apply file",
	);
	assert.equal(
		await fs.readFile(path.join(rollbackAgent, "settings.json"), "utf8"),
		"{}\n",
		"rollback should restore every collected file",
	);

	// --- Backup retention 0 keeps everything ---------------------------------
	const retentionAgent = path.join(tempRoot, "retention-agent");
	await fs.mkdir(retentionAgent, { recursive: true });
	await fs.writeFile(path.join(retentionAgent, "settings.json"), "{}\n");
	for (let index = 0; index < 3; index += 1) {
		await createLocalBackup(retentionAgent, 0);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.equal(
		(await fs.readdir(path.join(retentionAgent, ".webdav-sync", "backups")))
			.length,
		3,
		"backupRetention 0 should keep every backup",
	);

	// --- Raw backups keep referenced external resources ----------------------
	const pkgA = path.join(tempRoot, "pkg-a");
	const pkgB = path.join(tempRoot, "pkg-b");
	await fs.mkdir(path.join(pkgA, "src"), { recursive: true });
	await fs.mkdir(path.join(pkgB, "src"), { recursive: true });
	await fs.writeFile(path.join(pkgA, "src", "index.js"), "external A\n");
	await fs.writeFile(path.join(pkgB, "src", "index.js"), "external B\n");
	const extSourceA = path.join(tempRoot, "ext-source-a");
	const extSourceB = path.join(tempRoot, "ext-source-b");
	for (const [dir, pkg] of [
		[extSourceA, pkgA],
		[extSourceB, pkgB],
	]) {
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(
			path.join(dir, "settings.json"),
			`${JSON.stringify({ packages: [], skills: [path.join(pkg, "src")] }, null, 2)}\n`,
		);
		await writeTestConfig(dir);
	}
	const extBackendA = new MemoryBackend();
	const extBackendB = new MemoryBackend();
	await runWebdavSyncCommand(["push"], {
		agentDir: extSourceA,
		backend: extBackendA,
		confirmPush: async () => true,
	});
	await runWebdavSyncCommand(["push"], {
		agentDir: extSourceB,
		backend: extBackendB,
		confirmPush: async () => true,
	});

	const extAgent = path.join(tempRoot, "ext-agent");
	await fs.mkdir(extAgent, { recursive: true });
	await writeTestConfig(extAgent);
	const pullA = await runWebdavSyncCommand(["pull", "latest"], {
		agentDir: extAgent,
		backend: extBackendA,
	});
	assert.equal(pullA.ok, true, "the first external-resource pull should succeed");
	const settingsAfterA = await fs.readFile(
		path.join(extAgent, "settings.json"),
		"utf8",
	);
	assert(
		settingsAfterA.includes("./external-resources/"),
		"a pull should rewrite external references into the agent directory",
	);
	const resourceDirs = (
		await fs.readdir(path.join(extAgent, "external-resources"))
	).sort();
	assert.equal(resourceDirs.length, 1, "the first pull should create one resource");
	const resourceFile = path.join(
		extAgent,
		"external-resources",
		resourceDirs[0],
		"src",
		"index.js",
	);
	assert.equal(
		await fs.readFile(resourceFile, "utf8"),
		"external A\n",
		"the first pull should write the first external resource",
	);

	const safetyA = await createLocalBackup(extAgent, 5);
	const safetyArchive = parseArchive(
		await fs.readFile(
			path.join(extAgent, ".webdav-sync", "backups", safetyA.id, "backup.zip"),
		),
		undefined,
		extraPaths,
	);
	assert.equal(
		safetyArchive.manifest.settingsMode,
		"raw",
		"a local backup should declare raw settings mode",
	);
	assert(
		safetyArchive.manifest.externalResources.length > 0,
		"a local backup must include the external resources its settings reference",
	);
	assert(
		safetyArchive.entries.has(
			`external-resources/${resourceDirs[0]}/src/index.js`,
		),
		"the referenced external file must be inside the backup",
	);

	const pullB = await runWebdavSyncCommand(["pull", "latest"], {
		agentDir: extAgent,
		backend: extBackendB,
	});
	assert.equal(pullB.ok, true, "the second external-resource pull should succeed");
	const resourceDirsB = await fs.readdir(
		path.join(extAgent, "external-resources"),
	);
	assert(
		!resourceDirsB.includes(resourceDirs[0]),
		"the second pull should replace the first external resource",
	);

	const restoreSafetyA = await runWebdavSyncCommand(["restore", safetyA.id], {
		agentDir: extAgent,
		confirmRestore: async () => true,
	});
	assert.equal(
		restoreSafetyA.ok,
		true,
		"restoring the raw safety backup should succeed",
	);
	assert.equal(
		await fs.readFile(path.join(extAgent, "settings.json"), "utf8"),
		settingsAfterA,
		"restore must reproduce settings.json byte for byte",
	);
	assert.equal(
		await fs.readFile(resourceFile, "utf8"),
		"external A\n",
		"restore must reproduce the external resource bytes",
	);

	// --- Symlink write protection --------------------------------------------
	const outsideFile = path.join(tempRoot, "outside-target.txt");
	await fs.writeFile(outsideFile, "outside original\n");
	const outsideDir = path.join(tempRoot, "outside-dir");
	await fs.mkdir(outsideDir, { recursive: true });
	const symlinkTargetAgent = path.join(tempRoot, "symlink-leaf-agent");
	await fs.mkdir(symlinkTargetAgent, { recursive: true });
	await fs.writeFile(path.join(symlinkTargetAgent, "settings.json"), "{}\n");
	const leafLinkPath = path.join(symlinkTargetAgent, "AGENTS.md");
	const leafLinked =
		(await trySymlink(outsideFile, leafLinkPath, "file")) ||
		(await trySymlink(outsideDir, leafLinkPath, "junction"));
	if (leafLinked) {
		const symlinkZip = createRegularFileZip([
			["AGENTS.md", Buffer.from("incoming\n")],
		]);
		await assert.rejects(
			() =>
				applyArchiveToAgent(
					symlinkTargetAgent,
					parseArchive(symlinkZip.zipBytes, symlinkZip.latest.zipSha256),
				),
			/symlink/,
			"writing through a symlinked target must be rejected",
		);
		assert.equal(
			await fs.readFile(outsideFile, "utf8"),
			"outside original\n",
			"a symlinked target must stay untouched",
		);
		assert.equal(
			await exists(path.join(outsideDir, "AGENTS.md")),
			false,
			"a linked directory must stay untouched",
		);
	} else {
		console.log("skipped: link creation unavailable for the target path");
	}
	const ancestorAgent = path.join(tempRoot, "ancestor-agent");
	await fs.mkdir(ancestorAgent, { recursive: true });
	await fs.writeFile(path.join(ancestorAgent, "settings.json"), "{}\n");
	if (
		(await trySymlink(outsideDir, path.join(ancestorAgent, "skills"), "dir")) ||
		(await trySymlink(outsideDir, path.join(ancestorAgent, "skills"), "junction"))
	) {
		const ancestorZip = createRegularFileZip([
			["skills/escaped.md", Buffer.from("escaped\n")],
		]);
		await assert.rejects(
			() =>
				applyArchiveToAgent(
					ancestorAgent,
					parseArchive(ancestorZip.zipBytes, ancestorZip.latest.zipSha256),
				),
			/symlink/,
			"writing through a symlinked directory must be rejected",
		);
		assert.equal(
			await exists(path.join(outsideDir, "escaped.md")),
			false,
			"nothing may be written outside through a symlink",
		);
	} else {
		console.log("skipped: directory symlink creation unavailable here");
	}

	// --- Zip entry hardening --------------------------------------------------
	// Names must keep their exact length so patching only renames the records.
	const dupSource = createRegularFileZip([
		["settings.json", Buffer.from("{}\n")],
		["aaaa.json", Buffer.from("x\n")],
		["bbbb.json", Buffer.from("y\n")],
	]);
	const dupPatched = Buffer.from(dupSource.zipBytes);
	let dupHits = 0;
	for (let index = 0; index + 9 <= dupPatched.length; index += 1) {
		if (dupPatched.subarray(index, index + 9).toString("latin1") === "bbbb.json") {
			dupPatched.write("aaaa.json", index, "latin1");
			dupHits += 1;
		}
	}
	assert.equal(dupHits, 2, "the duplicate fixture should patch both name records");
	assert.throws(
		() => parseArchive(dupPatched),
		/Duplicate zip entry: files\/aaaa\.json/,
		"exact duplicate zip entry names must be rejected",
	);

	const normalizedBytes = zipSync({
		"files/AGENTS.md": Buffer.from("one"),
		"files/./AGENTS.md": Buffer.from("two"),
		"manifest.json": Buffer.from("{}"),
	});
	assert.throws(
		() => parseArchive(normalizedBytes),
		/Duplicate zip entry: files\/AGENTS\.md/,
		"zip entry names that normalize to the same path must be rejected",
	);

	const forgedSource = createRegularFileZip([
		["AGENTS.md", Buffer.from("agent rules\n")],
	]);
	const forgedBytes = Buffer.from(forgedSource.zipBytes);
	const localHeader = forgedBytes.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
	const centralHeader = forgedBytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
	assert(localHeader >= 0 && centralHeader >= 0, "fixture should contain zip headers");
	forgedBytes.writeUInt32LE(3, localHeader + 22);
	forgedBytes.writeUInt32LE(3, centralHeader + 24);
	assert.throws(
		() => parseArchive(forgedBytes),
		/hash mismatch/,
		"a forged small uncompressed size must fail content validation",
	);

	// --- File and directory type transitions ---------------------------------
	const transitionAgent = path.join(tempRoot, "transition-agent");
	await fs.mkdir(path.join(transitionAgent, "skills", "empty-dir"), {
		recursive: true,
	});
	await fs.writeFile(path.join(transitionAgent, "settings.json"), "{}\n");
	await fs.writeFile(path.join(transitionAgent, "skills", "old-file"), "old\n");
	const transitionZip = createRegularFileZip([
		["settings.json", Buffer.from("{}\n")],
		["skills/empty-dir", Buffer.from("now a file\n")],
		["skills/old-file/inner.md", Buffer.from("now a directory\n")],
	]);
	const transitionSummary = await applyArchiveToAgent(
		transitionAgent,
		parseArchive(transitionZip.zipBytes, transitionZip.latest.zipSha256),
	);
	assert.equal(
		transitionSummary.filesWritten,
		3,
		"all transition targets should be written",
	);
	assert.equal(
		await fs.readFile(path.join(transitionAgent, "skills", "empty-dir"), "utf8"),
		"now a file\n",
		"an empty directory should become a file",
	);
	assert.equal(
		await fs.readFile(
			path.join(transitionAgent, "skills", "old-file", "inner.md"),
			"utf8",
		),
		"now a directory\n",
		"a file should become a directory",
	);

	// --- A latest-only remote still requires an explicit id ------------------
	const latestOnly = new MemoryBackend();
	latestOnly.files.set(
		"profiles/default/latest.zip",
		rawBackend.files.get("profiles/default/latest.zip"),
	);
	latestOnly.files.set(
		"profiles/default/latest.json",
		rawBackend.files.get("profiles/default/latest.json"),
	);
	const latestOnlyPull = await runWebdavSyncCommand(["pull"], {
		agentDir: cancelAgent,
		backend: latestOnly,
	});
	assert.equal(
		latestOnlyPull.ok,
		false,
		"a latest-only remote must not be pulled implicitly without a picker",
	);
	assert.match(
		latestOnlyPull.text,
		/No snapshot picker is available/,
		"the latest-only error should explain how to proceed",
	);
	const latestOnlyExplicit = await runWebdavSyncCommand(["pull", "latest"], {
		agentDir: cancelAgent,
		backend: latestOnly,
		confirmInstallPackages: async () => false,
	});
	assert.equal(
		latestOnlyExplicit.ok,
		true,
		"an explicit latest pull should work without a picker",
	);

	// --- Install invocation: verified, shell-free, one argument --------------
	const fakePi = path.join(tempRoot, "fake-pi");
	await fs.mkdir(path.join(fakePi, "dist"), { recursive: true });
	await fs.writeFile(
		path.join(fakePi, "package.json"),
		`${JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "dist/cli.js" } })}\n`,
	);
	await fs.writeFile(path.join(fakePi, "dist", "cli.js"), "// cli\n");
	const foreignApp = path.join(tempRoot, "foreign-app");
	await fs.mkdir(path.join(foreignApp, "dist"), { recursive: true });
	await fs.writeFile(
		path.join(foreignApp, "package.json"),
		`${JSON.stringify({ name: "some-other-host-app" })}\n`,
	);
	await fs.writeFile(path.join(foreignApp, "dist", "cli.js"), "// host\n");
	const bareScript = path.join(tempRoot, "bare-script.js");
	await fs.writeFile(bareScript, "// bare\n");
	assert.equal(
		resolvePiInvocation(undefined),
		undefined,
		"no candidate means no invocation",
	);
	assert.equal(
		resolvePiInvocation(bareScript),
		undefined,
		"a script without pi package metadata must not be executed",
	);
	assert.equal(
		resolvePiInvocation(path.join(foreignApp, "dist", "cli.js")),
		undefined,
		"a foreign host entry must not be executed",
	);
	const piEntry = path.join(fakePi, "dist", "cli.js");
	assert.deepEqual(
		resolvePiInvocation(piEntry),
		{ command: process.execPath, args: [await fs.realpath(piEntry)] },
		"a verified pi package entry may be used",
	);
	const unrelatedInPi = path.join(fakePi, "dist", "other.js");
	await fs.writeFile(unrelatedInPi, "// not the declared cli\n");
	assert.equal(
		resolvePiInvocation(unrelatedInPi),
		undefined,
		"an unrelated script inside the pi package must not be executed",
	);
	const escapePkg = path.join(tempRoot, "escape-pi");
	await fs.mkdir(path.join(escapePkg, "deep"), { recursive: true });
	await fs.writeFile(
		path.join(escapePkg, "package.json"),
		`${JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "../outside-cli.js" } })}\n`,
	);
	await fs.writeFile(path.join(escapePkg, "deep", "cli.js"), "// inside\n");
	assert.equal(
		resolvePiInvocation(path.join(escapePkg, "deep", "cli.js")),
		undefined,
		"a bin entry escaping its package must not be executed",
	);

	const fixtureDir = path.join(tempRoot, "fixture");
	await fs.mkdir(fixtureDir, { recursive: true });
	const fixtureScript = path.join(fixtureDir, "record-argv.cjs");
	const argvRecord = path.join(fixtureDir, "argv.json");
	await fs.writeFile(
		fixtureScript,
		`require("node:fs").writeFileSync(${JSON.stringify(argvRecord)}, JSON.stringify(process.argv.slice(2)));\n`,
	);
	const specWithMetacharacters = "npm:x&echo INJECTED>marker";
	const fixtureCode = await runPiInstallWith(specWithMetacharacters, {
		command: process.execPath,
		args: [fixtureScript],
	});
	assert.equal(fixtureCode, 0, "the fixture installer should exit cleanly");
	assert.deepEqual(
		JSON.parse(await fs.readFile(argvRecord, "utf8")),
		["install", specWithMetacharacters],
		"the spec must reach the CLI as one uninterpreted argument",
	);

	const progressText = formatInstallProgress({
		phase: "package_start",
		spec: "git:https://user:secret-token@example.invalid/repo.git",
		index: 0,
		total: 1,
	});
	assert(
		progressText.includes("git:https://***@example.invalid/repo.git"),
		"progress output should redact credentials",
	);
	assert(
		!progressText.includes("secret-token"),
		"progress output must not leak credentials",
	);

	// --- Rollback from a fixed plan (no settings re-parse) -------------------
	const planAgent = path.join(tempRoot, "plan-agent");
	const outsidePkg = path.join(tempRoot, "plan-external");
	await fs.mkdir(path.join(outsidePkg, "src"), { recursive: true });
	await fs.writeFile(path.join(outsidePkg, "src", "keep.js"), "original external\n");
	await fs.mkdir(path.join(planAgent, "skills", "blocker", "node_modules"), {
		recursive: true,
	});
	await fs.writeFile(
		path.join(planAgent, "skills", "blocker", "node_modules", "keep.txt"),
		"keep\n",
	);
	await fs.writeFile(path.join(planAgent, "AGENTS.md"), "original agents\n");
	const planSettings = `${JSON.stringify({ packages: [], skills: [outsidePkg] }, null, 2)}\n`;
	await fs.writeFile(path.join(planAgent, "settings.json"), planSettings);
	const planSafety = await createLocalBackup(planAgent, 5);

	// Incoming archive: malformed settings.json, a new external reference, and a
	// write that must fail because a non-empty directory occupies the path.
	const planManifest = createManifest({
		files: [
			{
				path: "AGENTS.md",
				type: "file",
				size: Buffer.byteLength("incoming age"),
				sha256: sha256Bytes(Buffer.from("incoming age")),
			},
			{
				path: "settings.json",
				type: "file",
				size: Buffer.byteLength("{broken,,"),
				sha256: sha256Bytes(Buffer.from("{broken,,")),
			},
			{
				path: "skills/blocker",
				type: "file",
				size: Buffer.byteLength("blocked\n"),
				sha256: sha256Bytes(Buffer.from("blocked\n")),
			},
		],
		externalResources: [
			{
				id: "newresource",
				originalPathHash: "hash",
				baseName: "newresource",
				files: [
					{
						path: "external-resources/newresource/src/new.js",
						type: "file",
						size: Buffer.byteLength("new external"),
						sha256: sha256Bytes(Buffer.from("new external")),
					},
				],
			},
		],
		packageSpecs: [],
		warnings: [],
		settingsMode: "rewrite",
	});
	const planEntries = new Map([
		["files/AGENTS.md", Buffer.from("incoming age")],
		["files/settings.json", Buffer.from("{broken,,")],
		["external-resources/newresource/src/new.js", Buffer.from("new external")],
		[
			"files/skills/blocker",
			Buffer.from("blocked\n"),
		],
	]);
	planEntries.set(
		"manifest.json",
		Buffer.from(`${JSON.stringify(planManifest, null, 2)}\n`),
	);
	const planZip = createLatestZip(planEntries, planManifest);
	await assert.rejects(
		() =>
			applyArchiveWithRollback(
				planAgent,
				parseArchive(planZip.zipBytes, planZip.latest.zipSha256),
				planSafety.id,
			),
		/apply failed and was rolled back/,
		"a failed apply must roll back from the fixed plan",
	);
	assert.equal(
		await fs.readFile(path.join(planAgent, "AGENTS.md"), "utf8"),
		"original agents\n",
		"rollback must restore the original file even when the incoming settings.json was malformed",
	);
	assert.equal(
		await fs.readFile(path.join(planAgent, "settings.json"), "utf8"),
		planSettings,
		"rollback must restore the original settings.json bytes",
	);
	const planSafetyArchive = parseArchive(
		await fs.readFile(
			path.join(planAgent, ".webdav-sync", "backups", planSafety.id, "backup.zip"),
		),
		undefined,
		extraPaths,
	);
	const planOldExternal = planSafetyArchive.manifest.externalResources[0].files[0].path;
	assert.equal(
		await fs.readFile(path.join(planAgent, ...planOldExternal.split("/")), "utf8"),
		"original external\n",
		"rollback must restore the external resource the failed apply deleted",
	);
	assert.equal(
		await exists(
			path.join(planAgent, "external-resources", "newresource", "src", "new.js"),
		),
		false,
		"the failed apply must not leave its external resource behind",
	);

	// --- Rollback after a new external file was written ----------------------
	// Archive B carries two external files so the failure can be ordered after
	// the first one is written: the control run proves the write happens, and the
	// blocked later target forces the rollback that must remove it again.
	const rbPkgA = path.join(tempRoot, "rb-pkg-a");
	const rbPkgB = path.join(tempRoot, "rb-pkg-b");
	await fs.mkdir(path.join(rbPkgA, "src"), { recursive: true });
	await fs.mkdir(path.join(rbPkgB, "src"), { recursive: true });
	await fs.writeFile(path.join(rbPkgA, "src", "a.js"), "A content\n");
	await fs.writeFile(path.join(rbPkgB, "src", "a.js"), "B content\n");
	await fs.writeFile(path.join(rbPkgB, "src", "z.js"), "B tail\n");
	const rbSourceA = path.join(tempRoot, "rb-source-a");
	const rbSourceB = path.join(tempRoot, "rb-source-b");
	for (const [dir, pkg] of [
		[rbSourceA, rbPkgA],
		[rbSourceB, rbPkgB],
	]) {
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(
			path.join(dir, "settings.json"),
			`${JSON.stringify({ packages: [], skills: [path.join(pkg, "src")] }, null, 2)}\n`,
		);
		await writeTestConfig(dir);
	}
	const rbBackendA = new MemoryBackend();
	const rbBackendB = new MemoryBackend();
	await runWebdavSyncCommand(["push"], {
		agentDir: rbSourceA,
		backend: rbBackendA,
		confirmPush: async () => true,
	});
	await runWebdavSyncCommand(["push"], {
		agentDir: rbSourceB,
		backend: rbBackendB,
		confirmPush: async () => true,
	});
	const rbArchiveB = parseArchive(
		rbBackendB.files.get("profiles/default/latest.zip"),
		JSON.parse(rbBackendB.files.get("profiles/default/latest.json").toString("utf8"))
			.zipSha256,
		extraPaths,
	);
	const rbFiles = rbArchiveB.manifest.externalResources[0].files.map(
		(file) => file.path,
	);
	const rbWrittenRel = rbFiles.find((file) => file.endsWith("a.js"));
	const rbBlockedRel = rbFiles.find((file) => file.endsWith("z.js"));
	assert(rbWrittenRel && rbBlockedRel, "fixture needs both external files");
	assert(
		rbFiles.indexOf(rbWrittenRel) < rbFiles.indexOf(rbBlockedRel),
		"the written external file must come before the blocked one",
	);

	const controlAgent = path.join(tempRoot, "rb-control-agent");
	await fs.mkdir(controlAgent, { recursive: true });
	await writeTestConfig(controlAgent);
	const controlSummary = await applyArchiveToAgent(
		controlAgent,
		rbArchiveB,
		extraPaths,
	);
	assert(
		controlSummary.externalFilesWritten >= 2,
		"control apply should write both external files",
	);
	assert.equal(
		await fs.readFile(path.join(controlAgent, ...rbWrittenRel.split("/")), "utf8"),
		"B content\n",
		"control apply must create the first external file",
	);

	const rbAgent = path.join(tempRoot, "rb-agent");
	await fs.mkdir(rbAgent, { recursive: true });
	await writeTestConfig(rbAgent);
	const rbPullA = await runWebdavSyncCommand(["pull", "latest"], {
		agentDir: rbAgent,
		backend: rbBackendA,
	});
	assert.equal(rbPullA.ok, true, "external rollback: the first pull should succeed");
	const rbSettingsA = await fs.readFile(
		path.join(rbAgent, "settings.json"),
		"utf8",
	);
	const rbOldResource = (
		await fs.readdir(path.join(rbAgent, "external-resources"))
	)[0];
	const blockedDir = path.join(rbAgent, ...rbBlockedRel.split("/"));
	await fs.mkdir(path.join(blockedDir, "node_modules"), { recursive: true });
	await fs.writeFile(
		path.join(blockedDir, "node_modules", "keep.txt"),
		"keep\n",
	);
	const rbSafety = await createLocalBackup(rbAgent, 5);
	await assert.rejects(
		() => applyArchiveWithRollback(rbAgent, rbArchiveB, rbSafety.id, extraPaths),
		/apply failed and was rolled back/,
		"apply should fail and roll back when a later external target is blocked",
	);
	assert.equal(
		await exists(path.join(rbAgent, ...rbWrittenRel.split("/"))),
		false,
		"rollback must remove the new external file that was written",
	);
	assert.equal(
		await fs.readFile(path.join(rbAgent, "settings.json"), "utf8"),
		rbSettingsA,
		"rollback must restore the settings.json from before the failed apply",
	);
	assert.equal(
		await fs.readFile(
			path.join(rbAgent, "external-resources", rbOldResource, "src", "a.js"),
			"utf8",
		),
		"A content\n",
		"rollback must restore the managed external bytes from before the failed apply",
	);
	assert.equal(
		await exists(path.join(blockedDir, "node_modules", "keep.txt")),
		true,
		"the blocker subtree must survive the rollback",
	);

	// --- Profiles: separate remote namespaces ---------------------------------
	const profileAgent = path.join(tempRoot, "profile-agent");
	await fs.mkdir(profileAgent, { recursive: true });
	await fs.writeFile(
		path.join(profileAgent, "settings.json"),
		`${JSON.stringify({ packages: [] }, null, 2)}\n`,
	);
	await fs.writeFile(
		path.join(profileAgent, "AGENTS.md"),
		"default profile content\n",
	);
	await writeTestConfig(profileAgent);
	const profileConfig = JSON.parse(
		await fs.readFile(path.join(profileAgent, "settings.webdav.json"), "utf8"),
	);
	profileConfig.snapshotRetention = 1;
	await fs.writeFile(
		path.join(profileAgent, "settings.webdav.json"),
		`${JSON.stringify(profileConfig, null, 2)}\n`,
	);
	const sharedBackend = new MemoryBackend();
	const profileKeys = () => [...sharedBackend.files.keys()].sort();
	const defaultSnapshotKeys = () =>
		profileKeys().filter(
			(key) =>
				key.startsWith("profiles/default/snapshots/") && key.endsWith(".zip"),
		);
	const workSnapshotKeys = () =>
		profileKeys().filter(
			(key) =>
				key.startsWith("profiles/work/snapshots/") && key.endsWith(".zip"),
		);

	let pushPreviewProfile;
	const defaultPush = await runWebdavSyncCommand(["push"], {
		agentDir: profileAgent,
		backend: sharedBackend,
		confirmPush: async (preview) => {
			pushPreviewProfile = preview.profile;
			return true;
		},
	});
	assert.equal(defaultPush.ok, true, "the default push should succeed");
	assert.equal(
		pushPreviewProfile,
		"default",
		"the push confirmation should name the destination profile",
	);
	assert.equal(
		defaultPush.data.profile,
		"default",
		"the push result should report the destination profile",
	);
	assert.equal(
		sharedBackend.files.has("profiles/default/latest.zip"),
		true,
		"the default profile is a normal directory under profiles/",
	);
	for (const key of profileKeys()) {
		assert(
			key === "layout.json" || key.startsWith("profiles/default/"),
			`unexpected key outside the default profile: ${key}`,
		);
	}
	const defaultObjectKeys = () =>
		profileKeys().filter(
			(key) =>
				key.startsWith("profiles/default/latest") ||
				key.startsWith("profiles/default/snapshots/"),
		);
	const defaultObjectsAfterPush = new Map(
		defaultObjectKeys().map((key) => [
			key,
			Buffer.from(sharedBackend.files.get(key)),
		]),
	);

	await fs.writeFile(
		path.join(profileAgent, "AGENTS.md"),
		"work profile content\n",
	);
	const createPush = await runWebdavSyncCommand(
		["push", "--create-profile", "work"],
		{
			agentDir: profileAgent,
			backend: sharedBackend,
			confirmPush: async () => true,
		},
	);
	assert.equal(createPush.ok, true, "creating a profile should succeed");
	assert.equal(
		sharedBackend.files.has("profiles/work/latest.zip"),
		true,
		"a created profile should receive latest.zip",
	);
	assert.equal(
		sharedBackend.files.get("profiles/default/latest.zip").equals(
			sharedBackend.files.get("profiles/work/latest.zip"),
		),
		false,
		"profiles should hold different content",
	);
	assert.equal(
		defaultSnapshotKeys().length,
		1,
		"creating a profile must not add default-profile snapshots",
	);
	for (const key of profileKeys().filter((entry) => entry.startsWith("profiles/work/"))) {		assert(
			key === "profiles/work/latest.zip" ||
				key === "profiles/work/latest.json" ||
				key.startsWith("profiles/work/snapshots/"),
			`unexpected key inside the work profile: ${key}`,
		);
	}

	await fs.writeFile(
		path.join(profileAgent, "AGENTS.md"),
		"work profile content v2\n",
	);
	const workPush = await runWebdavSyncCommand(["push", "--profile", "work"], {
		agentDir: profileAgent,
		backend: sharedBackend,
		confirmPush: async () => true,
	});
	assert.equal(workPush.ok, true, "pushing to an existing profile should succeed");
	assert.equal(
		workSnapshotKeys().length,
		1,
		"snapshotRetention 1 should keep one snapshot inside the profile",
	);
	assert.equal(
		defaultSnapshotKeys().length,
		1,
		"default-profile retention must be independent of other profiles",
	);
	for (const [key, bytes] of defaultObjectsAfterPush) {
		assert(
			bytes.equals(Buffer.from(sharedBackend.files.get(key))),
			`a profile push must not modify the default profile object ${key}`,
		);
	}
	assert.deepEqual(
		defaultObjectKeys(),
		[...defaultObjectsAfterPush.keys()],
		"a profile push must not add or remove default-profile objects",
	);

	const profilesResult = await runWebdavSyncCommand(["profiles"], {
		agentDir: profileAgent,
		backend: sharedBackend,
	});
	assert.equal(profilesResult.ok, true, "the profiles command should succeed");
	assert.match(profilesResult.text, /- default/, "profiles should list the default profile");
	assert.match(profilesResult.text, /- work/, "profiles should list created profiles");
	assert.match(profilesResult.text, /profiles: 2/, "profiles should count usable profiles");

	const emptyProfilesBackend = new MemoryBackend();
	const noProfiles = await runWebdavSyncCommand(["profiles"], {
		agentDir: profileAgent,
		backend: emptyProfilesBackend,
	});
	assert.match(
		noProfiles.text,
		/profiles: none remote yet/,
		"an empty remote should report no profiles",
	);

	// selecting a profile for pull: profile picker, then snapshot picker
	const workTarget = path.join(tempRoot, "profile-work-target");
	await fs.mkdir(workTarget, { recursive: true });
	await writeTestConfig(workTarget);
	let profilePickerChoices;
	const workPull = await runWebdavSyncCommand(["pull"], {
		agentDir: workTarget,
		backend: sharedBackend,
		selectProfile: async (choices) => {
			profilePickerChoices = choices.map((choice) => choice.id);
			return "work";
		},
		selectSnapshot: async () => "latest",
	});
	assert.equal(workPull.ok, true, "pulling the work profile should succeed");
	assert.deepEqual(
		profilePickerChoices,
		["default", "work"],
		"the profile picker should offer existing profiles",
	);
	assert.match(workPull.text, /profile: work/, "pull should report the profile");
	assert.equal(workPull.data.profile, "work", "pull data should carry the profile");
	assert.equal(
		await fs.readFile(path.join(workTarget, "AGENTS.md"), "utf8"),
		"work profile content v2\n",
		"pull should apply the selected profile content",
	);

	const defaultTarget = path.join(tempRoot, "profile-default-target");
	await fs.mkdir(defaultTarget, { recursive: true });
	await writeTestConfig(defaultTarget);
	const defaultPull = await runWebdavSyncCommand(
		["pull", "--profile", "default", "latest"],
		{ agentDir: defaultTarget, backend: sharedBackend },
	);
	assert.equal(defaultPull.ok, true, "pulling the default profile should succeed");
	assert.equal(
		await fs.readFile(path.join(defaultTarget, "AGENTS.md"), "utf8"),
		"default profile content\n",
		"the default profile must keep its own content",
	);

	const workStatus = await runWebdavSyncCommand(
		["status", "--profile", "work"],
		{ agentDir: workTarget, backend: sharedBackend },
	);
	assert.match(workStatus.text, /up to date/, "status should be clean for the pulled profile");
	assert.match(workStatus.text, /profile: work/, "status should name the profile");
	const mismatchedStatus = await runWebdavSyncCommand(
		["status", "--profile", "default"],
		{ agentDir: workTarget, backend: sharedBackend },
	);
	assert.match(
		mismatchedStatus.text,
		/local differs from remote/,
		"status should compare against the requested profile",
	);

	// cancellations never mutate
	const keysBeforeCancel = profileKeys().join("\n");
	const cancelPick = await runWebdavSyncCommand(["push"], {
		agentDir: profileAgent,
		backend: sharedBackend,
		confirmPush: async () => true,
		selectProfile: async () => undefined,
	});
	assert.match(cancelPick.text, /push: cancelled/, "cancelling the profile picker should cancel");
	const cancelName = await runWebdavSyncCommand(["push"], {
		agentDir: profileAgent,
		backend: sharedBackend,
		confirmPush: async () => true,
		selectProfile: async (choices) =>
			choices.find((choice) => choice.isCreate).id,
		inputProfileName: async () => undefined,
	});
	assert.match(
		cancelName.text,
		/push: cancelled/,
		"cancelling the profile name input should cancel",
	);
	const cancelSnapshot = await runWebdavSyncCommand(["pull"], {
		agentDir: workTarget,
		backend: sharedBackend,
		selectProfile: async () => "work",
		selectSnapshot: async () => undefined,
	});
	assert.match(
		cancelSnapshot.text,
		/pull: cancelled/,
		"cancelling the snapshot picker should cancel the profile pull",
	);
	assert.equal(
		profileKeys().join("\n"),
		keysBeforeCancel,
		"cancelled profile operations must not write anything",
	);

	// interactive creation and empty-remote creation
	const freshBackend = new MemoryBackend();
	let emptyPickerChoices;
	const firstPush = await runWebdavSyncCommand(["push"], {
		agentDir: profileAgent,
		backend: freshBackend,
		confirmPush: async () => true,
		selectProfile: async (choices) => {
			emptyPickerChoices = choices;
			return choices.find((choice) => choice.isCreate).id;
		},
		inputProfileName: async () => "personal",
	});
	assert.equal(firstPush.ok, true, "an empty remote must still allow creating a profile");
	assert.equal(
		emptyPickerChoices.length,
		1,
		"an empty remote should offer only profile creation",
	);
	assert.equal(
		freshBackend.files.has("profiles/personal/latest.zip"),
		true,
		"the created profile should receive the upload",
	);
	const defaultCreate = await runWebdavSyncCommand(["push"], {
		agentDir: profileAgent,
		backend: freshBackend,
		confirmPush: async () => true,
		selectProfile: async (choices) =>
			choices.find((choice) => choice.isCreate).id,
		inputProfileName: async () => "default",
	});
	assert.equal(defaultCreate.ok, true, "creating the default profile should work");
	assert.equal(
		freshBackend.files.has("profiles/default/latest.zip"),
		true,
		"the default profile must be a normal directory",
	);

	// errors: missing, duplicate, invalid, and undiscoverable profiles
	const missingProfile = await runWebdavSyncCommand(
		["push", "--profile", "absent"],
		{ agentDir: profileAgent, backend: sharedBackend, confirmPush: async () => true },
	);
	assert.equal(missingProfile.ok, false, "pushing to a missing profile should fail");
	assert.match(missingProfile.text, /Profile not found: absent/, "missing profile message");
	const duplicateCreate = await runWebdavSyncCommand(
		["push", "--create-profile", "work"],
		{ agentDir: profileAgent, backend: sharedBackend, confirmPush: async () => true },
	);
	assert.equal(duplicateCreate.ok, false, "creating an existing profile should fail");
	assert.match(
		duplicateCreate.text,
		/Profile already exists: work/,
		"duplicate profile message",
	);
	const missingPullTarget = await runWebdavSyncCommand(
		["pull", "--profile", "absent", "latest"],
		{ agentDir: workTarget, backend: sharedBackend },
	);
	assert.equal(missingPullTarget.ok, false, "pulling a missing profile should fail");
	assert.match(missingPullTarget.text, /Profile not found: absent/, "missing pull profile message");

	for (const invalidName of [
		"../evil",
		"Work",
		"default.",
		"con",
		"con.txt",
		"nul.json",
		"com1.backup",
		"lpt9.a",
		"with space",
		"_leading",
		"a".repeat(65),
		"latest",
	]) {
		const before = profileKeys().join("\n");
		const invalid = await runWebdavSyncCommand(
			["push", "--create-profile", invalidName],
			{ agentDir: profileAgent, backend: sharedBackend, confirmPush: async () => true },
		);
		assert.equal(
			invalid.ok,
			false,
			`invalid profile name should fail: ${invalidName}`,
		);
		assert.equal(
			profileKeys().join("\n"),
			before,
			`invalid profile name must not write: ${invalidName}`,
		);
	}

	class FailingDiscoveryBackend extends MemoryBackend {
		async listIfExists() {
			throw new Error("listing unavailable");
		}
	}
	const discoveryBackend = new FailingDiscoveryBackend();
	discoveryBackend.files = new Map(sharedBackend.files);
	const discoveryPush = await runWebdavSyncCommand(["push"], {
		agentDir: profileAgent,
		backend: discoveryBackend,
		confirmPush: async () => true,
		selectProfile: async () => {
			throw new Error("the picker must not open when discovery fails");
		},
	});
	assert.equal(
		discoveryPush.ok,
		false,
		"a profile listing failure must not be reported as an empty remote",
	);
	assert.match(discoveryPush.text, /listing unavailable/, "discovery failure message");

	// unsupported remote directory names are listed but never selectable
	const unsupportedBackend = new MemoryBackend();
	unsupportedBackend.files.set(
		"profiles/Bad Name/latest.zip",
		Buffer.from("zip"),
	);
	unsupportedBackend.files.set(
		"profiles/Bad Name/latest.json",
		Buffer.from("{}"),
	);
	const unsupportedList = await runWebdavSyncCommand(["profiles"], {
		agentDir: profileAgent,
		backend: unsupportedBackend,
	});
	assert.match(
		unsupportedList.text,
		/Bad Name \(unsupported name\)/,
		"unsupported names should be reported as such",
	);
	assert.match(
		unsupportedList.text,
		/profiles: 0/,
		"unsupported names must not count as usable profiles",
	);
	let unsupportedPickerChoices = "not-called";
	const unsupportedPull = await runWebdavSyncCommand(["pull"], {
		agentDir: workTarget,
		backend: unsupportedBackend,
		selectProfile: async (choices) => {
			unsupportedPickerChoices = choices.map((choice) => choice.id);
			return undefined;
		},
		selectSnapshot: async () => "latest",
	});
	assert.equal(
		unsupportedPickerChoices,
		"not-called",
		"an unsupported-only remote must not open an empty profile picker",
	);
	assert.equal(
		unsupportedPull.ok,
		false,
		"an unsupported-only remote must not pull implicitly",
	);
	assert.match(
		unsupportedPull.text,
		/Profile not found: default/,
		"an unsupported-only pull should report the missing default profile",
	);
	assert.equal(
		await fs.readFile(path.join(workTarget, "AGENTS.md"), "utf8"),
		"work profile content v2\n",
		"a failed profile pull must not touch local state",
	);
	const unsupportedExplicit = await runWebdavSyncCommand(
		["pull", "--profile", "Bad Name", "latest"],
		{ agentDir: workTarget, backend: unsupportedBackend },
	);
	assert.equal(
		unsupportedExplicit.ok,
		false,
		"an unsupported remote name must never be used as a profile",
	);
	assert.match(
		unsupportedExplicit.text,
		/Profile name must be lowercase/,
		"unsupported name message",
	);

	// noninteractive profile pulls still require an explicit snapshot
	const noSnapshotPull = await runWebdavSyncCommand(
		["pull", "--profile", "work"],
		{ agentDir: workTarget, backend: sharedBackend },
	);
	assert.equal(
		noSnapshotPull.ok,
		false,
		"a profile pull without a picker must not choose a snapshot implicitly",
	);
	assert.match(noSnapshotPull.text, /No snapshot picker is available/, "explicit snapshot message");
	const legacyPull = await runWebdavSyncCommand(["pull", "latest"], {
		agentDir: defaultTarget,
		backend: sharedBackend,
	});
	assert.equal(legacyPull.ok, true, "the legacy positional snapshot must keep working");
	assert.match(legacyPull.text, /profile: default/, "legacy pull should use the default profile");

	// argument validation
	const argumentErrors = [
		[["push", "--profile"], /requires a profile name/],
		[["push", "--profile", "work", "--create-profile", "other"], /cannot be combined/],
		[["pull", "--create-profile", "other"], /only valid for \/webdav-sync:push/],
		[["restore", "--profile", "work"], /not profile-scoped/],
		[["init", "--profile", "work"], /not profile-scoped/],
		[["profiles", "--profile", "work"], /not profile-scoped/],
		[["push", "extra"], /no positional arguments/],
		[["status", "extra"], /no positional arguments/],
		[["push", "--yes"], /--yes is only valid/],
		[["profiles", "--yes"], /--yes is only valid/],
		[["profiles", "rename", "a", "b", "--yes"], /--yes is only valid/],
		[["profiles", "delete", "a", "b"], /at most one profile name/],
		[["profiles", "rename", "a"], /No profile name input is available/],
		[["profiles", "rename", "a", "b", "c"], /at most two profile names/],
		[["profiles", "extra"], /Unknown profiles subcommand/],
		[["push", "--unknown"], /Unknown option/],
		[["pull", "a", "b"], /at most one snapshot id/],
		[["restore", "a", "b"], /at most one backup id/],
		[
			["init", "https://example.invalid/pi.txt", "extra"],
			/at most one remote config URL/,
		],
	];
	for (const [input, pattern] of argumentErrors) {
		const result = await runWebdavSyncCommand(input, {
			agentDir: profileAgent,
			backend: sharedBackend,
			confirmPush: async () => true,
			confirmRestore: async () => true,
			selectProfile: async () => "work",
			selectSnapshot: async () => "latest",
		});
		assert.equal(
			result.ok,
			false,
			`argument error expected for: ${input.join(" ")}`,
		);
		assert.match(result.text, pattern, `message for: ${input.join(" ")}`);
	}

	// review regressions: pickers, name boundaries, and odd remote directories
	const defaultLatestBeforePick = Buffer.from(
		sharedBackend.files.get("profiles/default/latest.json"),
	).toString("utf8");
	let pushPickerChoices;
	const pickedExistingPush = await runWebdavSyncCommand(["push"], {
		agentDir: profileAgent,
		backend: sharedBackend,
		confirmPush: async (preview) => preview.profile === "work",
		selectProfile: async (choices) => {
			pushPickerChoices = choices;
			return "work";
		},
	});
	assert.equal(
		pickedExistingPush.ok,
		true,
		"pushing to a picked existing profile should succeed",
	);
	assert.deepEqual(
		pushPickerChoices
			.filter((choice) => !choice.isCreate)
			.map((choice) => choice.id),
		["default", "work"],
		"the push picker should list existing profiles",
	);
	assert.equal(
		pushPickerChoices.filter((choice) => choice.isCreate).length,
		1,
		"the push picker should offer profile creation",
	);
	assert.equal(
		Buffer.from(sharedBackend.files.get("profiles/default/latest.json")).toString(
			"utf8",
		),
		defaultLatestBeforePick,
		"pushing to a picked profile must not touch the default profile",
	);

	const longProfileName = "p".repeat(64);
	const longProfilePush = await runWebdavSyncCommand(
		["push", "--create-profile", longProfileName],
		{
			agentDir: profileAgent,
			backend: sharedBackend,
			confirmPush: async () => true,
		},
	);
	assert.equal(
		longProfilePush.ok,
		true,
		"the 64 character profile name boundary should be accepted",
	);
	assert.equal(
		sharedBackend.files.has(`profiles/${longProfileName}/latest.zip`),
		true,
		"the boundary-length profile should be written",
	);
	const dottedProfilePush = await runWebdavSyncCommand(
		["push", "--create-profile", "team.a"],
		{
			agentDir: profileAgent,
			backend: sharedBackend,
			confirmPush: async () => true,
		},
	);
	assert.equal(
		dottedProfilePush.ok,
		true,
		"dots inside a profile name should be accepted",
	);
	assert.equal(
		sharedBackend.files.has("profiles/team.a/latest.zip"),
		true,
		"the dotted profile should be written",
	);

	const oddBackend = new MemoryBackend();
	oddBackend.files.set("profiles/readme.txt", Buffer.from("not a profile\n"));
	oddBackend.directories.add("profiles/default");
	oddBackend.files.set(
		"profiles/default/latest.json",
		Buffer.from(
			`${JSON.stringify({ fileCount: 3, createdAt: "2026-01-01T00:00:00.000Z" })}\n`,
		),
	);
	oddBackend.files.set("profiles/default/latest.zip", Buffer.from("zip"));
	oddBackend.files.set(
		"profiles/stable/latest.json",
		Buffer.from(
			`${JSON.stringify({ fileCount: 4, createdAt: "2026-02-02T00:00:00.000Z" })}\n`,
		),
	);
	oddBackend.files.set("profiles/stable/latest.zip", Buffer.from("zip"));
	oddBackend.files.set(
		"profiles/broken/notes.txt",
		Buffer.from("no latest index here\n"),
	);
	const oddList = await runWebdavSyncCommand(["profiles"], {
		agentDir: profileAgent,
		backend: oddBackend,
	});
	assert.equal(oddList.ok, true, "listing odd remote directories should succeed");
	assert.match(
		oddList.text,
		/- default · 2026-01-01T00:00:00\.000Z · 3 file\(s\)/,
		"the default profile should be listed with its own metadata",
	);
	assert.doesNotMatch(
		oddList.text,
		/legacy/,
		"a profile-layout remote must not report legacy root data",
	);
	assert.match(
		oddList.text,
		/- stable · 2026-02-02T00:00:00\.000Z · 4 file\(s\)/,
		"valid profiles should be listed with metadata",
	);
	assert.doesNotMatch(
		oddList.text,
		/readme\.txt/,
		"a stray file inside profiles\/ must not be listed as a profile",
	);
	assert.match(oddList.text, /profiles: 3/, "only usable profiles should be counted");
	assert.match(
		oddList.text,
		/- broken \(no readable latest index\)/,
		"a profile without a readable index must be marked, not hidden",
	);

	let oddPickerChoices;
	const oddPull = await runWebdavSyncCommand(["pull"], {
		agentDir: workTarget,
		backend: oddBackend,
		selectProfile: async (choices) => {
			oddPickerChoices = choices.map((choice) => choice.id);
			return undefined;
		},
		selectSnapshot: async () => "latest",
	});
	assert.deepEqual(
		oddPickerChoices,
		["default", "broken", "stable"],
		"the pull picker should offer usable profiles and mark unreadable ones",
	);
	assert.match(oddPull.text, /pull: cancelled/, "cancelling the odd picker should cancel");

	// --- Scoped boundary and sole-profile reachability -----------------------
	class RecordingBackend extends MemoryBackend {
		calls = [];
		depth = 0;
		async record(method, remotePath, run) {
			if (this.depth === 0) this.calls.push(`${method}:${remotePath}`);
			this.depth += 1;
			try {
				return await run();
			} finally {
				this.depth -= 1;
			}
		}
		getJson(remotePath) {
			return this.record("getJson", remotePath, () => super.getJson(remotePath));
		}
		getBytes(remotePath) {
			return this.record("getBytes", remotePath, () => super.getBytes(remotePath));
		}
		putJson(remotePath, data) {
			return this.record("putJson", remotePath, () =>
				super.putJson(remotePath, data),
			);
		}
		putBytes(remotePath, bytes) {
			return this.record("putBytes", remotePath, () =>
				super.putBytes(remotePath, bytes),
			);
		}
		delete(remotePath) {
			return this.record("delete", remotePath, () => super.delete(remotePath));
		}
		exists(remotePath) {
			return this.record("exists", remotePath, () => super.exists(remotePath));
		}
		list(remotePath) {
			return this.record("list", remotePath, () => super.list(remotePath));
		}
		listIfExists(remotePath) {
			return this.record("listIfExists", remotePath, () =>
				super.listIfExists(remotePath),
			);
		}
	}
	const recording = new RecordingBackend();
	recording.files.set("profiles/work/latest.json", Buffer.from("{}\n"));
	recording.files.set("profiles/work/latest.zip", Buffer.from("zip"));
	const recordingScoped = scopedBackend(recording, "profiles/work");
	await recordingScoped.getJson("latest.json");
	await recordingScoped.getBytes("latest.zip");
	await recordingScoped.putJson("latest.json", { a: 1 });
	await recordingScoped.putBytes("latest.zip", Buffer.from("zip"));
	await recordingScoped.exists("latest.zip");
	await recordingScoped.delete("snapshots/x.zip");
	await recordingScoped.list("snapshots");
	await recordingScoped.listIfExists("snapshots");
	assert.deepEqual(
		recording.calls,
		[
			"getJson:profiles/work/latest.json",
			"getBytes:profiles/work/latest.zip",
			"putJson:profiles/work/latest.json",
			"putBytes:profiles/work/latest.zip",
			"exists:profiles/work/latest.zip",
			"delete:profiles/work/snapshots/x.zip",
			"list:profiles/work/snapshots",
			"listIfExists:profiles/work/snapshots",
		],
		"the scoped backend must prefix every remote path",
	);
	for (const unsafe of [
		"../personal/latest.zip",
		"snapshots/../../personal/latest.zip",
		"a/../../b",
		"/absolute/latest.zip",
		"..\\personal\\latest.zip",
		"..",
	]) {
		await assert.rejects(
			() => recordingScoped.exists(unsafe),
			/Unsafe scoped remote path/,
			`traversal must be rejected: ${unsafe}`,
		);
	}
	assert.throws(
		() => scopedBackend(recording, "profiles/../personal"),
		/Unsafe scoped profile prefix/,
		"an escaping profile prefix must be rejected",
	);
	assert.equal(
		recording.calls.some((call) => call.includes("..")),
		false,
		"no traversal path may reach the backend",
	);

	const workOnlyBackend = new MemoryBackend();
	for (const [key, value] of sharedBackend.files) {
		if (key.startsWith("profiles/work/")) workOnlyBackend.files.set(key, value);
	}
	const soleTarget = path.join(tempRoot, "sole-profile-target");
	await fs.mkdir(soleTarget, { recursive: true });
	await writeTestConfig(soleTarget);
	let solePickerCalled = false;
	const solePull = await runWebdavSyncCommand(["pull", "latest"], {
		agentDir: soleTarget,
		backend: workOnlyBackend,
		selectProfile: async () => {
			solePickerCalled = true;
			return undefined;
		},
	});
	assert.equal(
		solePickerCalled,
		false,
		"a single usable profile should not require a prompt",
	);
	assert.equal(
		solePull.ok,
		true,
		"the only available profile should be reachable without --profile",
	);
	assert.match(solePull.text, /profile: work/, "the sole profile should be reported");
	assert.equal(
		await fs.readFile(path.join(soleTarget, "AGENTS.md"), "utf8"),
		"work profile content v2\n",
		"the sole profile content should be applied",
	);
	const soleNoSnapshot = await runWebdavSyncCommand(["pull"], {
		agentDir: soleTarget,
		backend: workOnlyBackend,
	});
	assert.equal(
		soleNoSnapshot.ok,
		false,
		"a non-interactive pull must still require an explicit snapshot",
	);
	assert.match(
		soleNoSnapshot.text,
		/remote profiles: work — pass --profile <name>/,
		"the default-missing error should name the available profiles",
	);

	// a profile created while the confirmation dialog is open must not be overwritten
	const racedBackend = new MemoryBackend();
	for (const [key, value] of sharedBackend.files) {
		racedBackend.files.set(key, value);
	}
	const racedFence = `${JSON.stringify({ fenced: true })}\n`;
	const racedPush = await runWebdavSyncCommand(
		["push", "--create-profile", "raced"],
		{
			agentDir: profileAgent,
			backend: racedBackend,
			confirmPush: async () => {
				racedBackend.files.set(
					"profiles/raced/latest.json",
					Buffer.from(racedFence),
				);
				return true;
			},
		},
	);
	assert.equal(
		racedPush.ok,
		false,
		"a profile created while confirming must not be overwritten",
	);
	assert.match(
		racedPush.text,
		/Profile already exists: raced/,
		"the concurrent creation should be reported",
	);
	assert.equal(
		racedBackend.files.get("profiles/raced/latest.json").toString("utf8"),
		racedFence,
		"the other writer's index must survive",
	);
	assert.equal(
		racedBackend.files.has("profiles/raced/latest.zip"),
		false,
		"no upload may follow a failed profile recheck",
	);

	// --- Profile delete, rename, atomic claim, and config strictness ---------
	const manageBackend = new MemoryBackend();
	const manageAgent = path.join(tempRoot, "manage-agent");
	await fs.mkdir(manageAgent, { recursive: true });
	await fs.writeFile(
		path.join(manageAgent, "settings.json"),
		`${JSON.stringify({ packages: [] }, null, 2)}\n`,
	);
	await fs.writeFile(path.join(manageAgent, "AGENTS.md"), "manage content\n");
	await writeTestConfig(manageAgent);
	for (const name of ["alpha", "beta"]) {
		const pushed = await runWebdavSyncCommand([
			"push",
			"--create-profile",
			name,
		], {
			agentDir: manageAgent,
			backend: manageBackend,
			confirmPush: async () => true,
		});
		assert.equal(pushed.ok, true, `setup push for ${name} should succeed`);
	}
	const alphaZipBytes = Buffer.from(
		manageBackend.files.get("profiles/alpha/latest.zip"),
	);
	manageBackend.files.set("notes.txt", Buffer.from("unrelated\n"));
	manageBackend.directories.add("profiles/hollow");

	// creating a name whose directory already exists must fail even without an index
	const hollowCreate = await runWebdavSyncCommand(
		["push", "--create-profile", "hollow"],
		{
			agentDir: manageAgent,
			backend: manageBackend,
			confirmPush: async () => true,
		},
	);
	assert.equal(
		hollowCreate.ok,
		false,
		"the MKCOL claim must reject an existing directory",
	);
	assert.match(
		hollowCreate.text,
		/Profile already exists: hollow/,
		"the claim failure should name the profile",
	);

	// delete requires confirmation unless --yes is given
	const deleteNoConfirm = await runWebdavSyncCommand(
		["profiles", "delete", "alpha"],
		{ agentDir: manageAgent, backend: manageBackend },
	);
	assert.equal(deleteNoConfirm.ok, false, "delete without a confirmation path must fail");
	assert.match(deleteNoConfirm.text, /requires confirmation; re-run with --yes/, "--yes hint");
	assert.equal(
		manageBackend.files.has("profiles/alpha/latest.zip"),
		true,
		"an unconfirmed delete must not remove anything",
	);
	let deletePreview;
	const deleteCancelled = await runWebdavSyncCommand(
		["profiles", "delete", "alpha"],
		{
			agentDir: manageAgent,
			backend: manageBackend,
			confirmProfileDelete: async (preview) => {
				deletePreview = preview;
				return false;
			},
		},
	);
	assert.match(deleteCancelled.text, /delete: cancelled/, "cancelled delete message");
	assert.equal(deletePreview.profile, "alpha", "the preview should name the profile");
	assert(deletePreview.objectCount >= 3, "the preview should count objects");
	assert.equal(
		manageBackend.files.has("profiles/alpha/latest.zip"),
		true,
		"a cancelled delete must not remove anything",
	);

	// a picker-driven delete of an incomplete directory
	let deletePickerChoices;
	const hollowDelete = await runWebdavSyncCommand(["profiles", "delete", "hollow", "--yes"], {
		agentDir: manageAgent,
		backend: manageBackend,
	});
	assert.equal(hollowDelete.ok, true, "an index-less profile directory must be deletable");
	assert.doesNotMatch(
		hollowDelete.text,
		/backup: /,
		"an empty profile directory has nothing to back up",
	);
	assert.equal(
		manageBackend.directories.has("profiles/hollow"),
		false,
		"the hollow directory should be gone",
	);
	const deleteMissing = await runWebdavSyncCommand(
		["profiles", "delete", "absent", "--yes"],
		{ agentDir: manageAgent, backend: manageBackend },
	);
	assert.equal(deleteMissing.ok, false, "deleting a missing profile should fail");
	assert.match(deleteMissing.text, /Profile not found: absent/, "missing delete message");

	const deletedAlpha = await runWebdavSyncCommand(
		["profiles", "delete", "alpha", "--yes"],
		{ agentDir: manageAgent, backend: manageBackend },
	);
	assert.equal(deletedAlpha.ok, true, `delete --yes should succeed: ${deletedAlpha.text}`);
	assert.match(
		deletedAlpha.text,
		/backup: /,
		"deleting a profile must store a local backup first",
	);
	const alphaBackup = deletedAlpha.data.backup;
	assert(alphaBackup?.id, "the delete result should carry the backup id");
	assert.equal(
		(
			await fs.readFile(
				path.join(
					manageAgent,
					".webdav-sync",
					"backups",
					alphaBackup.id,
					"backup.zip",
				),
			)
		).equals(alphaZipBytes),
		true,
		"the pre-delete backup must contain the deleted profile archive",
	);
	assert.equal(
		[...manageBackend.files.keys()].some((key) => key.startsWith("profiles/alpha/")),
		false,
		"the deleted profile objects should be gone",
	);
	assert.equal(
		manageBackend.files.has("profiles/beta/latest.zip"),
		true,
		"deleting one profile must not touch another",
	);
	assert.equal(
		manageBackend.files.has("notes.txt"),
		true,
		"deleting a named profile must not touch unrelated root files",
	);
	await fs.writeFile(
		path.join(manageAgent, "AGENTS.md"),
		"locally edited after delete\n",
	);
	const restoreDeletedProfile = await runWebdavSyncCommand(
		["restore", alphaBackup.id],
		{ agentDir: manageAgent, confirmRestore: async () => true },
	);
	assert.equal(
		restoreDeletedProfile.ok,
		true,
		`restoring a pre-delete backup should succeed: ${restoreDeletedProfile.text}`,
	);
	assert.match(
		restoreDeletedProfile.text,
		/source profile: alpha/,
		"the restore should name the profile the backup came from",
	);
	assert.equal(
		await fs.readFile(path.join(manageAgent, "AGENTS.md"), "utf8"),
		"manage content\n",
		"a pre-delete backup must restore the deleted profile content locally",
	);

	// the default profile deletes only its own root objects
	const defaultPushForDelete = await runWebdavSyncCommand(["push"], {
		agentDir: manageAgent,
		backend: manageBackend,
		confirmPush: async () => true,
	});
	assert.equal(defaultPushForDelete.ok, true, "default push for delete setup");
	const deleteDefault = await runWebdavSyncCommand(
		["profiles", "delete", "default", "--yes"],
		{ agentDir: manageAgent, backend: manageBackend },
	);
	assert.equal(deleteDefault.ok, true, `default delete should succeed: ${deleteDefault.text}`);
	assert.equal(manageBackend.files.has("latest.zip"), false, "root zip removed");
	assert.equal(manageBackend.files.has("latest.json"), false, "root index removed");
	assert.equal(
		[...manageBackend.files.keys()].some((key) => key.startsWith("snapshots/")),
		false,
		"root snapshots removed",
	);
	assert.equal(manageBackend.files.has("notes.txt"), true, "unrelated root files must survive");
	assert.equal(
		manageBackend.files.has("profiles/beta/latest.zip"),
		true,
		"the default delete must not touch named profiles",
	);

	// rename: MOVE for named to named, copy+delete across the root layout
	class MoveRecordingBackend extends MemoryBackend {
		moveCalls = [];
		async move(remotePath, destinationPath) {
			this.moveCalls.push(`${remotePath}->${destinationPath}`);
			return await super.move(remotePath, destinationPath);
		}
	}
	const renameBackend = new MoveRecordingBackend();
	for (const [key, value] of manageBackend.files) renameBackend.files.set(key, value);
	for (const dir of manageBackend.directories) renameBackend.directories.add(dir);
	const renamed = await runWebdavSyncCommand(
		["profiles", "rename", "beta", "gamma"],
		{ agentDir: manageAgent, backend: renameBackend },
	);
	assert.equal(renamed.ok, true, `rename should succeed: ${renamed.text}`);
	assert.deepEqual(
		renameBackend.moveCalls,
		["profiles/beta->profiles/gamma"],
		"a named-to-named rename should use a single MOVE",
	);
	assert.match(renamed.text, /method: move/, "rename method should be reported");
	assert.equal(renameBackend.files.has("profiles/gamma/latest.zip"), true, "renamed zip");
	assert.equal(
		[...renameBackend.files.keys()].some((key) => key.startsWith("profiles/beta/")),
		false,
		"the rename source should be gone",
	);
	const renameExisting = await runWebdavSyncCommand(
		["profiles", "rename", "gamma", "gamma"],
		{ agentDir: manageAgent, backend: renameBackend },
	);
	assert.equal(renameExisting.ok, false, "renaming to the same name should fail");
	assert.match(renameExisting.text, /two different names/, "same-name message");

	await runWebdavSyncCommand(["push", "--create-profile", "delta"], {
		agentDir: manageAgent,
		backend: renameBackend,
		confirmPush: async () => true,
	});
	const renameCollision = await runWebdavSyncCommand(
		["profiles", "rename", "delta", "gamma"],
		{ agentDir: manageAgent, backend: renameBackend },
	);
	assert.equal(renameCollision.ok, false, "renaming onto an existing profile should fail");
	assert.match(renameCollision.text, /Profile already exists: gamma/, "collision message");

	class NoMoveBackend extends MemoryBackend {
		async move() {
			const error = new Error("method not allowed");
			error.status = 405;
			throw error;
		}
	}
	const fallbackBackend = new NoMoveBackend();
	for (const [key, value] of renameBackend.files) fallbackBackend.files.set(key, value);
	for (const dir of renameBackend.directories) fallbackBackend.directories.add(dir);
	const fallbackRename = await runWebdavSyncCommand(
		["profiles", "rename", "delta", "epsilon"],
		{ agentDir: manageAgent, backend: fallbackBackend },
	);
	assert.equal(fallbackRename.ok, true, `copy fallback rename: ${fallbackRename.text}`);
	assert.match(fallbackRename.text, /method: copy/, "the fallback should be reported");
	assert.equal(fallbackBackend.files.has("profiles/epsilon/latest.zip"), true, "copied zip");
	assert.equal(fallbackBackend.files.has("profiles/epsilon/latest.json"), true, "copied index");
	assert.equal(
		[...fallbackBackend.files.keys()].some((key) => key.startsWith("profiles/delta/")),
		false,
		"the copy fallback should remove the source after copying",
	);

	// renaming into and out of the default profile is an ordinary MOVE now
	const crossBackend = new MoveRecordingBackend();
	for (const [key, value] of fallbackBackend.files) crossBackend.files.set(key, value);
	for (const dir of fallbackBackend.directories) crossBackend.directories.add(dir);
	// A legacy root layout must not be silently forked by renaming onto default.
	crossBackend.files.set("latest.json", Buffer.from("{}\n"));
	const legacyRenameTarget = await runWebdavSyncCommand(
		["profiles", "rename", "epsilon", "default"],
		{ agentDir: manageAgent, backend: crossBackend },
	);
	assert.equal(
		legacyRenameTarget.ok,
		false,
		"renaming onto a legacy root default must refuse",
	);
	assert.match(
		legacyRenameTarget.text,
		/still holds pre-profile data/,
		"a refused legacy rename should explain the migration",
	);
	assert.deepEqual(crossBackend.moveCalls, [], "a refused rename must not MOVE");
	crossBackend.files.delete("latest.json");

	const toDefault = await runWebdavSyncCommand(
		["profiles", "rename", "epsilon", "default"],
		{ agentDir: manageAgent, backend: crossBackend },
	);
	assert.equal(toDefault.ok, true, `rename into default: ${toDefault.text}`);
	assert.match(toDefault.text, /method: move/, "renaming into default is a normal MOVE");
	assert.deepEqual(
		crossBackend.moveCalls,
		["profiles/epsilon->profiles/default"],
		"renaming into default should be one MOVE",
	);
	assert.equal(
		crossBackend.files.has("profiles/default/latest.zip"),
		true,
		"the default profile should hold the renamed objects",
	);
	assert.equal(
		[...crossBackend.files.keys()].some((key) =>
			key.startsWith("profiles/epsilon/"),
		),
		false,
		"the source profile should be gone after the rename",
	);
	const backToNamed = await runWebdavSyncCommand(
		["profiles", "rename", "default", "zeta"],
		{ agentDir: manageAgent, backend: crossBackend },
	);
	assert.equal(backToNamed.ok, true, `rename out of default: ${backToNamed.text}`);
	assert.match(backToNamed.text, /method: move/, "renaming out of default is a normal MOVE");
	assert.deepEqual(
		crossBackend.moveCalls,
		["profiles/epsilon->profiles/default", "profiles/default->profiles/zeta"],
		"each rename should be one MOVE",
	);
	assert.equal(
		crossBackend.files.has("profiles/zeta/latest.zip"),
		true,
		"named zip after rename",
	);
	assert.equal(
		[...crossBackend.files.keys()].some((key) =>
			key.startsWith("profiles/default/"),
		),
		false,
		"the default profile should be gone after the rename",
	);
	assert.equal(crossBackend.files.has("notes.txt"), true, "unrelated root files survive renames");

	// bounded metadata enrichment
	const manyBackend = new MemoryBackend();
	for (let index = 0; index < 21; index += 1) {
		const name = `p${String(index).padStart(2, "0")}`;
		manyBackend.directories.add(`profiles/${name}`);
		manyBackend.files.set(
			`profiles/${name}/latest.json`,
			Buffer.from(`${JSON.stringify({ fileCount: index, createdAt: "2026-03-03T00:00:00.000Z" })}\n`),
		);
		manyBackend.files.set(`profiles/${name}/latest.zip`, Buffer.from("zip"));
	}
	const manyList = await runWebdavSyncCommand(["profiles"], {
		agentDir: manageAgent,
		backend: manyBackend,
	});
	assert.equal(manyList.ok, true, "listing many profiles should succeed");
	const enrichedLines = manyList.text
		.split("\n")
		.filter((line) => line.includes("2026-03-03"));
	assert.equal(
		enrichedLines.length,
		20,
		"metadata reads should be capped at 20 profiles",
	);
	assert.match(manyList.text, /profiles: 21/, "all profiles should still be listed");

	// unknown config keys are rejected, "$" keys are ignored
	const strictConfigPath = path.join(manageAgent, "settings.webdav.json");
	const strictConfig = JSON.parse(await fs.readFile(strictConfigPath, "utf8"));
	await fs.writeFile(
		strictConfigPath,
		`${JSON.stringify({ ...strictConfig, extraFile: ["typo.json"] }, null, 2)}\n`,
	);
	const unknownKey = await runWebdavSyncCommand(["status"], {
		agentDir: manageAgent,
		backend: manageBackend,
	});
	assert.equal(unknownKey.ok, false, "an unknown config key must be reported");
	assert.match(unknownKey.text, /Unknown config key\(s\): extraFile/, "unknown key message");
	assert.match(unknownKey.text, /Supported keys: backend, remoteBaseUrl/, "supported keys hint");
	await fs.writeFile(
		strictConfigPath,
		`${JSON.stringify({ ...strictConfig, $comment: "keep me" }, null, 2)}\n`,
	);
	const commentKey = await runWebdavSyncCommand(["status"], {
		agentDir: manageAgent,
		backend: manageBackend,
	});
	assert.equal(commentKey.ok, true, `a "$" comment key should be ignored: ${commentKey.text}`);
	await fs.writeFile(strictConfigPath, `${JSON.stringify(strictConfig, null, 2)}\n`);

	// --- Scripted WebDAV server: the real client end to end ------------------
	const webdavModulePath = path.join(
		root,
		"node_modules",
		"webdav",
		"dist",
		"node",
		"index.js",
	);
	const fetchModulePath = path.join(
		root,
		"node_modules",
		"@buttercup",
		"fetch",
		"dist",
		"index.node.js",
	);
	const { getPatcher } = await import(pathToFileURL(webdavModulePath).href);
	const { Response: DavResponse } = await import(
		pathToFileURL(fetchModulePath).href
	);
	const { createWebdavBackend } = await import(distUrl("backends/webdav.js"));

	class ScriptedWebdavServer {
		constructor(basePath = "/dav") {
			this.basePath = basePath;
			this.files = new Map();
			this.dirs = new Set();
			this.calls = [];
		}
		relative(pathname) {
			const decoded = decodeURIComponent(pathname);
			const trimmed = decoded.replace(/\/+$/, "") || "/";
			if (!trimmed.startsWith(this.basePath)) return null;
			return trimmed.slice(this.basePath.length) || "/";
		}
		isDir(remotePath) {
			if (remotePath === "/") return true;
			if (this.dirs.has(remotePath)) return true;
			return [...this.files.keys()].some((key) =>
				key.startsWith(`${remotePath}/`),
			);
		}
		children(remotePath) {
			const prefix = remotePath === "/" ? "/" : `${remotePath}/`;
			const names = new Map();
			for (const key of [...this.files.keys(), ...this.dirs.values()]) {
				if (!key.startsWith(prefix)) continue;
				const rest = key.slice(prefix.length);
				if (!rest) continue;
				const slash = rest.indexOf("/");
				const name = slash === -1 ? rest : rest.slice(0, slash);
				if (!names.has(name)) names.set(name, `${prefix}${name}`);
			}
			return [...names.values()].map((childPath) => ({
				path: childPath,
				type: this.files.has(childPath) ? "file" : "dir",
			}));
		}
		propfind(remotePath, depth) {
			const exists =
				remotePath === "/" ||
				this.isDir(remotePath) ||
				this.files.has(remotePath);
			if (!exists) return undefined;
			const targets = [
				{
					path: remotePath,
					type: this.files.has(remotePath) ? "file" : "dir",
				},
			];
			if (depth !== "0" && this.isDir(remotePath))
				targets.push(...this.children(remotePath));
			const body = targets
				.map((target) => {
					const href = encodeURI(
						`${this.basePath}${target.path === "/" ? "/" : target.path}`,
						);
					const bytes = this.files.get(target.path);
					return `<D:response><D:href>${href}</D:href><D:propstat><D:prop><D:resourcetype>${
						target.type === "dir" ? "<D:collection/>" : ""
					}</D:resourcetype>${
						target.type === "file"
							? `<D:getcontentlength>${bytes ? bytes.length : 0}</D:getcontentlength><D:getlastmodified>Tue, 01 Jan 2030 00:00:00 GMT</D:getlastmodified>`
							: ""
					}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
				})
				.join("");
			return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${body}</D:multistatus>`;
		}
		head(rootPath, headerName) {
			for (const key of Object.keys(this.headers || {})) {
				if (key.toLowerCase() === headerName) return this.headers[key];
			}
			return rootPath;
		}
		async handle(url, options) {
			this.headers = options.headers || {};
			const remotePath = this.relative(new URL(url).pathname);
			const method = options.method || "GET";
			this.calls.push(`${method} ${remotePath}`);
			if (remotePath === null)
				return new DavResponse("outside", { status: 404 });
			const header = (name) => {
				for (const key of Object.keys(this.headers)) {
					if (key.toLowerCase() === name) return String(this.headers[key]);
				}
				return undefined;
			};
			const parentOf = (target) =>
				target.includes("/")
					? target.slice(0, target.lastIndexOf("/")) || "/"
					: "/";
			if (method === "PROPFIND") {
				const body = this.propfind(remotePath, header("depth") ?? "1");
				return body === undefined
					? new DavResponse("nf", { status: 404, statusText: "Not Found" })
					: new DavResponse(body, {
							status: 207,
							headers: { "content-type": "application/xml" },
						});
			}
			if (method === "MKCOL") {
				if (this.isDir(remotePath) || this.files.has(remotePath))
					return new DavResponse("exists", { status: 405 });
				if (!this.isDir(parentOf(remotePath)))
					return new DavResponse("conflict", { status: 409 });
				this.dirs.add(remotePath);
				return new DavResponse("", { status: 201 });
			}
			if (method === "PUT") {
				if (this.isDir(remotePath)) return new DavResponse("conflict", { status: 409 });
				const data = options.body;
				if (typeof data === "string") this.files.set(remotePath, Buffer.from(data));
				else if (Buffer.isBuffer(data) || data instanceof Uint8Array)
					this.files.set(remotePath, Buffer.from(data));
				else return new DavResponse("unsupported body", { status: 501 });
				return new DavResponse("", { status: 201 });
			}
			if (method === "GET") {
				const bytes = this.files.get(remotePath);
				return bytes
					? new DavResponse(bytes, { status: 200 })
					: new DavResponse("nf", { status: 404 });
			}
			if (method === "DELETE") {
				if (this.files.has(remotePath)) {
					this.files.delete(remotePath);
					return new DavResponse("", { status: 204 });
				}
				if (this.isDir(remotePath) && remotePath !== "/") {
					for (const key of [...this.files.keys()])
						if (key.startsWith(`${remotePath}/`)) this.files.delete(key);
					for (const dir of [...this.dirs])
						if (dir === remotePath || dir.startsWith(`${remotePath}/`))
							this.dirs.delete(dir);
					return new DavResponse("", { status: 204 });
				}
				return new DavResponse("nf", { status: 404 });
			}
			if (method === "MOVE") {
				const destinationHeader = header("destination");
				if (!destinationHeader)
					return new DavResponse("bad destination", { status: 400 });
				const destination = this.relative(
					new URL(destinationHeader, url).pathname,
				);
				if (destination === null)
					return new DavResponse("outside", { status: 404 });
				if (this.files.has(destination) || this.isDir(destination))
					return new DavResponse("exists", {
						status: 412,
						statusText: "Precondition Failed",
					});
				if (this.files.has(remotePath)) {
					this.files.set(destination, this.files.get(remotePath));
					this.files.delete(remotePath);
					return new DavResponse("", { status: 201 });
				}
				if (!this.isDir(remotePath))
					return new DavResponse("nf", { status: 404 });
				for (const key of [...this.files.keys()]) {
					if (!key.startsWith(`${remotePath}/`)) continue;
					this.files.set(
						`${destination}${key.slice(remotePath.length)}`,
						this.files.get(key),
					);
					this.files.delete(key);
				}
				for (const dir of [...this.dirs]) {
					if (dir !== remotePath && !dir.startsWith(`${remotePath}/`)) continue;
					this.dirs.delete(dir);
					this.dirs.add(`${destination}${dir.slice(remotePath.length)}`);
				}
				this.dirs.add(destination);
				return new DavResponse("", { status: 201 });
			}
			return new DavResponse(`unsupported ${method}`, { status: 501 });
		}
	}

	const scriptedServer = new ScriptedWebdavServer();
	const patcher = getPatcher();
	patcher.patch("fetch", (url, options) => scriptedServer.handle(url, options));
	try {
		const davBackend = createWebdavBackend({
			backend: "webdav",
			remoteBaseUrl: "https://dav.example.invalid/dav/",
			username: "user",
			password: "secret",
			remoteDir: "/sync",
		});
		assert.deepEqual(
			await davBackend.listIfExists("profiles"),
			[],
			"a missing collection must read as empty through the real client",
		);
		assert.equal(
			await davBackend.createDirectory("profiles/davwork"),
			true,
			"MKCOL on a new collection must report creation",
		);
		assert.equal(
			await davBackend.createDirectory("profiles/davwork"),
			false,
			"MKCOL on an existing collection must report the failed claim",
		);
		scriptedServer.files.set("/sync/notes.txt", Buffer.from("unrelated\n"));
		scriptedServer.files.set(
			"/sync/profiles/other/latest.json",
			Buffer.from("{}\n"),
		);
		await assert.rejects(
			() => davBackend.move("profiles/davwork", "profiles/other"),
			/412/,
			"MOVE with overwrite disabled must refuse an existing destination",
		);
		await davBackend.delete("profiles/davwork");
		await davBackend.delete("profiles/davwork");
		assert.equal(
			scriptedServer.files.has("/sync/notes.txt"),
			true,
			"unrelated root files must survive backend operations",
		);

		const davAgent = path.join(tempRoot, "dav-agent");
		await fs.mkdir(davAgent, { recursive: true });
		await fs.writeFile(
			path.join(davAgent, "settings.json"),
			`${JSON.stringify({ packages: [] }, null, 2)}\n`,
		);
		await fs.writeFile(path.join(davAgent, "AGENTS.md"), "dav profile content\n");
		await writeTestConfig(davAgent);
		const davCreate = await runWebdavSyncCommand(
			["push", "--create-profile", "davwork"],
			{
				agentDir: davAgent,
				backend: davBackend,
				confirmPush: async () => true,
			},
		);
		assert.equal(
			davCreate.ok,
			true,
			`push through the real client should succeed: ${davCreate.text}`,
		);
		assert.equal(
			scriptedServer.files.has("/sync/profiles/davwork/latest.zip"),
			true,
			"the real client should upload the zip",
		);
		assert.equal(
			scriptedServer.files.has("/sync/profiles/davwork/latest.json"),
			true,
			"the real client should upload the index",
		);
		const davProfiles = await runWebdavSyncCommand(["profiles"], {
			agentDir: davAgent,
			backend: davBackend,
		});
		assert.match(
			davProfiles.text,
			/- davwork · /,
			"the scripted remote should list the created profile with metadata",
		);

		const davTarget = path.join(tempRoot, "dav-target");
		await fs.mkdir(davTarget, { recursive: true });
		await writeTestConfig(davTarget);
		const davPull = await runWebdavSyncCommand(
			["pull", "--profile", "davwork", "latest"],
			{ agentDir: davTarget, backend: davBackend },
		);
		assert.equal(
			davPull.ok,
			true,
			`pull through the real client should succeed: ${davPull.text}`,
		);
		assert.equal(
			await fs.readFile(path.join(davTarget, "AGENTS.md"), "utf8"),
			"dav profile content\n",
			"the pulled content should be applied",
		);
		const davStatus = await runWebdavSyncCommand(
			["status", "--profile", "davwork"],
			{ agentDir: davTarget, backend: davBackend },
		);
		assert.match(
			davStatus.text,
			/up to date/,
			"status through the real client should be clean after the pull",
		);

		const davRename = await runWebdavSyncCommand(
			["profiles", "rename", "davwork", "davteam"],
			{ agentDir: davAgent, backend: davBackend },
		);
		assert.equal(davRename.ok, true, `real-client rename: ${davRename.text}`);
		assert.match(davRename.text, /method: move/, "named profiles should rename with MOVE");
		assert(
			scriptedServer.calls.some((call) => call.startsWith("MOVE ")),
			"the scripted server should have received a MOVE",
		);
		assert.equal(
			scriptedServer.files.has("/sync/profiles/davteam/latest.zip"),
			true,
			"MOVE should carry the objects to the new name",
		);
		assert.equal(
			[...scriptedServer.files.keys()].some((key) =>
				key.startsWith("/sync/profiles/davwork/"),
			),
			false,
			"MOVE should leave no source objects behind",
		);

		const davDelete = await runWebdavSyncCommand(
			["profiles", "delete", "davteam", "--yes"],
			{ agentDir: davAgent, backend: davBackend },
		);
		assert.equal(davDelete.ok, true, `real-client delete: ${davDelete.text}`);
		assert.equal(
			[...scriptedServer.files.keys()].some((key) =>
				key.startsWith("/sync/profiles/davteam"),
			),
			false,
			"the recursive DELETE should remove the profile",
		);
		assert.equal(
			scriptedServer.files.has("/sync/notes.txt"),
			true,
			"a profile delete must not touch unrelated root files",
		);
		assert.equal(
			scriptedServer.files.has("/sync/profiles/other/latest.json"),
			true,
			"a profile delete must not touch sibling profiles",
		);

		// legacy layout through the real client: seed the root, then migrate
		scriptedServer.files.set(
			"/sync/latest.zip",
			scriptedServer.files.get("/sync/profiles/other/latest.json") &&
				Buffer.from("legacy zip\n"),
		);
		scriptedServer.files.set(
			"/sync/latest.json",
			Buffer.from(
				`${JSON.stringify({ createdAt: "2026-01-01T00:00:00.000Z", fileCount: 1 })}\n`,
			),
		);
		scriptedServer.files.set(
			"/sync/snapshots/2026-01-01T00-00-00-000Z.zip",
			Buffer.from("legacy snapshot\n"),
		);
		scriptedServer.files.set(
			"/sync/snapshots/2026-01-01T00-00-00-000Z.json",
			Buffer.from("{}\n"),
		);
		const davLegacyList = await runWebdavSyncCommand(["profiles"], {
			agentDir: davAgent,
			backend: davBackend,
		});
		assert.match(
			davLegacyList.text,
			/legacy: default data still sits at the remote root/,
			"the real client should detect the legacy layout",
		);
		const davMigrate = await runWebdavSyncCommand(
			["profiles", "migrate", "--yes"],
			{ agentDir: davAgent, backend: davBackend },
		);
		assert.equal(davMigrate.ok, true, `real-client migrate: ${davMigrate.text}`);
		assert.match(davMigrate.text, /method: move/, "the scripted server supports MOVE");
		assert.equal(
			scriptedServer.files.has("/sync/profiles/default/latest.zip"),
			true,
			"the real client should move the archive into the default profile",
		);
		assert.equal(
			scriptedServer.files.has("/sync/profiles/default/snapshots/2026-01-01T00-00-00-000Z.zip"),
			true,
			"the real client should move the snapshots too",
		);
		assert.equal(
			scriptedServer.files.has("/sync/latest.json"),
			false,
			"the legacy root index should be gone",
		);
		assert.equal(
			scriptedServer.files.has("/sync/layout.json"),
			true,
			"the layout marker should be written through the real client",
		);
		assert.equal(
			scriptedServer.files.get("/sync/notes.txt").toString("utf8"),
			"unrelated\n",
			"unrelated root files must survive a real migration",
		);

		// automatic migration through the real client: push a real archive pair, move it
		// to the root as legacy data, then pull and watch the migration happen
		const davAutoFixture = await runWebdavSyncCommand(
			["push", "--create-profile", "autopull"],
			{
				agentDir: davAgent,
				backend: davBackend,
				confirmPush: async () => true,
			},
		);
		assert.equal(davAutoFixture.ok, true, `fixture push: ${davAutoFixture.text}`);
		scriptedServer.files.set(
			"/sync/latest.zip",
			scriptedServer.files.get("/sync/profiles/autopull/latest.zip"),
		);
		scriptedServer.files.set(
			"/sync/latest.json",
			scriptedServer.files.get("/sync/profiles/autopull/latest.json"),
		);
		scriptedServer.files.delete("/sync/profiles/autopull/latest.zip");
		scriptedServer.files.delete("/sync/profiles/autopull/latest.json");
		// clear the earlier default profile so the legacy root is the only copy
		scriptedServer.files.delete("/sync/profiles/default/latest.zip");
		scriptedServer.files.delete("/sync/profiles/default/latest.json");
		const davAutoPull = await runWebdavSyncCommand(["pull", "latest"], {
			agentDir: davTarget,
			backend: davBackend,
			confirmInstallPackages: async () => false,
		});
		assert.equal(
			davAutoPull.ok,
			true,
			`auto-migration pull: ${davAutoPull.text}`,
		);
		assert.match(
			davAutoPull.text,
			/migrated: default -> profiles\/default/,
			"a pull through the real client should migrate automatically",
		);
		assert.equal(
			scriptedServer.files.has("/sync/latest.json"),
			false,
			"the legacy root should be cleaned by the automatic migration",
		);
		assert.equal(
			scriptedServer.files.has("/sync/profiles/default/latest.json"),
			true,
			"the migrated index should live in the default profile",
		);
	} finally {
		if (patcher.isPatched("fetch")) patcher.restore("fetch");
	}

	// --- Interactive profile management through the TUI callbacks ------------
	const uiBackend = new MoveRecordingBackend();
	for (const [key, value] of crossBackend.files) uiBackend.files.set(key, value);
	for (const dir of crossBackend.directories) uiBackend.directories.add(dir);

	const actionPrompts = [];
	let actionChoices;
	const listAction = await runWebdavSyncCommand(["profiles"], {
		agentDir: manageAgent,
		backend: uiBackend,
		selectProfile: async (choices, message) => {
			actionPrompts.push(message);
			actionChoices = choices.map((choice) => choice.id);
			return "list";
		},
	});
	assert.equal(listAction.ok, true, `bare profiles should work: ${listAction.text}`);
	assert.deepEqual(
		actionPrompts,
		["WebDAV profiles:"],
		"the bare command should open the action menu first",
	);
	assert.deepEqual(
		actionChoices,
		["list", "delete", "rename"],
		"the action menu should offer list, delete, and rename",
	);
	assert.match(listAction.text, /profiles: 2/, "choosing List profiles counts profiles");
	assert.match(listAction.text, /- gamma/, "choosing List profiles prints the listing");

	let renamePickerPrompt;
	const menuRename = await runWebdavSyncCommand(["profiles"], {
		agentDir: manageAgent,
		backend: uiBackend,
		selectProfile: async (choices, message) => {
			if (message === "WebDAV profiles:") return "rename";
			renamePickerPrompt = message;
			return "zeta";
		},
		inputProfileName: async () => "omega",
	});
	assert.equal(menuRename.ok, true, `menu rename: ${menuRename.text}`);
	assert.equal(
		renamePickerPrompt,
		"Select the profile to rename:",
		"the picker prompt should say what it is for",
	);
	assert.match(menuRename.text, /profiles rename: zeta -> omega/, "menu rename result");
	assert.equal(
		uiBackend.files.has("profiles/omega/latest.zip"),
		true,
		"the profile should be renamed through the menu",
	);

	const deletePrompts = [];
	const menuDelete = await runWebdavSyncCommand(["profiles"], {
		agentDir: manageAgent,
		backend: uiBackend,
		selectProfile: async (choices, message) => {
			deletePrompts.push(message);
			return message === "WebDAV profiles:" ? "delete" : "omega";
		},
		confirmProfileDelete: async (preview) => preview.profile === "omega",
	});
	assert.equal(menuDelete.ok, true, `menu delete: ${menuDelete.text}`);
	assert.deepEqual(
		deletePrompts,
		["WebDAV profiles:", "Select the profile to delete:"],
		"delete should ask which profile after the action menu",
	);
	assert.equal(
		[...uiBackend.files.keys()].some((key) => key.startsWith("profiles/omega/")),
		false,
		"the profile should be deleted through the menu",
	);

	const cancelMenu = await runWebdavSyncCommand(["profiles"], {
		agentDir: manageAgent,
		backend: uiBackend,
		selectProfile: async () => undefined,
	});
	assert.match(cancelMenu.text, /profiles: cancelled/, "cancelling the menu cancels");

	uiBackend.directories.add("profiles/hollow2");
	let hollowChoices;
	const hollowPick = await runWebdavSyncCommand(["profiles", "delete"], {
		agentDir: manageAgent,
		backend: uiBackend,
		selectProfile: async (choices) => {
			hollowChoices = choices.map((choice) => choice.id);
			return "hollow2";
		},
		confirmProfileDelete: async () => true,
	});
	assert.equal(hollowPick.ok, true, `index-less delete: ${hollowPick.text}`);
	assert(
		hollowChoices.includes("hollow2"),
		"an index-less directory must be pickable for delete",
	);
	assert.equal(
		uiBackend.directories.has("profiles/hollow2"),
		false,
		"the picked index-less directory should be deleted",
	);

	await runWebdavSyncCommand(["push", "--create-profile", "iota"], {
		agentDir: manageAgent,
		backend: uiBackend,
		confirmPush: async () => true,
	});
	const partialRename = await runWebdavSyncCommand(["profiles", "rename", "iota"], {
		agentDir: manageAgent,
		backend: uiBackend,
		inputProfileName: async () => "kappa",
	});
	assert.equal(partialRename.ok, true, `partial rename: ${partialRename.text}`);
	assert.match(
		partialRename.text,
		/profiles rename: iota -> kappa/,
		"the new name may come from the input dialog",
	);

	// --- Legacy root layout: read-only status, automatic migration ------------
	const makeLegacyBackend = () => {
		const backend = new MemoryBackend();
		for (const [key, value] of sharedBackend.files) {
			if (!key.startsWith("profiles/default/")) continue;
			backend.files.set(key.slice("profiles/default/".length), value);
		}
		backend.files.set("notes.txt", Buffer.from("mine\n"));
		return backend;
	};
	const legacyAgentDir = path.join(tempRoot, "legacy-agent");
	await fs.mkdir(legacyAgentDir, { recursive: true });
	await fs.writeFile(
		path.join(legacyAgentDir, "settings.json"),
		`${JSON.stringify({ packages: [] }, null, 2)}\n`,
	);
	await fs.writeFile(path.join(legacyAgentDir, "AGENTS.md"), "legacy local\n");
	await writeTestConfig(legacyAgentDir);

	// status is read-only: it reads the legacy root in place and writes nothing
	const statusBackend = makeLegacyBackend();
	const statusKeys = [...statusBackend.files.keys()].sort().join("\n");
	const legacyStatus = await runWebdavSyncCommand(["status"], {
		agentDir: legacyAgentDir,
		backend: statusBackend,
	});
	assert.equal(legacyStatus.ok, true, `legacy status: ${legacyStatus.text}`);
	assert.match(
		legacyStatus.text,
		/layout: legacy root/,
		"status should name the legacy layout",
	);
	assert.equal(
		[...statusBackend.files.keys()].sort().join("\n"),
		statusKeys,
		"status must not modify a legacy remote",
	);
	const legacyList = await runWebdavSyncCommand(["profiles"], {
		agentDir: legacyAgentDir,
		backend: statusBackend,
	});
	assert.match(
		legacyList.text,
		/legacy: default data still sits at the remote root/,
		"the listing should report legacy root data",
	);
	assert.match(legacyList.text, /profiles: 0/, "legacy root data is not a profile yet");

	// push migrates transparently, then uploads into profiles/default
	const pushBackend = makeLegacyBackend();
	const legacyPush = await runWebdavSyncCommand(["push"], {
		agentDir: legacyAgentDir,
		backend: pushBackend,
		confirmPush: async () => true,
	});
	assert.equal(legacyPush.ok, true, `push on a legacy remote: ${legacyPush.text}`);
	assert.match(
		legacyPush.text,
		/migrated: default -> profiles\/default/,
		"push should report the automatic migration",
	);
	assert.match(
		legacyPush.text,
		/backup: /,
		"an automatic migration must store a local backup first",
	);
	assert.equal(
		pushBackend.files.has("profiles/default/latest.zip"),
		true,
		"the migrated archive should live in the default profile",
	);
	assert.equal(
		[...pushBackend.files.keys()].some(
			(key) =>
				key === "latest.json" ||
				key === "latest.zip" ||
				key.startsWith("snapshots/"),
		),
		false,
		"the remote root should be empty after the automatic migration",
	);
	assert.equal(pushBackend.files.has("layout.json"), true, "the marker should be written");
	assert.equal(
		pushBackend.files.get("notes.txt").toString("utf8"),
		"mine\n",
		"unrelated root files must survive the automatic migration",
	);
	assert.equal(
		await fs.readFile(path.join(legacyAgentDir, "AGENTS.md"), "utf8"),
		"legacy local\n",
		"push must not change local files",
	);

	// pull migrates transparently, then applies the legacy content
	const pullBackend = makeLegacyBackend();
	const legacySourceArchive = parseArchive(
		pullBackend.files.get("latest.zip"),
		JSON.parse(pullBackend.files.get("latest.json").toString("utf8")).zipSha256,
		extraPaths,
	);
	const expectedLegacyAgents = legacySourceArchive.entries
		.get("files/AGENTS.md")
		.toString("utf8");
	const legacyAutoPull = await runWebdavSyncCommand(["pull", "latest"], {
		agentDir: legacyAgentDir,
		backend: pullBackend,
		confirmInstallPackages: async () => false,
	});
	assert.equal(legacyAutoPull.ok, true, `pull on a legacy remote: ${legacyAutoPull.text}`);
	assert.match(
		legacyAutoPull.text,
		/migrated: default -> profiles\/default/,
		"pull should report the automatic migration",
	);
	assert.equal(
		await fs.readFile(path.join(legacyAgentDir, "AGENTS.md"), "utf8"),
		expectedLegacyAgents,
		"the legacy content must still be applied after migrating",
	);
	assert.equal(
		[...pullBackend.files.keys()].some(
			(key) => key === "latest.json" || key.startsWith("snapshots/"),
		),
		false,
		"the legacy root should be gone after the automatic migration",
	);

	// named pushes migrate as well, and creating default migrates instead of failing
	const namedBackend = makeLegacyBackend();
	const legacyNamedPush = await runWebdavSyncCommand(
		["push", "--create-profile", "work"],
		{
			agentDir: legacyAgentDir,
			backend: namedBackend,
			confirmPush: async () => true,
		},
	);
	assert.equal(legacyNamedPush.ok, true, `named push on legacy: ${legacyNamedPush.text}`);
	assert.match(legacyNamedPush.text, /migrated:/, "a named push should migrate too");
	assert.equal(
		namedBackend.files.has("profiles/work/latest.zip"),
		true,
		"the named profile should be created",
	);
	assert.equal(
		namedBackend.files.has("profiles/default/latest.json"),
		true,
		"the migrated default profile should survive",
	);
	assert.equal(namedBackend.files.has("layout.json"), true, "the marker should be written");

	const createDefaultBackend = makeLegacyBackend();
	const legacyCreateDefault = await runWebdavSyncCommand(
		["push", "--create-profile", "default"],
		{
			agentDir: legacyAgentDir,
			backend: createDefaultBackend,
			confirmPush: async () => true,
		},
	);
	assert.equal(
		legacyCreateDefault.ok,
		true,
		`create-default on legacy: ${legacyCreateDefault.text}`,
	);
	assert.match(
		legacyCreateDefault.text,
		/profile: default/,
		"creating default on a legacy remote should update it",
	);
	assert.match(legacyCreateDefault.text, /migrated:/, "it should migrate first");

	// a conflicting profiles/default refuses instead of forking the data
	const conflictBackend = makeLegacyBackend();
	conflictBackend.files.set("profiles/default/latest.json", Buffer.from("{}\n"));
	const conflictPush = await runWebdavSyncCommand(["push"], {
		agentDir: legacyAgentDir,
		backend: conflictBackend,
		confirmPush: async () => true,
	});
	assert.equal(
		conflictPush.ok,
		false,
		"a conflicting profiles/default must not be forked",
	);
	assert.match(
		conflictPush.text,
		/already has data while the remote root still holds/,
		"conflict message",
	);

	// the explicit command still works, requires confirmation, and is idempotent
	const manualBackend = makeLegacyBackend();
	const noConfirmMigrate = await runWebdavSyncCommand(["profiles", "migrate"], {
		agentDir: legacyAgentDir,
		backend: manualBackend,
	});
	assert.equal(noConfirmMigrate.ok, false, "migrate without confirmation must fail");
	assert.match(noConfirmMigrate.text, /requires confirmation; re-run with --yes/, "--yes hint");
	let migratePreview;
	const cancelledMigrate = await runWebdavSyncCommand(["profiles", "migrate"], {
		agentDir: legacyAgentDir,
		backend: manualBackend,
		confirmProfileMigrate: async (preview) => {
			migratePreview = preview;
			return false;
		},
	});
	assert.match(cancelledMigrate.text, /migrate: cancelled/, "cancelled migrate message");
	assert.equal(
		manualBackend.files.has("latest.json"),
		true,
		"a cancelled migrate must not move anything",
	);
	assert(migratePreview.objectCount >= 3, "the migrate preview should count objects");
	const migrated = await runWebdavSyncCommand(["profiles", "migrate", "--yes"], {
		agentDir: legacyAgentDir,
		backend: manualBackend,
	});
	assert.equal(migrated.ok, true, `migrate --yes: ${migrated.text}`);
	assert.match(migrated.text, /method: move/, "the memory double supports MOVE");
	assert.match(migrated.text, /backup: /, "migration must store a local backup first");
	assert.equal(
		manualBackend.files.has("profiles/default/latest.zip"),
		true,
		"migrated zip",
	);
	assert.equal(
		manualBackend.files.has("profiles/default/latest.json"),
		true,
		"migrated index",
	);
	assert.equal(manualBackend.files.has("latest.json"), false, "root index removed");
	assert.equal(manualBackend.files.has("latest.zip"), false, "root zip removed");
	assert.equal(
		[...manualBackend.files.keys()].some((key) => key.startsWith("snapshots/")),
		false,
		"root snapshots removed",
	);
	assert.equal(
		[...manualBackend.files.keys()].some((key) =>
			key.startsWith("profiles/default/snapshots/"),
		),
		true,
		"snapshots moved under the profile",
	);
	assert.equal(manualBackend.files.has("layout.json"), true, "the marker should be written");
	assert.equal(
		manualBackend.files.get("notes.txt").toString("utf8"),
		"mine\n",
		"unrelated root files must survive the migration",
	);
	const migratedIndex = JSON.parse(
		manualBackend.files.get("profiles/default/latest.json").toString("utf8"),
	);
	const migratedArchive = parseArchive(
		manualBackend.files.get("profiles/default/latest.zip"),
		migratedIndex.zipSha256,
		extraPaths,
	);
	const afterMigrateList = await runWebdavSyncCommand(["profiles"], {
		agentDir: legacyAgentDir,
		backend: manualBackend,
	});
	assert.doesNotMatch(afterMigrateList.text, /legacy:/, "no legacy hint after migrating");
	const afterMigratePull = await runWebdavSyncCommand(
		["pull", "--profile", "default", "latest"],
		{ agentDir: legacyAgentDir, backend: manualBackend },
	);
	assert.equal(afterMigratePull.ok, true, `pull after migrate: ${afterMigratePull.text}`);
	assert.equal(
		await fs.readFile(path.join(legacyAgentDir, "AGENTS.md"), "utf8"),
		migratedArchive.entries.get("files/AGENTS.md").toString("utf8"),
		"the migrated archive must restore its content",
	);
	const secondMigrate = await runWebdavSyncCommand(["profiles", "migrate", "--yes"], {
		agentDir: legacyAgentDir,
		backend: manualBackend,
	});
	assert.match(secondMigrate.text, /nothing to migrate/, "migration must be idempotent");

	const noMoveLegacy = new NoMoveBackend();
	noMoveLegacy.files.set("latest.zip", Buffer.from("legacy zip\n"));
	noMoveLegacy.files.set("latest.json", Buffer.from("{}\n"));
	noMoveLegacy.files.set(
		"snapshots/2026-01-01T00-00-00-000Z.zip",
		Buffer.from("snap zip\n"),
	);
	noMoveLegacy.files.set(
		"snapshots/2026-01-01T00-00-00-000Z.json",
		Buffer.from("{}\n"),
	);
	const copyMigrate = await runWebdavSyncCommand(["profiles", "migrate", "--yes"], {
		agentDir: legacyAgentDir,
		backend: noMoveLegacy,
	});
	assert.equal(copyMigrate.ok, true, `copy fallback migrate: ${copyMigrate.text}`);
	assert.match(copyMigrate.text, /method: copy/, "the MOVE-less fallback should be reported");
	assert.equal(
		noMoveLegacy.files.has("profiles/default/latest.zip"),
		true,
		"copied zip",
	);
	assert.equal(
		noMoveLegacy.files.has("profiles/default/snapshots/2026-01-01T00-00-00-000Z.zip"),
		true,
		"copied snapshot",
	);
	assert.equal(
		noMoveLegacy.files.has("snapshots/2026-01-01T00-00-00-000Z.zip"),
		false,
		"the source snapshot should be removed after copying",
	);

	// an unverified copy must abort before the source is removed
	class NoMoveTruncatingBackend extends NoMoveBackend {
		async putBytes(remotePath, bytes) {
			await super.putBytes(
				remotePath,
				Buffer.from(bytes).subarray(0, Math.max(1, bytes.byteLength - 1)),
			);
		}
	}
	const truncatingBackend = new NoMoveTruncatingBackend();
	truncatingBackend.files.set("latest.zip", Buffer.from("legacy zip\n"));
	truncatingBackend.files.set("latest.json", Buffer.from("{}\n"));
	const truncatingMigrate = await runWebdavSyncCommand(
		["profiles", "migrate", "--yes"],
		{ agentDir: legacyAgentDir, backend: truncatingBackend },
	);
	assert.equal(
		truncatingMigrate.ok,
		false,
		"an unverified copy must abort the migration",
	);
	assert.match(
		truncatingMigrate.text,
		/copy verification failed/,
		"the verification failure should be reported",
	);
	assert.equal(
		truncatingBackend.files.has("latest.zip"),
		true,
		"the source archive must survive a failed copy",
	);

	// a leftover partial destination is re-copied instead of blocking the migration
	const healBackend = new NoMoveBackend();
	healBackend.files.set("latest.zip", Buffer.from("legacy zip\n"));
	healBackend.files.set("latest.json", Buffer.from("{}\n"));
	healBackend.files.set("profiles/default/latest.zip", Buffer.from("legacy zip"));
	const healedMigrate = await runWebdavSyncCommand(
		["profiles", "migrate", "--yes"],
		{ agentDir: legacyAgentDir, backend: healBackend },
	);
	assert.equal(healedMigrate.ok, true, `self-healing migration: ${healedMigrate.text}`);
	assert.equal(
		healBackend.files.get("profiles/default/latest.zip").toString("utf8"),
		"legacy zip\n",
		"a partial destination must be replaced by a verified copy",
	);
	assert.equal(
		healBackend.files.has("latest.zip"),
		false,
		"the source is dropped only after the copy verifies",
	);

	// the interactive menu offers migration, and the picker can target the legacy root
	const menuLegacyBackend = makeLegacyBackend();
	let menuActions;
	const menuCancel = await runWebdavSyncCommand(["profiles"], {
		agentDir: legacyAgentDir,
		backend: menuLegacyBackend,
		selectProfile: async (choices) => {
			menuActions = choices.map((choice) => choice.id);
			return undefined;
		},
	});
	assert(
		menuActions.includes("migrate"),
		"the action menu should offer migration on a legacy remote",
	);
	assert.match(menuCancel.text, /profiles: cancelled/, "cancelling the menu cancels");
	let legacyPickerChoices;
	const legacyMenuDelete = await runWebdavSyncCommand(["profiles"], {
		agentDir: legacyAgentDir,
		backend: menuLegacyBackend,
		selectProfile: async (choices, message) => {
			if (message === "WebDAV profiles:") return "delete";
			legacyPickerChoices = choices.map((choice) => choice.id);
			return "default";
		},
		confirmProfileDelete: async () => true,
	});
	assert.equal(legacyMenuDelete.ok, true, `legacy menu delete: ${legacyMenuDelete.text}`);
	assert(
		legacyPickerChoices.includes("default"),
		"the legacy root profile must be pickable for delete",
	);
	assert.equal(
		menuLegacyBackend.files.has("latest.json"),
		false,
		"the legacy root index should be deleted",
	);

	const deleteLegacyBackend = makeLegacyBackend();
	deleteLegacyBackend.files.set("snapshots/x.zip", Buffer.from("zip\n"));
	const legacyDelete = await runWebdavSyncCommand(
		["profiles", "delete", "default", "--yes"],
		{ agentDir: legacyAgentDir, backend: deleteLegacyBackend },
	);
	assert.equal(legacyDelete.ok, true, `legacy delete: ${legacyDelete.text}`);
	assert.equal(deleteLegacyBackend.files.has("latest.json"), false, "legacy index removed");
	assert.equal(
		deleteLegacyBackend.files.has("snapshots/x.zip"),
		false,
		"legacy snapshots removed",
	);
	assert.equal(
		deleteLegacyBackend.files.has("notes.txt"),
		true,
		"unrelated root files must survive a legacy delete",
	);

	const futureBackend = new MemoryBackend();
	futureBackend.files.set(
		"layout.json",
		Buffer.from(`${JSON.stringify({ layoutVersion: 3 })}\n`),
	);
	futureBackend.files.set("profiles/work/latest.json", Buffer.from("{}\n"));
	for (const input of [
		["profiles"],
		["push", "--profile", "work"],
		["pull", "--profile", "work", "latest"],
		["status", "--profile", "work"],
	]) {
		const futureCommand = await runWebdavSyncCommand(input, {
			agentDir: legacyAgentDir,
			backend: futureBackend,
			confirmPush: async () => true,
		});
		assert.equal(
			futureCommand.ok,
			false,
			`a newer remote layout must be refused for ${input.join(" ")}`,
		);
		assert.match(
			futureCommand.text,
			/written by a newer pi-webdav-sync/,
			`future layout version message for ${input.join(" ")}`,
		);
	}

	console.log("self-test passed");
} finally {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = originalUserProfile;
	await fs.rm(tempRoot, { recursive: true, force: true });
}

async function seedSourceAgent(agentDir, externalDir) {
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(path.join(agentDir, "skills", "good"), { recursive: true });
	await fs.mkdir(
		path.join(agentDir, "extensions", "foo", "node_modules", "bad"),
		{ recursive: true },
	);
	await fs.mkdir(path.join(agentDir, "prompts"), { recursive: true });
	await fs.mkdir(path.join(agentDir, "custom-config", "nested"), {
		recursive: true,
	});
	await fs.mkdir(path.join(agentDir, "npm", "pkg"), { recursive: true });
	await fs.mkdir(path.join(agentDir, "git", "pkg"), { recursive: true });
	await fs.mkdir(path.join(agentDir, "sessions"), { recursive: true });
	await fs.mkdir(path.join(agentDir, ".webdav-sync", "backups"), {
		recursive: true,
	});
	await fs.mkdir(path.join(testHome, ".pi"), { recursive: true });
	await fs.mkdir(path.join(externalDir, "src"), { recursive: true });
	await fs.mkdir(path.join(externalDir, "node_modules", "bad"), {
		recursive: true,
	});
	await fs.mkdir(path.join(externalDir, ".git"), { recursive: true });

	await fs.writeFile(path.join(agentDir, "AGENTS.md"), "agent rules\n");
	await fs.writeFile(
		path.join(agentDir, "auth.json"),
		JSON.stringify({ token: "secret" }),
	);
	await fs.writeFile(
		path.join(agentDir, "skills", "good", "skill.md"),
		"skill\n",
	);
	await fs.writeFile(
		path.join(agentDir, "extensions", "foo", "index.js"),
		"export default {};\n",
	);
	await fs.writeFile(
		path.join(agentDir, "hermes-memory-config.json"),
		"source memory config\n",
	);
	await fs.writeFile(
		path.join(agentDir, "custom-config", "nested", "config.json"),
		"source directory config\n",
	);
	await fs.writeFile(
		path.join(testHome, ".pi", "web-search.json"),
		"source home config\n",
	);
	await fs.writeFile(
		path.join(agentDir, "extensions", "foo", "node_modules", "bad", "bad.js"),
		"bad\n",
	);
	await fs.writeFile(
		path.join(agentDir, "npm", "pkg", "installed.js"),
		"bad\n",
	);
	await fs.writeFile(
		path.join(agentDir, "git", "pkg", "installed.js"),
		"bad\n",
	);
	await fs.writeFile(path.join(agentDir, "sessions", "session.json"), "bad\n");
	await fs.writeFile(
		path.join(agentDir, ".webdav-sync", "state.json"),
		"bad\n",
	);
	await fs.writeFile(path.join(agentDir, "pi-crash.log"), "bad\n");
	await fs.writeFile(
		path.join(externalDir, "package.json"),
		JSON.stringify({ name: "external" }),
	);
	await fs.writeFile(path.join(externalDir, "src", "index.js"), "external\n");
	await fs.writeFile(
		path.join(externalDir, "node_modules", "bad", "bad.js"),
		"bad\n",
	);
	await fs.writeFile(path.join(externalDir, ".git", "config"), "bad\n");

	await fs.writeFile(
		path.join(agentDir, "settings.json"),
		`${JSON.stringify(
			{
				packages: [
					"npm:pi-web-access",
					"pi-skills",
					{ source: externalDir, extensions: ["x"] },
				],
				skills: [path.join(externalDir, "src")],
				shellPath: "/local/only/shell",
				npmCommand: ["local-node-manager", "npm"],
				sessionDir: "/local/only/sessions",
			},
			null,
			2,
		)}\n`,
	);
}

async function writeTestConfig(agentDir) {
	await fs.writeFile(
		path.join(agentDir, "settings.webdav.json"),
		`${JSON.stringify(
			{
				backend: "webdav",
				remoteBaseUrl: "https://example.invalid/dav/",
				username: "user",
				passwordEnv: "PI_WEBDAV_TEST_PASSWORD",
				remoteDir: "/pi",
				...extraPaths,
			},
			null,
			2,
		)}\n`,
	);
}

async function seedTargetAgent(agentDir) {
	await fs.mkdir(path.join(agentDir, "extensions", "old"), { recursive: true });
	await fs.mkdir(path.join(agentDir, "skills", "old"), { recursive: true });
	await fs.mkdir(path.join(agentDir, "custom-config"), { recursive: true });
	await fs.writeFile(path.join(agentDir, "AGENTS.md"), "old target\n");
	await fs.writeFile(
		path.join(agentDir, "settings.json"),
		`${JSON.stringify({ packages: [] }, null, 2)}\n`,
	);
	await fs.writeFile(
		path.join(agentDir, "extensions", "old", "old.js"),
		"old\n",
	);
	await fs.writeFile(path.join(agentDir, "skills", "old", "old.md"), "old\n");
	await fs.writeFile(
		path.join(agentDir, "hermes-memory-config.json"),
		"old target memory config\n",
	);
	await fs.writeFile(
		path.join(agentDir, "custom-config", "old-only.json"),
		"old directory config\n",
	);
	await fs.mkdir(path.join(testHome, ".pi"), { recursive: true });
	await fs.writeFile(
		path.join(testHome, ".pi", "web-search.json"),
		"old target home config\n",
	);
	await fs.writeFile(path.join(agentDir, "old-only.txt"), "keep\n");
}

function createUncheckedRegularFileZip(files) {
	const manifest = createManifest({
		files: files.map(([filePath, bytes]) => ({
			path: filePath,
			type: "file",
			size: bytes.byteLength,
			sha256: sha256Bytes(bytes),
		})),
		externalResources: [],
		packageSpecs: [],
		warnings: [],
	});
	return zipSync({
		...Object.fromEntries(
			files.map(([filePath, bytes]) => [`files/${filePath}`, bytes]),
		),
		"manifest.json": Buffer.from(
			`${JSON.stringify(manifest, null, 2)}\n`,
			"utf8",
		),
	});
}

function createRegularFileZip(files) {
	const manifest = createManifest({
		files: files.map(([filePath, bytes]) => ({
			path: filePath,
			type: "file",
			size: bytes.byteLength,
			sha256: sha256Bytes(bytes),
		})),
		externalResources: [],
		packageSpecs: [],
		warnings: [],
	});
	const entries = new Map(
		files.map(([filePath, bytes]) => [`files/${filePath}`, bytes]),
	);
	entries.set(
		"manifest.json",
		Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
	);
	return createLatestZip(entries, manifest);
}

async function exists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function trySymlink(target, linkPath, type) {
	try {
		await fs.symlink(target, linkPath, type);
		return true;
	} catch {
		return false;
	}
}
