/** OpenAI-compatible speech-to-text adapter. */

import type { CommandCenterSettings } from '../settings';
import type { MultiProviderSettings, ProviderId } from '../providers/provider-types';
import { detectLocalRuntime, isLocalBaseUrl, sanitizeBaseUrl } from '../providers/provider-types';
import { PROVIDER_REGISTRY } from '../providers/provider-registry';
import { JitModelManager } from '../providers/jit-manager';

export interface TranscriptionOptions {
	model?: string;
	language?: string;
	prompt?: string;
	responseFormat?: 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt';
	temperature?: number;
	/** Seconds a local transcription server should retain the loaded model. */
	ttl?: number;
	/** Ollama-compatible retention duration. */
	keepAlive?: string | number;
	filename?: string;
}

export interface TranscriberAdapterOptions {
	providerId: ProviderId;
	getSettings: () => MultiProviderSettings | CommandCenterSettings;
	defaultModel?: string;
	/** Total attempts for transient network, 429, and 5xx failures. */
	maxAttempts?: number;
	backoffMs?: number;
	fetch?: typeof fetch;
	/** Resolve an ephemeral key from the memory-only credential vault. */
	getApiKey?: (providerId: ProviderId) => string;
	/** Cancels model discovery, transcription fetches, retries, and backoff waits. */
	signal?: AbortSignal;
}

export class TranscriptionError extends Error {
	readonly status?: number;
	readonly retryable: boolean;

	constructor(message: string, status?: number, retryable = false, cause?: unknown) {
		super(message);
		this.name = 'TranscriptionError';
		this.status = status;
		this.retryable = retryable;
		if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
	}
}

export class TranscriberAdapter {
	private readonly options: TranscriberAdapterOptions;
	private readonly jitModelManager: JitModelManager;
	private discoveredAudioModels: string[] | null = null;

	constructor(options: TranscriberAdapterOptions) {
		this.options = options;
		this.jitModelManager = new JitModelManager({
			fetch: options.fetch,
			signal: options.signal,
			getApiKey: () => options.getApiKey?.(options.providerId) ?? '',
		});
	}

	/** Query an OpenAI-compatible model catalog and retain only likely STT models. */
	async fetchLiveAudioModels(): Promise<string[]> {
		const { apiKey, baseUrl, meta } = this.resolveConnection();
		const fetchFn = this.options.fetch ?? window.fetch.bind(window);
		if (!fetchFn) throw new TranscriptionError('Fetch is not available in this environment.', undefined, false);
		const headers: Record<string, string> = {};
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
		let response: Response;
		try {
			response = await fetchFn(this.modelsUrl(baseUrl), { method: 'GET', headers, signal: this.options.signal });
		} catch (error) {
			throw new TranscriptionError(`Model discovery failed: ${error instanceof Error ? error.message : String(error)}`, undefined, true, error);
		}
		if (!response.ok) throw new TranscriptionError(`Model discovery failed with HTTP ${response.status} for ${meta.label}.`, response.status, response.status === 408 || response.status === 429 || response.status >= 500);
		const payload = await response.json() as { data?: unknown; models?: unknown };
		const entries = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
		const ids = entries.flatMap(entry => {
			if (typeof entry === 'string') return [entry];
			if (!entry || typeof entry !== 'object') return [];
			const value = entry as { id?: unknown; key?: unknown; name?: unknown; capabilities?: unknown };
			const id = [value.id, value.key, value.name].find(candidate => typeof candidate === 'string');
			const searchable = `${String(id ?? '')} ${JSON.stringify(value.capabilities ?? '')}`.toLowerCase();
			return typeof id === 'string' && /(whisper|speech[-_ ]?to[-_ ]?text|transcri|\bstt\b)/i.test(searchable) ? [id] : [];
		});
		this.discoveredAudioModels = [...new Set(ids)];
		return [...this.discoveredAudioModels];
	}

