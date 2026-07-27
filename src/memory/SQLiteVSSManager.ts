export type VectorStorageMode = 'sqlite-vss' | 'sqlite' | 'memory';

export interface SemanticVectorRecord {
	id: string;
	filePath: string;
	text: string;
	vector: number[];
	heading: string;
	startLine: number;
	endLine: number;
	wikilinks: string[];
	mtime?: number;
	size?: number;
}

export interface VectorSearchMatch {
	record: SemanticVectorRecord;
	score: number;
}

/** Local SQLite bridge supplied by the desktop runtime; no network API is permitted. */
export interface LocalSQLiteVSSAdapter {
	readonly localOnly: true;
	open(databasePath: string): Promise<void>;
	loadVssExtension(): Promise<void>;
	initializeSchema(): Promise<void>;
	upsert(records: readonly SemanticVectorRecord[]): Promise<void>;
	removeFile(filePath: string): Promise<void>;
	search(vector: readonly number[], limit: number): Promise<VectorSearchMatch[]>;
	close(): Promise<void>;
}

export interface SQLiteVSSManagerOptions {
	/** Vault-relative path under the private Command Center runtime directory. */
	databasePath?: string;
	adapter?: LocalSQLiteVSSAdapter;
}

export interface SQLiteVSSStatus {
	mode: VectorStorageMode;
	open: boolean;
	fallbackReason?: string;
}

const DEFAULT_DATABASE_PATH = '.command-center/semantic-index.sqlite3';

/**
 * Lifecycle boundary for a strictly local vector index. Missing SQLite or VSS
 * support degrades first to plain SQLite and finally to an in-memory index.
 */
export class SQLiteVSSManager {
	private readonly records = new Map<string, SemanticVectorRecord>();
	private mode: VectorStorageMode = 'memory';
	private opened = false;
	private fallbackReason: string | undefined;

	constructor(private readonly options: SQLiteVSSManagerOptions = {}) {
		if (options.adapter && options.adapter.localOnly !== true) throw new Error('SQLite-VSS adapters must declare local-only operation.');
	}

	async open(): Promise<SQLiteVSSStatus> {
		if (this.opened) return this.status;
		const adapter = this.options.adapter;
		if (!adapter) {
			this.opened = true;
			this.fallbackReason = 'No compatible local SQLite adapter is available; using memory.';
			return this.status;
		}
		try {
			await adapter.open(this.validateLocalPath(this.options.databasePath ?? DEFAULT_DATABASE_PATH));
			await adapter.initializeSchema();
			this.mode = 'sqlite';
			try {
				await adapter.loadVssExtension();
				this.mode = 'sqlite-vss';
			} catch (error) {
				this.fallbackReason = `VSS unavailable; using local SQLite: ${this.errorMessage(error)}`;
			}
			this.opened = true;
		} catch (error) {
			this.mode = 'memory';
			this.opened = true;
			this.fallbackReason = `SQLite unavailable; using memory: ${this.errorMessage(error)}`;
			try { await adapter.close(); } catch { /* best-effort cleanup */ }
		}
		return this.status;
	}

	async upsert(records: readonly SemanticVectorRecord[]): Promise<void> {
		this.assertOpen();
		for (const record of records) this.records.set(record.id, this.copyRecord(record));
		if (this.mode !== 'memory') await this.options.adapter?.upsert(records);
	}

	async removeFile(filePath: string): Promise<void> {
		this.assertOpen();
		for (const [id, record] of this.records) if (record.filePath === filePath) this.records.delete(id);
		if (this.mode !== 'memory') await this.options.adapter?.removeFile(filePath);
	}

	async search(vector: readonly number[], limit = 10): Promise<VectorSearchMatch[]> {
		this.assertOpen();
		const boundedLimit = Math.max(0, Math.floor(limit));
		if (!boundedLimit || !vector.length) return [];
		if (this.mode === 'sqlite-vss') return this.options.adapter?.search(vector, boundedLimit) ?? [];
		return [...this.records.values()].map(record => ({ record: this.copyRecord(record), score: cosine(vector, record.vector) }))
			.filter(match => match.score > 0).sort((a, b) => b.score - a.score).slice(0, boundedLimit);
	}

	async close(): Promise<void> {
		if (!this.opened) return;
		if (this.mode !== 'memory') await this.options.adapter?.close();
		this.opened = false;
		this.mode = 'memory';
		this.records.clear();
	}

	get status(): SQLiteVSSStatus {
		return { mode: this.mode, open: this.opened, ...(this.fallbackReason ? { fallbackReason: this.fallbackReason } : {}) };
	}

	private assertOpen(): void { if (!this.opened) throw new Error('SQLiteVSSManager is not open.'); }
	private validateLocalPath(path: string): string {
		const normalized = path.replace(/\\/g, '/');
		if (!normalized.startsWith('.command-center/') || normalized.includes('..') || /^(?:[a-z]+:|\/)/i.test(normalized)) throw new Error('Vector database path must remain under .command-center/.');
		return normalized;
	}
	private copyRecord(record: SemanticVectorRecord): SemanticVectorRecord { return { ...record, vector: [...record.vector], wikilinks: [...record.wikilinks] }; }
	private errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'unknown local adapter error'; }
}

function cosine(left: readonly number[], right: readonly number[]): number {
	if (!left.length || left.length !== right.length) return 0;
	let dot = 0, leftNorm = 0, rightNorm = 0;
	for (let index = 0; index < left.length; index++) {
		const a = left[index] ?? 0, b = right[index] ?? 0;
		dot += a * b; leftNorm += a * a; rightNorm += b * b;
	}
	return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}
