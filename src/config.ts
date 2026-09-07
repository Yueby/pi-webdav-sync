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

export function configDir(agentDir = getAgentDir()): string {
  return agentDir;
}

export function configPath(agentDir = getAgentDir()): string {
  return path.join(configDir(agentDir), "settings.webdav.json");
}

export function stateDir(agentDir = getAgentDir()): string {
  return path.join(agentDir, ".webdav-sync");
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
