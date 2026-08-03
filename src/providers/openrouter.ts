/**
 * OpenRouter Provider — OpenAI-compatible gateway with rich model metadata.
 *
 * OpenRouter returns extended model metadata (pricing, context_length,
 * architecture, modalities, provider info) beyond the standard
 * OpenAI-compatible model list format. This provider subclass parses
 * those fields and maps them to Command Center's ProviderModel.
 *
 * @see https://openrouter.ai/docs/api/api-reference/models/get-a-model-by-its-slug
 */

import type { ProviderModel, TaskType } from './provider-types';
import { OpenAICompatibleProvider } from './openai-compatible';

/* ─── Pricing → costTier mapping ──────────────────────── */

/**
 * Convert OpenRouter per-token pricing to a local cost tier.
 * Pricing is in USD per token (as a decimal string).
 * Thresholds: free=0, cheap<5e-6, moderate<3e-5, expensive>=3e-5
 */
function pricingToCostTier(promptPrice: string | undefined): ProviderModel['costTier'] {
	if (!promptPrice) return 'moderate';
	const price = parseFloat(promptPrice);
	if (isNaN(price) || price <= 0) return 'free';
	if (price < 5e-6) return 'cheap';
	if (price < 3e-5) return 'moderate';
	return 'expensive';
}

/* ─── Modality → capabilities mapping ─────────────────── */

function hasVision(inputModalities: string[] | undefined): boolean {
	if (!inputModalities) return false;
	return inputModalities.some(m => /image/i.test(m));
}

function hasAudio(inputModalities: string[] | undefined): boolean {
	if (!inputModalities) return false;
	return inputModalities.some(m => /audio/i.test(m));
}

/* ─── Provider Adapter ─────────────────────────────────── */

export class OpenRouterProvider extends OpenAICompatibleProvider {
	/**
	 * Override model list parsing to extract OpenRouter's rich metadata.
	 *
	 * OpenRouter's GET /v1/models response shape:
	 * {
	 *   data: [{
	 *     id: "openai/gpt-4o",
	 *     name: "GPT-4o",
	 *     description: "...",
	 *     context_length: 128000,
	 *     architecture: {
	 *       modality: "text+image->text",
	 *       input_modalities: ["text", "image"],
	 *       output_modalities: ["text"]
	 *     },
	 *     pricing: { prompt: "0.0000025", completion: "0.00001", input_cache_read: "0.00000125" },
	 *     top_provider: { context_length: 128000, max_completion_tokens: 16384 },
	 *     supported_parameters: ["tools", "vision", ...],
	 *     supported_voices: ["voice_id", ...],
	 *     reasoning: { mandatory: false, supported_efforts: [...] }
	 *   }]
	 * }
	 */
	protected parseModelListResponse(data: Record<string, unknown>): ProviderModel[] {
		const rawModels = data.data as Array<Record<string, unknown>> | undefined;
		if (!rawModels || !Array.isArray(rawModels)) return [];

		return rawModels
			.filter(m => m.id && typeof m.id === 'string')
			.map(m => this.parseOpenRouterModel(m));
	}

	/**
	 * Parse a single OpenRouter model entry into a ProviderModel.
	 */
	private parseOpenRouterModel(raw: Record<string, unknown>): ProviderModel {
		const id = raw.id as string;
		const name = (raw.name as string) ?? this.deriveLabel(id);
		const contextLength = (raw.context_length as number) ?? 128_000;
		const architecture = raw.architecture as Record<string, unknown> | undefined;
		const inputModalities = architecture?.input_modalities as string[] | undefined;
		const pricing = raw.pricing as Record<string, string> | undefined;
		const supportedParams = raw.supported_parameters as string[] | undefined;
		const topProvider = raw.top_provider as Record<string, unknown> | undefined;
		const maxCompletionTokens = (topProvider?.max_completion_tokens as number) ?? 4096;
		const description = (raw.description as string) ?? '';

		// Determine capabilities from supported_parameters
		const supportsVision = hasVision(inputModalities)
			|| (supportedParams?.includes('vision') ?? false)
			|| /vision|image|multimodal/i.test(description);

		const supportsTools = supportedParams?.includes('tools')
			?? supportedParams?.includes('tool_choice')
			?? !/instruct/i.test(id);

		const supportsCaching = supportedParams?.includes('prompt_caching')
			?? false;

		// Determine cost tier from pricing
		const costTier = pricingToCostTier(pricing?.prompt);

		// Determine strengths from model capabilities
		const strengths = this.inferStrengths(id, description, supportsVision, inputModalities);

		return {
			id,
			label: name,
			contextWindow: contextLength,
			maxOutput: maxCompletionTokens,
			supportsVision,
			supportsTools,
			supportsCaching,
			costTier,
			strengths,
		};
	}

	/**
	 * Derive a human-readable label from a model ID when no name is provided.
	 */
	private deriveLabel(id: string): string {
		return id
			.replace(/^.*\//, '')
			.replace(/[-_]/g, ' ')
			.replace(/\b(\w)/g, c => c.toUpperCase());
	}

	/**
	 * Infer task type strengths from model ID, description, and capabilities.
	 */
	private inferStrengths(
		id: string, description: string, vision: boolean,
		inputModalities: string[] | undefined,
	): TaskType[] {
		const strengths: TaskType[] = ['fast'];
		const lowerId = id.toLowerCase();
		const lowerDesc = description.toLowerCase();

		// Coding
		if (/coder|code|deepseek|qwen-coder|developer/i.test(lowerId) ||
			/coding|code|programming|developer/i.test(lowerDesc)) {
			strengths.push('coding');
		}

		// Reasoning
		if (/reasoning|reason|deepseek|o1|o3|claude|gemini|grok/i.test(lowerId) ||
			/reasoning|complex|advanced/i.test(lowerDesc)) {
			strengths.push('reasoning');
		}

		// Reading
		if (/context|long|128k|1m|reading|summarize|analyze/i.test(lowerDesc) ||
			/128k|1m|claude|gemini|command/i.test(lowerId)) {
			strengths.push('reading');
		}

		// Vision
		if (vision) {
			strengths.push('vision');
		}

		// Audio/speech models
		if (hasAudio(inputModalities) || /tts|stt|whisper|speech|audio|voxtral/i.test(lowerId)) {
			// These are STT/TTS models — no text strengths
			return [];
		}

		return [...new Set(strengths)];
	}
}