	/** Construct a fresh payload for each request/retry; FormData bodies are not reused. */
	buildFormData(audio: Blob, options: TranscriptionOptions = {}): FormData {
		if (!(audio instanceof Blob) || audio.size === 0) throw new Error('Cannot transcribe an empty audio blob.');
		const form = new FormData();
		const filename = options.filename ?? 'recording.webm';
		form.append('file', audio, filename);
		const model = this.resolveRequestModel(options.model);
		if (model) form.append('model', model);
		if (options.language) form.append('language', options.language);
		if (options.prompt) form.append('prompt', options.prompt);
		if (options.responseFormat) form.append('response_format', options.responseFormat);
		if (options.temperature !== undefined) form.append('temperature', String(options.temperature));

		const ttl = options.ttl ?? this.resolveConfiguredTtl();
		const runtime = this.localRuntime();
		if (runtime === 'ollama') {
			const keepAlive = options.keepAlive ?? this.resolveConfiguredKeepAlive();
			if (keepAlive !== undefined) form.append('keep_alive', String(keepAlive));
		} else if (runtime && ttl !== undefined && Number.isFinite(ttl) && ttl >= 0) {
			form.append('ttl', String(ttl));
		}
		return form;
	}

	async transcribe(audio: Blob, overrideModel?: string): Promise<string>;
	async transcribe(audio: Blob, options?: TranscriptionOptions): Promise<string>;
	async transcribe(audio: Blob, modelOrOptions: string | TranscriptionOptions = {}): Promise<string> {
		if (!(audio instanceof Blob) || audio.size === 0) throw new Error('Cannot transcribe an empty audio blob.');
		const options = typeof modelOrOptions === 'string' ? { model: modelOrOptions } : modelOrOptions;
		const attempts = Math.max(1, this.options.maxAttempts ?? 2);
		let lastError: TranscriptionError | undefined;

		for (let attempt = 1; attempt <= attempts; attempt++) {
			try {
				return await this.request(audio, options);
			} catch (error) {
				lastError = this.normalizeError(error);
				if (this.options.signal?.aborted || !lastError.retryable || attempt === attempts) throw lastError;
				await this.delay((this.options.backoffMs ?? 250) * 2 ** (attempt - 1));
			}
		}
		throw lastError ?? new TranscriptionError('Transcription failed.');
	}

	private async request(audio: Blob, options: TranscriptionOptions): Promise<string> {
		// Resolve credentials at request time so settings changes need no adapter rebuild.
		const { apiKey, baseUrl } = this.resolveConnection();
		const headers: Record<string, string> = {};
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
		const fetchFn = this.options.fetch ?? window.fetch.bind(window);
		if (!fetchFn) throw new TranscriptionError('Fetch is not available in this environment.', undefined, false);

		const model = this.resolveRequestModel(options.model);
		if (isLocalBaseUrl(baseUrl) && model && this.discoveredAudioModels === null) {
			await this.jitModelManager.ensureModelLoaded(baseUrl, model, options.ttl ?? this.resolveConfiguredTtl());
		}

		let response: Response;
		try {
			response = await fetchFn(this.transcriptionUrl(baseUrl), {
				method: 'POST',
				headers,
				body: this.buildFormData(audio, options),
				signal: this.options.signal,
			});
		} catch (error) {
			throw new TranscriptionError(
				`Transcription request failed: ${error instanceof Error ? error.message : String(error)}`,
				undefined,
				true,
				error,
			);
		}

		if (!response.ok) {
			const message = await this.readErrorMessage(response);
			const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
			throw new TranscriptionError(message, response.status, retryable);
		}

		const contentType = response.headers.get('content-type') ?? '';
		if (contentType.includes('application/json')) {
			const payload = await response.json() as { text?: unknown; error?: { message?: unknown } | string };
			if (typeof payload.text === 'string') {
				const text = payload.text.trim();
				if (text) return text;
			}
			throw new TranscriptionError('Transcription response did not contain text.', response.status, false);
		}
		const text = (await response.text()).trim();
		if (!text) throw new TranscriptionError('Transcription response did not contain text.', response.status, false);
		return text;
	}

	private resolveMultiProviderSettings(): MultiProviderSettings {
		const settings = this.options.getSettings();
		return 'multiProvider' in settings ? settings.multiProvider : settings;
	}

	private resolveConfiguredModel(): string | undefined {
		const defaults = this.resolveMultiProviderSettings().defaults as Record<string, unknown>;
		const configured = defaults.transcriptionModel;
		return typeof configured === 'string' && configured.trim() ? configured.trim() : undefined;
	}

