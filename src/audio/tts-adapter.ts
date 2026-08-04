/**
 * TtsAdapter — provider text-to-speech via OpenAI-compatible /audio/speech
 * (and xAI's native /v1/tts). Returns an audio Blob playable through an
 * HTMLAudioElement. Falls back to the browser's speechSynthesis when no
 * provider TTS is configured (handled by the caller).
 *
 * Supported providers:
 *   - OpenAI:          POST /v1/audio/speech     { model, input, voice, response_format }
 *   - OpenRouter:      POST /api/v1/audio/speech (same body, routed slugs)
 *   - Mistral:         POST /v1/audio/speech     (Voxtral TTS)
 *   - xAI:             POST /v1/tts              { model, input, voice }
 *   - DeepInfra/Groq/Custom/LM Studio/Ollama: OpenAI-compatible /audio/speech
 *
 * Auth: Bearer token (x-api-key is xAI/Anthropic-specific; TTS providers all use Bearer).
 *
 * @see https://platform.openai.com/docs/api-reference/audio/createSpeech
 * @see https://docs.x.ai/developers/rest-api-reference/text-to-speech
 */

import type { CommandCenterSettings } from '../settings/settings-model';
import type { MultiProviderSettings, ProviderId } from '../providers/provider-types';
import { sanitizeBaseUrl } from '../providers/provider-types';
import {
	PROVIDER_REGISTRY,
	DEFAULT_TTS_MODELS,
	DEFAULT_TTS_VOICES,
	OPENAI_COMPATIBLE_TTS_PROVIDERS,
} from '../providers/provider-registry';
import { XAI_TTS_URL_PATH } from '../providers/xai';

export interface TtsOptions {
	/** Override the resolved model slug. */
	model?: string;
	/** Override the resolved voice id. */
	voice?: string;
	/** Audio format: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm' (provider-dependent). */
	responseFormat?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
	/** Speech speed 0.25–4.0 (OpenAI supports 0.25–4.0; xAI supports 0.5–5.0). */
	speed?: number;
	/** Optional input audio for voice cloning (provider-specific; unsupported here when omitted). */
}

export interface TtsAdapterOptions {
	providerId: ProviderId;
	getSettings: () => MultiProviderSettings | CommandCenterSettings;
	getApiKey: (providerId: ProviderId) => string;
	/** Cancels the in-flight synthesis request. */
	signal?: AbortSignal;
	/** Injectable fetch (tests); defaults to window.fetch. */
	fetch?: typeof fetch;
}

export class TtsError extends Error {
	readonly status?: number;
	readonly retryable: boolean;
	constructor(message: string, status?: number, retryable = false, cause?: unknown) {
		super(message);
		this.name = 'TtsError';
		this.status = status;
		this.retryable = retryable;
		if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
	}
}

export class TtsAdapter {
	private readonly options: TtsAdapterOptions;

	constructor(options: TtsAdapterOptions) {
		this.options = options;
	}

	/** True when the provider has a known TTS endpoint + default model. */
	static supportsProvider(providerId: ProviderId): boolean {
		return providerId === 'xai' || OPENAI_COMPATIBLE_TTS_PROVIDERS.has(providerId);
	}

	/**
	 * Synthesize `text` into an audio Blob ready for `HTMLAudioElement`.
	 * Throws TtsError on any failure (caller falls back to browser speechSynthesis).
	 */
	async synthesize(text: string, options: TtsOptions = {}): Promise<Blob> {
		if (!text.trim()) throw new TtsError('Nothing to synthesize (empty text).', undefined, false);
		const { apiKey, baseUrl } = this.resolveConnection();
		const model = this.resolveModel(options.model);
		const voice = this.resolveVoice(options.voice);
		const url = this.synthesisUrl(baseUrl);
		const body = this.buildBody(model, text, voice, options);
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

		const fetchFn = this.options.fetch ?? window.fetch.bind(window);
		if (!fetchFn) throw new TtsError('Fetch is not available in this environment.', undefined, false);

		let response: Response;
		try {
			response = await fetchFn(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: this.options.signal,
			});
		} catch (error) {
			if (this.options.signal?.aborted) throw new TtsError('TTS cancelled.', undefined, false, error);
			throw new TtsError(
				`TTS request failed: ${error instanceof Error ? error.message : String(error)}`,
				undefined, true, error,
			);
		}

		if (!response.ok) {
			const message = await this.readErrorMessage(response);
			const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
			throw new TtsError(message, response.status, retryable);
		}

