/**
 * Reranker adapter — re-scores retrieved chunks with a dedicated rerank model.
 *
 * Many providers ship dedicated rerank models that classify query/document pairs
 * far more accurately than a conversational model's logits. This adapter
 * supports two strategies, selected by `RerankerSettings.mode`:
 *
 *   1. `api`  — calls a native rerank endpoint (`POST /v1/rerank`). Cohere,
 *      Jina, and Voyage all expose a shared shape:
 *        { model, query, documents: string[], top_n }
 *      → { results: [{ index, relevance_score }] }
 *      Cohere uses `/v1/rerank`; Jina uses `/v1/rerank`; Voyage uses `/v1/rerank`.
 *      The adapter normalizes each provider's response shape.
 *
 *   2. `llm`  — a provider-agnostic fallback that asks a chat-completion model
 *      to score each candidate `[0, 100]` for relevance to the query. This works
 *      with any provider the user already has configured and never requires a
 *      dedicated rerank endpoint.
 *
 * Both modes route through the existing `ProviderDispatcher` / `NativeAutoRouter`
 * so the selected provider/model is honored and the request reuses the
 * provider stack's auth, retries, and telemetry. When `mode === 'none'` the
 * adapter is a no-op and callers keep the built-in RRF / graph scoring.
 *
 * Failures are non-fatal: a rerank error returns the candidates in their
 * original order so retrieval degrades gracefully to the seed ranking.
 */

import type { ProviderId } from '../providers/provider-types';
import type { HybridMatch } from './hybrid-retriever';

/**
 * Reranker configuration. When the model needs to re-rank retrieved chunks
 * (GraphRAG expansion, hybrid RAG fusion), a dedicated reranker model or
 * API provider can be selected so the right model handles the scoring pass
 * instead of the conversational model. Rerank models are discovered from
 * each provider's live model list (Cohere `rerank-*`, Jina `jina-reranker-*`,
 * Voyage `rerank-*`, etc.) and surfaced in settings.
 */
export interface RerankerSettings {
	/** Reranking strategy. 'none' keeps the built-in RRF/graph scoring. */
	mode: 'none' | 'api' | 'llm';
	/** Provider to route rerank requests through ('auto' uses the Native Auto-Router). */
	providerId: 'auto' | ProviderId;
	/** Model slug for the reranker; empty lets the provider choose. */
	model: string;
	/** How many candidates to ask the reranker to score per pass. */
	candidateLimit: number;
	/** Hard cap on candidates sent to the reranker to bound token spend. */
	maxCandidates: number;
	/** Score threshold in [0, 1] below which reranked chunks are dropped. */
	minScore: number;
}

export const DEFAULT_RERANKER: RerankerSettings = {
	mode: 'none',
	providerId: 'auto',
	model: '',
	candidateLimit: 20,
	maxCandidates: 40,
	minScore: 0,
};

/**
 * Backfill a saved reranker config against defaults so an upgrade from a
 * `data.json` that predates the reranker settings always yields a complete,
 * validated object. Invalid enum values fall back to 'none' (disabled).
 */
export function mergeReranker(
	defaults: RerankerSettings,
	saved: Partial<RerankerSettings> | undefined,
): RerankerSettings {
	const merged = { ...defaults };
	if (!saved) return merged;
	if (saved.mode === 'none' || saved.mode === 'api' || saved.mode === 'llm') merged.mode = saved.mode;
	if (typeof saved.providerId === 'string') merged.providerId = saved.providerId;
	if (typeof saved.model === 'string') merged.model = saved.model;
	if (typeof saved.candidateLimit === 'number' && Number.isFinite(saved.candidateLimit)) merged.candidateLimit = Math.max(1, Math.floor(saved.candidateLimit));
	if (typeof saved.maxCandidates === 'number' && Number.isFinite(saved.maxCandidates)) merged.maxCandidates = Math.max(1, Math.floor(saved.maxCandidates));
	if (typeof saved.minScore === 'number' && Number.isFinite(saved.minScore)) merged.minScore = Math.min(1, Math.max(0, saved.minScore));
	return merged;
}


/** Minimal dispatcher surface needed to run a chat-completion rerank pass. */
interface DispatcherLike {
	dispatchTo(providerId: string, request: {
		systemPrompt: string;
		userPrompt: string;
		config?: { model?: string; maxTokens?: number };
	}): Promise<{ success: boolean; output?: string }>;
}

/** Minimal router surface for resolving a rerank model id. */
interface RouterLike {
	resolve(modality: string): { providerId: string; modelId?: string; reason?: string } | undefined;
}

export interface RerankerAdapterOptions {
	settings: RerankerSettings;
	dispatcher: DispatcherLike;
	router?: RouterLike;
	/** Injected fetch for the native rerank API path (defaults to window.fetch). */
	fetch?: typeof fetch;
	/** Resolves a provider's base URL + apiKey for the native rerank API call. */
	resolveEndpoint?: (providerId: string) => { baseUrl: string; apiKey: string } | undefined;
	logger?: Pick<Console, 'warn'>;
}

export class RerankerAdapter {
	private settings: RerankerSettings;
	private readonly dispatcher: DispatcherLike;
	private readonly router?: RouterLike;
	private readonly fetchFn: typeof fetch;
	private readonly resolveEndpoint?: (providerId: string) => { baseUrl: string; apiKey: string } | undefined;
	private readonly logger: Pick<Console, 'warn'>;

	constructor(options: RerankerAdapterOptions) {
		this.settings = options.settings;
		this.dispatcher = options.dispatcher;
		this.router = options.router;
		this.fetchFn = options.fetch ?? window.fetch.bind(window);
		this.resolveEndpoint = options.resolveEndpoint;
		this.logger = options.logger ?? console;
	}

