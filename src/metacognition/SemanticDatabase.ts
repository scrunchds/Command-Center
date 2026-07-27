import { normalizePath } from 'obsidian';

export const SEMANTIC_DATABASE_PATH = '.obsidian/plugins/command-center/data/semantic-memory.sqlite3';

export interface SQLiteStatement { run(...parameters: unknown[]): Promise<void>; all<T>(...parameters: unknown[]): Promise<T[]>; }
export interface SQLiteConnection { exec(sql: string): Promise<void>; prepare(sql: string): SQLiteStatement; close(): Promise<void>; }
export interface SQLiteDriver { open(path: string): Promise<SQLiteConnection>; loadExtension(connection: SQLiteConnection, extension: string): Promise<void>; }
export interface SemanticChunkRecord { id: string; documentPath: string; heading: string; content: string; vector: number[]; tags: string[]; aliases: string[]; wikilinks: string[]; startLine: number; endLine: number; }
export interface SemanticMatch extends SemanticChunkRecord { distance: number; }

/** Local SQLite-VSS repository. A desktop-native driver is injected to avoid bundling an unsafe native binary. */
export class SemanticDatabase {
	private connection: SQLiteConnection | null = null;
	private readonly memory = new Map<string, SemanticChunkRecord>();
	private opened = false;
	constructor(private readonly driver: SQLiteDriver | undefined, private readonly dimensions: number, private readonly path = SEMANTIC_DATABASE_PATH, private readonly vssExtension = 'vss0') {
		if (!Number.isInteger(dimensions) || dimensions < 1) throw new Error('Embedding dimensions must be a positive integer.');
	}

	async open(): Promise<void> {
		if (this.opened) return;
		if (!this.driver) { this.opened = true; return; }
		const connection = await this.driver.open(normalizePath(this.path));
		try {
			await this.driver.loadExtension(connection, this.vssExtension);
			await connection.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS documents (path TEXT PRIMARY KEY, tags_json TEXT NOT NULL, aliases_json TEXT NOT NULL, indexed_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS chunks (rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, document_path TEXT NOT NULL REFERENCES documents(path) ON DELETE CASCADE, heading TEXT NOT NULL, content TEXT NOT NULL, wikilinks_json TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vss0(embedding(${this.dimensions}));
CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_path);
`);
			this.connection = connection;
			this.opened = true;
		} catch (error) { await connection.close(); throw error; }
	}

	async replaceDocument(path: string, tags: readonly string[], aliases: readonly string[], records: readonly SemanticChunkRecord[]): Promise<void> {
		if (!this.opened) throw new Error('Semantic database is not open.');
		if (!this.connection) {
			for (const [id, record] of this.memory) if (record.documentPath === path) this.memory.delete(id);
			for (const record of records) this.memory.set(record.id, { ...record, vector: [...record.vector], tags: [...record.tags], aliases: [...record.aliases], wikilinks: [...record.wikilinks] });
			return;
		}
		const db = this.connection;
		await db.exec('BEGIN IMMEDIATE;');
		try {
			await db.prepare('DELETE FROM chunk_vectors WHERE rowid IN (SELECT rowid FROM chunks WHERE document_path = ?)').run(path);
			await db.prepare('DELETE FROM chunks WHERE document_path = ?').run(path);
			await db.prepare('INSERT INTO documents(path,tags_json,aliases_json,indexed_at) VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET tags_json=excluded.tags_json, aliases_json=excluded.aliases_json, indexed_at=excluded.indexed_at').run(path, JSON.stringify(tags), JSON.stringify(aliases), Date.now());
			for (const record of records) {
				await db.prepare('INSERT INTO chunks(id,document_path,heading,content,wikilinks_json,start_line,end_line) VALUES(?,?,?,?,?,?,?)').run(record.id, path, record.heading, record.content, JSON.stringify(record.wikilinks), record.startLine, record.endLine);
				const rows = await db.prepare('SELECT rowid FROM chunks WHERE id = ?').all<{ rowid: number }>(record.id);
				const rowid = rows[0]?.rowid;
				if (rowid === undefined) throw new Error('SQLite failed to return the inserted chunk.');
				await db.prepare('INSERT INTO chunk_vectors(rowid, embedding) VALUES(?, ?)').run(rowid, JSON.stringify(record.vector));
			}
			await db.exec('COMMIT;');
		} catch (error) { await db.exec('ROLLBACK;'); throw error; }
	}

	async search(vector: readonly number[], limit = 10): Promise<SemanticMatch[]> {
		if (vector.length !== this.dimensions) throw new Error('Embedding dimension mismatch.');
		if (!this.opened) throw new Error('Semantic database is not open.');
		if (!this.connection) return [...this.memory.values()].map(record => ({ ...record, vector: [], distance: 1 - this.cosine(vector, record.vector) })).sort((a, b) => a.distance - b.distance).slice(0, Math.max(1, Math.floor(limit)));
		const rows = await this.connection.prepare(`SELECT c.id,c.document_path,c.heading,c.content,c.wikilinks_json,c.start_line,c.end_line,d.tags_json,d.aliases_json,v.distance FROM chunk_vectors v JOIN chunks c ON c.rowid=v.rowid JOIN documents d ON d.path=c.document_path WHERE vss_search(v.embedding, ?) LIMIT ?`).all<Record<string, unknown>>(JSON.stringify(vector), Math.max(1, Math.floor(limit)));
		return rows.map(row => ({ id: String(row.id), documentPath: String(row.document_path), heading: String(row.heading), content: String(row.content), vector: [], tags: this.strings(row.tags_json), aliases: this.strings(row.aliases_json), wikilinks: this.strings(row.wikilinks_json), startLine: Number(row.start_line), endLine: Number(row.end_line), distance: Number(row.distance) }));
	}

	async close(): Promise<void> { if (this.connection) await this.connection.close(); this.connection = null; this.memory.clear(); this.opened = false; }
	private cosine(a: readonly number[], b: readonly number[]): number { let dot = 0; let aa = 0; let bb = 0; for (let i = 0; i < a.length; i++) { const x = a[i] ?? 0; const y = b[i] ?? 0; dot += x * y; aa += x * x; bb += y * y; } return aa && bb ? dot / Math.sqrt(aa * bb) : 0; }
	private strings(value: unknown): string[] { try { const parsed: unknown = JSON.parse(String(value)); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []; } catch { return []; } }
}
