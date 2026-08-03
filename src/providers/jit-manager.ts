/** Explicit local-model load/unload lifecycle for latency-sensitive workloads. */

import { detectLocalRuntime, isLocalBaseUrl } from './provider-types';

export interface JitModelManagerOptions {
	fetch?: typeof fetch;
	/** Optional bearer token resolver for authenticated local runtimes. */
	getApiKey?: () => string;
	signal?: AbortSignal;
	/** Maximum time for this optional optimization. Defaults to five seconds. */
	timeoutMs?: number;
}

export interface DownloadProgress {
	status: 'pending' | 'downloading' | 'completed' | 'failed';
	bytesDownloaded?: number;
	bytesTotal?: number;
	error?: string;
}

export class JitModelManager {
	private readonly fetchFn: typeof fetch | undefined;
	private readonly signal?: AbortSignal;
	private readonly timeoutMs: number;
	private readonly getApiKey: () => string;

	constructor(options: JitModelManagerOptions = {}) {
		this.fetchFn = options.fetch ?? window.fetch.bind(window);
		this.signal = options.signal;
		this.getApiKey = options.getApiKey ?? (() => '');
		this.timeoutMs = Math.max(0, options.timeoutMs ?? 120_000);
	}

	/**
	 * Check local state and pre-warm an unloaded model.
	 * If the model is not found locally, attempts to download it first.
	 * Never blocks normal inference on failure.
	 */
	async ensureModelLoaded(baseURL: string, modelId: string, ttlSeconds = 300, bearerToken = this.getApiKey()): Promise<boolean> {
		if (!isLocalBaseUrl(baseURL) || !modelId.trim() || !Number.isFinite(ttlSeconds) || ttlSeconds < 0) return false;
		const ollama = detectLocalRuntime(baseURL) === 'ollama';
		const state = await this.modelState(baseURL, modelId, ollama, bearerToken);

		// Model is already loaded
		if (state === true) return true;

		// Model exists but isn't loaded — load it
		if (state === 'exists') {
			if (ollama) {
				return this.post(this.ollamaEndpoint(baseURL), {
					model: modelId, prompt: '', stream: false, options: { num_predict: 0 }, keep_alive: ttlSeconds,
				}, bearerToken);
			}
			return this.post(this.lmStudioEndpoint(baseURL, 'load'), { model: modelId, ttl: ttlSeconds }, bearerToken);
		}

		// Model doesn't exist locally — try to download it first, then load directly
		if (state === 'missing') {
			const downloaded = await this.downloadModel(baseURL, modelId, bearerToken);
			if (!downloaded) return false;
			// Download initiated — load directly without re-checking state, since the
			// model may not appear in the list until the download completes.
			if (ollama) {
				return this.post(this.ollamaEndpoint(baseURL), {
					model: modelId, prompt: '', stream: false, options: { num_predict: 0 }, keep_alive: ttlSeconds,
				}, bearerToken);
			}
			return this.post(this.lmStudioEndpoint(baseURL, 'load'), { model: modelId, ttl: ttlSeconds }, bearerToken);
		}

		// State unknown — try loading directly (Ollama auto-downloads, LM Studio may fail)
		if (ollama) {
			return this.post(this.ollamaEndpoint(baseURL), {
				model: modelId, prompt: '', stream: false, options: { num_predict: 0 }, keep_alive: ttlSeconds,
			}, bearerToken);
		}
		// For LM Studio, try download + load
		const downloaded = await this.downloadModel(baseURL, modelId, bearerToken);
		if (!downloaded) return false;
		return this.post(this.lmStudioEndpoint(baseURL, 'load'), { model: modelId, ttl: ttlSeconds }, bearerToken);
	}

	/** Immediately release a local model after a bounded batch or ReAct session. */
	async evictModel(baseURL: string, modelId: string, bearerToken = this.getApiKey()): Promise<boolean> {
		if (!isLocalBaseUrl(baseURL) || !modelId.trim()) return false;
		if (detectLocalRuntime(baseURL) === 'ollama') {
			return this.post(this.ollamaEndpoint(baseURL), {
				model: modelId, prompt: '', stream: false, keep_alive: 0,
			}, bearerToken);
		}
		return this.post(this.lmStudioEndpoint(baseURL, 'unload'), { instance_id: modelId }, bearerToken);
	}

	/**
	 * Download a model to LM Studio from Hugging Face.
	 * POST /api/v1/models/download
	 *
	 * @param baseURL - LM Studio server base URL
	 * @param modelId - Hugging Face path (e.g. "lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF")
	 * @param bearerToken - Optional bearer token for authenticated servers
	 * @returns true if download was initiated successfully
	 */
	async downloadModel(baseURL: string, modelId: string, bearerToken = this.getApiKey()): Promise<boolean> {
		if (!isLocalBaseUrl(baseURL) || !modelId.trim()) return false;
		const runtime = detectLocalRuntime(baseURL);
		if (runtime !== 'lmstudio') return false;

		return this.post(this.lmStudioEndpoint(baseURL, 'download'), {
			identifier: modelId,
		}, bearerToken);
	}

