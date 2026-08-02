/**
 * Anthropic Provider — native Claude API with prompt caching and tool-use optimization.
 *
 * Uses the Anthropic Messages API (not OpenAI-compatible). Supports:
 *   - Streaming via SSE
 *   - Tool use (function calling)
 *   - Prompt caching (cache_control) — system prompt, tools, and conversation turns
 *   - Token budget optimization — adjusts maxTokens to match model context window
 *   - Extended thinking (for Opus)
 *
 * Cache strategy:
 *   - System prompt: cached via `cache_control: {type: "ephemeral"}` on the
 *     system content block (array format). Requires ~1024+ token threshold.
 *   - Tool definitions: cached via `cache_control` on the last tool entry.
 *   - Conversation history: when strategy='aggressive', the first N user
 *     messages get `cache_control` on their text content blocks.
 *   - Cache stats are tracked per-instance via CacheStatsTracker.
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
	buildAnthropicSystemBlock, applyAnthropicToolCache,
	applyAnthropicMessageCache, CacheStatsTracker,
} from './cache-manager';

export class AnthropicProvider extends BaseHttpProvider {
	/** Per-instance cache stats tracker. */
	readonly cacheStats = new CacheStatsTracker();

	/** Last resolved cache config for debugging and settings UI. */
	private lastCacheConfig: CacheConfig | null = null;

	/** Cache key for the current session (system prompt + tools hash). */
	private currentCacheKey: string | null = null;

	protected buildRequestBody(
		messages: ProviderMessage[], model: string,
		config: ProviderRequestConfig, tools?: unknown[],
		images?: ImageContent[],
	): unknown {
		const cacheConfig = resolveCacheConfig(config.cacheConfig);
		this.lastCacheConfig = cacheConfig;
		const cacheEnabled = shouldUseCache(
			cacheConfig, messages[0]?.content ?? '', tools as ToolDefinition[], messages.length,
		);

		if (cacheEnabled && cacheConfig.cacheSystemPrompt) {
			this.currentCacheKey = generateCacheKey(
				messages[0]?.content ?? '',
				tools as ToolDefinition[],
			);
		} else {
			this.currentCacheKey = null;
		}

		// Token budget optimization
		let maxTokens = config.maxTokens;
		if (cacheConfig.tokenBudgetOptimization) {
			const modelMeta = this.meta.models.find(m => m.id === model);
			const contextWindow = modelMeta?.contextWindow ?? 200_000;
			const estimatedPrompt = estimatePromptTokens(
				messages.map(m => m.content).join('\n'),
			);
			maxTokens = computeOptimalMaxTokens(
				maxTokens, estimatedPrompt, contextWindow,
				cacheConfig.outputBudgetFraction,
			);
		}

		// Anthropic uses a different message structure
		const systemMsg = messages.find(m => m.role === 'system');
		const otherMsgs = messages.filter(m => m.role !== 'system');

		const body: Record<string, unknown> = {
			model,
			max_tokens: maxTokens,
			temperature: config.temperature,
			messages: otherMsgs.map((m, idx) => {
				const entry: Record<string, unknown> = { role: m.role };

				// ── Multimodal: images go in the last user message ──
				if (images && images.length > 0 && m.role === 'user' && idx === otherMsgs.length - 1) {
					const contentArray: Record<string, unknown>[] = [];
					if (m.content) {
						contentArray.push({ type: 'text', text: m.content });
					}
					for (const img of images) {
						contentArray.push({
							type: 'image',
							source: {
								type: 'base64',
								media_type: img.mimeType,
								data: img.data,
							},
						});
					}
					entry.content = contentArray;
					return entry;
				}

				// Normal content string
				entry.content = m.content;

				if (m.toolCalls && m.role === 'assistant') {
					entry.content = m.toolCalls.map(tc => ({
						type: 'tool_use',
						id: tc.id,
						name: tc.name,
						input: tc.arguments,
					}));
				}
				if (m.toolCallId && m.role === 'tool') {
					entry.content = [{
						type: 'tool_result',
						tool_use_id: m.toolCallId,
						content: m.content,
					}];
				}
				return entry;
			}),
		};

		// ── Caching: System Prompt ──
		if (systemMsg) {
			const systemBlock = buildAnthropicSystemBlock(systemMsg.content, cacheEnabled ? cacheConfig : { ...cacheConfig, enabled: false });
			body.system = systemBlock;
		}

		// ── Caching: Tools ──
		if (tools && tools.length > 0) {
			let formattedTools = (tools as ToolDefinition[]).map(t => ({
				name: t.name,
				description: t.description,
				input_schema: t.parameters,
			}));
			if (cacheEnabled) {
				formattedTools = applyAnthropicToolCache(formattedTools, cacheConfig, this.currentCacheKey ?? undefined) as typeof formattedTools;
			}
			body.tools = formattedTools;
		}

		// ── Caching: Conversation history turns ──
		if (cacheEnabled && cacheConfig.strategy === 'aggressive' && cacheConfig.cacheHistoryTurns > 0) {
			const msgs = body.messages as Record<string, unknown>[];
			for (let i = 0; i < msgs.length; i++) {
				const msg = msgs[i]!;
				if (msg.role === 'user' && Array.isArray(msg.content)) {
					msg.content = applyAnthropicMessageCache(
						msg.content as Record<string, unknown>[],
						i, cacheConfig,
					);
				}
			}
		}

		if (config.stop.length > 0) body.stop_sequences = config.stop;
		if (config.topP < 1.0) body.top_p = config.topP;

		return body;
	}

	protected buildHeaders(apiKey: string): Record<string, string> {
		// Anthropic recommends setting anthropic-beta for prompt caching
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'x-api-key': apiKey,
			'anthropic-version': '2023-06-01',
		};
		// Enable prompt caching via header (required for cache_control to take effect)
		if (this.lastCacheConfig?.enabled) {
			headers['anthropic-beta'] = 'prompt-caching-2024-07-31';
		}
		return headers;
	}

	/* ─── Live Model Fetching ────────────────────── */

	/**
	 * Anthropic's model list endpoint uses the same base URL.
	 * Auth uses x-api-key header, handled by buildListHeaders.
	 */
	protected buildListHeaders(apiKey: string): Record<string, string> {
		return {
			'Content-Type': 'application/json',
			'x-api-key': apiKey,
			'anthropic-version': '2023-06-01',
		};
	}

	/**
	 * Parse Anthropic's model list response:
	 *   { data: [{ type, id, display_name, created_at }] }
	 */
	protected parseModelListResponse(data: Record<string, unknown>): ProviderModel[] {
		const rawModels = data.data as Array<Record<string, unknown>> | undefined;
		if (!rawModels || !Array.isArray(rawModels)) return [];

		return rawModels
			.filter(m => m.id && typeof m.id === 'string' && m.type === 'model')
			.map(m => {
				const id = m.id as string;
				const displayName = (m.display_name as string) ?? id;

				// Check static registry for known metadata
				const registered = this.meta.models.find(rm => rm.id === id);
				if (registered) return { ...registered };

				return {
					id,
					label: displayName,
					contextWindow: /claude-3/.test(id) ? 200_000 : 100_000,
					maxOutput: 8192,
					supportsVision: /claude-3/.test(id),
					supportsTools: true,
					supportsCaching: true,
					costTier: /haiku/i.test(id) ? 'cheap' : /opus/i.test(id) ? 'expensive' : 'moderate',
					strengths: ['reasoning', 'coding', 'reading'] as TaskType[],
				};
			});
	}

	protected getEndpoint(): string {
		return `${this.getBaseUrl().replace(/\/+$/, '')}/messages`;
	}

	protected parseResponse(
		data: Record<string, unknown>, model: string, startedAt: number,
	): ProviderResponse {
		const content = data.content as Array<Record<string, unknown>> | undefined;
		const usageRaw = data.usage as Record<string, number> | undefined;

		let output = '';
		const toolCalls: ProviderToolCall[] = [];

		if (content) {
			for (const block of content) {
				if (block.type === 'text') {
					output += (block.text as string) ?? '';
				}
				if (block.type === 'tool_use') {
					toolCalls.push({
						id: (block.id as string) ?? '',
						name: (block.name as string) ?? '',
						arguments: (block.input as Record<string, unknown>) ?? {},
					});
				}
			}
		}

		// Parse cache metrics from usage
		let cacheCreationTokens: number | undefined;
		let cacheReadTokens: number | undefined;
		if (usageRaw) {
			cacheCreationTokens = usageRaw.cache_creation_input_tokens;
			cacheReadTokens = usageRaw.cache_read_input_tokens;

			// Track cache hits/misses
			if (cacheCreationTokens && cacheCreationTokens > 0) {
				this.cacheStats.recordCreation(cacheCreationTokens);
			}
			if (cacheReadTokens && cacheReadTokens > 0) {
				this.cacheStats.recordRead(cacheReadTokens);
			}
			if (cacheCreationTokens || cacheReadTokens) {
				this.cacheStats.updateLastCacheInfo({
					creationTokens: cacheCreationTokens,
					readTokens: cacheReadTokens,
					cacheKey: this.currentCacheKey ?? undefined,
				});
			}
		}

		return {
			output, success: true, model, providerId: this.id,
			usage: usageRaw ? {
				promptTokens: usageRaw.input_tokens ?? 0,
				completionTokens: usageRaw.output_tokens ?? 0,
				totalTokens: (usageRaw.input_tokens ?? 0) + (usageRaw.output_tokens ?? 0),
				cacheCreationTokens,
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
	): { type: 'delta'; text?: string } | { type: 'tool_call'; toolCall?: ProviderToolCall } | { type: 'usage'; usage?: { promptTokens: number; completionTokens: number; totalTokens: number; cacheReadTokens?: number; cacheCreationTokens?: number } } | null {
		// Anthropic SSE: "event: content_block_delta\ndata: {...}"
		if (!line.startsWith('data:')) return null;
		const data = line.slice(5).trim();

		try {
			const event = JSON.parse(data) as Record<string, unknown>;

			if (event.type === 'content_block_delta') {
				const delta = event.delta as Record<string, unknown> | undefined;
				if (delta?.type === 'text_delta') {
					return { type: 'delta', text: (delta.text as string) ?? '' };
				}
				if (delta?.type === 'input_json_delta') {
					// Partial tool call — accumulate in subclass if needed
					return { type: 'delta', text: (delta.partial_json as string) ?? '' };
				}
			}

			if (event.type === 'content_block_start') {
				const block = event.content_block as Record<string, unknown> | undefined;
				if (block?.type === 'tool_use') {
					return {
						type: 'tool_call',
						toolCall: {
							id: (block.id as string) ?? '',
							name: (block.name as string) ?? '',
							arguments: (block.input as Record<string, unknown>) ?? {},
						},
					};
				}
			}

			if (event.type === 'message_delta') {
				const usage = event.usage as Record<string, number> | undefined;
				if (usage) {
					// Track cache stats from streaming response
					const cacheCreation = usage.cache_creation_input_tokens;
					const cacheRead = usage.cache_read_input_tokens;
					if (cacheCreation) this.cacheStats.recordCreation(cacheCreation);
					if (cacheRead) this.cacheStats.recordRead(cacheRead);

					return {
						type: 'usage',
						usage: {
							promptTokens: 0,
							completionTokens: usage.output_tokens ?? 0,
							totalTokens: 0,
							cacheReadTokens: cacheRead,
							cacheCreationTokens: cacheCreation,
						},
					};
				}
			}

			// Track cache-related message-level metrics
			if (event.type === 'message_start') {
				const msgUsage = (event.message as Record<string, unknown> | undefined)?.usage as Record<string, number> | undefined;
				if (msgUsage) {
					const cacheCreation = msgUsage.cache_creation_input_tokens;
					const cacheRead = msgUsage.cache_read_input_tokens;
					if (cacheCreation) this.cacheStats.recordCreation(cacheCreation);
					if (cacheRead) this.cacheStats.recordRead(cacheRead);
				}
			}

			return null;
		} catch {
			return null;
		}
	}
}
