import fs from "node:fs/promises";
import path from "node:path";
import {
  getAgentDir,
  isExcludedRelativePath,
  normalizeConfiguredPath,
  validatePathForCurrentPlatform,
} from "./paths.js";

export type WebdavSyncConfig = {
  backend: "webdav";
  remoteBaseUrl?: string;
  username?: string;
  passwordEnv?: string;
  password?: string;
  remoteDir?: string;
  installMissingPackages?: "ask" | "always" | "never";
  backupRetention?: number;
  snapshotRetention?: number;
  extraFiles?: string[];
  extraDirs?: string[];
};

/** Keys accepted in settings.webdav.json. Unknown keys are rejected, not ignored. */
const CONFIG_KEYS = new Set([
  "backend",
  "remoteBaseUrl",
  "username",
  "passwordEnv",
  "password",
  "remoteDir",
  "installMissingPackages",
  "backupRetention",
  "snapshotRetention",
  "extraFiles",
  "extraDirs",
]);

export function configDir(agentDir = getAgentDir()): string {
  return agentDir;
}

export function configPath(agentDir = getAgentDir()): string {
  return path.join(configDir(agentDir), "settings.webdav.json");
}

export function stateDir(agentDir = getAgentDir()): string {
  return path.join(agentDir, ".webdav-sync");
}

/**
 * Machine-local preferences. They live next to the backups, are never part of a
 * snapshot, and a missing or unreadable file must never break a sync.
 */
export type LocalState = {
  /** Profile the last push, pull, or status worked on. */
  currentProfile?: string;
};

export function statePath(agentDir = getAgentDir()): string {
  return path.join(stateDir(agentDir), "state.json");
}

export async function readLocalState(agentDir = getAgentDir()): Promise<LocalState> {
  try {
    const raw = await fs.readFile(statePath(agentDir), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const value = (parsed as { currentProfile?: unknown }).currentProfile;
    return typeof value === "string" && value.trim() ? { currentProfile: value.trim() } : {};
  } catch {
    // A corrupt or unreadable preferences file is treated as "nothing remembered".
    return {};
  }
}

/** Merges a patch into the local state; `undefined` removes a key. */
export async function writeLocalState(
  patch: LocalState,
  agentDir = getAgentDir(),
): Promise<void> {
  const next: LocalState = { ...(await readLocalState(agentDir)) };
  for (const [key, value] of Object.entries(patch) as Array<[keyof LocalState, string | undefined]>) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  const target = statePath(agentDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  // Write through a temporary file so a crash cannot leave a half-written state.
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await fs.rename(temporary, target);
}

export function defaultConfig(): WebdavSyncConfig {
  return {
    backend: "webdav",
    remoteDir: "/",
    installMissingPackages: "ask",
    backupRetention: 5,
    snapshotRetention: 5,
  };
}

export async function readConfig(agentDir = getAgentDir()): Promise<WebdavSyncConfig | undefined> {
  try {
    const raw = await fs.readFile(configPath(agentDir), "utf8");
    return validateConfig(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeConfig(config: WebdavSyncConfig, agentDir = getAgentDir()): Promise<void> {
  await fs.mkdir(configDir(agentDir), { recursive: true });
  await fs.writeFile(configPath(agentDir), `${JSON.stringify(validateConfig(config), null, 2)}\n`, "utf8");
}

export function validateConfig(value: unknown): WebdavSyncConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("config must be an object");
  }
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).filter(
    (key) => !CONFIG_KEYS.has(key) && !key.startsWith("$"),
  );
  if (unknown.length) {
    throw new Error(
      `Unknown config key(s): ${unknown.join(", ")}. Supported keys: ${[...CONFIG_KEYS].join(", ")}; keys starting with "$" are ignored`,
    );
  }
  const config: WebdavSyncConfig = { ...defaultConfig(), ...(input as Partial<WebdavSyncConfig>) };
  if (config.backend !== "webdav") throw new Error("only webdav backend is supported by config schema");
  for (const key of ["remoteBaseUrl", "username", "passwordEnv", "password", "remoteDir"] as const) {
    if (config[key] !== undefined && typeof config[key] !== "string") throw new Error(`${key} must be a string`);
  }
  if (!["ask", "always", "never"].includes(config.installMissingPackages || "ask")) {
    throw new Error("installMissingPackages must be ask, always, or never");
  }
  if (config.backupRetention !== undefined && (!Number.isInteger(config.backupRetention) || config.backupRetention < 0)) {
    throw new Error("backupRetention must be a non-negative integer");
  }
  if (config.snapshotRetention !== undefined && (!Number.isInteger(config.snapshotRetention) || config.snapshotRetention < 0)) {
    throw new Error("snapshotRetention must be a non-negative integer");
  }
  config.extraFiles = validateConfiguredPaths(input.extraFiles, "extraFiles");
  config.extraDirs = validateConfiguredPaths(input.extraDirs, "extraDirs");
  for (const file of config.extraFiles || []) {
    const fileKey = configuredPathComparisonKey(file);
    for (const dir of config.extraDirs || []) {
      const dirKey = configuredPathComparisonKey(dir);
      if (dirKey === fileKey || dirKey.startsWith(`${fileKey}/`)) {
        throw new Error(`extra file conflicts with extra directory: ${file}, ${dir}`);
      }
    }
  }
  return config;
}

function validateConfiguredPaths(value: unknown, key: "extraFiles" | "extraDirs"): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of strings`);
  const normalized = value.map((item, index) => {
    if (typeof item !== "string") throw new Error(`${key}[${index}] must be a string`);
    let configuredPath: string;
    try {
      configuredPath = normalizeConfiguredPath(item);
    } catch {
      throw new Error(`${key}[${index}] must be agent-relative or start with ~/`);
    }
    try {
      validatePathForCurrentPlatform(configuredPath);
    } catch {
      throw new Error(`${key}[${index}] is not valid on this platform`);
    }
    if (isExcludedRelativePath(configuredPath, key === "extraDirs")) {
      throw new Error(`${key}[${index}] is always excluded from sync`);
    }
    return configuredPath;
  });
  return [...new Set(normalized)];
}

function configuredPathComparisonKey(value: string): string {
  if (process.platform === "darwin") return value.normalize("NFD").toLowerCase();
  return process.platform === "win32" ? value.toLowerCase() : value;
}