	private resolveConfiguredTtl(): number {
		const configured = this.resolveMultiProviderSettings().defaults.ttl;
		return typeof configured === 'number' ? configured : 300;
	}

	private resolveConfiguredKeepAlive(): string | number {
		return this.resolveMultiProviderSettings().defaults.keepAlive ?? '5m';
	}

	private localRuntime(): ReturnType<typeof detectLocalRuntime> {
		const settings = this.resolveMultiProviderSettings();
		const credentials = settings.credentials[this.options.providerId];
		const baseUrl = sanitizeBaseUrl(credentials?.baseUrl || PROVIDER_REGISTRY[this.options.providerId].defaultBaseUrl || '');
		return detectLocalRuntime(baseUrl, this.options.providerId);
	}

	private resolveRequestModel(override?: string): string | undefined {
		const requested = override?.trim() || this.resolveConfiguredModel() || this.options.defaultModel;
		if (this.discoveredAudioModels !== null) {
			if (requested && this.discoveredAudioModels.includes(requested)) return requested;
			// Local catalogs are authoritative: choose a loaded STT model, or omit the
			// field so endpoints with an implicit model can select their own fallback.
			return this.discoveredAudioModels[0];
		}
		return requested || 'whisper-large-v3-turbo';
	}

	private resolveConnection(): { apiKey: string; baseUrl: string; meta: typeof PROVIDER_REGISTRY[ProviderId] } {
		const settings = this.resolveMultiProviderSettings();
		const credentials = settings.credentials[this.options.providerId];
		const meta = PROVIDER_REGISTRY[this.options.providerId];
		if (!credentials?.enabled) throw new TranscriptionError(`${meta.label} is not enabled for transcription.`, undefined, false);
		const apiKey = this.options.getApiKey?.(this.options.providerId).trim() || credentials?.apiKey?.trim() || '';
		if (meta.requiresKey && !apiKey) throw new TranscriptionError(`API key not configured for ${meta.label}.`, undefined, false);
		const baseUrl = sanitizeBaseUrl(credentials?.baseUrl || meta.defaultBaseUrl || '');
		if (!baseUrl) throw new TranscriptionError(`Base URL not configured for ${meta.label}.`, undefined, false);
		return { apiKey, baseUrl, meta };
	}

	private modelsUrl(baseUrl: string): string {
		const base = baseUrl.replace(/\/+$/, '');
		if (/\/models$/i.test(base)) return base;
		return /\/v1$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
	}

	private transcriptionUrl(baseUrl: string): string {
		const base = baseUrl.replace(/\/+$/, '');
		if (/\/audio\/transcriptions$/i.test(base)) return base;
		return /\/v1$/i.test(base) ? `${base}/audio/transcriptions` : `${base}/v1/audio/transcriptions`;
	}

	private async readErrorMessage(response: Response): Promise<string> {
		const fallback = `Transcription failed with HTTP ${response.status}.`;
		try {
			const text = await response.text();
			if (!text) return fallback;
			try {
				const payload = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
				if (typeof payload.error === 'string') return payload.error;
				if (payload.error && typeof payload.error.message === 'string') return payload.error.message;
				if (typeof payload.message === 'string') return payload.message;
			} catch { /* Preserve a plain-text provider error. */ }
			return text;
		} catch {
			return fallback;
		}
	}

	private normalizeError(error: unknown): TranscriptionError {
		return error instanceof TranscriptionError
			? error
			: new TranscriptionError(error instanceof Error ? error.message : String(error), undefined, false, error);
	}


	private delay(ms: number): Promise<void> {
		if (ms <= 0) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const signal = this.options.signal;
			const onAbort = (): void => {
				window.clearTimeout(timer);
				reject(new TranscriptionError('Transcription cancelled.', undefined, false));
			};
			const timer = window.setTimeout(() => {
				signal?.removeEventListener('abort', onAbort);
				resolve();
			}, ms);
			if (signal?.aborted) onAbort();
			else signal?.addEventListener('abort', onAbort, { once: true });
		});
	}
}
