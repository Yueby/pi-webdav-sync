import crypto from "node:crypto";

export type ManifestFileEntry = {
  path: string;
  type: "file";
  size: number;
  sha256: string;
  mode?: number;
};

export type ExternalResourceEntry = {
  id: string;
  originalPathHash: string;
  baseName: string;
  files: ManifestFileEntry[];
};

export type SyncManifest = {
  schemaVersion: 1;
  formatVersion: 1;
  createdAt: string;
  files: ManifestFileEntry[];
  externalResources: ExternalResourceEntry[];
  packageSpecs: string[];
  settingsRewriteVersion: 1;
  warnings: string[];
  contentSha256: string;
};

export type LatestIndex = {
  schemaVersion: 1;
  createdAt: string;
  zipSha256: string;
  contentSha256: string;
  fileCount: number;
  externalResourceCount: number;
  packageSpecs: string[];
};

export function sha256Bytes(bytes: Uint8Array | Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function sha256String(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortJson(record[key]);
        return acc;
      }, {});
  }
  return value;
}

export function createManifest(input: {
  files: ManifestFileEntry[];
  externalResources: ExternalResourceEntry[];
  packageSpecs: string[];
  warnings: string[];
  createdAt?: string;
}): SyncManifest {
  const base = {
    schemaVersion: 1 as const,
    formatVersion: 1 as const,
    createdAt: input.createdAt || new Date().toISOString(),
    files: [...input.files].sort((a, b) => a.path.localeCompare(b.path)),
    externalResources: [...input.externalResources].sort((a, b) => a.id.localeCompare(b.id)),
    packageSpecs: [...new Set(input.packageSpecs)].sort(),
    settingsRewriteVersion: 1 as const,
    warnings: [...input.warnings],
  };
  const contentSha256 = sha256String(
    stableJson({
      files: base.files.map(({ path, type, size, sha256, mode }) => ({ path, type, size, sha256, mode })),
      externalResources: base.externalResources,
      packageSpecs: base.packageSpecs,
      settingsRewriteVersion: base.settingsRewriteVersion,
    }),
  );
  return { ...base, contentSha256 };
}

export function createLatestIndex(manifest: SyncManifest, zipBytes: Uint8Array, createdAt = manifest.createdAt): LatestIndex {
  return {
    schemaVersion: 1,
    createdAt,
    zipSha256: sha256Bytes(zipBytes),
    contentSha256: manifest.contentSha256,
    fileCount: manifest.files.length,
    externalResourceCount: manifest.externalResources.length,
    packageSpecs: manifest.packageSpecs,
  };
}
