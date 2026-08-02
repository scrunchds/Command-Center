/** OpenAI-compatible speech-to-text adapter. */

import type { CommandCenterSettings } from '../settings/settings-model';
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

export interface TranscriptionCandidate {
	providerId: ProviderId;
	model?: string;
	label: string;
	local: boolean;
}

const TRANSCRIPTION_PROVIDER_ORDER: ProviderId[] = [
	'lmstudio',
	'ollama',
	'groq',
	'openai',
	'deepinfra',
	'openrouter',
	'custom',
];

function getConfiguredTranscriptionModel(settings: MultiProviderSettings | CommandCenterSettings): string | undefined {
	if ('speechToTextModel' in settings && typeof settings.speechToTextModel === 'string') {
		const configured = settings.speechToTextModel.trim();
		if (configured) return configured;
	}
	const mp = 'multiProvider' in settings ? settings.multiProvider : settings;
	const configured = (mp.defaults as Record<string, unknown>).transcriptionModel;
	return typeof configured === 'string' && configured.trim() ? configured.trim() : undefined;
}

function getPreferredTranscriptionProvider(settings: MultiProviderSettings | CommandCenterSettings): 'auto' | ProviderId {
	return 'speechToTextProviderId' in settings ? settings.speechToTextProviderId : 'auto';
}

function providerOrder(preferred: 'auto' | ProviderId): ProviderId[] {
	if (preferred === 'auto' || !TRANSCRIPTION_PROVIDER_ORDER.includes(preferred)) return [...TRANSCRIPTION_PROVIDER_ORDER];
	return [preferred, ...TRANSCRIPTION_PROVIDER_ORDER.filter(providerId => providerId !== preferred)];
}

