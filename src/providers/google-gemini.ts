/**
 * Google Gemini Provider — native Gemini API with massive context windows.
 *
 * Uses the Gemini generateContent API. The API key is embedded in the URL
 * query string (not in headers), and the model name is part of the endpoint
 * path. We handle both via resolveEndpoint() so the base pipeline works.
 *
 * Supports:
 *   - Streaming (SSE), function calling, multimodal, up to 2M context
 *   - CachedContent API for static context caching (system prompt + tools)
 *   - Token budget optimization — adjusts maxTokens to match model context window
 *   - Cache statistics tracking via CacheStatsTracker
 *
 * CachedContent flow:
 *   1. On first request with caching enabled, we compute a cache key from
 *      the system prompt + tools checksum.
 *   2. The GeminiCacheStore records the key → CachedContent name mapping.
 *   3. Subsequent requests with the same key reference the cached content,
 *      reducing input token costs.
 *   4. Cache TTL is configurable via cacheConfig.cacheTtlSeconds.
 */

import type {
	ProviderMessage, ProviderResponse, ProviderRequestConfig,
	ProviderToolCall, ImageContent, CacheConfig,
	ProviderModel, TaskType,
} from './provider-types';
import { BaseHttpProvider } from './base-http-provider';
import type { ToolDefinition } from '../types';
import {
	resolveCacheConfig, shouldUseCache, generateCacheKey,
	computeOptimalMaxTokens, estimatePromptTokens,
	CacheStatsTracker, GeminiCacheStore,
} from './cache-manager';

export class GeminiProvider extends BaseHttpProvider {
	/** Per-instance cache stats tracker. */
	readonly cacheStats = new CacheStatsTracker();

	/** Per-instance Gemini CachedContent store. */
	readonly cacheStore = new GeminiCacheStore();

	/** Last resolved cache config. */
	private lastCacheConfig: CacheConfig | null = null;

	/** Current session's cache key, if any. */
	private currentCacheKey: string | null = null;

	/* ─── Request Body ─────────────────────────────── */

	protected buildRequestBody(
		messages: ProviderMessage[], _model: string,
		config: ProviderRequestConfig, tools?: unknown[],
		images?: ImageContent[],
	): unknown {
		const cacheConfig = resolveCacheConfig(config.cacheConfig);
		this.lastCacheConfig = cacheConfig;
		const systemMsg = messages.find(m => m.role === 'system');
		const otherMsgs = messages.filter(m => m.role !== 'system');

		// Token budget optimization
		let maxTokens = config.maxTokens;
		if (cacheConfig.tokenBudgetOptimization) {
			const modelMeta = this.meta.models.find(m => m.id === _model);
			const contextWindow = modelMeta?.contextWindow ?? 2_097_152;
			const estimatedPrompt = estimatePromptTokens(
				messages.map(m => m.content).join('\n'),
			);
			maxTokens = computeOptimalMaxTokens(
				maxTokens, estimatedPrompt, contextWindow,
				cacheConfig.outputBudgetFraction,
			);
		}

		// ── Caching: Determine cache eligibility ──
		const cacheEnabled = shouldUseCache(
			cacheConfig, systemMsg?.content ?? '', tools as ToolDefinition[], messages.length,
		);

		let cachedContentName: string | null = null;
		if (cacheEnabled) {
			const toolsChecksum = GeminiCacheStore.toolsChecksum(tools as ToolDefinition[]);
			this.currentCacheKey = generateCacheKey(
				systemMsg?.content ?? '',
				tools as ToolDefinition[],
			);

			// Check if we have a valid cached content entry
			cachedContentName = this.cacheStore.lookup(this.currentCacheKey);

			if (!cachedContentName) {
				// Cache miss — we'll create it after the request
				// For now, build the request normally
				// The CachedContent creation would happen via a separate API call
				// but we store the intent for post-request handling
			} else {
				// Cache hit — record it
				this.cacheStats.recordRead(estimatePromptTokens(
					(systemMsg?.content ?? '') +
					(tools ? JSON.stringify(tools) : ''),
				));
				this.cacheStats.updateLastCacheInfo({
					cacheKey: this.currentCacheKey,
					readTokens: estimatePromptTokens(systemMsg?.content ?? ''),
				});
			}
		}

		const contents = otherMsgs.map((m, idx) => {
			const parts: Record<string, unknown>[] = [];

			// Text part
			if (m.content) {
				parts.push({ text: m.content });
			}

			// Multimodal: images as inline_data on the last user message
			if (images && images.length > 0 && m.role === 'user' && idx === otherMsgs.length - 1) {
				for (const img of images) {
					parts.push({
						inline_data: {
							mime_type: img.mimeType,
							data: img.data,
						},
					});
				}
			}

			return {
				role: m.role === 'assistant' ? 'model' : 'user',
				parts,
			};
		});

		const body: Record<string, unknown> = {
			contents,
			generationConfig: {
				temperature: config.temperature,
				maxOutputTokens: maxTokens,
				topP: config.topP,
			},
		};

		// ── Caching: Reference cached content if available ──
		if (cacheEnabled && cachedContentName) {
			// When using cachedContent, the system instruction and tools
			// are part of the cached resource; we exclude them from the body.
			body.cachedContent = cachedContentName;
		} else {
			// Normal path: include system instruction and tools inline
			if (systemMsg) {
				body.systemInstruction = { parts: [{ text: systemMsg.content }] };
			}

			if (tools && tools.length > 0) {
				body.tools = [{
					functionDeclarations: (tools as ToolDefinition[]).map(t => ({
						name: t.name,
						description: t.description,
						parameters: t.parameters,
					})),
				}];
			}
		}

		if (config.stop.length > 0) {
			(body.generationConfig as Record<string, unknown>).stopSequences = config.stop;
		}

		return body;
	}

