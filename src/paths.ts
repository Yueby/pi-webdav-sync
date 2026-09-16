import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const ALLOWLIST_FILES = [
  "settings.json",
  "auth.json",
  "models.json",
  "AGENTS.md",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
  "keybindings.json",
  "mcp.json",
] as const;

export const ALLOWLIST_DIRS = ["prompts", "skills", "extensions", "themes"] as const;

export type SyncPathOptions = {
  extraFiles?: readonly string[];
  extraDirs?: readonly string[];
};

export type NormalizedSyncPaths = {
  extraFiles: string[];
  extraDirs: string[];
};

const EXCLUDED_DIR_NAMES = new Set([
  "npm",
  "git",
  "node_modules",
  "sessions",
  "cache",
  "logs",
  "webdav-sync",
  ".webdav-sync",
  ".git",
]);

const EXCLUDED_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "settings.webdav.json"]);

export function getAgentDir(explicit?: string): string {
  const value = explicit || process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.resolve(expandHome(value));
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizeRelativePath(value: string): string {
  const normalized = path.posix.normalize(toPosixPath(value));
  return normalized === "." ? "" : normalized;
}

export function safeRelativePath(value: string): string {
  const raw = toPosixPath(value);
  if (!raw || raw.includes("\0") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`Unsafe path: ${value}`);
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    throw new Error(`Unsafe path: ${value}`);
  }
  return normalized;
}

export function isSafeZipPath(value: string): boolean {
  try {
    validatePathForCurrentPlatform(safeRelativePath(value));
    return !toPosixPath(value).includes("\\");
  } catch {
    return false;
  }
}

export function validatePathForCurrentPlatform(value: string): void {
  if (process.platform !== "win32") return;
  for (const part of toPosixPath(value).split("/").filter(Boolean)) {
    if (/[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part)) {
      throw new Error(`Path is not valid on Windows: ${value}`);
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)) {
      throw new Error(`Path is not valid on Windows: ${value}`);
    }
  }
}

export function pathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function pathHasSymlinkAncestor(root: string, target: string): Promise<boolean> {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!pathInside(resolvedRoot, resolvedTarget)) return true;
  const parts = path.relative(resolvedRoot, resolvedTarget).split(path.sep).filter(Boolean);
  let current = resolvedRoot;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return false;
}

export function relativeToAgent(agentDir: string, absolutePath: string): string {
  return toPosixPath(path.relative(agentDir, absolutePath));
}

export function isExcludedRelativePath(relativePath: string, isDirectory = false): boolean {
  const rel = normalizeRelativePath(relativePath);
  if (!rel) return false;
  const parts = rel.split("/").filter(Boolean);
  if (parts.some((part) => EXCLUDED_DIR_NAMES.has(part))) return true;
  const base = parts[parts.length - 1] || "";
  if (!isDirectory && EXCLUDED_FILE_NAMES.has(base)) return true;
  if (!isDirectory && /(^|[.-])log$/i.test(base)) return true;
  if (!isDirectory && /\.log$/i.test(base)) return true;
  if (!isDirectory && /\.(tmp|temp|swp)$/i.test(base)) return true;
  return false;
}

export function normalizeConfiguredPath(value: string): string {
  const raw = toPosixPath(value);
  if (raw === "~") throw new Error(`Unsafe path: ${value}`);
  if (raw.startsWith("~/")) {
    return `~/${safeRelativePath(raw.slice(2))}`;
  }
  if (raw.startsWith("~")) throw new Error(`Unsafe path: ${value}`);
  return safeRelativePath(raw);
}

export function normalizeSyncPaths(options: SyncPathOptions = {}): NormalizedSyncPaths {
  return {
    extraFiles: [...new Set((options.extraFiles || []).map(normalizeConfiguredPath))],
    extraDirs: [...new Set((options.extraDirs || []).map(normalizeConfiguredPath))],
  };
}

export function isAllowlistedRelativePath(
  relativePath: string,
  options: SyncPathOptions = {},
): boolean {
  const rel = normalizeRelativePath(relativePath);
  if ((ALLOWLIST_FILES as readonly string[]).includes(rel)) return true;
  if (ALLOWLIST_DIRS.some((dir) => rel.startsWith(`${dir}/`))) return true;
  const extra = normalizeSyncPaths(options);
  const configured = extra.extraFiles.includes(rel)
    || extra.extraDirs.some((dir) => rel.startsWith(`${dir}/`));
  return configured && !isExcludedRelativePath(rel, false);
}

export function resolveConfiguredPath(value: string, agentDir: string): string {
  const normalized = normalizeConfiguredPath(value);
  if (normalized.startsWith("~/")) {
    return path.resolve(os.homedir(), normalized.slice(2));
  }
  return path.resolve(agentDir, normalized);
}

export function resolveMaybeRelativePath(value: string, baseDir: string): string {
  const expanded = expandHome(value);
  if (path.isAbsolute(expanded)) return path.resolve(expanded);
  return path.resolve(baseDir, expanded);
}

export function externalResourceZipRoot(id: string, baseName: string): string {
  return safeRelativePath(path.posix.join("external-resources", id, baseName));
}
