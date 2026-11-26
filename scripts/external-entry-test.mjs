import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectAgentArchive } from "../dist/src/collector.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "webdav-entry-"));
try {
	const agent = path.join(root, "agent");
	const ext = path.join(root, "outside", "asset-ext");
	await fs.mkdir(path.join(ext, "src", "tools"), { recursive: true });
	await fs.mkdir(agent, { recursive: true });
	await fs.writeFile(path.join(ext, "index.ts"), 'import "./src/tools/asset-query.js";\n');
	await fs.writeFile(path.join(ext, "src", "tools", "asset-query.ts"), "export {};\n");
	await fs.writeFile(path.join(agent, "settings.json"), JSON.stringify({ extensions: [path.join(ext, "index.ts")] }));
	const collected = await collectAgentArchive(agent, {});
	const settings = JSON.parse(collected.zipEntries.get("files/settings.json").toString());
	const ref = settings.extensions[0];
	assert.match(ref, /^\.\/external-resources\/[0-9a-f]{16}\/asset-ext\/index\.ts$/);
	const base = ref.slice(2).replace(/\/index\.ts$/, "");
	assert(collected.zipEntries.has(`${base}/index.ts`));
	assert(collected.zipEntries.has(`${base}/src/tools/asset-query.ts`), "siblings travel with the entry file");
	console.log("external-entry-test ok");
} finally {
	await fs.rm(root, { recursive: true, force: true });
}
