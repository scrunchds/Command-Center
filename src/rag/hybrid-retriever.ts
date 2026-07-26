/** Cached vault chunk index combining BM25 and embedding similarity with RRF. */

import type { App } from 'obsidian';
import { MarkdownChunker, type MarkdownChunk } from './chunker';
import { EmbeddingAdapter } from './embeddings';

export interface HybridRetrieverOptions {
	chunker?: MarkdownChunker;
	embeddings: EmbeddingAdapter;
	keywordWeight?: number;
	vectorWeight?: number;
	/** Reciprocal-rank constant. The conventional default is 60. */
	rrfK?: number;
	/** Hard maximum for formatContext(). */
	contextCharBudget?: number;
}

export interface IndexedVaultFile {
	path: string;
	content: string;
	mtime?: number;
	size?: number;
}

export interface HybridSearchOptions {
	limit?: number;
	/** One or more vault folder roots. Paths are normalized before matching. */
	folders?: string[];
	/** Candidate depth per ranking before reciprocal rank fusion. */
	candidateLimit?: number;
}

export interface HybridMatch {
	chunk: MarkdownChunk;
	/** Normalized fused score in [0, 1]. */
	score: number;
	bm25Score: number;
	vectorScore: number;
	snippet: string;
}

interface IndexedChunk {
	chunk: MarkdownChunk;
	terms: Map<string, number>;
	length: number;
	vector: number[];
}

const K1 = 1.5;
const B = 0.75;
const DEFAULT_CONTEXT_BUDGET = 3_000;

export function tokenizeForRetrieval(text: string): string[] {
	return text.toLocaleLowerCase().match(/[\p{L}\p{N}_'-]+/gu) ?? [];
}

export function bm25TermScore(tf: number, documentLength: number, documentCount: number, documentFrequency: number, averageLength: number): number {
	if (tf <= 0 || documentCount <= 0) return 0;
	const idf = Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
	return idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * documentLength / Math.max(1, averageLength)));
}

