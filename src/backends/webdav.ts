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

export class WebdavBackend implements SyncBackend {
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
		await this.client.putFileContents(
			this.fullPath(remotePath),
			Buffer.from(bytes),
			{ overwrite: true },
		);
	}

	async exists(remotePath: string): Promise<boolean> {
		return this.client.exists(this.fullPath(remotePath));
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

	private async ensureRemoteDir(): Promise<void> {
		if (this.remoteDir === "/") return;
		try {
			await this.client.createDirectory(this.remoteDir, { recursive: true });
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
