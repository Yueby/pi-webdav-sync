import type { RemoteListEntry, SyncBackend } from "./types.js";

/**
 * Prefixes every remote path with a profile directory, so push, pull, status,
 * and snapshot pruning run unchanged against one profile and no operation can
 * reach a sibling profile.
 */
class ScopedBackend implements SyncBackend {
	private readonly backend: SyncBackend;
	private readonly prefix: string;

	constructor(backend: SyncBackend, prefix = "") {
		assertScopedPath(prefix, "profile prefix");
		this.backend = backend;
		this.prefix = prefix;
	}

	async getJson<T = unknown>(remotePath: string): Promise<T> {
		return await this.backend.getJson<T>(this.scoped(remotePath));
	}

	async getBytes(remotePath: string): Promise<Uint8Array> {
		return await this.backend.getBytes(this.scoped(remotePath));
	}

	async putJson(remotePath: string, data: unknown): Promise<void> {
		await this.backend.putJson(this.scoped(remotePath), data);
	}

	async putBytes(remotePath: string, bytes: Uint8Array): Promise<void> {
		await this.backend.putBytes(this.scoped(remotePath), bytes);
	}

	async delete(remotePath: string): Promise<void> {
		await this.backend.delete(this.scoped(remotePath));
	}

	async exists(remotePath: string): Promise<boolean> {
		return await this.backend.exists(this.scoped(remotePath));
	}

	async list(remotePath = "."): Promise<RemoteListEntry[]> {
		return await this.backend.list(this.scoped(remotePath));
	}

	async listIfExists(remotePath = "."): Promise<RemoteListEntry[]> {
		return await this.backend.listIfExists(this.scoped(remotePath));
	}

	async createDirectory(remotePath: string): Promise<boolean> {
		return await this.backend.createDirectory(this.scoped(remotePath));
	}

	async move(remotePath: string, destinationPath: string): Promise<void> {
		await this.backend.move(
			this.scoped(remotePath),
			this.scoped(destinationPath),
		);
	}

	private scoped(remotePath: string): string {
		assertScopedPath(remotePath, "remote path");
		if (!this.prefix) return remotePath;
		if (remotePath === "." || remotePath === "") return this.prefix;
		return `${this.prefix}/${remotePath}`;
	}
}

/**
 * Rejects anything a server could normalize outside the scoped prefix (".."
 * segments, absolute paths, backslashes), so the boundary holds even if a caller
 * passes an unvalidated path.
 */
function assertScopedPath(value: string, label: string): void {
	if (value === "" || value === ".") return;
	if (value.includes("\0") || value.includes("\\") || value.startsWith("/"))
		throw new Error(`Unsafe scoped ${label}: ${value}`);
	if (value.split("/").includes(".."))
		throw new Error(`Unsafe scoped ${label}: ${value}`);
}

/** Returns the backend unchanged for the root-backed default profile. */
export function scopedBackend(backend: SyncBackend, prefix = ""): SyncBackend {
	return prefix ? new ScopedBackend(backend, prefix) : backend;
}
