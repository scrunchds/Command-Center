/** OpenAI-compatible embeddings with a deterministic local TF fallback. */

import { detectLocalRuntime, isLocalBaseUrl, type ProviderId } from '../providers/provider-types';

export interface EmbeddingAdapterOptions {
	baseUrl: string;
	apiKey?: string;
	model?: string;
	/** Optional hint when a non-standard port does not identify the local runtime. */
	providerId?: ProviderId;
	/** LM Studio/unknown-local model residency in seconds. Defaults to 300. */
	ttl?: number;
	/** Ollama model residency duration. Defaults to "5m". */
	keepAlive?: string | number;
	fetch?: typeof fetch;
	signal?: AbortSignal;
	/** Dimensions in the dependency-free hashed term-frequency fallback. */
	fallbackDimensions?: number;
}

export interface EmbeddingRequest {
	url: string;
	init: RequestInit;
	body: {
		model: string;
		input: string[];
		encoding_format: 'float';
		ttl?: number;
		keep_alive?: string | number;
	};
}

export interface EmbeddingBatch {
	vectors: number[][];
	model: string;
	source: 'remote' | 'term-frequency';
}

function normalizeBaseUrl(url: string): string {
	return url.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function defaultModel(baseUrl: string): string {
	return /(?:localhost|127\.0\.0\.1|\[::1\]|ollama|:11434)(?::|\/|$)/i.test(baseUrl)
		? 'nomic-embed-text'
		: 'text-embedding-3-small';
}

/** Stable FNV-1a hash allows documents and later queries to share TF dimensions. */
function hashTerm(term: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < term.length; i++) {
		hash ^= term.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

export function termFrequencyEmbedding(text: string, dimensions = 256): number[] {
	const size = Math.max(32, Math.floor(dimensions));
	const vector = Array<number>(size).fill(0);
	const terms = text.toLocaleLowerCase().match(/[\p{L}\p{N}_'-]+/gu) ?? [];
	for (const term of terms) {
		const index = hashTerm(term) % size;
		vector[index] = (vector[index] ?? 0) + 1;
	}
	const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
	return norm > 0 ? vector.map(value => value / norm) : vector;
}

export class EmbeddingAdapter {
	private readonly options: EmbeddingAdapterOptions;

	constructor(options: EmbeddingAdapterOptions) {
		this.options = options;
	}

	buildRequest(input: string | string[]): EmbeddingRequest {
		const values = Array.isArray(input) ? input : [input];
		const model = this.options.model?.trim() || defaultModel(this.options.baseUrl);
		const body: EmbeddingRequest['body'] = { model, input: values, encoding_format: 'float' };
		// Retention controls must never leak to cloud APIs. For local engines use
		// their native field at the final request boundary, matching inference/STT.
		if (isLocalBaseUrl(this.options.baseUrl)) {
			const runtime = detectLocalRuntime(this.options.baseUrl, this.options.providerId);
			if (runtime === 'ollama') body.keep_alive = this.options.keepAlive ?? '5m';
			else body.ttl = this.validTtl(this.options.ttl) ?? 300;
		}
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (this.options.apiKey) headers.Authorization = `Bearer ${this.options.apiKey}`;
		return {
			url: `${normalizeBaseUrl(this.options.baseUrl)}/v1/embeddings`,
			init: { method: 'POST', headers, body: JSON.stringify(body), signal: this.options.signal },
			body,
		};
	}

	async embed(input: string | string[]): Promise<EmbeddingBatch> {
		const values = Array.isArray(input) ? input : [input];
		const request = this.buildRequest(values);
		const fetchFn = this.options.fetch ?? window.fetch.bind(window);
		if (fetchFn && !this.options.signal?.aborted) {
			try {
				const response = await fetchFn(request.url, request.init);
				if (response.ok) {
					const payload = await response.json() as {
						data?: Array<{ index?: number; embedding?: unknown }>;
						embeddings?: unknown;
						embedding?: unknown;
					};
					const vectors = this.parseVectors(payload, values.length);
					if (vectors) return { vectors, model: request.body.model, source: 'remote' };
				}
			} catch {
				// Offline, timeout, CORS, and malformed endpoints intentionally degrade to TF.
			}
		}
		return {
			vectors: values.map(text => termFrequencyEmbedding(text, this.options.fallbackDimensions)),
			model: 'local-term-frequency',
			source: 'term-frequency',
		};
	}

	private validTtl(value: number | undefined): number | undefined {
		return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
	}

	private parseVectors(payload: { data?: Array<{ index?: number; embedding?: unknown }>; embeddings?: unknown; embedding?: unknown }, expected: number): number[][] | null {
		let raw: unknown[];
		if (Array.isArray(payload.data)) {
			raw = [...payload.data]
				.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
				.map(item => item.embedding);
		} else if (Array.isArray(payload.embeddings)) raw = payload.embeddings;
		else raw = [payload.embedding];
		if (raw.length !== expected) return null;
		const vectors = raw.map(value => Array.isArray(value) && value.every(number => typeof number === 'number' && Number.isFinite(number)) ? value as number[] : null);
		return vectors.every((vector): vector is number[] => vector !== null && vector.length > 0) ? vectors : null;
	}
}