export function cosineSimilarity(left: number[], right: number[]): number {
	if (!left.length || left.length !== right.length) return 0;
	let dot = 0, leftNorm = 0, rightNorm = 0;
	for (let index = 0; index < left.length; index++) {
		const a = left[index] ?? 0, b = right[index] ?? 0;
		dot += a * b; leftNorm += a * a; rightNorm += b * b;
	}
	return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

export class HybridRetriever {
	private readonly chunker: MarkdownChunker;
	private readonly embeddings: EmbeddingAdapter;
	private readonly keywordWeight: number;
	private readonly vectorWeight: number;
	private readonly rrfK: number;
	private readonly contextCharBudget: number;
	private readonly index = new Map<string, IndexedChunk[]>();
	/** path -> mtime:size (or content hash:size for plain records). */
	private readonly fileVersions = new Map<string, string>();

	constructor(options: HybridRetrieverOptions) {
		this.chunker = options.chunker ?? new MarkdownChunker();
		this.embeddings = options.embeddings;
		this.keywordWeight = Math.max(0, options.keywordWeight ?? 0.55);
		this.vectorWeight = Math.max(0, options.vectorWeight ?? 0.45);
		this.rrfK = Math.max(1, Math.floor(options.rrfK ?? 60));
		this.contextCharBudget = Math.max(0, Math.floor(options.contextCharBudget ?? DEFAULT_CONTEXT_BUDGET));
	}

	/** Index plain records and remove records omitted from this complete snapshot. */
	async indexFiles(files: IndexedVaultFile[]): Promise<number> {
		const active = new Set(files.map(file => this.normalizePath(file.path)));
		for (const path of this.index.keys()) if (!active.has(path)) this.removePath(path);
		for (const file of files) {
			const path = this.normalizePath(file.path);
			const size = file.size ?? file.content.length;
			const version = `${file.mtime ?? this.hashContent(file.content)}:${size}`;
			if (this.fileVersions.get(path) !== version) await this.indexFile(path, file.content, version);
		}
		return this.size;
	}

	/**
	 * Incrementally indexes Markdown under selected folders. Stat keys are checked
	 * before cachedRead(), so unchanged notes incur neither reads nor embeddings.
	 */
	async indexVault(app: App, folders: string[] = []): Promise<number> {
		const roots = this.normalizeFolders(folders);
		const selected = app.vault.getMarkdownFiles().filter(file => this.inFolders(file.path, roots));
		const active = new Set(selected.map(file => this.normalizePath(file.path)));
		for (const path of this.index.keys()) if (!active.has(path)) this.removePath(path);
		for (const file of selected) {
			const path = this.normalizePath(file.path);
			const version = `${file.stat.mtime}:${file.stat.size}`;
			if (this.fileVersions.get(path) === version) continue;
			await this.indexFile(path, await app.vault.cachedRead(file), version);
		}
		return this.size;
	}

	async search(query: string, k?: number): Promise<HybridMatch[]>;
	async search(query: string, options?: HybridSearchOptions): Promise<HybridMatch[]>;
	async search(query: string, limitOrOptions: number | HybridSearchOptions = 5): Promise<HybridMatch[]> {
		const options = typeof limitOrOptions === 'number' ? { limit: limitOrOptions } : limitOrOptions;
		const limit = Math.max(0, Math.floor(options.limit ?? 5));
		const queryTerms = [...new Set(tokenizeForRetrieval(query))];
		if (!queryTerms.length || this.size === 0 || limit <= 0) return [];
		const roots = this.normalizeFolders(options.folders ?? []);
		const documents = [...this.index.values()].flat().filter(document => this.inFolders(document.chunk.metadata.filePath, roots));
		if (!documents.length) return [];

		const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / documents.length;
		const frequencies = new Map<string, number>();
		for (const term of queryTerms) {
			let count = 0;
			for (const document of documents) if (document.terms.has(term)) count++;
			frequencies.set(term, count);
		}
		const queryVector = (await this.embeddings.embed(query)).vectors[0] ?? [];
		const scored = documents.map(document => {
			let bm25Score = 0;
			for (const term of queryTerms) bm25Score += bm25TermScore(document.terms.get(term) ?? 0, document.length, documents.length, frequencies.get(term) ?? 0, averageLength);
			return { document, bm25Score, vectorScore: Math.max(0, cosineSimilarity(queryVector, document.vector)) };
		});

		const depth = Math.min(documents.length, Math.max(limit, Math.floor(options.candidateLimit ?? limit * 4), 20));
		const lexical = scored.filter(item => item.bm25Score > 0).sort((a, b) => b.bm25Score - a.bm25Score).slice(0, depth);
		const semantic = scored.filter(item => item.vectorScore > 0).sort((a, b) => b.vectorScore - a.vectorScore).slice(0, depth);
		const fused = new Map<IndexedChunk, { bm25Score: number; vectorScore: number; fused: number }>();
		const addRank = (items: typeof scored, weight: number): void => {
			items.forEach((item, rank) => {
				const current = fused.get(item.document) ?? { bm25Score: item.bm25Score, vectorScore: item.vectorScore, fused: 0 };
				current.fused += weight / (this.rrfK + rank + 1);
				fused.set(item.document, current);
			});
		};
		addRank(lexical, this.keywordWeight);
		addRank(semantic, this.vectorWeight);
		const maxFused = Math.max(0, ...[...fused.values()].map(item => item.fused));
		return [...fused.entries()].map(([document, item]) => ({
			chunk: document.chunk,
			score: maxFused > 0 ? item.fused / maxFused : 0,
			bm25Score: item.bm25Score,
			vectorScore: item.vectorScore,
			snippet: this.formatSnippet(document.chunk),
		})).sort((a, b) => b.score - a.score || b.bm25Score - a.bm25Score || a.chunk.id.localeCompare(b.chunk.id)).slice(0, limit);
	}

	/** Assemble cited snippets without ever exceeding the configured hard budget. */
	formatContext(matches: HybridMatch[], charBudget = this.contextCharBudget): string {
		const budget = Math.max(0, Math.min(this.contextCharBudget, Math.floor(charBudget)));
		if (!budget) return '';
		let output = '';
		for (const match of matches) {
			const separator = output ? '\n\n' : '';
			const available = budget - output.length - separator.length;
			if (available <= 0) break;
			let snippet = match.snippet;
			if (snippet.length > available) {
				const headerEnd = snippet.indexOf('\n');
				const header = headerEnd >= 0 ? snippet.slice(0, headerEnd + 1) : '';
				if (header.length + 1 > available) break;
				const bodyBudget = available - header.length;
				const body = snippet.slice(header.length, header.length + bodyBudget).replace(/\s+\S*$/, '').trimEnd();
				snippet = `${header}${body}${body.length < bodyBudget ? '…' : ''}`.slice(0, available);
			}
			output += separator + snippet;
		}
		return output.slice(0, budget);
	}

	clear(): void { this.index.clear(); this.fileVersions.clear(); }
	get size(): number { return [...this.index.values()].reduce((sum, chunks) => sum + chunks.length, 0); }

	private async indexFile(path: string, content: string, version: string): Promise<void> {
		const chunks = this.chunker.chunk(content, path);
		const vectors = chunks.length ? (await this.embeddings.embed(chunks.map(chunk => chunk.text))).vectors : [];
		this.index.set(path, chunks.map((chunk, index) => {
			const terms = new Map<string, number>();
			const tokens = tokenizeForRetrieval(`${chunk.metadata.heading} ${chunk.text}`);
			for (const term of tokens) terms.set(term, (terms.get(term) ?? 0) + 1);
			return { chunk, terms, length: Math.max(1, tokens.length), vector: vectors[index] ?? [] };
		}));
		this.fileVersions.set(path, version);
	}

	private formatSnippet(chunk: MarkdownChunk): string {
		const meta = chunk.metadata;
		const heading = meta.heading ? ` — ${meta.heading}` : '';
		return `> [!info] Snippet from [[${meta.filePath}]] (Lines ${meta.startLine}–${meta.endLine})${heading}\n>\n${chunk.text.split('\n').map(line => `> ${line}`).join('\n')}`;
	}

	private normalizePath(path: string): string { return path.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''); }
	private normalizeFolders(folders: string[]): string[] { return [...new Set(folders.map(folder => this.normalizePath(folder)).filter(Boolean))]; }
	private inFolders(path: string, roots: string[]): boolean {
		if (!roots.length) return true;
		const normalized = this.normalizePath(path).toLocaleLowerCase();
		return roots.some(root => normalized === root.toLocaleLowerCase() || normalized.startsWith(`${root.toLocaleLowerCase()}/`));
	}
	private removePath(path: string): void { this.index.delete(path); this.fileVersions.delete(path); }
	private hashContent(content: string): number {
		let hash = 2166136261;
		for (let index = 0; index < content.length; index++) hash = Math.imul(hash ^ content.charCodeAt(index), 16777619);
		return hash >>> 0;
	}
}
