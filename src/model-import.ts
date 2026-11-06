export type ModelChoice = {
	path: string;
	provider: string;
	modelId?: string;
};

export type ModelImportResult = {
	models: Record<string, unknown>;
	auth?: Record<string, unknown>;
	modelCount: number;
	replacedCount: number;
	providers: string[];
};

type JsonObject = Record<string, unknown>;
type Provider = JsonObject & {
	models?: (JsonObject & { id: string })[];
	modelOverrides?: Record<string, JsonObject>;
};
type Models = JsonObject & { providers?: Record<string, Provider> };
const connectionFields = new Set(["baseUrl", "api", "headers", "apiKey", "authHeader", "oauth", "compat"]);
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
const own = (value: object, key: string): boolean => Object.hasOwn(value, key);
const isObject = (value: unknown): value is JsonObject =>
	value !== null && typeof value === "object" && !Array.isArray(value);

function invalid(): never {
	throw new Error("Invalid model import data.");
}

// Accept JSON data only, including null-prototype records, never inherited data.
function validateJson(value: unknown, ancestors = new Set<object>()): void {
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number" && Number.isFinite(value)) return;
	if (typeof value !== "object" || !value || ancestors.has(value)) invalid();
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== (Array.isArray(value) ? Array.prototype : Object.prototype) &&
		!(prototype === null && !Array.isArray(value))) invalid();
	ancestors.add(value);
	for (const key of Object.keys(value)) {
		if (forbiddenKeys.has(key)) invalid();
		const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
		if (!own(descriptor, "value")) invalid();
		validateJson(descriptor.value, ancestors);
	}
	ancestors.delete(value);
}

function readObject(value: unknown): JsonObject {
	if (value === undefined) return {};
	validateJson(value);
	if (!isObject(value)) invalid();
	return value;
}

function validId(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && !forbiddenKeys.has(value);
}

function readModels(value: unknown): Models {
	const root = readObject(value);
	if (!own(root, "providers")) return root;
	if (!isObject(root.providers)) invalid();
	for (const [id, provider] of Object.entries(root.providers)) {
		if (!validId(id) || !isObject(provider)) invalid();
		if (own(provider, "models")) {
			if (!Array.isArray(provider.models)) invalid();
			const ids = new Set<string>();
			for (const model of provider.models) {
				if (!isObject(model) || !validId(model.id) || ids.has(model.id)) invalid();
				ids.add(model.id);
			}
		}
		if (own(provider, "modelOverrides")) {
			if (!isObject(provider.modelOverrides)) invalid();
			for (const [modelId, override] of Object.entries(provider.modelOverrides)) {
				if (!validId(modelId) || !isObject(override)) invalid();
			}
		}
	}
	return root as Models;
}

function metadata(provider: Provider): JsonObject {
	return Object.fromEntries(Object.entries(provider).filter(
		([key]) => key !== "models" && key !== "modelOverrides",
	));
}

// Replace metadata while taking connection fields exclusively from the chosen side.
function withConnection(entry: JsonObject, connection: JsonObject = {}): JsonObject {
	return {
		...Object.fromEntries(Object.entries(entry).filter(([key]) => !connectionFields.has(key))),
		...Object.fromEntries(Object.entries(connection).filter(([key]) => connectionFields.has(key))),
	};
}

function label(index: number, value: string): string {
	return `${index + 1}. ${value.replace(/[\\/\p{Cc}]/gu, "_").trim() || "Unnamed"}`;
}

function choicesFor(root: Models): ModelChoice[] {
	const choices: ModelChoice[] = [];
	Object.entries(root.providers ?? {}).forEach(([provider, config], providerIndex) => {
		const ids = new Set([
			...(config.models ?? []).map((model) => model.id),
			...Object.keys(config.modelOverrides ?? {}),
		]);
		const prefix = `Models/${label(providerIndex, provider)}/`;
		[...ids].forEach((modelId, modelIndex) => choices.push({
			path: prefix + label(modelIndex, modelId), provider, modelId,
		}));
		if (!ids.size && Object.keys(metadata(config)).length) {
			choices.push({ path: prefix + "1. Provider connection only", provider });
		}
	});
	return choices;
}

export function modelImportChoices(incoming: unknown): ModelChoice[] {
	return choicesFor(readModels(incoming));
}

function resolveChoices(root: Models, selected: ModelChoice[]): ModelChoice[] {
	const known = new Map(choicesFor(root).map((choice) => [choice.path, choice]));
	const resolved = new Map<string, ModelChoice>();
	for (const choice of selected) {
		const canonical = known.get(choice?.path);
		if (!canonical) throw new Error("Unknown model import selection.");
		resolved.set(canonical.path, canonical);
	}
	return [...resolved.values()];
}

function equal(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
			a.every((value, index) => equal(value, b[index]));
	}
	if (!isObject(a) || !isObject(b)) return false;
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length &&
		keys.every((key) => own(b, key) && equal(a[key], b[key]));
}

