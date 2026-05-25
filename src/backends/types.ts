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
	exists(remotePath: string): Promise<boolean>;
	list(remotePath?: string): Promise<RemoteListEntry[]>;
}
