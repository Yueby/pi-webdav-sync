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

const EXCLUDED_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "settings.json.webdav"]);

export function getAgentDir(explicit?: string): string {
  const value = explicit || process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.resolve(expandHome(value));
}

export function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

export function normalizeRelativePath(value: string): string {
  const normalized = path.posix.normalize(toPosixPath(value));
  return normalized === "." ? "" : normalized;
}

export function safeRelativePath(value: string): string {
  const raw = toPosixPath(value);
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
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
    safeRelativePath(value);
    return !toPosixPath(value).includes("\\");
  } catch {
    return false;
  }
}

export function pathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
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

export function isAllowlistedRelativePath(relativePath: string): boolean {
  const rel = normalizeRelativePath(relativePath);
  if ((ALLOWLIST_FILES as readonly string[]).includes(rel)) return true;
  return ALLOWLIST_DIRS.some((dir) => rel === dir || rel.startsWith(`${dir}/`));
}

export function resolveMaybeRelativePath(value: string, baseDir: string): string {
  const expanded = expandHome(value);
  if (path.isAbsolute(expanded)) return path.resolve(expanded);
  return path.resolve(baseDir, expanded);
}

export function externalResourceZipRoot(id: string, baseName: string): string {
  return safeRelativePath(path.posix.join("external-resources", id, baseName));
}
