import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distUrl = (relativePath) =>
	pathToFileURL(path.join(root, "dist/src", relativePath)).href;
const { collectAgentArchive } = await import(distUrl("collector.js"));
const { createManifest } = await import(distUrl("manifest.js"));
const { isRemotePackageSpec } = await import(distUrl("package-specs.js"));
const { createLatestZip, listZipEntries, parseArchive } = await import(
	distUrl("zip-store.js")
);
const { runWebdavSyncCommand } = await import(distUrl("commands.js"));

class MemoryBackend {
	files = new Map();
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
	async exists(remotePath) {
		return this.files.has(remotePath);
	}
	async list() {
		return [...this.files.keys()]
			.sort()
			.map((file) => ({ path: file, type: "file" }));
	}
}

const tempRoot = await fs.mkdtemp(
	path.join(os.tmpdir(), "pi-webdav-sync-test-"),
);
const sourceAgent = path.join(tempRoot, "source-agent");
const targetAgent = path.join(tempRoot, "target-agent");
const externalDir = path.join(tempRoot, "external package");

try {
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

	const noConfigStatus = await runWebdavSyncCommand(["status", "--json"], {
		agentDir: sourceAgent,
	});
	assert.equal(
		noConfigStatus.ok,
		true,
		"status without config should still succeed",
	);
	assert.equal(
		JSON.parse(noConfigStatus.text).configured,
		false,
		"status should report missing config",
	);

	const init = await runWebdavSyncCommand(
		[
			"init",
			"url=https://example.invalid/dav/",
			"username=user",
			"passwordEnv=PI_WEBDAV_TEST_PASSWORD",
			"remoteDir=/pi",
		],
		{ agentDir: sourceAgent },
	);
	assert.equal(init.ok, true, "init should write config");
	const backend = new MemoryBackend();
	const push = await runWebdavSyncCommand(["push", "--yes", "--json"], {
		agentDir: sourceAgent,
		backend,
	});
	assert.equal(push.ok, true, "push --yes should upload to backend");
	assert.deepEqual(
		[...backend.files.keys()].sort(),
		["latest.json", "latest.zip"],
		"push should upload only latest.json/latest.zip",
	);

	const remoteStatus = await runWebdavSyncCommand(["status", "--json"], {
		agentDir: sourceAgent,
		backend,
	});
	assert.equal(remoteStatus.ok, true, "status with remote should succeed");
	assert.equal(
		JSON.parse(remoteStatus.text).comparison,
		"same",
		"remote and local hashes should match after push",
	);

	await seedTargetAgent(targetAgent);
	await runWebdavSyncCommand(
		[
			"init",
			"url=https://example.invalid/dav/",
			"username=user",
			"passwordEnv=PI_WEBDAV_TEST_PASSWORD",
		],
		{ agentDir: targetAgent },
	);
	const dryPull = await runWebdavSyncCommand(["pull", "--dry-run", "--json"], {
		agentDir: targetAgent,
		backend,
	});
	assert.equal(dryPull.ok, true, "pull --dry-run should succeed");
	assert(
		JSON.parse(dryPull.text).diff.modify.includes("AGENTS.md"),
		"dry-run should report changed AGENTS.md",
	);
	assert(
		JSON.parse(dryPull.text).diff.externalAdd.length > 0,
		"dry-run should report external resource adds",
	);

	const pull = await runWebdavSyncCommand(["pull", "--yes"], {
		agentDir: targetAgent,
		backend,
	});
	assert.equal(pull.ok, true, "pull --yes should apply archive");
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

	const backups = await fs.readdir(
		path.join(targetAgent, ".webdav-sync", "backups"),
	);
	assert.equal(backups.length, 1, "pull should create one local backup");
	const restoreDryRun = await runWebdavSyncCommand(
		["restore", "latest", "--dry-run"],
		{ agentDir: targetAgent },
	);
	assert.equal(restoreDryRun.ok, true, "restore --dry-run should succeed");
	const restore = await runWebdavSyncCommand(["restore", "latest", "--yes"], {
		agentDir: targetAgent,
	});
	assert.equal(restore.ok, true, "restore latest should apply backup");
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

	console.log("self-test passed");
} finally {
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
	await fs.mkdir(path.join(agentDir, "npm", "pkg"), { recursive: true });
	await fs.mkdir(path.join(agentDir, "git", "pkg"), { recursive: true });
	await fs.mkdir(path.join(agentDir, "sessions"), { recursive: true });
	await fs.mkdir(path.join(agentDir, ".webdav-sync", "backups"), {
		recursive: true,
	});
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
	await fs.writeFile(path.join(agentDir, ".webdav-sync", "state.json"), "bad\n");
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
			},
			null,
			2,
		)}\n`,
	);
}

async function seedTargetAgent(agentDir) {
	await fs.mkdir(path.join(agentDir, "extensions", "old"), { recursive: true });
	await fs.mkdir(path.join(agentDir, "skills", "old"), { recursive: true });
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
	await fs.writeFile(path.join(agentDir, "old-only.txt"), "keep\n");
}

async function exists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}