	get enabled(): boolean {
		return this.settings.mode !== 'none';
	}

	/** Apply changed settings without rebuilding the adapter. */
	updateSettings(settings: RerankerSettings): void {
		this.settings = settings;
	}

	/**
	 * Re-rank candidate matches. Returns the matches sorted by reranker score
	 * (descending), with scores below `minScore` dropped. On any error the
	 * original order is preserved so retrieval degrades to seed ranking.
	 */
	async rerank(query: string, candidates: HybridMatch[]): Promise<HybridMatch[]> {
		if (!this.enabled || candidates.length <= 1) return candidates;
		const cap = Math.min(candidates.length, this.settings.maxCandidates);
		const batch = candidates.slice(0, cap);
		try {
			const scored = this.settings.mode === 'api'
				? await this.rerankViaApi(query, batch)
				: await this.rerankViaLlm(query, batch);
			const filtered = scored.filter(item => item.score >= this.settings.minScore);
			const result = (filtered.length ? filtered : scored)
				.sort((a, b) => b.score - a.score)
				.map(item => item.match);
			// Append any candidates that exceeded maxCandidates in original order.
			return [...result, ...candidates.slice(cap)];
		} catch (error) {
			this.logger.warn('[CC] Reranker failed, falling back to seed ranking:', error);
			return candidates;
		}
	}

	/** Native rerank endpoint (Cohere / Jina / Voyage share this shape). */
	private async rerankViaApi(query: string, batch: HybridMatch[]): Promise<Array<{ match: HybridMatch; score: number }>> {
		if (!this.resolveEndpoint) throw new Error('No rerank endpoint resolver configured.');
		const target = this.resolveTarget();
		const endpoint = this.resolveEndpoint(target.providerId);
		if (!endpoint) throw new Error(`No rerank endpoint for provider '${target.providerId}'.`);
		const documents = batch.map(match => this.documentText(match));
		const url = `${endpoint.baseUrl.replace(/\/+$/, '')}/v1/rerank`;
		const response = await this.fetchFn(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${endpoint.apiKey}`,
			},
			body: JSON.stringify({
				model: target.model,
				query,
				documents,
				top_n: batch.length,
			}),
		});
		if (!response.ok) throw new Error(`Rerank API HTTP ${response.status}`);
		const payload = await response.json() as { results?: Array<{ index?: number; relevance_score?: number }> };
		const results = payload.results ?? [];
		const scored: Array<{ match: HybridMatch; score: number }> = [];
		for (const entry of results) {
			const candidate = batch[entry.index ?? 0];
			if (candidate) scored.push({ match: candidate, score: Math.min(1, Math.max(0, entry.relevance_score ?? 0)) });
		}
		return scored;
	}

	/** LLM fallback: ask a chat model to score each candidate [0, 100]. */
	private async rerankViaLlm(query: string, batch: HybridMatch[]): Promise<Array<{ match: HybridMatch; score: number }>> {
		const target = this.resolveTarget();
		const documents = batch.map((match, index) => `[${index + 1}] ${this.documentText(match)}`).join('\n\n');
		const systemPrompt = 'You are a retrieval reranker. Score each document 0–100 for how relevant it is to answering the query. Reply ONLY with one score per line: "<index>: <score>". No prose.';
		const userPrompt = `Query: ${query}\n\nDocuments:\n${documents}\n\nScores (one per line, "index: score"):`;
		const result = await this.dispatcher.dispatchTo(target.providerId, {
			systemPrompt,
			userPrompt,
			config: { model: target.model || undefined, maxTokens: 4 * batch.length },
		});
		if (!result.success || !result.output) throw new Error('LLM rerank produced no output.');
		return this.parseLlmScores(result.output, batch);
	}

	private parseLlmScores(output: string, batch: HybridMatch[]): Array<{ match: HybridMatch; score: number }> {
		const lines = output.split('\n');
		const scored: Array<{ match: HybridMatch; score: number }> = [];
		for (const line of lines) {
			const match = /^\s*(\d+)\s*[:)]\s*(\d+(?:\.\d+)?)/.exec(line);
			if (!match) continue;
			const index = Number.parseInt(match[1] ?? '0', 10) - 1;
			const raw = Number.parseFloat(match[2] ?? '0');
			if (index < 0 || index >= batch.length) continue;
			const candidate = batch[index];
			if (candidate) scored.push({ match: candidate, score: Math.min(1, Math.max(0, raw / 100)) });
		}
		// Any unscored candidates get score 0 so they're retained but ranked last.
		for (let index = 0; index < batch.length; index++) {
			const candidate = batch[index];
			if (candidate && !scored.some(item => item.match === candidate)) {
				scored.push({ match: candidate, score: 0 });
			}
		}
		return scored;
	}

	/** Resolve the provider + model to route the rerank request to. */
	private resolveTarget(): { providerId: string; model: string } {
		const settings = this.settings;
		if (settings.providerId !== 'auto') {
			return { providerId: settings.providerId, model: settings.model };
		}
		// Use the Native Auto-Router to resolve a reasoning-capable model.
		const resolved = this.router?.resolve?.('reasoning');
		if (resolved?.providerId) return { providerId: resolved.providerId, model: settings.model || resolved.modelId || '' };
		return { providerId: '', model: settings.model };
	}

	/** Compact text used to represent a chunk to the reranker. */
	private documentText(match: HybridMatch): string {
		const meta = match.chunk.metadata;
		const heading = meta.heading ? ` (${meta.heading})` : '';
		return `${meta.filePath}${heading}\n${match.chunk.text}`.slice(0, 1_500);
	}
}
