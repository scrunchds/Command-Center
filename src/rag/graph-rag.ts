/**
 * GraphRAG retriever — layered on top of the existing HybridRetriever.
 *
 * Obsidian's native graph view and link metadata are exposed through
 * `metadataCache.resolvedLinks`, a bidirectional source → {destination: count}
 * adjacency map. This retriever reuses that same data to build an in-memory
 * bidirectional link graph (forward links + backlinks), then performs a
 * hybrid seed search and a bounded breadth-first expansion along the graph.
 *
 * Retrieval model (a lightweight personal-GraphRAG):
 *   1. Seed — the delegate HybridRetriever ranks chunks by BM25 + semantic RRF,
 *      exactly as before, producing a small set of seed chunks.
 *   2. Expand — for each seed's source file, walk `hopDepth` hops along forward
 *      links and backlinks, gathering neighbor files.
 *   3. Neighbor retrieval — neighbor files are searched with the same query
 *      (lexical + semantic) so only the relevant chunks of connected notes are
 *      pulled in, not whole files.
 *   4. Re-rank — every chunk is scored by
 *        graphScore = seedScore + Σ(hopDecay^hop * neighborScore) + hubBonus
 *      where `hubBonus` rewards notes with high degree (MOCs / hub notes), and
 *      `hopDecay` controls how quickly signal attenuates across hops.
 *   5. De-duplicate and return the top-K with the original snippet/citation
 *      format so the downstream `VaultSearchTool`, `injectRagContext`, and
 *      ConversationManager need no changes.
 *
 * This keeps the existing hybrid RAG untouched and only adds a graph layer,
 * so GraphRAG degrades gracefully to plain hybrid retrieval when the vault has
 * no links or when embeddings are unavailable.
 */

import type { App } from 'obsidian';
import type { HybridMatch, HybridRetriever } from './hybrid-retriever';
import type { RerankerAdapter } from './reranker';

export interface GraphRAGOptions {
	/** How many link hops to expand from each seed file. Default 1. */
	hopDepth?: number;
	/** Per-hop score decay in (0, 1]. Default 0.5. */
	hopDecay?: number;
	/** Centrality bonus multiplier for hub notes. Default 0.15. */
	hubWeight?: number;
	/** Cap on neighbor files gathered per hop to bound work. Default 8. */
	neighborsPerHop?: number;
	/** Whether to include backlinks in the expansion. Default true. */
	useBacklinks?: boolean;
	/** Optional reranker applied after graph re-ranking. */
	reranker?: RerankerAdapter;
}

export interface GraphRAGSearchOptions {
	limit?: number;
	folders?: string[];
	/** Candidate limit for the seed search. Default 5 * limit. */
	seedLimit?: number;
}

interface GraphStats {
	totalLinks: number;
	totalFiles: number;
}

/**
 * A retriever surface compatible with `VaultSearchTool` / `injectRagContext`.
 * Only `search` and optionally `formatContext` are required; this matches the
 * `SearchRetriever` structural type in `rag-tool.ts`.
 */
export interface GraphRAGRetriever {
	search(query: string, limit?: number): Promise<HybridMatch[]>;
	search(query: string, options?: GraphRAGSearchOptions): Promise<HybridMatch[]>;
	formatContext?: HybridRetriever['formatContext'];
}

export class GraphRAG implements GraphRAGRetriever {
	private readonly delegate: HybridRetriever;
	private readonly app: App;
	private readonly hopDepth: number;
	private readonly hopDecay: number;
	private readonly hubWeight: number;
	private readonly neighborsPerHop: number;
	private readonly useBacklinks: boolean;
	private reranker: RerankerAdapter | undefined;
	private adjacency: Map<string, Set<string>> | null = null;
	private degree: Map<string, number> | null = null;
	private maxDegree = 0;
	private graphVersion = -1;

	constructor(delegate: HybridRetriever, app: App, options: GraphRAGOptions = {}) {
		this.delegate = delegate;
		this.app = app;
		this.hopDepth = Math.max(0, Math.floor(options.hopDepth ?? 1));
		this.hopDecay = Math.min(1, Math.max(0, options.hopDecay ?? 0.5));
		this.hubWeight = Math.max(0, options.hubWeight ?? 0.15);
		this.neighborsPerHop = Math.max(1, Math.floor(options.neighborsPerHop ?? 8));
		this.useBacklinks = options.useBacklinks ?? true;
		this.reranker = options.reranker;
	}

	/** Rebuild the adjacency map from `metadataCache.resolvedLinks`. */
	refreshGraph(): void {
		const resolved = this.app.metadataCache.resolvedLinks;
		// A cheap generation counter: object identity changes when Obsidian
		// rebuilds the cache, so we skip work when nothing changed.
		if (this.graphVersion !== -1 && this.adjacency && resolved === this.cachedResolvedLinks) return;
		this.cachedResolvedLinks = resolved;
		const adjacency = new Map<string, Set<string>>();
		const degree = new Map<string, number>();
		let maxDegree = 0;

		const addEdge = (source: string, destination: string): void => {
			if (source === destination) return;
			let neighbors = adjacency.get(source);
			if (!neighbors) { neighbors = new Set(); adjacency.set(source, neighbors); }
			neighbors.add(destination);
			const next = (degree.get(source) ?? 0) + 1;
			degree.set(source, next);
			if (next > maxDegree) maxDegree = next;
		};

		for (const [source, destinations] of Object.entries(resolved)) {
			for (const [destination, count] of Object.entries(destinations)) {
				if (count <= 0) continue;
				addEdge(source, destination);
				if (this.useBacklinks) addEdge(destination, source);
			}
		}

		this.adjacency = adjacency;
		this.degree = degree;
		this.maxDegree = maxDegree;
		this.graphVersion++;
	}

