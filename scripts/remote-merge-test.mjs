import assert from "node:assert/strict";
import { createManifest, sha256Bytes } from "../dist/src/manifest.js";
import { jsonBytes, mergeRemoteArchive } from "../dist/src/import-plan.js";
import { createLatestZip, parseArchive } from "../dist/src/zip-store.js";

export async function runRemoteMergeTests() {
	const options = { extraDirs: ["external-resources"] };
	const oldTime = "2000-01-01T00:00:00.000Z";
	const file = (path, value) => {
		const bytes = Buffer.from(value);
		return { path, type: "file", size: bytes.length, sha256: sha256Bytes(bytes), mode: 0o644 };
	};
	const fixture = (normal = {}, external = [], metadata = {}) => {
		const entries = new Map(Object.entries(normal).map(([path, text]) => [`files/${path}`, Buffer.from(text)]));
		const externalResources = external.map(({ id, values = {}, ...fields }) => {
			for (const [path, text] of Object.entries(values)) entries.set(path, Buffer.from(text));
			return { id, originalPathHash: `hash-${id}`, baseName: id, ...fields,
				files: Object.entries(values).map(([path, text]) => file(path, text)) };
		});
		const manifest = createManifest({ files: Object.entries(normal).map(([path, text]) => file(path, text)),
			externalResources, packageSpecs: ["npm:stale"], warnings: [], createdAt: oldTime, ...metadata });
		entries.set("manifest.json", jsonBytes(manifest));
		const zip = createLatestZip(entries, manifest);
		return parseArchive(zip.zipBytes, zip.latest.zipSha256, options);
	};
	const snapshot = (archive) => ({ manifest: structuredClone(archive.manifest),
		entries: [...archive.entries].map(([path, bytes]) => [path, Buffer.from(bytes)]) });
	const text = (archive, path) => archive.entries.get(path)?.toString("utf8");
	const destination = fixture({
		"models.json": '{"old":true}', "AGENTS.md": "remote rules", "themes/keep.json": "remote theme",
		"settings.json": JSON.stringify({ packages: ["npm:old", "npm:keep"] }),
	}, [
		{ id: "one", values: { "external-resources/one/index.js": "old", "external-resources/one/keep.js": "keep" } },
		{ id: "two", baseName: "untouched", values: { "external-resources/two/main.js": "other" } },
		{ id: "empty", baseName: "empty descriptor" },
	], { warnings: ["remote warning", "shared"] });
	const patch = fixture({
		"models.json": '{"new":true}',
		"settings.json": JSON.stringify({ packages: ["npm:new", { source: "npm:keep" }, "./local-only"] }),
	}, [{ id: "one", baseName: "patched", originalPathHash: "new-hash", values: {
		"external-resources/one/index.js": "new", "external-resources/one/added.js": "added",
	} }], { settingsMode: "raw", warnings: ["shared", "patch warning"] });
	const before = [snapshot(destination), snapshot(patch)];
	const merged = mergeRemoteArchive(destination, patch, options);
	assert.equal(text(merged, "files/models.json"), '{"new":true}');
	assert.equal(text(merged, "files/AGENTS.md"), "remote rules");
	assert.equal(text(merged, "files/themes/keep.json"), "remote theme");
	assert.deepEqual(merged.manifest.packageSpecs, ["npm:keep", "npm:new"]);
	assert.deepEqual(merged.manifest.warnings, ["remote warning", "shared", "patch warning"]);
	assert.equal(text(merged, "external-resources/one/index.js"), "new");
	assert.equal(text(merged, "external-resources/one/keep.js"), "keep");
	assert.equal(text(merged, "external-resources/one/added.js"), "added");
	assert.equal(merged.manifest.externalResources.find((r) => r.id === "one").baseName, "patched");
	assert.equal(merged.manifest.externalResources.find((r) => r.id === "one").originalPathHash, "new-hash");
	for (const id of ["two", "empty"]) assert.deepEqual(merged.manifest.externalResources.find((r) => r.id === id),
		destination.manifest.externalResources.find((r) => r.id === id));
	assert.deepEqual([snapshot(destination), snapshot(patch)], before);
	assert.equal(merged.manifest.settingsMode, "rewrite");
	assert.notEqual(merged.manifest.createdAt, oldTime);
	assert.notEqual(merged.manifest.contentSha256, destination.manifest.contentSha256);
	const repacked = createLatestZip(merged.entries, merged.manifest);
	assert.deepEqual(snapshot(parseArchive(repacked.zipBytes, repacked.latest.zipSha256, options)), snapshot(merged));
	for (const descriptor of [...merged.manifest.files, ...merged.manifest.externalResources.flatMap((r) => r.files)]) {
		const bytes = merged.entries.get(`files/${descriptor.path}`) ?? merged.entries.get(descriptor.path);
		assert.equal(descriptor.sha256, sha256Bytes(bytes));
		assert.equal(descriptor.size, bytes.length);
	}

	const fresh = mergeRemoteArchive(undefined, patch, options);
	assert.deepEqual([...fresh.entries.keys()].sort(), [...patch.entries.keys()].sort());
	assert.equal(fresh.manifest.settingsMode, "rewrite");
	assert.deepEqual(fresh.manifest.packageSpecs, ["npm:keep", "npm:new"]);
	assert.equal(fresh.entries.has("files/AGENTS.md"), false);
	assert.deepEqual(mergeRemoteArchive(undefined, fixture(), options).manifest.packageSpecs, []);
	assert.equal(mergeRemoteArchive(fixture({}, [], { settingsMode: "raw" }), patch, options).manifest.settingsMode, "raw");
	const fileOnly = mergeRemoteArchive(destination, fixture({ "models.json": "{}" }), options);
	assert.deepEqual(fileOnly.manifest.packageSpecs, ["npm:keep", "npm:old"]);
	assert.equal(text(fileOnly, "files/settings.json"), text(destination, "files/settings.json"));

	// A logical file changes representation without retaining the previous ZIP entry.
	const logical = "external-resources/one/index.js";
	const ordinary = fixture({ [logical]: "ordinary" });
	const asOrdinary = mergeRemoteArchive(destination, ordinary, options);
	assert.equal(text(asOrdinary, `files/${logical}`), "ordinary");
	assert.equal(asOrdinary.entries.has(logical), false);
	assert.equal(asOrdinary.manifest.externalResources.find((r) => r.id === "one").files.length, 1);
	const asExternal = mergeRemoteArchive(ordinary, patch, options);
	assert.equal(asExternal.entries.has(`files/${logical}`), false);
	assert.equal(text(asExternal, logical), "new");

	for (const corrupt of [
		(archive) => archive.entries.set("files/prompts/hidden.md", Buffer.from("hidden")),
		(archive) => archive.entries.delete("files/models.json"),
		(archive) => archive.entries.set("files/models.json", Buffer.from("wrong bytes")),
		(archive) => { archive.manifest.warnings.push("entry manifest mismatch"); },
	]) {
		const invalid = fixture({ "models.json": "{}" });
		corrupt(invalid);
		assert.throws(() => mergeRemoteArchive(undefined, invalid, options));
		assert.throws(() => mergeRemoteArchive(invalid, patch, options));
	}
	const duplicate = fixture({ "models.json": "{}" });
	duplicate.manifest.files.push({ ...duplicate.manifest.files[0] });
	duplicate.entries.set("manifest.json", jsonBytes(duplicate.manifest));
	assert.throws(() => mergeRemoteArchive(undefined, duplicate, options), /duplicate logical/);
	const collision = fixture({ [logical]: "old" }, [{ id: "one", values: { [logical]: "old" } }]);
	assert.throws(() => mergeRemoteArchive(undefined, collision, options), /duplicate logical/);
	const parent = fixture({ "extensions/plugin": "file" });
	const child = fixture({ "extensions/plugin/main.js": "child" });
	assert.throws(() => mergeRemoteArchive(parent, child, options), /conflicting logical/);
	assert.throws(() => mergeRemoteArchive(undefined, fixture({}, [{ id: "one" }, { id: "one" }]), options), /duplicate resource/);
	assert.throws(() => mergeRemoteArchive(undefined, fixture({ "settings.json": "[]" }), options), /JSON object/);
	assert.throws(() => mergeRemoteArchive(undefined, ordinary, {}), /not allowlisted/);
	merged.entries.get("files/models.json").fill(0);
	merged.manifest.externalResources[0].baseName = "mutated result";
	assert.deepEqual([snapshot(destination), snapshot(patch)], before);
	console.log("remote merge tests passed");
}
