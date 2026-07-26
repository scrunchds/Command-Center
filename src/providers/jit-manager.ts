/** Explicit local-model load/unload lifecycle for latency-sensitive workloads. */

import { detectLocalRuntime, isLocalBaseUrl } from './provider-types';

export interface JitModelManagerOptions {
	fetch?: typeof fetch;
	signal?: AbortSignal;
	/** Maximum time for this optional optimization. Defaults to five seconds. */
	timeoutMs?: number;
}

export class JitModelManager {
	private readonly fetchFn: typeof fetch | undefined;
	private readonly signal?: AbortSignal;
	private readonly timeoutMs: number;

	constructor(options: JitModelManagerOptions = {}) {
		this.fetchFn = options.fetch ?? window.fetch.bind(window);
		this.signal = options.signal;
		this.timeoutMs = Math.max(0, options.timeoutMs ?? 5_000);
	}

	/** Check local state and pre-warm an unloaded model. Never blocks normal inference on failure. */
	async ensureModelLoaded(baseURL: string, modelId: string, ttlSeconds = 300): Promise<boolean> {
		if (!isLocalBaseUrl(baseURL) || !modelId.trim() || !Number.isFinite(ttlSeconds) || ttlSeconds < 0) return false;
		const ollama = detectLocalRuntime(baseURL) === 'ollama';
		const state = await this.modelState(baseURL, modelId, ollama);
		if (state === true) return true;
		if (ollama) {
			// Ollama loads on first generation. An empty, zero-output generation is
			// the least expensive portable warm-up supported by local releases.
			return this.post(this.ollamaEndpoint(baseURL), {
				model: modelId, prompt: '', stream: false, options: { num_predict: 0 }, keep_alive: ttlSeconds,
			});
		}
		return this.post(this.lmStudioEndpoint(baseURL, 'load'), { model: modelId, ttl: ttlSeconds });
	}

	/** Immediately release a local model after a bounded batch or ReAct session. */
	async evictModel(baseURL: string, modelId: string): Promise<boolean> {
		if (!isLocalBaseUrl(baseURL) || !modelId.trim()) return false;
		if (detectLocalRuntime(baseURL) === 'ollama') {
			return this.post(this.ollamaEndpoint(baseURL), {
				model: modelId, prompt: '', stream: false, keep_alive: 0,
			});
		}
		return this.post(this.lmStudioEndpoint(baseURL, 'unload'), { instance_id: modelId });
	}

	/** Backward-compatible lifecycle aliases. */
	async loadModel(baseURL: string, modelId: string, ttlSeconds = 300): Promise<boolean> {
		return this.ensureModelLoaded(baseURL, modelId, ttlSeconds);
	}
	async unloadModel(baseURL: string, modelId: string): Promise<boolean> {
		return this.evictModel(baseURL, modelId);
	}

	private async modelState(baseURL: string, modelId: string, ollama: boolean): Promise<boolean | undefined> {
		const endpoints = ollama
			? [`${this.serverRoot(baseURL)}/api/tags`, `${this.serverRoot(baseURL)}/v1/models`]
			: [`${this.serverRoot(baseURL)}/api/v1/models`, `${this.serverRoot(baseURL)}/v1/models`];
		for (const endpoint of endpoints) {
			const payload = await this.getJson(endpoint);
			if (!payload) continue;
			const entries = (Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : []) as unknown[];
			return entries.some(entry => {
				if (typeof entry === 'string') return entry === modelId;
				if (!entry || typeof entry !== 'object') return false;
				const item = entry as Record<string, unknown>;
				const id = item.id ?? item.key ?? item.model ?? item.name;
				if (id !== modelId) return false;
				// LM Studio native catalogs can include downloaded but unloaded models.
				return item.loaded !== false && item.state !== 'unloaded' && item.status !== 'unloaded';
			});
		}
		return undefined;
	}

	private async getJson(endpoint: string): Promise<Record<string, unknown> | undefined> {
		if (!this.fetchFn || this.signal?.aborted) return undefined;
		try {
			const response = await this.fetchWithTimeout(endpoint, { method: 'GET' });
			return response.ok ? await response.json() as Record<string, unknown> : undefined;
		} catch { return undefined; }
	}

	private async post(endpoint: string, payload: Record<string, unknown>): Promise<boolean> {
		if (!this.fetchFn || this.signal?.aborted) return false;
		try {
			const response = await this.fetchWithTimeout(endpoint, {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
			});
			return response.ok;
		} catch {
			// JIT is optional; normal execution and provider fallback remain authoritative.
			return false;
		}
	}

	private async fetchWithTimeout(endpoint: string, init: RequestInit): Promise<Response> {
		if (!this.fetchFn) throw new Error('Fetch is unavailable.');
		const controller = new AbortController();
		const abort = () => controller.abort();
		this.signal?.addEventListener('abort', abort, { once: true });
		const timer = this.timeoutMs > 0 ? window.setTimeout(abort, this.timeoutMs) : undefined;
		try { return await this.fetchFn(endpoint, { ...init, signal: controller.signal }); }
		finally {
			if (timer !== undefined) window.clearTimeout(timer);
			this.signal?.removeEventListener('abort', abort);
		}
	}

	private serverRoot(baseURL: string): string {
		const url = new URL(baseURL);
		return `${url.protocol}//${url.host}`;
	}
	private ollamaEndpoint(baseURL: string): string { return `${this.serverRoot(baseURL)}/api/generate`; }
	private lmStudioEndpoint(baseURL: string, operation: 'load' | 'unload'): string {
		return `${this.serverRoot(baseURL)}/api/v1/models/${operation}`;
	}
}