	private cachedResolvedLinks: Record<string, Record<string, number>> | null = null;

	get graphStats(): GraphStats {
		this.refreshGraph();
		return {
			totalLinks: this.maxDegree,
			totalFiles: this.adjacency?.size ?? 0,
		};
	}

	search(query: string, limit?: number): Promise<HybridMatch[]>;
	search(query: string, options?: GraphRAGSearchOptions): Promise<HybridMatch[]>;
	async search(query: string, limitOrOptions: number | GraphRAGSearchOptions = 5): Promise<HybridMatch[]> {
		const options = typeof limitOrOptions === 'number' ? { limit: limitOrOptions } : limitOrOptions;
		const limit = Math.max(1, Math.floor(options.limit ?? 5));
		const folders = options.folders ?? [];
		const seedLimit = Math.max(limit, Math.floor(options.seedLimit ?? Math.max(limit, 5)));

		// Seed search reuses the full hybrid BM25 + semantic RRF ranking.
		const seedMatches = folders.length
			? await this.delegate.search(query, { limit: seedLimit, folders })
			: await this.delegate.search(query, seedLimit);
		if (seedMatches.length === 0 || this.hopDepth === 0) return seedMatches.slice(0, limit);

		this.refreshGraph();
		if (!this.adjacency || this.adjacency.size === 0) return seedMatches.slice(0, limit);

		// Build the set of seed source files and their per-file best score.
		const seedFileScore = new Map<string, number>();
		for (const match of seedMatches) {
			const file = match.chunk.metadata.filePath;
			const existing = seedFileScore.get(file);
			if (existing === undefined || match.score > existing) seedFileScore.set(file, match.score);
		}

		// Breadth-first expansion along the link graph for `hopDepth` hops.
		const visited = new Set<string>(seedFileScore.keys());
		const hopOfFile = new Map<string, number>([...seedFileScore.keys()].map(f => [f, 0]));
		const frontier: string[] = [...seedFileScore.keys()];
		for (let hop = 0; hop < this.hopDepth; hop++) {
			const nextFrontier: string[] = [];
			const neighborSet = new Set<string>();
			for (const node of frontier) {
				const neighbors = this.adjacency.get(node);
				if (!neighbors) continue;
				for (const neighbor of neighbors) {
					if (visited.has(neighbor)) continue;
					visited.add(neighbor);
					neighborSet.add(neighbor);
					nextFrontier.push(neighbor);
				}
				if (neighborSet.size >= this.neighborsPerHop) break;
			}
			for (const neighbor of nextFrontier) if (!hopOfFile.has(neighbor)) hopOfFile.set(neighbor, hop + 1);
			frontier.length = 0;
			frontier.push(...nextFrontier);
			if (frontier.length === 0) break;
		}

		// Gather neighbor chunks via the same hybrid query so only the relevant
		// portions of connected notes are pulled in (not whole files).
		const neighborFiles = [...hopOfFile.keys()].filter(file => !seedFileScore.has(file));
		const neighborMatches: HybridMatch[] = [];
		if (neighborFiles.length > 0) {
			const neighborResults = folders.length
				? await this.delegate.search(query, { limit: limit * 2, folders })
				: await this.delegate.search(query, limit * 2);
			for (const match of neighborResults) {
				if (neighborFiles.includes(match.chunk.metadata.filePath)) neighborMatches.push(match);
			}
		}

		// Graph-boosted re-ranking.
		const allMatches = [...seedMatches, ...neighborMatches];
		const scored = allMatches.map(match => {
			const file = match.chunk.metadata.filePath;
			const hop = hopOfFile.get(file) ?? 0;
			const isSeed = seedFileScore.has(file);
			const neighborBoost = isSeed ? 0 : match.score * Math.pow(this.hopDecay, hop);
			const hubBonus = this.degree && this.maxDegree > 0
				? this.hubWeight * ((this.degree.get(file) ?? 0) / this.maxDegree)
				: 0;
			const baseScore = isSeed ? match.score : 0;
			const graphScore = baseScore + neighborBoost + hubBonus;
			return { match, graphScore, isSeed };
		});

		// Seeds always win ties, then graph score, then lexical score.
		scored.sort((a, b) => {
			if (a.graphScore !== b.graphScore) return b.graphScore - a.graphScore;
			if (a.isSeed !== b.isSeed) return a.isSeed ? -1 : 1;
			return b.match.bm25Score - a.match.bm25Score;
		});

		// De-duplicate by chunk id, keeping the first occurrence.
		const seen = new Set<string>();
		const out: HybridMatch[] = [];
		for (const { match } of scored) {
			if (seen.has(match.chunk.id)) continue;
			seen.add(match.chunk.id);
			out.push(match);
			if (out.length >= limit * 2) break; // gather extras for the reranker to trim.
		}
		// Apply the reranker (if enabled) to re-score the graph-expanded set.
		if (this.reranker && this.reranker.enabled && out.length > 1) {
			const reranked = await this.reranker.rerank(query, out);
			return reranked.slice(0, limit);
		}
		return out.slice(0, limit);
	}

	/** Delegate to the hybrid retriever so callers share one citation format. */
	get formatContext(): HybridRetriever['formatContext'] | undefined {
		return this.delegate.formatContext.bind(this.delegate);
	}

	/** Attach or replace the reranker (called after the dispatcher is built). */
	setReranker(reranker: RerankerAdapter | undefined): void {
		this.reranker = reranker;
	}
}