		// The audio body is returned as binary (audio/mpeg, audio/ogg, etc.).
		const contentType = response.headers.get('content-type') ?? 'audio/mpeg';
		const arrayBuffer = await response.arrayBuffer();
		return new Blob([arrayBuffer], { type: contentType });
	}

	/* ─── Helpers ──────────────────────────────────────────── */

	private resolveConnection(): { apiKey: string; baseUrl: string } {
		const settings = this.resolveMultiProviderSettings();
		const credentials = settings.credentials[this.options.providerId];
		const meta = PROVIDER_REGISTRY[this.options.providerId];
		if (!credentials?.enabled) throw new TtsError(`${meta.label} is not enabled for TTS.`, undefined, false);
		const apiKey = this.options.getApiKey(this.options.providerId).trim() || credentials?.apiKey?.trim() || '';
		if (meta.requiresKey && !apiKey) throw new TtsError(`API key not configured for ${meta.label}.`, undefined, false);
		const baseUrl = sanitizeBaseUrl(credentials?.baseUrl || meta.defaultBaseUrl || '');
		if (!baseUrl) throw new TtsError(`Base URL not configured for ${meta.label}.`, undefined, false);
		return { apiKey, baseUrl };
	}

	private resolveMultiProviderSettings(): MultiProviderSettings {
		const settings = this.options.getSettings();
		return 'multiProvider' in settings ? settings.multiProvider : settings;
	}

	private resolveModel(override?: string): string {
		const requested = override?.trim();
		if (requested) return requested;
		// Per-provider override from settings.
		const settings = this.options.getSettings();
		if ('textToSpeechModels' in settings) {
			const perProvider = (settings.textToSpeechModels as Partial<Record<ProviderId, string>> | undefined)?.[this.options.providerId];
			if (perProvider && perProvider.trim()) return perProvider.trim();
		}
		// Global TTS model fallback.
		if ('textToSpeechModel' in settings && typeof settings.textToSpeechModel === 'string' && settings.textToSpeechModel.trim()) {
			return settings.textToSpeechModel.trim();
		}
		// Discovered live TTS model from the provider's /models catalog (if available).
		// Mirrors the STT path: scan liveModels for a TTS-capable entry before
		// falling back to the static default.
		const mp = this.resolveMultiProviderSettings();
		const liveTts = mp.liveModels?.[this.options.providerId]?.find(model =>
			/(\btts\b|text[-_ ]?to[-_ ]?speech|speech[-_ ]?synthesis|voxtral[-_ ]?tts|grok[-_ ]?tts|tts[-_ ]?1)/i.test(model.id),
		);
		if (liveTts?.id) return liveTts.id;
		const fallback = DEFAULT_TTS_MODELS[this.options.providerId];
		if (fallback) return fallback;
		throw new TtsError(`No default TTS model for ${this.options.providerId}.`, undefined, false);
	}

	private resolveVoice(override?: string): string {
		const requested = override?.trim();
		if (requested) return requested;
		const settings = this.options.getSettings();
		if ('textToSpeechApiVoice' in settings && typeof settings.textToSpeechApiVoice === 'string' && settings.textToSpeechApiVoice.trim()) {
			return settings.textToSpeechApiVoice.trim();
		}
		return DEFAULT_TTS_VOICES[this.options.providerId] ?? 'alloy';
	}

	/** xAI uses /v1/tts; all others use the OpenAI-compatible /audio/speech. */
	private synthesisUrl(baseUrl: string): string {
		const base = baseUrl.replace(/\/+$/, '');
		if (this.options.providerId === 'xai') {
			const path = XAI_TTS_URL_PATH.startsWith('/') ? XAI_TTS_URL_PATH : `/${XAI_TTS_URL_PATH}`;
			const serverRoot = base.replace(/\/v\d+$/i, '');
			return `${serverRoot}${path}`;
		}
		if (/\/audio\/speech$/i.test(base)) return base;
		return `${base}/audio/speech`;
	}

	private buildBody(
		model: string, text: string, voice: string, options: TtsOptions,
	): Record<string, unknown> {
		const body: Record<string, unknown> = { model, input: text, voice };
		// xAI does not accept response_format; OpenAI-compatible providers do.
		if (this.options.providerId !== 'xai') {
			const format = options.responseFormat ?? 'mp3';
			body.response_format = format;
		}
		if (options.speed !== undefined && Number.isFinite(options.speed) && options.speed > 0) {
			body.speed = options.speed;
		}
		return body;
	}

	private async readErrorMessage(response: Response): Promise<string> {
		const fallback = `TTS failed with HTTP ${response.status}.`;
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
}

/**
 * Play a TTS audio Blob through a hidden HTMLAudioElement.
 * Returns a promise that resolves when playback completes (or rejects on error).
 */
export function playTtsBlob(blob: Blob, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(blob);
		const audio = document.body.createEl('audio');
		audio.src = url;
		audio.hidden = true;
		audio.addClass('cc-tts-player');

		const cleanup = (): void => {
			audio.pause();
			audio.remove();
			URL.revokeObjectURL(url);
		};
		const onAbort = (): void => { cleanup(); reject(new TtsError('TTS cancelled.', undefined, false)); };
		audio.onended = (): void => { cleanup(); resolve(); };
		audio.onerror = (): void => { cleanup(); reject(new TtsError('Audio playback failed.', undefined, false)); };
		if (signal?.aborted) { onAbort(); return; }
		signal?.addEventListener('abort', onAbort, { once: true });
		void audio.play().catch(err => { cleanup(); reject(new TtsError(`Playback failed: ${err instanceof Error ? err.message : String(err)}`, undefined, false)); });
	});
}
