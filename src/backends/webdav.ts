import path from "node:path";
import {
	createClient,
	type FileStat,
	type WebDAVClient,
	type WebDAVClientError,
} from "webdav";
import type { WebdavSyncConfig } from "../config.js";
import { safeRelativePath, toPosixPath } from "../paths.js";
import type { RemoteListEntry, SyncBackend } from "./types.js";

class WebdavBackend implements SyncBackend {
	private readonly client: WebDAVClient;
	private readonly remoteDir: string;

	constructor(config: WebdavSyncConfig) {
		if (!config.remoteBaseUrl)
			throw new Error("config.remoteBaseUrl is required");
		const password = resolvePassword(config);
		this.client = createClient(config.remoteBaseUrl, {
			username: config.username,
			password,
		});
		this.remoteDir = normalizeRemoteDir(config.remoteDir || "/");
	}

	async getJson<T = unknown>(remotePath: string): Promise<T> {
		const bytes = await this.getBytes(remotePath);
		return JSON.parse(Buffer.from(bytes).toString("utf8")) as T;
	}

	async getBytes(remotePath: string): Promise<Uint8Array> {
		const result = await this.client.getFileContents(
			this.fullPath(remotePath),
			{ format: "binary" },
		);
		if (typeof result === "string") return Buffer.from(result, "utf8");
		if (Buffer.isBuffer(result)) return result;
		if (result instanceof ArrayBuffer) return Buffer.from(result);
		throw new Error(`Unexpected WebDAV response for ${remotePath}`);
	}

	async putJson(remotePath: string, data: unknown): Promise<void> {
		await this.putBytes(
			remotePath,
			Buffer.from(`${JSON.stringify(data, null, 2)}\n`, "utf8"),
		);
	}

	async putBytes(remotePath: string, bytes: Uint8Array): Promise<void> {
		await this.ensureRemoteDir();
		await this.ensureRemoteParentDir(remotePath);
		await this.client.putFileContents(
			this.fullPath(remotePath),
			Buffer.from(bytes),
			{ overwrite: true },
		);
	}

	async exists(remotePath: string): Promise<boolean> {
		return this.client.exists(this.fullPath(remotePath));
	}

	async delete(remotePath: string): Promise<void> {
		try {
			await this.client.deleteFile(this.fullPath(remotePath));
		} catch (error) {
			const status = (error as WebDAVClientError).status;
			if (status !== 404) throw error;
		}
	}

	async list(remotePath = "."): Promise<RemoteListEntry[]> {
		const items = await this.client.getDirectoryContents(
			this.fullPath(remotePath),
		);
		return items.map((item: FileStat) => ({
			path: item.filename,
			type: item.type,
			size: item.size,
			lastModified: item.lastmod,
		}));
	}

	async listIfExists(remotePath = "."): Promise<RemoteListEntry[]> {
		const full = this.fullPath(remotePath);
		try {
			if (!(await this.client.exists(full))) return [];
		} catch (error) {
			if (isNotFoundRemoteError(error)) return [];
			throw error;
		}
		try {
			return await this.list(remotePath);
		} catch (error) {
			if (isNotFoundRemoteError(error)) return [];
			throw error;
		}
	}

	async createDirectory(remotePath: string): Promise<boolean> {
		await this.ensureRemoteParentDir(remotePath);
		try {
			await this.client.createDirectory(this.fullPath(remotePath), {
				recursive: false,
			});
			return true;
		} catch (error) {
			if (isAlreadyThereRemoteError(error)) return false;
			throw error;
		}
	}

	async move(remotePath: string, destinationPath: string): Promise<void> {
		await this.ensureRemoteParentDir(destinationPath);
		await this.client.moveFile(
			this.fullPath(remotePath),
			this.fullPath(destinationPath),
			{ overwrite: false },
		);
	}

	private async ensureRemoteDir(): Promise<void> {
		await this.ensureDirectory(this.remoteDir);
	}

	private async ensureRemoteParentDir(remotePath: string): Promise<void> {
		const parent = path.posix.dirname(safeRelativePath(remotePath));
		if (!parent || parent === ".") return;
		await this.ensureDirectory(toPosixPath(path.posix.join(this.remoteDir, parent)));
	}

	private async ensureDirectory(directoryPath: string): Promise<void> {
		if (directoryPath === "/") return;
		try {
			await this.client.createDirectory(directoryPath, { recursive: true });
		} catch (error) {
			const status = (error as WebDAVClientError).status;
			if (status !== 405) throw error;
		}
	}

	private fullPath(remotePath: string): string {
		const rel = remotePath === "." ? "" : safeRelativePath(remotePath);
		if (!rel) return this.remoteDir;
		return toPosixPath(path.posix.join(this.remoteDir, rel));
	}
}

export function createWebdavBackend(config: WebdavSyncConfig): SyncBackend {
	return new WebdavBackend(config);
}

/**
 * Only 404 is a confirmed "collection is not there" answer. Other statuses,
 * including 409, propagate so a conflict is never reported as an empty remote.
 */
function isNotFoundRemoteError(error: unknown): boolean {
	return (error as WebDAVClientError).status === 404;
}

/** 405 (MKCOL on an existing collection) and 409 are the "already there" answers. */
function isAlreadyThereRemoteError(error: unknown): boolean {
	const status = (error as WebDAVClientError).status;
	return status === 405 || status === 409;
}

/**
 * MOVE is optional in WebDAV: 405/501 mean the server does not implement it, and
 * some hosts reject it with 403 while still allowing the PUT fallback.
 */
export function isMoveUnsupportedRemoteError(error: unknown): boolean {
	const status = (error as WebDAVClientError).status;
	return status === 403 || status === 405 || status === 501;
}

function resolvePassword(config: WebdavSyncConfig): string | undefined {
	if (config.passwordEnv) {
		const value = process.env[config.passwordEnv];
		if (!value)
			throw new Error(`Environment variable ${config.passwordEnv} is not set`);
		return value;
	}
	return config.password;
}

function normalizeRemoteDir(value: string): string {
	const normalized = toPosixPath(value || "/");
	if (normalized === "." || normalized === "/") return "/";
	const withoutLeading = normalized.replace(/^\/+/, "");
	return `/${safeRelativePath(withoutLeading)}`;
}
