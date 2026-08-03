/**
 * xAI (Grok) Provider — OpenAI-compatible chat + native STT/TTS endpoints.
 *
 * Chat: POST /v1/chat/completions (OpenAI-compatible)
 * STT:  POST /v1/stt               (NOT OpenAI-compatible /v1/audio/transcriptions)
 * TTS:  POST /v1/tts               (native REST endpoint)
 *       GET  /v1/tts/voices        (list voices)
 *       GET  /v1/tts/voices/{id}   (voice details)
 *
 * Models: grok-4.5, grok-4.3, grok-4.20-reasoning, grok-build-0.1,
 *         grok-stt, grok-tts
 *
 * @see https://docs.x.ai/developers/rest-api-reference/inference
 */

import { OpenAICompatibleProvider } from './openai-compatible';

/* ─── xAI-specific STT/TTS URL helpers ─────────────────── */

/** xAI STT endpoint is /v1/stt, not OpenAI's /v1/audio/transcriptions. */
export const XAI_STT_URL_PATH = '/v1/stt';
/** xAI TTS endpoint is /v1/tts. */
export const XAI_TTS_URL_PATH = '/v1/tts';
/** xAI voices list endpoint. */
export const XAI_VOICES_URL_PATH = '/v1/tts/voices';

/* ─── Provider Adapter ─────────────────────────────────── */

export class XAIProvider extends OpenAICompatibleProvider {
	/**
	 * Override the endpoint to ensure we use the correct base for all
	 * xAI API calls. The base class sends to /v1/chat/completions which
	 * is correct for chat.
	 */
	protected getEndpoint(): string {
		const base = this.getBaseUrl().replace(/\/+$/, '');
		if (/\/v1\/chat\/completions$/i.test(base)) return base;
		return /\/v1$/i.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
	}

	/**
	 * xAI STT transcription URL — POST /v1/stt.
	 * This differs from the OpenAI-compatible /v1/audio/transcriptions.
	 */
	static getSttUrl(baseUrl: string): string {
		const base = baseUrl.replace(/\/+$/, '');
		if (/\/stt$/i.test(base)) return base;
		if (/\/v1$/i.test(base)) return `${base}/stt`;
		return `${base}/v1/stt`;
	}

	/**
	 * xAI TTS generation URL — POST /v1/tts.
	 */
	static getTtsUrl(baseUrl: string): string {
		const base = baseUrl.replace(/\/+$/, '');
		if (/\/tts$/i.test(base)) return base;
		if (/\/v1$/i.test(base)) return `${base}/tts`;
		return `${base}/v1/tts`;
	}

	/**
	 * xAI voices list URL — GET /v1/tts/voices.
	 */
	static getVoicesUrl(baseUrl: string): string {
		const base = baseUrl.replace(/\/+$/, '');
		if (/\/tts\/voices$/i.test(base)) return base;
		if (/\/v1$/i.test(base)) return `${base}/tts/voices`;
		return `${base}/v1/tts/voices`;
	}

	/**
	 * Fetch available TTS voices from xAI.
	 * Returns an array of { voice_id, name, language } objects.
	 */
	async fetchVoices(): Promise<Array<{ voiceId: string; name: string; language: string }>> {
		const url = XAIProvider.getVoicesUrl(this.getBaseUrl());
		const headers = this.buildHeaders(this.getApiKey());
		try {
			const { requestUrl } = await import('../obsidian-request');
			const voicesResp = await requestUrl({
				url,
				method: 'GET',
				headers,
			});
			const payload = voicesResp.json as { voices?: Array<{ voice_id?: string; name?: string; language?: string }> };
			if (!payload.voices || !Array.isArray(payload.voices)) return [];
			return payload.voices.map(v => ({
				voiceId: v.voice_id ?? '',
				name: v.name ?? '',
				language: v.language ?? 'multilingual',
			})).filter(v => v.voiceId.length > 0);
		} catch {
			return [];
		}
	}
}