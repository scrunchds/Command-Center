import type { TopographyMap } from '../ingestion/TopographySweep';
import type { HybridMatch, HybridRetriever, HybridSearchOptions } from '../rag/hybrid-retriever';

export interface DialecticRAGOptions {
	limit?: number;
	graphDepth?: number;
	graphWeight?: number;
	folders?: string[];
}

export interface DialecticMatch extends HybridMatch {
	graphScore: number;
	graphPaths: string[];
	dialecticScore: number;
}

/** Combines existing hybrid retrieval with structural evidence from TopographySweep. */
export class DialecticRAG {
	constructor(
		private readonly retriever: HybridRetriever,
		private readonly getTopography: () => TopographyMap | null,
	) {}

	async retrieve(query: string, options: DialecticRAGOptions = {}): Promise<DialecticMatch[]> {
		const limit = Math.max(0, Math.floor(options.limit ?? 5));
		if (!limit) return [];
		const graphDepth = Math.max(0, Math.min(3, Math.floor(options.graphDepth ?? 1)));
		const graphWeight = Math.max(0, Math.min(1, options.graphWeight ?? 0.25));
		const searchOptions: HybridSearchOptions = { limit: Math.max(limit * 3, 20), folders: options.folders };
		const lexicalSemantic = await this.retriever.search(query, searchOptions);
		const graph = this.getTopography();
		if (!graph) return lexicalSemantic.slice(0, limit).map(match => ({ ...match, graphScore: 0, graphPaths: [], dialecticScore: match.score }));

		const seedPaths = lexicalSemantic.map(match => match.chunk.metadata.filePath);
		return lexicalSemantic.map(match => {
			const graphPaths = this.relatedPaths(graph, match.chunk.metadata.filePath, seedPaths, graphDepth);
			const graphScore = Math.min(1, graphPaths.length / Math.max(1, seedPaths.length));
			return { ...match, graphPaths, graphScore, dialecticScore: match.score * (1 - graphWeight) + graphScore * graphWeight };
		}).sort((a, b) => b.dialecticScore - a.dialecticScore || b.score - a.score).slice(0, limit);
	}

	formatContext(matches: DialecticMatch[], charBudget?: number): string {
		const enriched: HybridMatch[] = matches.map(match => ({
			...match,
			snippet: match.graphPaths.length
				? `${match.snippet}\n> Structural context: ${match.graphPaths.map(path => `[[${path}]]`).join(', ')}`
				: match.snippet,
		}));
		return this.retriever.formatContext(enriched, charBudget);
	}

	private relatedPaths(graph: TopographyMap, path: string, seeds: string[], depth: number): string[] {
		if (!depth) return [];
		const seedSet = new Set(seeds);
		const seen = new Set([path]);
		let frontier = [path];
		const related = new Set<string>();
		for (let level = 0; level < depth; level++) {
			const next: string[] = [];
			for (const currentPath of frontier) {
				const node = graph.nodes.get(currentPath);
				if (!node) continue;
				const neighbors = [...node.outboundLinks, ...node.inboundLinks];
				for (const neighbor of neighbors) {
					if (seen.has(neighbor) || !graph.nodes.has(neighbor)) continue;
					seen.add(neighbor); next.push(neighbor);
					if (seedSet.has(neighbor)) related.add(neighbor);
				}
			}
			frontier = next;
		}
		return [...related].sort();
	}
}
