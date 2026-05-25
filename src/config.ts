import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "./paths.js";

export type WebdavSyncConfig = {
  backend: "webdav";
  remoteBaseUrl?: string;
  username?: string;
  passwordEnv?: string;
  password?: string;
  remoteDir?: string;
  installMissingPackages?: "ask" | "always" | "never";
  backupRetention?: number;
};

export function configDir(agentDir = getAgentDir()): string {
  return path.join(agentDir, "webdav-sync");
}

export function configPath(agentDir = getAgentDir()): string {
  return path.join(configDir(agentDir), "config.json");
}

export function defaultConfig(): WebdavSyncConfig {
  return {
    backend: "webdav",
    remoteDir: "/",
    installMissingPackages: "ask",
    backupRetention: 5,
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
  return config;
}