export function modelConnectionConflicts(
	incomingModels: unknown,
	localModels: unknown,
	incomingAuth: unknown,
	localAuth: unknown,
	choices: ModelChoice[],
): Array<{ provider: string; fields: string[] }> {
	const source = readModels(incomingModels);
	const local = readModels(localModels);
	const sourceAuth = readObject(incomingAuth);
	const targetAuth = readObject(localAuth);
	const selected = resolveChoices(source, choices);
	const providers = new Set(selected.map((choice) => choice.provider));
	const conflicts: Array<{ provider: string; fields: string[] }> = [];
	for (const provider of providers) {
		// Built-in providers can have credentials without a models.json entry.
		if (!own(local.providers ?? {}, provider) && !own(targetAuth, provider)) continue;
		const a = metadata(source.providers![provider]);
		const b = metadata(local.providers?.[provider] ?? {});
		const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])]
			.filter((key) => !equal(a[key], b[key])).sort();
		for (const { modelId } of selected.filter((choice) => choice.provider === provider)) {
			if (modelId === undefined) continue;
			const incoming = source.providers![provider];
			const existing = local.providers?.[provider];
			const entries = [
				["models", incoming.models?.find((model) => model.id === modelId),
					existing?.models?.find((model) => model.id === modelId)],
				["modelOverrides", own(incoming.modelOverrides ?? {}, modelId) ? incoming.modelOverrides![modelId] : undefined,
					own(existing?.modelOverrides ?? {}, modelId) ? existing!.modelOverrides![modelId] : undefined],
			] as const;
			for (const [kind, sourceEntry, targetEntry] of entries) {
				for (const key of connectionFields) {
					if (!equal(sourceEntry?.[key], targetEntry?.[key])) fields.push(`${kind}.${modelId}.${key}`);
				}
			}
		}
		if (!equal(
			own(sourceAuth, provider) ? sourceAuth[provider] : undefined,
			own(targetAuth, provider) ? targetAuth[provider] : undefined,
		)) fields.push("auth.json");
		if (fields.length) conflicts.push({ provider, fields });
	}
	return conflicts;
}

export function mergeModelImport(
	incomingModels: unknown,
	localModels: unknown,
	incomingAuth: unknown,
	localAuth: unknown,
	selected: ModelChoice[],
	sourceConnections: Set<string>,
): ModelImportResult {
	const source = readModels(incomingModels);
	const local = readModels(localModels);
	const sourceAuth = readObject(incomingAuth);
	const targetAuth = readObject(localAuth);
	const choices = resolveChoices(source, selected);
	const providers = [...new Set(choices.map((choice) => choice.provider))];
	const mergedProviders = { ...local.providers };
	const auth = { ...targetAuth };
	let modelCount = 0;
	let replacedCount = 0;
	for (const provider of providers) {
		const incoming = source.providers![provider];
		const existing = own(local.providers ?? {}, provider) ? local.providers![provider] : undefined;
		const knownLocally = existing !== undefined || own(targetAuth, provider);
		const useSource = !knownLocally || sourceConnections.has(provider);
		const merged: Provider = metadata(useSource ? incoming : (existing ?? {}));
		const models = [...(existing?.models ?? [])];
		const overrides = { ...existing?.modelOverrides };
		for (const choice of choices.filter((item) => item.provider === provider)) {
			if (choice.modelId === undefined) continue;
			const id = choice.modelId;
			const index = models.findIndex((model) => model.id === id);
			modelCount++;
			if (index !== -1 || own(overrides, id)) replacedCount++;
			const model = incoming.models?.find((item) => item.id === id);
			if (model) {
				const replacement = withConnection(model, useSource ? model : models[index]) as JsonObject & { id: string };
				if (index === -1) models.push(replacement);
				else models[index] = replacement;
			} else if (useSource && index !== -1) {
				// Override-only selections must not retain a target full-model connection.
				models[index] = withConnection(models[index]) as JsonObject & { id: string };
			}
			const incomingOverride = own(incoming.modelOverrides ?? {}, id) ? incoming.modelOverrides![id] : undefined;
			const targetOverride = own(overrides, id) ? overrides[id] : undefined;
			const replacementOverride = withConnection(incomingOverride ?? {}, useSource ? incomingOverride : targetOverride);
			if (incomingOverride || Object.keys(replacementOverride).length) {
				overrides[id] = replacementOverride;
			} else {
				delete overrides[id];
			}
		}
		if (models.length || existing?.models !== undefined) merged.models = models;
		if (Object.keys(overrides).length || existing?.modelOverrides !== undefined) {
			merged.modelOverrides = overrides;
		}
		mergedProviders[provider] = merged;
		if (useSource) {
			if (own(sourceAuth, provider)) auth[provider] = sourceAuth[provider];
			else delete auth[provider];
		}
	}
	const models: JsonObject = { ...local };
	if (providers.length || own(local, "providers")) models.providers = mergedProviders;
	return {
		models,
		...(!equal(auth, targetAuth) ? { auth } : {}),
		modelCount, replacedCount, providers,
	};
}