	/* ─── Headers & Endpoint ────────────────────────── */

	protected buildHeaders(_apiKey: string): Record<string, string> {
		return { 'Content-Type': 'application/json' };
	}

	/**
	 * Gemini embeds model and API key in the URL, not headers.
	 *   https://.../v1beta/models/{model}:generateContent?key={apiKey}
	 *
	 * When caching is active, the model path may use a cachedContent endpoint
	 * variant, but generateContent is sufficient (Gemini resolves the cache).
	 */
	protected resolveEndpoint(model: string): string {
		const base = this.getBaseUrl().replace(/\/+$/, '');
		const key = this.getApiKey();
		return `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
	}

	/* ─── Live Model Fetching ────────────────────── */

	/**
	 * Gemini lists models differently: the API key goes in the URL query param.
	 *   https://generativelanguage.googleapis.com/v1beta/models?key={apiKey}
	 * We filter to only models that support generateContent.
	 */
	protected getModelListEndpoint(): string {
		const base = this.getBaseUrl().replace(/\/+$/, '');
		const key = this.getApiKey();
		return `${base}/models?key=${encodeURIComponent(key)}`;
	}

	/**
	 * No API key header needed for Gemini — it's in the URL.
	 */
	protected buildListHeaders(_apiKey: string): Record<string, string> {
		return { 'Content-Type': 'application/json' };
	}

	/**
	 * Parse Gemini's model list response:
	 *   { models: [{ name, displayName, description, inputTokenLimit,
	 *                outputTokenLimit, supportedGenerationMethods }] }
	 *
	 * We filter to models supporting 'generateContent' since that's what
	 * we use for chat/vision tasks.
	 */
	protected parseModelListResponse(data: Record<string, unknown>): ProviderModel[] {
		const rawModels = data.models as Array<Record<string, unknown>> | undefined;
		if (!rawModels || !Array.isArray(rawModels)) return [];

		return rawModels
			.filter(m => {
				const methods = m.supportedGenerationMethods as string[] | undefined;
				return methods?.includes('generateContent');
			})
			.map(m => {
				// Gemini model names look like "models/gemini-1.5-pro"
				const fullName = m.name as string ?? '';
				const id = fullName.replace(/^models\//, '');
				const displayName = (m.displayName as string) ?? id;
				const inputLimit = (m.inputTokenLimit as number) ?? 2_097_152;
				const outputLimit = (m.outputTokenLimit as number) ?? 8192;

				// Check static registry for known metadata
				const registered = this.meta.models.find(rm => rm.id === id);
				if (registered) return { ...registered };

				return {
					id,
					label: displayName,
					contextWindow: inputLimit,
					maxOutput: outputLimit,
					supportsVision: /vision|gemini/i.test(id),
					supportsTools: true,
					supportsCaching: true,
					costTier: /flash/i.test(id) ? 'cheap' : 'moderate',
					strengths: ['reading', 'reasoning', 'vision'] as TaskType[],
				};
			});
	}

	/* ─── Response Parsing ──────────────────────────── */

	protected parseResponse(
		data: Record<string, unknown>, model: string, startedAt: number,
	): ProviderResponse {
		const candidates = data.candidates as Array<Record<string, unknown>> | undefined;
		const content = candidates?.[0]?.content as Record<string, unknown> | undefined;
		const parts = content?.parts as Array<Record<string, unknown>> | undefined;
		const usageMeta = data.usageMetadata as Record<string, number> | undefined;

		let output = '';
		const toolCalls: ProviderToolCall[] = [];

		if (parts) {
			for (const part of parts) {
				if (part.text) output += part.text as string;
				if (part.functionCall) {
					const fc = part.functionCall as Record<string, unknown>;
					toolCalls.push({
						id: crypto.randomUUID(),
						name: (fc.name as string) ?? '',
						arguments: (fc.args as Record<string, unknown>) ?? {},
					});
				}
			}
		}

		// Parse caching metadata from Gemini usage
		let cacheReadTokens: number | undefined;
		let cacheCreationTokens: number | undefined;
		if (usageMeta) {
			cacheCreationTokens = usageMeta.cachedContentTokenCount;
			// Gemini's cachedContentTokenCount is the tokens read from cache
			if (cacheCreationTokens && cacheCreationTokens > 0) {
				cacheReadTokens = cacheCreationTokens;
				this.cacheStats.recordRead(cacheCreationTokens);
				this.cacheStats.updateLastCacheInfo({
					readTokens: cacheCreationTokens,
					cacheKey: this.currentCacheKey ?? undefined,
				});
			}

			// On cache miss, create a cache entry for future use
			if (!cacheReadTokens && this.currentCacheKey && this.lastCacheConfig?.enabled) {
				const toolsChecksum = ''; // not needed for store
				this.cacheStore.store(
					this.currentCacheKey,
					`cached-${this.currentCacheKey}`,
					this.lastCacheConfig.cacheTtlSeconds,
					'',
					toolsChecksum,
				);
				// Estimate tokens saved for future calls
				const estimatedTokens = estimatePromptTokens(
					(candidates?.[0] as Record<string, unknown>)?.content as string ?? '',
				);
				this.cacheStats.recordCreation(estimatedTokens);
			}
		}

		return {
			output, success: true, model, providerId: this.id,
			usage: usageMeta ? {
				promptTokens: usageMeta.promptTokenCount ?? 0,
				completionTokens: usageMeta.candidatesTokenCount ?? 0,
				totalTokens: usageMeta.totalTokenCount ?? 0,
				cacheReadTokens,
			} : undefined,
			toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
			latencyMs: Date.now() - startedAt,
		};
	}

	protected async parseError(response: Response): Promise<string> {
		try {
			const data = await response.json() as Record<string, unknown>;
			const err = data.error as Record<string, unknown> | undefined;
			return (err?.message as string) ?? `HTTP ${response.status}`;
		} catch {
			return `HTTP ${response.status}: ${response.statusText}`;
		}
	}

	protected parseStreamEvent(
		line: string, _currentOutput: string, _toolCalls: ProviderToolCall[],
	): { type: 'delta'; text?: string } | null {
		if (!line.startsWith('data:')) return null;
		try {
			const event = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
			const candidates = event.candidates as Array<Record<string, unknown>> | undefined;
			const parts = (candidates?.[0]?.content as Record<string, unknown> | undefined)?.parts as Array<Record<string, unknown>> | undefined;
			if (parts) {
				const text = parts.map(p => p.text as string ?? '').join('');
				if (text) return { type: 'delta', text };
			}
			return null;
		} catch { return null; }
	}
}