	/**
	 * Check the progress of an in-progress model download.
	 * GET /api/v1/models/download/status?identifier={modelId}
	 *
	 * @param baseURL - LM Studio server base URL
	 * @param modelId - Model identifier to check
	 * @param bearerToken - Optional bearer token
	 * @returns Download progress info, or undefined if the request failed
	 */
	async getDownloadProgress(baseURL: string, modelId: string, bearerToken = this.getApiKey()): Promise<DownloadProgress | undefined> {
		if (!isLocalBaseUrl(baseURL) || !modelId.trim()) return undefined;
		const runtime = detectLocalRuntime(baseURL);
		if (runtime !== 'lmstudio') return undefined;

		try {
			const base = this.serverRoot(baseURL);
			const url = `${base}/api/v1/models/download/status?identifier=${encodeURIComponent(modelId)}`;
			const response = await this.fetchWithTimeout(url, {
				method: 'GET',
				headers: this.authHeaders(bearerToken),
			});
			if (!response.ok) return undefined;
			const data = await response.json() as Record<string, unknown>;
			return {
				status: (data.status as DownloadProgress['status']) ?? 'pending',
				bytesDownloaded: data.bytes_downloaded as number | undefined,
				bytesTotal: data.bytes_total as number | undefined,
				error: data.error as string | undefined,
			};
		} catch {
			return undefined;
		}
	}

	/** Backward-compatible lifecycle aliases. */
	async loadModel(baseURL: string, modelId: string, ttlSeconds = 300): Promise<boolean> {
		return this.ensureModelLoaded(baseURL, modelId, ttlSeconds);
	}
	async unloadModel(baseURL: string, modelId: string): Promise<boolean> {
		return this.evictModel(baseURL, modelId);
	}

	/**
	 * Check local model state — reports whether a model is loaded, exists but
	 * unloaded, or missing entirely.
	 */
	private async modelState(baseURL: string, modelId: string, ollama: boolean, bearerToken: string): Promise<boolean | 'exists' | 'missing' | undefined> {
		const endpoints = ollama
			? [`${this.serverRoot(baseURL)}/api/tags`, `${this.serverRoot(baseURL)}/v1/models`]
			: [`${this.serverRoot(baseURL)}/api/v1/models`, `${this.serverRoot(baseURL)}/v1/models`];
		for (const endpoint of endpoints) {
			const payload = await this.getJson(endpoint, bearerToken);
			if (!payload) continue;
			const entries = (Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : []) as unknown[];
			const found = entries.some(entry => {
				if (typeof entry === 'string') return entry === modelId;
				if (!entry || typeof entry !== 'object') return false;
				const item = entry as Record<string, unknown>;
				const id = item.id ?? item.key ?? item.model ?? item.name;
				return id === modelId;
			});
			if (!found) continue;

			// Found the model — check if it's loaded
			for (const entry of entries) {
				if (typeof entry === 'string') continue;
				if (!entry || typeof entry !== 'object') continue;
				const item = entry as Record<string, unknown>;
				const id = item.id ?? item.key ?? item.model ?? item.name;
				if (id !== modelId) continue;
				// LM Studio: `loaded_instances` is authoritative when present
				if (Array.isArray(item.loaded_instances)) return item.loaded_instances.length > 0 ? true : 'exists';
				if (item.loaded === false || item.state === 'unloaded' || item.status === 'unloaded') return 'exists';
				return true;
			}
			return 'exists';
		}
		return 'missing';
	}

	private async getJson(endpoint: string, bearerToken: string): Promise<Record<string, unknown> | undefined> {
		if (!this.fetchFn || this.signal?.aborted) return undefined;
		try {
			const response = await this.fetchWithTimeout(endpoint, { method: 'GET', headers: this.authHeaders(bearerToken) });
			return response.ok ? await response.json() as Record<string, unknown> : undefined;
		} catch { return undefined; }
	}

	private async post(endpoint: string, payload: Record<string, unknown>, bearerToken: string): Promise<boolean> {
		if (!this.fetchFn || this.signal?.aborted) return false;
		try {
			const response = await this.fetchWithTimeout(endpoint, {
				method: 'POST', headers: { 'Content-Type': 'application/json', ...this.authHeaders(bearerToken) }, body: JSON.stringify(payload),
			});
			return response.ok;
		} catch {
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

	private authHeaders(bearerToken = this.getApiKey()): Record<string, string> {
		const apiKey = bearerToken.trim();
		return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
	}

	private serverRoot(baseURL: string): string {
		const url = new URL(baseURL);
		return `${url.protocol}//${url.host}`;
	}
	private ollamaEndpoint(baseURL: string): string { return `${this.serverRoot(baseURL)}/api/generate`; }
	private lmStudioEndpoint(baseURL: string, operation: 'load' | 'unload' | 'download'): string {
		const base = `${this.serverRoot(baseURL)}/api/v1/models`;
		if (operation === 'download') return `${base}/download`;
		return `${base}/${operation}`;
	}
}

/** Exported endpoint helper for external use. */
export function getLMStudioDownloadUrl(baseURL: string): string {
	const url = new URL(baseURL);
	return `${url.protocol}//${url.host}/api/v1/models/download`;
}

/** Exported endpoint helper for download status. */
export function getLMStudioDownloadStatusUrl(baseURL: string, modelId: string): string {
	const url = new URL(baseURL);
	return `${url.protocol}//${url.host}/api/v1/models/download/status?identifier=${encodeURIComponent(modelId)}`;
}