import type { TFile } from 'obsidian';
import type { NativeAutoRouter } from '../routing/NativeAutoRouter';
import type { PythonWorkerTransport } from '../execution/ExecutionRouter';
import { DataNormalizer } from '../execution/DataNormalizer';
import { ChunkingEngine } from './ChunkingEngine';
import type { SemanticChunkRecord } from './SemanticDatabase';
import { SemanticDatabase } from './SemanticDatabase';

interface VectorEnvelope { vectors?: unknown; embeddings?: unknown; }

/** Ingestion boundary: Embeddings intent -> Python JSON-RPC -> normalizer -> SQLite-VSS. */
export class DialecticRAG {
	constructor(private readonly router: NativeAutoRouter, private readonly python: PythonWorkerTransport, private readonly database: SemanticDatabase, private readonly chunker = new ChunkingEngine(), private readonly normalizer = new DataNormalizer()) {}

	async ingest(file: TFile, markdown: string, frontmatter: { tags?: unknown; aliases?: unknown } = {}, signal?: AbortSignal): Promise<number> {
		const chunks = this.chunker.chunk(markdown, file.path, frontmatter);
		if (!chunks.length) { await this.database.replaceDocument(file.path, this.values(frontmatter.tags), this.values(frontmatter.aliases), []); return 0; }
		const route = this.router.resolve('embeddings');
		const raw = await this.python.execute({ schemaVersion: 1, taskId: `embed-${Date.now()}-${Math.random().toString(36).slice(2)}`, taskType: 'embeddings', providerId: route.providerId, ...(route.modelId ? { modelId: route.modelId } : {}), systemPrompt: 'Generate one embedding vector for each input string. Return JSON only: {"vectors":[[number]]}.', userPrompt: JSON.stringify({ texts: chunks.map(chunk => chunk.content) }), metadata: { modality: 'Embeddings', depth: route.depth } }, signal);
		const normalized = this.normalizer.normalize(raw, 'python-worker');
		if (!normalized.success) throw new Error(normalized.error ?? 'Embedding worker failed.');
		const vectors = this.parseVectors(normalized.content);
		if (vectors.length !== chunks.length) throw new Error('Embedding worker returned an unexpected vector count.');
		const dimensions = vectors[0]?.length ?? 0;
		if (!dimensions || vectors.some(vector => vector.length !== dimensions || vector.some(value => !Number.isFinite(value)))) throw new Error('Embedding worker returned invalid vectors.');
		const records: SemanticChunkRecord[] = chunks.map((chunk, index) => ({ id: chunk.id, documentPath: file.path, heading: chunk.metadata.heading, content: chunk.content, vector: vectors[index]!, tags: chunk.metadata.tags, aliases: chunk.metadata.aliases, wikilinks: chunk.metadata.wikilinks, startLine: chunk.metadata.startLine, endLine: chunk.metadata.endLine }));
		await this.database.replaceDocument(file.path, this.values(frontmatter.tags), this.values(frontmatter.aliases), records);
		return records.length;
	}

	private parseVectors(content: string): number[][] {
		let parsed: unknown; try { parsed = JSON.parse(content); } catch { throw new Error('Embedding worker returned malformed JSON.'); }
		const envelope = parsed as VectorEnvelope;
		const value = envelope.vectors ?? envelope.embeddings;
		if (!Array.isArray(value)) throw new Error('Embedding worker response omitted vectors.');
		return value.map(vector => { if (!Array.isArray(vector)) throw new Error('Embedding vector is malformed.'); return vector.map(item => { if (typeof item !== 'number') throw new Error('Embedding vector contains a non-number.'); return item; }); });
	}
	private values(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : typeof value === 'string' ? [value] : []; }
}
