export type RemoteListEntry = {
	path: string;
	type: "file" | "directory";
	size?: number;
	lastModified?: string;
};

export interface SyncBackend {
	getJson<T = unknown>(remotePath: string): Promise<T>;
	getBytes(remotePath: string): Promise<Uint8Array>;
	putJson(remotePath: string, data: unknown): Promise<void>;
	putBytes(remotePath: string, bytes: Uint8Array): Promise<void>;
	delete(remotePath: string): Promise<void>;
	exists(remotePath: string): Promise<boolean>;
	list(remotePath?: string): Promise<RemoteListEntry[]>;
	/** Like list(), but a missing collection yields an empty list instead of an error. */
	listIfExists(remotePath?: string): Promise<RemoteListEntry[]>;
	/**
	 * Creates a single collection and reports whether this call created it. False
	 * means it already existed, which makes the call an atomic claim for a name.
	 */
	createDirectory(remotePath: string): Promise<boolean>;
	/** Renames a remote resource; must fail instead of overwriting the target. */
	move(remotePath: string, destinationPath: string): Promise<void>;
}
