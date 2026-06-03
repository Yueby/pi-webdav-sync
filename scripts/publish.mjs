#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const registry = "https://registry.npmjs.org/";

if (!existsSync("package.json")) {
	console.error("package.json not found; script root resolution failed");
	process.exit(1);
}

run("npm", ["run", "typecheck"]);
run("npm", ["test"]);
run("npm", [
	"publish",
	"--access",
	"public",
	"--registry",
	registry,
	"--auth-type",
	"web",
]);

function run(command, args) {
	const result = spawnSync(command, args, {
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
