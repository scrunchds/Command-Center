/**
 * OpenAI-compatible Provider — handles OpenAI, OpenRouter, Groq, DeepInfra,
 * Ollama, LM Studio, and Custom endpoints that speak the OpenAI chat API.
 */

import type {
	ProviderMessage, ProviderResponse, ProviderRequestConfig,
	ProviderToolCall, ImageContent,
} from './provider-types';
import { detectLocalRuntime, isLocalBaseUrl } from './provider-types';
import { parseModelJson } from './json-repair';
import { BaseHttpProvider } from './base-http-provider';
import type { ToolDefinition } from '../types';

/* ─── Adapter ──────────────────────────────────────────── */

export class OpenAICompatibleProvider extends BaseHttpProvider {
	/**
	 * Build OpenAI-compatible request body.
	 * When images are present, the last user message content is converted
	 * to a multimodal array with data-URI image_url blocks.
	 */
	protected buildRequestBody(
		messages: ProviderMessage[], model: string,
		config: ProviderRequestConfig, tools?: unknown[],
		images?: ImageContent[],
	): unknown {
		const body: Record<string, unknown> = {
			model,
			messages: messages.map((m, idx) => {
				const entry: Record<string, unknown> = { role: m.role };

				// Multimodal: images go in the last user message as content array
				if (images && images.length > 0 && m.role === 'user' && idx === messages.length - 1) {
					const contentArray: Record<string, unknown>[] = [];
					if (m.content) {
						contentArray.push({ type: 'text', text: m.content });
					}
					for (const img of images) {
						contentArray.push({
							type: 'image_url',
							image_url: { url: `data:${img.mimeType};base64,${img.data}` },
						});
					}
					entry.content = contentArray;
				} else {
					entry.content = m.content;
				}

				if (m.toolCallId) entry.tool_call_id = m.toolCallId;
				if (m.toolCalls) entry.tool_calls = m.toolCalls.map(tc => ({
					id: tc.id, type: 'function',
					function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
				}));
				return entry;
			}),
			temperature: config.temperature,
			max_tokens: config.maxTokens,
			top_p: config.topP,
		};
		if (config.stop.length > 0) body.stop = config.stop;
		if (tools && tools.length > 0) {
			body.tools = (tools as ToolDefinition[]).map(t => ({
				type: 'function',
				function: { name: t.name, description: t.description, parameters: t.parameters },
			}));
			body.tool_choice = 'auto';
		}
		if (config.extra && Object.keys(config.extra).length > 0) {
			Object.assign(body, config.extra);
		}

		// Keep direct body-builder use safe (settings previews/tests); the base
		// provider applies the same final policy to every send and tool continuation.
		if (!isLocalBaseUrl(this.getBaseUrl())) {
			delete body.ttl;
			delete body.keep_alive;
			delete body.keepAlive;
		} else if (detectLocalRuntime(this.getBaseUrl(), this.id) === 'ollama') {
			delete body.ttl;
			delete body.keepAlive;
			body.keep_alive = config.keepAlive ?? '5m';
		} else {
			delete body.keep_alive;
			delete body.keepAlive;
			body.ttl = config.ttl ?? 300;
		}
		return body;
	}

	protected buildHeaders(apiKey: string): Record<string, string> {
		const h: Record<string, string> = { 'Content-Type': 'application/json' };
		if (apiKey) {
			// OpenRouter uses a different header prefix
			if (this.id === 'openrouter') {
				h['Authorization'] = `Bearer ${apiKey}`;
				h['HTTP-Referer'] = 'obsidian-command-center';
				h['X-Title'] = 'Obsidian Command Center';
			} else {
				h['Authorization'] = `Bearer ${apiKey}`;
			}
		}
		return h;
	}

	protected getEndpoint(): string {
		const base = this.getBaseUrl().replace(/\/+$/, '');
		return `${base}/chat/completions`;
	}

	protected parseResponse(
		data: Record<string, unknown>, model: string, startedAt: number,
	): ProviderResponse {
		const choices = data.choices as Array<Record<string, unknown>> | undefined;
		const choice = choices?.[0];
		const message = choice?.message as Record<string, unknown> | undefined;
		const usageRaw = data.usage as Record<string, number> | undefined;

		let output = '';
		const toolCalls: ProviderToolCall[] = [];

		if (message) {
			output = (message.content as string) ?? '';
			const tcArray = message.tool_calls as Array<Record<string, unknown>> | undefined;
			if (tcArray) {
				for (const tc of tcArray) {
					const fn = tc.function as Record<string, unknown> | undefined;
					toolCalls.push({
						id: (tc.id as string) ?? '',
						name: (fn?.name as string) ?? '',
						arguments: safeParseJSON((fn?.arguments as string) ?? '{}'),
					});
				}
			}
		}

		return {
			output, success: true, model, providerId: this.id,
			usage: usageRaw ? {
				promptTokens: usageRaw.prompt_tokens ?? 0,
				completionTokens: usageRaw.completion_tokens ?? 0,
				totalTokens: usageRaw.total_tokens ?? 0,
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
	): { type: 'delta'; text?: string } | { type: 'tool_call'; toolCall?: ProviderToolCall } | { type: 'usage'; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } } | null {
		if (!line.startsWith('data:')) return null;
		const data = line.slice(5).trim();
		if (data === '[DONE]') return null;

		try {
			const parsed = JSON.parse(data) as Record<string, unknown>;
			const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
			const choice = choices?.[0];
			const delta = choice?.delta as Record<string, unknown> | undefined;

			if (delta?.content) {
				return { type: 'delta', text: delta.content as string };
			}

			const tcArray = delta?.tool_calls as Array<Record<string, unknown>> | undefined;
			if (tcArray) {
				for (const tc of tcArray) {
					const fn = tc.function as Record<string, unknown> | undefined;
					if (fn?.name) {
						return {
							type: 'tool_call',
							toolCall: {
								id: (tc.id as string) ?? '',
								name: fn.name as string,
								arguments: safeParseJSON((fn.arguments as string) ?? '{}'),
							},
						};
					}
				}
			}

			if (parsed.usage) {
				const u = parsed.usage as Record<string, number>;
				return { type: 'usage', usage: { promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0, totalTokens: u.total_tokens ?? 0 } };
			}

			return null;
		} catch {
			return null;
		}
	}
}

/* ─── Helpers ──────────────────────────────────────────── */

function safeParseJSON(raw: string): Record<string, unknown> {
	try {
		const parsed = parseModelJson<unknown>(raw);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: {};
	} catch { return {}; }
}

/**
 * Convert our ToolDefinition[] to OpenAI-format tool definitions.
 */
export function toOpenAITools(tools: ToolDefinition[]): Array<{
	type: 'function';
	function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
	return tools.map(t => ({
		type: 'function' as const,
		function: { name: t.name, description: t.description, parameters: t.parameters as unknown as Record<string, unknown> },
	}));
}