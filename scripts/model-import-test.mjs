import assert from "node:assert/strict";

export async function runModelImportTests() {
	const { modelImportChoices, modelConnectionConflicts, mergeModelImport } =
		await import("../dist/src/model-import.js");
	const tests = [];
	const test = (name, run) => tests.push({ name, run });
	const choices = (source, provider, id) => modelImportChoices(source).filter(
		(choice) => choice.provider === provider && (id === undefined || choice.modelId === id),
	);
	const merge = (source, local, selected, sourceProviders = [], sourceAuth, localAuth) =>
		mergeModelImport(source, local, sourceAuth, localAuth, selected, new Set(sourceProviders));
	const rejects = (run) => assert.throws(run, (error) => {
		assert.match(error.message, /^(Invalid model import data|Unknown model import selection)\.$/);
		assert.ok(!error.message.includes("artificial-secret"));
		return true;
	});
	const source = {
		currentProfile: "source-profile",
		providers: {
			alpha: {
				baseUrl: "https://source.invalid", apiKey: "artificial-secret-source",
				models: [
					{ id: "same", name: "Source", baseUrl: "https://per-model.invalid", apiKey: "artificial-secret-per-model" },
					{ id: "both", name: "Both" },
					{ id: "new", name: "New" },
				],
				modelOverrides: {
					both: { contextWindow: 200 },
					"override-only": { maxTokens: 100 },
				},
			},
			beta: { models: [{ id: "same", name: "Other source" }] },
		},
	};
	const local = {
		currentProfile: "local-profile", localMetadata: { preserve: true },
		providers: {
			alpha: {
				baseUrl: "https://local.invalid", apiKey: "artificial-secret-local",
				headers: { "x-local": "keep" }, compat: { legacy: true },
				models: [
					{ id: "same", name: "Local", stale: true },
					{ id: "both", name: "Local both" },
					{ id: "untouched", name: "Keep" },
				],
				modelOverrides: {
					same: { stale: true }, both: { maxTokens: 20, stale: true },
					"override-only": { maxTokens: 10, stale: true }, untouched: { keep: true },
				},
			},
			beta: { models: [{ id: "same", name: "Other local" }] },
		},
	};
	const sourceAuth = { alpha: { key: "artificial-secret-source" }, beta: { key: "unused-source" } };
	const localAuth = { alpha: { key: "artificial-secret-local" }, beta: { key: "keep-beta" } };

	test("choices unite full models and overrides with safe indexed labels", () => {
		const all = modelImportChoices(source);
		assert.equal(all.filter((choice) => choice.provider === "alpha").length, 4);
		assert.equal(all.filter((choice) => choice.modelId === "both").length, 1);
		assert.deepEqual(modelImportChoices(source), all);
		const unsafeLabels = { providers: { "a/b\\c\u0000": {
			models: [{ id: "x/y\\z\u007f", name: "artificial-secret-display-name" }, { id: "x_y_z_" }],
			apiKey: "artificial-secret-key",
		} } };
		const labels = modelImportChoices(unsafeLabels).map((choice) => choice.path);
		assert.equal(new Set(labels).size, 2);
		for (const path of labels) {
			assert.equal(path.split("/").length, 3);
			assert.match(path, /^Models\/1\. /);
			assert.doesNotMatch(path, /[\\\p{Cc}]|artificial-secret/gu);
		}
	});

	test("replace one provider/id, preserve local roots and all unselected content", () => {
		const before = structuredClone({ source, local, sourceAuth, localAuth });
		const result = merge(source, local, choices(source, "alpha", "same"), [], sourceAuth, localAuth);
		const provider = result.models.providers.alpha;
		assert.deepEqual(provider.models[0], { id: "same", name: "Source" });
		assert.equal(provider.models[0].stale, undefined);
		assert.equal(provider.modelOverrides.same, undefined);
		assert.deepEqual(provider.models.slice(1), local.providers.alpha.models.slice(1));
		assert.deepEqual(provider.modelOverrides.untouched, { keep: true });
		assert.deepEqual(result.models.providers.beta, local.providers.beta);
		assert.deepEqual(result.models.localMetadata, local.localMetadata);
		assert.equal(result.models.currentProfile, "local-profile");
		assert.equal(provider.apiKey, "artificial-secret-local");
		assert.equal(provider.models[0].baseUrl, undefined);
		assert.equal(provider.models[0].apiKey, undefined);
		assert.equal(provider.baseUrl, "https://local.invalid");
		assert.equal(result.modelCount, 1);
		assert.equal(result.replacedCount, 1);
		assert.deepEqual(result.providers, ["alpha"]);
		assert.ok(!Object.hasOwn(result, "auth"));
		assert.deepEqual({ source, local, sourceAuth, localAuth }, before);
	});

	test("full and override entries replace whole selected entries", () => {
		const result = merge(source, local, choices(source, "alpha", "both"));
		assert.deepEqual(result.models.providers.alpha.models[1], source.providers.alpha.models[1]);
		assert.deepEqual(result.models.providers.alpha.modelOverrides.both, { contextWindow: 200 });
		assert.deepEqual(result.models.providers.alpha.modelOverrides.same, { stale: true });
	});

	test("override-only import preserves full local model list", () => {
		const result = merge(source, local, choices(source, "alpha", "override-only"));
		assert.deepEqual(result.models.providers.alpha.models, local.providers.alpha.models);
		assert.deepEqual(result.models.providers.alpha.modelOverrides["override-only"], { maxTokens: 100 });
		assert.equal(result.replacedCount, 1);
	});

	test("new full model counts as added, not replaced", () => {
		const result = merge(source, local, choices(source, "alpha", "new"));
		assert.deepEqual(result.models.providers.alpha.models.at(-1), source.providers.alpha.models[2]);
		assert.equal(result.modelCount, 1);
		assert.equal(result.replacedCount, 0);
	});

	test("source policy replaces provider metadata and only that provider's auth", () => {
		const result = merge(source, local, choices(source, "alpha", "same"), ["alpha"], sourceAuth, localAuth);
		assert.equal(result.models.providers.alpha.baseUrl, "https://source.invalid");
		assert.equal(result.models.providers.alpha.headers, undefined);
		assert.equal(result.models.providers.alpha.compat, undefined);
		assert.deepEqual(result.models.providers.alpha.models.slice(1), local.providers.alpha.models.slice(1));
		assert.deepEqual(result.models.providers.alpha.modelOverrides.untouched, { keep: true });
		assert.deepEqual(result.auth, { alpha: sourceAuth.alpha, beta: localAuth.beta });
		assert.equal(result.models.currentProfile, "local-profile");
	});

	test("mixed selected providers apply connection and auth policies independently", () => {
		const selected = [...choices(source, "alpha", "same"), ...choices(source, "beta", "same")];
		const result = merge(source, local, selected, ["alpha"], sourceAuth, localAuth);
		assert.equal(result.modelCount, 2);
		assert.equal(result.replacedCount, 2);
		assert.deepEqual(result.providers, ["alpha", "beta"]);
		assert.deepEqual(result.models.providers.beta.models, source.providers.beta.models);
		assert.deepEqual(result.auth, { alpha: sourceAuth.alpha, beta: localAuth.beta });
	});

	test("source policy removes absent source auth, preserving unrelated credentials", () => {
		const result = merge(source, local, choices(source, "alpha", "same"), ["alpha"], undefined, localAuth);
		assert.deepEqual(result.auth, { beta: localAuth.beta });
		assert.equal(result.models.providers.alpha.apiKey, "artificial-secret-source");
	});

	test("new providers receive only selected models, overrides, and credentials", () => {
		const result = merge(source, { currentProfile: "local-profile" }, choices(source, "alpha", "both"), [], sourceAuth, { beta: localAuth.beta });
		assert.deepEqual(result.models.providers.alpha.models, [source.providers.alpha.models[1]]);
		assert.deepEqual(result.models.providers.alpha.modelOverrides, { both: { contextWindow: 200 } });
		assert.equal(result.models.providers.alpha.apiKey, "artificial-secret-source");
		assert.deepEqual(result.auth, { alpha: sourceAuth.alpha, beta: localAuth.beta });
		assert.equal(result.models.currentProfile, "local-profile");
		const onlyOverride = merge(source, undefined, choices(source, "alpha", "override-only"));
		assert.equal(onlyOverride.models.providers.alpha.models, undefined);
		assert.deepEqual(onlyOverride.models.providers.alpha.modelOverrides, { "override-only": { maxTokens: 100 } });
	});

	test("provider connection-only choices support keep and source policy", () => {
		const incoming = { providers: { empty: { baseUrl: "https://new.invalid", apiKey: "artificial-secret-empty" }, ignored: {} } };
		const selected = modelImportChoices(incoming);
		assert.equal(selected.length, 1);
		assert.equal(selected[0].modelId, undefined);
		assert.match(selected[0].path, /Provider connection only$/);
		const fresh = merge(incoming, undefined, selected, [], { empty: { token: "artificial-secret-token" } });
		assert.deepEqual(fresh.models.providers.empty, incoming.providers.empty);
		assert.equal(fresh.modelCount, 0);
		assert.equal(fresh.replacedCount, 0);
		assert.deepEqual(fresh.auth, { empty: { token: "artificial-secret-token" } });
		const existing = { providers: { empty: { baseUrl: "https://old.invalid" } } };
		assert.deepEqual(merge(incoming, existing, selected).models, existing);
		assert.deepEqual(merge(incoming, existing, selected, ["empty"]).models, { providers: { empty: incoming.providers.empty } });
	});

	test("no selected auth writes, including equal reordered source auth", () => {
		const selected = choices(source, "alpha", "new");
		assert.ok(!Object.hasOwn(merge(source, local, selected, ["beta"], sourceAuth, localAuth), "auth"));
		const a = { alpha: { token: "artificial-secret", nested: { a: 1, b: 2 } } };
		const b = { alpha: { nested: { b: 2, a: 1 }, token: "artificial-secret" } };
		assert.ok(!Object.hasOwn(merge(source, local, selected, ["alpha"], a, b), "auth"));
		assert.ok(!Object.hasOwn(merge(source, local, selected, ["alpha"]), "auth"));
	});

	test("empty selection is pure; cancellation remains a caller decision", () => {
		const result = merge(source, local, [], ["alpha"], sourceAuth, localAuth);
		assert.deepEqual(result, { models: local, modelCount: 0, replacedCount: 0, providers: [] });
		assert.deepEqual(merge(undefined, undefined, []), { models: {}, modelCount: 0, replacedCount: 0, providers: [] });
		assert.deepEqual(modelImportChoices(undefined), []);
	});

	test("conflicts compare metadata/auth without disclosing values", () => {
		const result = modelConnectionConflicts(source, local, sourceAuth, localAuth, choices(source, "alpha", "same"));
		assert.deepEqual(result, [{ provider: "alpha", fields: [
			"apiKey", "baseUrl", "compat", "headers", "models.same.baseUrl", "models.same.apiKey", "auth.json",
		] }]);
		assert.ok(!JSON.stringify(result).includes("artificial-secret"));
		assert.deepEqual(modelConnectionConflicts(source, undefined, sourceAuth, undefined, modelImportChoices(source)), []);
		assert.deepEqual(modelConnectionConflicts(source, local, sourceAuth, localAuth, []), []);
	});

	test("built-in provider credentials are treated as an existing connection", () => {
		const selected = choices(source, "alpha", "same");
		const conflicts = modelConnectionConflicts(source, undefined, sourceAuth, localAuth, selected);
		assert.equal(conflicts.length, 1);
		assert.equal(conflicts[0].provider, "alpha");
		assert(conflicts[0].fields.includes("auth.json"));
		const kept = merge(source, undefined, selected, [], sourceAuth, localAuth);
		assert.equal(kept.models.providers.alpha.apiKey, undefined);
		assert.equal(kept.models.providers.alpha.models[0].apiKey, undefined);
		assert.equal(kept.models.providers.alpha.models[0].baseUrl, undefined);
		assert.equal(kept.auth, undefined);
		const replaced = merge(source, undefined, selected, ["alpha"], sourceAuth, localAuth);
		assert.equal(replaced.models.providers.alpha.apiKey, "artificial-secret-source");
		assert.equal(replaced.auth.alpha.key, "artificial-secret-source");
	});

	test("conflicts ignore object order and nonconnection model/override differences", () => {
		const a = { providers: { p: { headers: { a: "A", b: "B" }, compat: { nested: [{ x: 1, y: 2 }] }, models: [{ id: "id" }] } } };
		const b = { providers: { p: { compat: { nested: [{ y: 2, x: 1 }] }, headers: { b: "B", a: "A" }, modelOverrides: { other: {} } } } };
		assert.deepEqual(modelConnectionConflicts(a, b, { p: { a: 1, b: 2 } }, { p: { b: 2, a: 1 } }, modelImportChoices(a)), []);
		assert.deepEqual(modelConnectionConflicts(a, b, { p: null }, {}, modelImportChoices(a)), [{ provider: "p", fields: ["auth.json"] }]);
		b.providers.p.compat.nested.reverse();
		b.providers.p.compat.nested[0].x = 3;
		assert.deepEqual(modelConnectionConflicts(a, b, undefined, undefined, modelImportChoices(a)), [{ provider: "p", fields: ["compat"] }]);
	});

	test("connection fields follow policy at model and override layers", () => {
		const sourceConnection = {
			baseUrl: "https://source-model.invalid", api: "source-api", headers: { "x-key": "artificial-secret-source" },
			apiKey: "artificial-secret-source", authHeader: false,
			oauth: { token: "artificial-secret-source" }, compat: { source: true },
		};
		const targetConnection = {
			baseUrl: "https://target-model.invalid", api: "target-api", headers: { "x-key": "artificial-secret-target" },
			apiKey: "artificial-secret-target", authHeader: true,
			oauth: { token: "artificial-secret-target" }, compat: { target: true },
		};
		const incoming = { providers: { p: {
			baseUrl: "https://source.invalid", apiKey: "artificial-secret-provider-source",
			models: [{ id: "id", name: "Imported", ...sourceConnection }],
			modelOverrides: { id: { maxTokens: 200, ...sourceConnection } },
		} } };
		const target = { providers: { p: {
			baseUrl: "https://target.invalid", apiKey: "artificial-secret-provider-target",
			models: [{ id: "id", name: "Old", stale: true, ...targetConnection }, { id: "keep", ...targetConnection }],
			modelOverrides: { id: { maxTokens: 20, stale: true, ...targetConnection }, keep: { ...targetConnection } },
		} } };
		const before = structuredClone({ incoming, target });
		const selected = modelImportChoices(incoming);
		for (const useSource of [false, true]) {
			const result = merge(incoming, target, selected, useSource ? ["p"] : []).models.providers.p;
			const connection = useSource ? sourceConnection : targetConnection;
			assert.deepEqual(result.models[0], { id: "id", name: "Imported", ...connection });
			assert.deepEqual(result.modelOverrides.id, { maxTokens: 200, ...connection });
			assert.deepEqual(result.models[1], target.providers.p.models[1]);
			assert.deepEqual(result.modelOverrides.keep, target.providers.p.modelOverrides.keep);
		}
		assert.deepEqual({ incoming, target }, before);
		delete incoming.providers.p.modelOverrides;
		const kept = merge(incoming, target, selected).models.providers.p;
		assert.deepEqual(kept.modelOverrides.id, targetConnection);
		const copied = merge(incoming, target, selected, ["p"]).models.providers.p;
		assert.equal(copied.modelOverrides.id, undefined);
		assert.deepEqual(target, before.target);
		assert.deepEqual(incoming.providers.p.models, before.incoming.providers.p.models);
		for (const key of Object.keys(sourceConnection)) delete incoming.providers.p.models[0][key];
		const inherited = merge(incoming, target, selected, ["p"]).models.providers.p;
		assert.deepEqual(inherited.models[0], { id: "id", name: "Imported" });
		assert.equal(inherited.modelOverrides.id, undefined);
	});

	test("new selected models inherit the target provider without source connection overrides", () => {
		const incoming = { providers: { p: {
			baseUrl: "https://source.invalid",
			models: [{ id: "new", name: "Imported", baseUrl: "https://source-model.invalid", apiKey: "artificial-secret-source" }],
			modelOverrides: { new: { maxTokens: 200, baseUrl: "https://source-override.invalid", headers: { key: "artificial-secret" } } },
		} } };
		const target = { providers: { p: { baseUrl: "https://target.invalid", apiKey: "artificial-secret-target" } } };
		const targetAuth = { p: { key: "artificial-secret-target-auth" } };
		const result = merge(incoming, target, modelImportChoices(incoming), [], undefined, targetAuth);
		assert.deepEqual(result.models.providers.p, {
			...target.providers.p, models: [{ id: "new", name: "Imported" }], modelOverrides: { new: { maxTokens: 200 } },
		});
		assert.equal(result.auth, undefined);
		assert.doesNotMatch(JSON.stringify(result), /source(?:-model|-override)?\.invalid|artificial-secret-source/);
		const fresh = merge(incoming, undefined, modelImportChoices(incoming));
		assert.deepEqual(fresh.models.providers.p, incoming.providers.p);
	});

	test("override-only selections govern existing full model and override connections", () => {
		const incoming = { providers: { p: {
			baseUrl: "https://source.invalid",
			modelOverrides: { id: { maxTokens: 200, baseUrl: "https://source-override.invalid", api: "source-api" } },
		} } };
		const target = { providers: { p: {
			baseUrl: "https://target.invalid", apiKey: "artificial-secret-provider-target",
			models: [{ id: "id", name: "Keep full model", baseUrl: "https://target-model.invalid", apiKey: "artificial-secret-model-target", headers: { key: "artificial-secret" }, authHeader: true, oauth: { token: "artificial-secret" }, api: "target-api", compat: { target: true } }],
			modelOverrides: { id: { stale: true, maxTokens: 20, baseUrl: "https://target-override.invalid", apiKey: "artificial-secret-override-target" } },
		} } };
		const before = structuredClone({ incoming, target });
		const selected = modelImportChoices(incoming);
		const kept = merge(incoming, target, selected).models.providers.p;
		assert.deepEqual(kept.models, target.providers.p.models);
		assert.deepEqual(kept.modelOverrides.id, {
			maxTokens: 200, baseUrl: "https://target-override.invalid", apiKey: "artificial-secret-override-target",
		});
		const copied = merge(incoming, target, selected, ["p"]).models.providers.p;
		assert.deepEqual(copied.models, [{ id: "id", name: "Keep full model" }]);
		assert.deepEqual(copied.modelOverrides, incoming.providers.p.modelOverrides);
		assert.equal(copied.apiKey, undefined);
		assert.deepEqual({ incoming, target }, before);
		const newOverride = merge(incoming, { providers: { p: {
			baseUrl: "https://target.invalid", apiKey: "artificial-secret-provider-target",
		} } }, selected).models.providers.p;
		assert.equal(newOverride.models, undefined);
		assert.deepEqual(newOverride.modelOverrides.id, { maxTokens: 200 });
		delete incoming.providers.p.modelOverrides.id.baseUrl;
		delete incoming.providers.p.modelOverrides.id.api;
		const inherited = merge(incoming, target, selected, ["p"]).models.providers.p;
		assert.deepEqual(inherited.models, [{ id: "id", name: "Keep full model" }]);
		assert.deepEqual(inherited.modelOverrides.id, { maxTokens: 200 });
		assert.equal(inherited.baseUrl, "https://source.invalid");
		assert.deepEqual(target, before.target);
	});

	test("selected model and override connection differences conflict with equal provider metadata", () => {
		for (const kind of ["models", "modelOverrides"]) {
			const incoming = { providers: { p: {
				baseUrl: "https://provider.invalid",
				[kind]: kind === "models" ? [{ id: "id", baseUrl: "https://source.invalid" }] : { id: { baseUrl: "https://source.invalid" } },
			} } };
			const target = structuredClone(incoming);
			const entry = kind === "models" ? target.providers.p.models[0] : target.providers.p.modelOverrides.id;
			entry.baseUrl = "https://target.invalid";
			entry.apiKey = "artificial-secret-target";
			const conflict = modelConnectionConflicts(incoming, target, undefined, undefined, modelImportChoices(incoming));
			assert.deepEqual(conflict, [{ provider: "p", fields: [`${kind}.id.baseUrl`, `${kind}.id.apiKey`] }]);
			assert.doesNotMatch(JSON.stringify(conflict), /https:|artificial-secret/);
			assert.deepEqual(modelConnectionConflicts(incoming, incoming, undefined, undefined, modelImportChoices(incoming)), []);
			assert.deepEqual(modelConnectionConflicts(incoming, target, undefined, undefined, []), []);
		}
	});

	test("selection paths are canonical, duplicate selections count once", () => {
		const canonical = choices(source, "alpha", "same")[0];
		const forged = { ...canonical, provider: "beta", modelId: "new" };
		const result = merge(source, local, [forged, canonical]);
		assert.equal(result.modelCount, 1);
		assert.deepEqual(result.providers, ["alpha"]);
		assert.deepEqual(result.models.providers.beta, local.providers.beta);
		rejects(() => merge(source, local, [{ ...canonical, path: "Models/unknown" }]));
		rejects(() => modelConnectionConflicts(source, local, undefined, undefined, [{ path: "unknown", provider: "alpha" }]));
	});

	test("malformed model data and duplicate IDs fail for source and local", () => {
		const malformed = [
			null, [], "artificial-secret", { providers: null }, { providers: [] },
			{ providers: { p: null } }, { providers: { " ": {} } },
			{ providers: { p: { models: {} } } }, { providers: { p: { models: [null] } } },
			{ providers: { p: { models: [{ id: "" }] } } },
			{ providers: { p: { models: [{ id: " " }] } } },
			{ providers: { p: { models: [{ id: 1 }] } } },
			{ providers: { p: { models: [{ id: "same" }, { id: "same" }] } } },
			{ providers: { p: { modelOverrides: [] } } },
			{ providers: { p: { modelOverrides: { id: null } } } },
			{ providers: { p: { modelOverrides: { id: [] } } } },
			{ providers: { p: { modelOverrides: { "": {} } } } },
		];
		for (const value of malformed) {
			rejects(() => modelImportChoices(value));
			rejects(() => merge(value, undefined, []));
			rejects(() => merge(undefined, value, []));
			rejects(() => modelConnectionConflicts(undefined, value, undefined, undefined, []));
		}
		for (const auth of [null, [], "artificial-secret"]) {
			rejects(() => mergeModelImport(undefined, undefined, auth, undefined, [], new Set()));
			rejects(() => mergeModelImport(undefined, undefined, undefined, auth, [], new Set()));
		}
	});

	test("prototype keys are rejected recursively without pollution", () => {
		for (const key of ["__proto__", "constructor", "prototype"]) {
			const values = [
				JSON.parse(`{"providers":{"${key}":{}}}`),
				JSON.parse(`{"providers":{"p":{"modelOverrides":{"${key}":{}}}}}`),
				JSON.parse(`{"providers":{"p":{"models":[{"id":"ok","nested":{"${key}":{"polluted":true}}}]}}}`),
				{ providers: { p: { models: [{ id: key }] } } },
			];
			for (const value of values) {
				rejects(() => modelImportChoices(value));
				rejects(() => merge(undefined, value, []));
			}
			const hostileAuth = JSON.parse(`{"p":{"nested":[{"${key}":true}]}}`);
			rejects(() => mergeModelImport(undefined, undefined, hostileAuth, undefined, [], new Set()));
			rejects(() => modelConnectionConflicts(undefined, undefined, undefined, hostileAuth, []));
		}
		assert.equal({}.polluted, undefined);
		rejects(() => modelImportChoices(Object.create({ providers: source.providers })));
		rejects(() => modelImportChoices({ providers: { p: Object.create({ models: [{ id: "inherited" }] }) } }));
	});

	test("ordinary inherited built-in names are never treated as local entries", () => {
		const incoming = { providers: { toString: { models: [{ id: "valueOf" }], apiKey: "artificial-secret" } } };
		const result = merge(incoming, { providers: {} }, modelImportChoices(incoming), [], { toString: { token: "artificial-secret" } }, {});
		assert.equal(result.models.providers.toString.apiKey, "artificial-secret");
		assert.deepEqual(result.auth, { toString: { token: "artificial-secret" } });
		assert.deepEqual(modelConnectionConflicts(incoming, { providers: {} }, {}, {}, modelImportChoices(incoming)), []);
	});

	for (const { name, run } of tests) {
		try { run(); } catch (error) {
			throw new Error(`Model import test failed: ${name}`, { cause: error });
		}
	}
	return tests.length;
}
