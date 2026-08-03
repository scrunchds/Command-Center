/**
 * Cohere Provider — Command R+ API optimized for RAG and multi-step reasoning.
 *
 * Uses Cohere's native chat API (not OpenAI-compatible).
 */

import type {
	ProviderMessage, ProviderResponse, ProviderRequestConfig,
	ProviderToolCall, ImageContent,
} from './provider-types';
import { BaseHttpProvider } from './base-http-provider';
import type { ToolDefinition } from '../types';

/** Cohere STT endpoint is /v2/audio/transcriptions. */
export const COHERE_STT_URL_PATH = '/v2/audio/transcriptions';

/** Cohere STT default model. */
export const COHERE_STT_MODEL = 'cohere-transcribe-03-2026';

export class CohereProvider extends BaseHttpProvider {
	/** @note Cohere doesn't support multimodal yet; images are ignored. */
	protected buildRequestBody(
		messages: ProviderMessage[], model: string,
		config: ProviderRequestConfig, tools?: unknown[],
		_images?: ImageContent[],
	): unknown {
		// Cohere uses "chat_history" + "message" format
		const systemMsg = messages.find(m => m.role === 'system');
		const chatHistory = messages.filter(m => m.role !== 'system' && m.role !== messages[messages.length - 1]?.role);
		const lastMsg = messages[messages.length - 1];

		const body: Record<string, unknown> = {
			model,
			message: lastMsg?.content ?? '',
			temperature: config.temperature,
			max_tokens: config.maxTokens,
			p: config.topP,
		};

		if (systemMsg) body.preamble = systemMsg.content;

		if (chatHistory.length > 0) {
			body.chat_history = chatHistory.map(m => ({
				role: m.role === 'assistant' ? 'CHATBOT' : 'USER',
				message: m.content,
			}));
		}

		if (tools && tools.length > 0) {
			body.tools = (tools as ToolDefinition[]).map(t => ({
				name: t.name,
				description: t.description,
				parameter_definitions: Object.entries(
					(t.parameters.properties ?? {}) as Record<string, { type: string; description?: string }>
				).reduce<Record<string, unknown>>((acc, [key, val]) => {
					acc[key] = { type: val.type, description: val.description ?? '', required: (t.parameters.required ?? []).includes(key) };
					return acc;
				}, {}),
			}));
		}

		if (config.stop.length > 0) body.stop_sequences = config.stop;

		return body;
	}

	protected buildHeaders(apiKey: string): Record<string, string> {
		return {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${apiKey}`,
		};
	}

	protected getEndpoint(): string {
		return `${this.getBaseUrl().replace(/\/+$/, '')}/chat`;
	}

	protected parseResponse(
		data: Record<string, unknown>, model: string, startedAt: number,
	): ProviderResponse {
		const output = (data.text as string) ?? '';
		const usageRaw = (data.meta as Record<string, unknown> | undefined)?.tokens as Record<string, number> | undefined;
		const toolCalls: ProviderToolCall[] = [];
		const tcArray = data.tool_calls as Array<Record<string, unknown>> | undefined;
		if (tcArray) {
			for (const tc of tcArray) {
				toolCalls.push({
					id: crypto.randomUUID(),
					name: (tc.name as string) ?? '',
					arguments: (tc.parameters as Record<string, unknown>) ?? {},
				});
			}
		}

		return {
			output, success: true, model, providerId: this.id,
			usage: usageRaw ? {
				promptTokens: (usageRaw).input_tokens ?? 0,
				completionTokens: (usageRaw).output_tokens ?? 0,
				totalTokens: 0,
			} : undefined,
			toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
			latencyMs: Date.now() - startedAt,
		};
	}

	protected async parseError(response: Response): Promise<string> {
		try {
			const data = await response.json() as Record<string, unknown>;
			return (data.message as string) ?? `HTTP ${response.status}`;
		} catch {
			return `HTTP ${response.status}: ${response.statusText}`;
		}
	}

	protected parseStreamEvent(
		line: string, _currentOutput: string, _toolCalls: ProviderToolCall[],
	): { type: 'delta'; text?: string } | null {
		if (!line.startsWith('data:')) return null;
		const data = line.slice(5).trim();
		try {
			const event = JSON.parse(data) as Record<string, unknown>;
			if (event.type === 'text-generation' && event.text) {
				return { type: 'delta', text: event.text as string };
			}
			if (event.type === 'stream-end' && event.response) {
				const resp = event.response as Record<string, unknown>;
				return { type: 'delta', text: (resp.text as string) ?? '' };
			}
			return null;
		} catch { return null; }
	}
}