export function buildTranscriptionCandidates(
	settings: MultiProviderSettings | CommandCenterSettings,
	options: {
		hasApiKey?: (providerId: ProviderId) => boolean;
	} = {},
): TranscriptionCandidate[] {
	if ('speechToTextEnabled' in settings && settings.speechToTextEnabled === false) return [];
	const mp = 'multiProvider' in settings ? settings.multiProvider : settings;
	const configuredModel = getConfiguredTranscriptionModel(settings);
	const preferred = getPreferredTranscriptionProvider(settings);
	return providerOrder(preferred).flatMap(providerId => {
		const credentials = mp.credentials[providerId];
		const meta = PROVIDER_REGISTRY[providerId];
		if (!credentials?.enabled || (!credentials.baseUrl && !meta.defaultBaseUrl)) return [];
		if (meta.requiresKey && options.hasApiKey && !options.hasApiKey(providerId)) return [];
		const local = providerId === 'lmstudio' || providerId === 'ollama';
		const persisted = mp.liveModels?.[providerId]?.find(model => /(whisper|speech[-_ ]?to[-_ ]?text|transcri|\bstt\b)/i.test(model.id));
		const model = persisted?.id ?? configuredModel ?? (providerId === 'groq' ? 'whisper-large-v3' : local ? undefined : 'whisper-large-v3-turbo');
		const providerLabel = providerId === 'lmstudio' ? 'Local LM Studio' : providerId === 'ollama' ? 'Local Ollama' : meta.label;
		return [{ providerId, model, label: `${providerLabel} (${model ?? 'automatic Whisper'})`, local }];
	});
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
		// Derive the filename extension from the actual blob MIME type so the
		// provider can decode the audio correctly.  A hardcoded .webm extension
		// can cause hallucinated filler text (e.g. "Thank you.") when the browser
		// falls back to a different codec.
		const ext = mimeExtension(audio.type) || 'webm';
		const filename = options.filename ?? `recording.${ext}`;
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
			const payload = await response.json() as Record<string, unknown>;
			const extracted = extractTranscriptionText(payload);
			if (extracted) return extracted;
			// Include the actual response shape so provider mismatches are debuggable
			// instead of surfacing as a generic "did not contain text" failure.
			throw new TranscriptionError(
				`Transcription response did not contain text (received ${describeResponse(payload)}).`,
				response.status,
				false,
			);
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

/* ─── Helpers ──────────────────────────────────────────── */

/**
 * Extract transcription text from a JSON response, trying multiple common formats.
 *
 * Providers (OpenRouter, Groq, etc.) may return the transcription in one of
 * several field names.  This function tries them in priority order and returns
 * the first non-empty string found.
 */
function extractTranscriptionText(payload: Record<string, unknown>): string | undefined {
	// Priority-ordered list of field names that may hold transcription text.
	const candidates = ['text', 'transcript', 'results', 'transcription', 'content', 'output'];
	for (const key of candidates) {
		const value = payload[key];
		if (typeof value === 'string') {
			const trimmed = value.trim();
			if (trimmed) return trimmed;
		}
		// Some providers wrap the text in an array or object.
		if (Array.isArray(value) && value.length > 0) {
			for (const item of value) {
				if (typeof item === 'string') {
					const trimmed = item.trim();
					if (trimmed) return trimmed;
				}
				if (item && typeof item === 'object') {
					const nested = extractTranscriptionText(item as Record<string, unknown>);
					if (nested) return nested;
				}
			}
		}
	}
	// Last resort: check for a nested structure like { data: { text: "..." } }
	if (payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) {
		const nested = extractTranscriptionText(payload.data as Record<string, unknown>);
		if (nested) return nested;
	}
	return undefined;
}

/**
 * Build a compact human-readable description of a JSON response shape.
 * This is included in the error message so users (and developers) can see
 * what the provider actually returned without needing to open DevTools.
 */
function describeResponse(payload: Record<string, unknown>, maxDepth = 2): string {
	const seen = new Set<unknown>();
	function describe(value: unknown, depth: number): string {
		if (depth > maxDepth) return '…';
		if (value === null) return 'null';
		if (value === undefined) return 'undefined';
		if (typeof value === 'string') {
			const truncated = value.length > 60 ? value.slice(0, 57) + '…' : value;
			return JSON.stringify(truncated);
		}
		if (typeof value === 'number' || typeof value === 'boolean') return String(value);
		if (Array.isArray(value)) {
			if (value.length === 0) return '[]';
			if (seen.has(value)) return '[Circular]';
			seen.add(value);
			// Show first element type as a hint.
			const first = describe(value[0], depth + 1);
			seen.delete(value);
			return `[${value.length} items, first: ${first}]`;
		}
		if (typeof value === 'object') {
			if (seen.has(value)) return '{Circular}';
			seen.add(value);
			const keys = Object.keys(value);
			const parts = keys.slice(0, 5).map(k => `${k}: ${describe((value as Record<string, unknown>)[k], depth + 1)}`);
			if (keys.length > 5) parts.push(`…+${keys.length - 5} keys`);
			seen.delete(value);
			return `{${parts.join(', ')}}`;
		}
		// Fallback for functions, symbols, and other primitives.
		const str = typeof value === 'function' ? value.name || 'ƒ' : typeof value === 'symbol' ? value.description || 'Symbol' : JSON.stringify(value);
		return str ?? '?';
	}
	return describe(payload, 0);
}

/**
 * Map a MIME type to a file extension suitable for multipart transcription requests.
 * Falls back to 'webm' when the type is unknown or missing.
 */
function mimeExtension(mime: string): string | undefined {
	const map: Record<string, string> = {
		'audio/webm': 'webm',
		'audio/webm;codecs=opus': 'webm',
		'audio/ogg': 'ogg',
		'audio/ogg;codecs=opus': 'ogg',
		'audio/mp4': 'm4a',
		'audio/mpeg': 'mp3',
		'audio/mp3': 'mp3',
		'audio/wav': 'wav',
		'audio/x-wav': 'wav',
		'audio/flac': 'flac',
		'audio/aac': 'aac',
	};
	// Normalise: strip parameters like codecs for a safe lookup.
	const normalised = mime.split(';')[0]?.trim().toLowerCase() ?? '';
	return map[normalised] ?? map[mime];
}