/**
 * Provider Registry — static metadata and default models for all supported providers.
 */
import type { ProviderId, ProviderMeta, ProviderModel, ProviderCapabilities, TaskType } from './provider-types';

/* ─── Capability Builders ────────────────────────────── */

function caps(overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities {
	return {
		streaming: true, toolCalling: true, vision: false,
		promptCaching: false, embeddings: false, tokenCounting: false,
		maxContextWindow: 128_000,
		...overrides,
	};
}

/* ─── Model Builders ───────────────────────────────────── */

function m(id: string, label: string, ctx: number, out: number, opts: {
	vision?: boolean; tools?: boolean; cache?: boolean;
	cost?: ProviderModel['costTier']; strengths?: TaskType[];
} = {}): ProviderModel {
	return {
		id, label, contextWindow: ctx, maxOutput: out,
		supportsVision: opts.vision ?? false,
		supportsTools: opts.tools ?? true,
		supportsCaching: opts.cache ?? false,
		costTier: opts.cost ?? 'moderate',
		strengths: opts.strengths ?? ['reasoning', 'coding', 'fast', 'reading'],
	};
}

/* ─── Registry ──────────────────────────────────────────── */

export const PROVIDER_REGISTRY: Record<ProviderId, ProviderMeta> = {
	'pi-daemon': {
		id: 'pi-daemon', label: 'Pi Daemon (Local)', icon: '🖥️',
		description: 'Local Pi RPC; offline and keyless.',
		requiresKey: false, authentication: 'none',
		capabilities: caps({ vision: false, embeddings: false, tokenCounting: true, maxContextWindow: 128_000 }),
		models: [m('pi-default', 'Pi Default', 128_000, 8192, { cost: 'free' })],
	},
	'openai': {
		id: 'openai', label: 'OpenAI', icon: '🧠',
		description: 'GPT and o-series models.',
		requiresKey: true, defaultBaseUrl: 'https://api.openai.com/v1',
		capabilities: caps({ vision: true, embeddings: true, tokenCounting: true, maxContextWindow: 200_000 }),
		models: [
			m('gpt-5', 'GPT-5', 400_000, 32_768, { vision: true, strengths: ['reasoning', 'coding', 'vision', 'reading'] }),
			m('gpt-4o', 'GPT-4o', 128_000, 16384, { vision: true, strengths: ['reasoning', 'coding', 'vision', 'reading'] }),
			m('gpt-4o-mini', 'GPT-4o Mini', 128_000, 16384, { vision: true, cost: 'cheap', strengths: ['fast', 'reading', 'reasoning'] }),
			m('o3', 'o3', 200_000, 100_000, { vision: true, cost: 'expensive', strengths: ['reasoning', 'coding'] }),
			m('o3-mini', 'o3-mini', 200_000, 100_000, { strengths: ['reasoning', 'coding'] }),
			m('o4-mini', 'o4-mini', 200_000, 100_000, { vision: true, strengths: ['reasoning', 'coding', 'fast'] }),
		],
	},
	'anthropic': {
		id: 'anthropic', label: 'Anthropic', icon: '🎭',
		description: 'Claude models with tools and caching.',
		requiresKey: true, defaultBaseUrl: 'https://api.anthropic.com/v1',
		capabilities: caps({ vision: true, promptCaching: true, tokenCounting: true, maxContextWindow: 200_000 }),
		models: [
			m('claude-opus-4-1-20250805', 'Claude Opus 4.1', 200_000, 32_000, { vision: true, cache: true, cost: 'expensive', strengths: ['reasoning', 'reading', 'coding', 'vision'] }),
			m('claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5', 200_000, 16_384, { vision: true, cache: true, strengths: ['coding', 'reasoning', 'reading', 'vision'] }),
			m('claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 200_000, 8192, { vision: true, cache: true, cost: 'cheap', strengths: ['fast', 'reading', 'reasoning'] }),
		],
	},
	'google-gemini': {
		id: 'google-gemini', label: 'Google Gemini', icon: '🔮',
		description: 'Long-context multimodal Gemini models.',
		requiresKey: true, defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
		capabilities: caps({ vision: true, promptCaching: true, tokenCounting: true, maxContextWindow: 2_097_152 }),
		models: [
			m('gemini-2.5-pro', 'Gemini 2.5 Pro', 2_097_152, 8192, { vision: true, strengths: ['reading', 'reasoning', 'vision'] }),
			m('gemini-2.5-flash', 'Gemini 2.5 Flash', 1_048_576, 8192, { vision: true, cost: 'cheap', strengths: ['fast', 'reading', 'vision', 'reasoning'] }),
			m('gemini-2.0-flash', 'Gemini 2.0 Flash', 1_048_576, 8192, { vision: true, cost: 'cheap', strengths: ['fast', 'reading', 'vision'] }),
		],
	},
	'openrouter': {
		id: 'openrouter', label: 'OpenRouter', icon: '🌐',
		description: 'OpenAI-compatible multi-model gateway.',
		requiresKey: true, defaultBaseUrl: 'https://openrouter.ai/api/v1',
		capabilities: caps({ vision: true, maxContextWindow: 2_097_152 }),
		models: [
			m('openai/gpt-4o', 'GPT-4o (OpenRouter)', 128_000, 16384, { vision: true, strengths: ['reasoning', 'coding', 'vision', 'reading'] }),
			m('anthropic/claude-3.5-sonnet', 'Claude 3.5 Sonnet (OpenRouter)', 200_000, 8192, { vision: true, strengths: ['coding', 'reasoning', 'reading'] }),
			m('google/gemini-pro-1.5', 'Gemini 1.5 Pro (OpenRouter)', 2_097_152, 8192, { vision: true, strengths: ['reading', 'reasoning'] }),
			m('deepseek/deepseek-coder', 'DeepSeek-Coder (OpenRouter)', 128_000, 8192, { cost: 'cheap', strengths: ['coding', 'fast'] }),
			m('openai/whisper-large-v3', 'Whisper Large v3 (OpenRouter)', 0, 0, { cost: 'cheap', strengths: [] }),
			m('openai/tts-1', 'OpenAI TTS-1 (OpenRouter)', 0, 0, { cost: 'cheap', strengths: [] }),
			m('openai/tts-1-hd', 'OpenAI TTS-1 HD (OpenRouter)', 0, 0, { cost: 'moderate', strengths: [] }),
			m('mistralai/voxtral-mini-tts-2603', 'Voxtral Mini TTS (OpenRouter)', 0, 0, { cost: 'cheap', strengths: [] }),
			m('mistralai/voxtral-mini', 'Voxtral Mini (OpenRouter)', 0, 0, { cost: 'cheap', strengths: [] }),
			// Image generation models (discoverable via /api/v1/models/user)
			m('google/gemini-3.1-flash-image', 'Nano Banana 2 (OpenRouter)', 1_000_000, 8192, { cost: 'moderate', strengths: ['vision'] }),
			m('google/gemini-2.5-flash-image', 'Nano Banana (OpenRouter)', 1_000_000, 8192, { cost: 'cheap', strengths: ['vision'] }),
			m('openai/gpt-5-image', 'GPT-5 Image (OpenRouter)', 128_000, 8192, { cost: 'expensive', strengths: ['vision'] }),
			m('openai/gpt-5-image-mini', 'GPT-5 Image Mini (OpenRouter)', 128_000, 8192, { cost: 'moderate', strengths: ['vision'] }),
			m('openai/gpt-5.4-image-2', 'GPT-5.4 Image 2 (OpenRouter)', 128_000, 8192, { cost: 'expensive', strengths: ['vision'] }),
		],
	},
	'ollama': {
		id: 'ollama', label: 'Ollama (Local)', icon: '🦙',
		description: 'Run open models locally or through an authenticated OpenAI-compatible proxy.',
		requiresKey: false, authentication: 'optional', defaultBaseUrl: 'http://localhost:11434/v1',
		capabilities: caps({ vision: false, embeddings: false, maxContextWindow: 128_000 }),
		models: [
			m('llama3.1:8b', 'Llama 3.1 8B', 128_000, 4096, { cost: 'free', strengths: ['fast', 'reading', 'reasoning'] }),
			m('llama3.1:70b', 'Llama 3.1 70B', 128_000, 4096, { cost: 'free', strengths: ['reasoning', 'coding', 'reading'] }),
			m('mistral:7b', 'Mistral 7B', 32_000, 4096, { cost: 'free', strengths: ['fast', 'reading'] }),
			m('deepseek-coder:6.7b', 'DeepSeek-Coder 6.7B', 16_000, 4096, { cost: 'free', strengths: ['coding', 'fast'] }),
		],
	},
	'groq': {
		id: 'groq', label: 'Groq', icon: '⚡',
		description: 'Low-latency hosted inference.',
		requiresKey: true, defaultBaseUrl: 'https://api.groq.com/openai/v1',
		capabilities: caps({ vision: false, maxContextWindow: 128_000 }),
		models: [
			m('llama-3.3-70b-versatile', 'Llama 3.3 70B', 128_000, 8192, { cost: 'cheap', strengths: ['reasoning', 'coding', 'fast'] }),
			m('llama-3.1-8b-instant', 'Llama 3.1 8B', 128_000, 8192, { cost: 'cheap', strengths: ['fast', 'reading'] }),
			m('llama-4-maverick-17b-128e-instruct', 'Llama 4 Maverick', 1_048_576, 8192, { cost: 'cheap', strengths: ['reasoning', 'reading'] }),
			m('llama-4-scout-17b-16e-instruct', 'Llama 4 Scout', 1_048_576, 8192, { cost: 'cheap', strengths: ['reading', 'fast'] }),
		],
	},
	'deepinfra': {
		id: 'deepinfra', label: 'DeepInfra', icon: '🏭',
		description: 'Hosted open-weight models.',
		requiresKey: true, defaultBaseUrl: 'https://api.deepinfra.com/v1/openai',
		capabilities: caps({ vision: false, maxContextWindow: 128_000 }),
		models: [
			m('meta-llama/Llama-3.1-70B-Instruct', 'Llama 3.1 70B', 128_000, 4096, { cost: 'cheap', strengths: ['reasoning', 'coding', 'reading'] }),
			m('deepseek-ai/DeepSeek-Coder-V2-Instruct', 'DeepSeek-Coder V2', 128_000, 4096, { cost: 'cheap', strengths: ['coding', 'reasoning'] }),
		],
	},
	'mistral': {
		id: 'mistral', label: 'Mistral AI', icon: '💨',
		description: 'Mistral and Codestral models.',
		requiresKey: true, defaultBaseUrl: 'https://api.mistral.ai/v1',
		capabilities: caps({ vision: false, maxContextWindow: 128_000 }),
		models: [
			m('mistral-large-latest', 'Mistral Large', 128_000, 4096, { strengths: ['reasoning', 'reading', 'coding'] }),
			m('mistral-medium-3', 'Mistral Medium 3', 128_000, 4096, { strengths: ['reasoning', 'reading', 'fast'] }),
			m('mistral-small-latest', 'Mistral Small', 32_000, 4096, { cost: 'cheap', strengths: ['fast', 'reading'] }),
			m('codestral-latest', 'Codestral', 32_000, 4096, { strengths: ['coding', 'reasoning'] }),
			m('devstral-2507', 'Devstral', 32_000, 4096, { strengths: ['coding', 'fast'] }),
		],
	},
	'cohere': {
		id: 'cohere', label: 'Cohere', icon: '🔗',
		description: 'Command models optimized for RAG with native STT.',
		requiresKey: true, defaultBaseUrl: 'https://api.cohere.com/v2',
		capabilities: caps({ vision: false, maxContextWindow: 128_000 }),
		models: [
			m('command-r-plus-08-2024', 'Command R+', 128_000, 4096, { strengths: ['reasoning', 'reading'] }),
			m('command-r-08-2024', 'Command R', 128_000, 4096, { cost: 'cheap', strengths: ['fast', 'reading'] }),
			m('command-a-03-2026', 'Command A', 256_000, 8192, { cost: 'moderate', strengths: ['reasoning', 'reading', 'coding'] }),
			m('cohere-transcribe-03-2026', 'Cohere Transcribe', 0, 0, { cost: 'moderate', strengths: [] }),
		],
	},
	'lmstudio': {
		id: 'lmstudio', label: 'LM Studio (Local)', icon: '💻',
		description: 'Local OpenAI-compatible server; supports an optional bearer token when Require Authentication is enabled.',
		requiresKey: false, authentication: 'optional', defaultBaseUrl: 'http://localhost:1234/v1',
		capabilities: caps({ vision: false, embeddings: false, maxContextWindow: 128_000 }),
		models: [
			m('local-model', 'Local Model (auto-detect)', 128_000, 4096, { cost: 'free', strengths: ['reasoning', 'coding', 'fast', 'reading'] }),
		],
	},
	'xai': {
		id: 'xai', label: 'xAI (Grok)', icon: '🛸',
		description: 'Grok models with vision, tools, and native STT/TTS.',
		requiresKey: true, defaultBaseUrl: 'https://api.x.ai/v1',
		capabilities: caps({ vision: true, embeddings: false, maxContextWindow: 1_000_000 }),
		models: [
			m('grok-4.5', 'Grok 4.5', 500_000, 32_000, { vision: true, cost: 'expensive', strengths: ['reasoning', 'coding', 'vision', 'reading'] }),
			m('grok-4.3', 'Grok 4.3', 1_000_000, 32_000, { vision: true, cost: 'moderate', strengths: ['reasoning', 'reading', 'fast', 'coding'] }),
			m('grok-4.20-reasoning', 'Grok 4.20 Reasoning', 1_000_000, 32_000, { vision: true, cost: 'expensive', strengths: ['reasoning', 'coding', 'reading'] }),
			m('grok-build-0.1', 'Grok Build', 256_000, 16_384, { cost: 'cheap', strengths: ['coding', 'fast'] }),
			m('grok-stt', 'Grok STT', 0, 0, { cost: 'moderate', strengths: [] }),
			m('grok-tts', 'Grok TTS', 0, 0, { cost: 'moderate', strengths: [] }),
		],
	},
	'custom': {
		id: 'custom', label: 'Custom Endpoint', icon: '🔌',
		description: 'Custom OpenAI-compatible endpoint with optional bearer authentication.',
		requiresKey: false, authentication: 'optional', defaultBaseUrl: 'http://localhost:8000/v1',
		capabilities: caps(),
		models: [
			m('custom-model', 'Custom Model', 128_000, 4096, { cost: 'free', strengths: ['reasoning', 'coding', 'fast', 'reading'] }),
		],
	},
};

/* ─── Default Models Per Task Type ─────────────────────── */

export const DEFAULT_ROUTE_MODELS: Record<TaskType, { provider: ProviderId; model: string }> = {
	coding:    { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
	vision:    { provider: 'openai', model: 'gpt-4o' },
	reading:   { provider: 'google-gemini', model: 'gemini-2.5-pro' },
	reasoning: { provider: 'anthropic', model: 'claude-opus-4-1-20250805' },
	fast:      { provider: 'groq', model: 'llama-3.1-8b-instant' },
};

/**
 * Default models for providers with dedicated STT models.
 * Used by the transcription fallback chain to pick the right model ID.
 */
export const DEFAULT_STT_MODELS: Partial<Record<ProviderId, string>> = {
	'xai': 'grok-stt',
	'groq': 'whisper-large-v3',
	'openai': 'whisper-1',
	'deepinfra': 'openai/whisper-large-v3-turbo',
	'openrouter': 'openai/whisper-large-v3',
	'mistral': 'voxtral-mini-latest',
	'cohere': 'cohere-transcribe-03-2026',
};

/**
 * Default models for providers with dedicated TTS (text-to-speech) models.
 * Used by the TTS adapter to pick the right model ID per provider.
 * xAI uses a native /v1/tts endpoint; the rest use the OpenAI-compatible
 * POST /audio/speech (or /v1/audio/speech) endpoint.
 */
export const DEFAULT_TTS_MODELS: Partial<Record<ProviderId, string>> = {
	'openai': 'gpt-4o-mini-tts',
	'openrouter': 'openai/tts-1',
	'xai': 'grok-tts',
	'mistral': 'voxtral-mini-tts-latest',
};

/** Providers whose TTS endpoint is OpenAI-compatible (POST /audio/speech). */
export const OPENAI_COMPATIBLE_TTS_PROVIDERS: ReadonlySet<ProviderId> = new Set([
	'openai', 'openrouter', 'mistral', 'deepinfra', 'groq', 'custom', 'lmstudio', 'ollama',
]);

/** Default voice for OpenAI-compatible TTS providers (varies by provider). */
export const DEFAULT_TTS_VOICES: Partial<Record<ProviderId, string>> = {
	'openai': 'alloy',
	'openrouter': 'alloy',
	'mistral': 'alloy',
};

/** Best default model for each provider, per task type. */
export function getDefaultModelForProvider(providerId: ProviderId, taskType: TaskType): string {
	const meta = PROVIDER_REGISTRY[providerId];
	if (!meta || meta.models.length === 0) return 'unknown';

	// Prefer models with matching strengths
	const ranked = meta.models
		.filter(m => m.strengths.includes(taskType))
		.sort((a, b) => {
			const costOrder = { free: 0, cheap: 1, moderate: 2, expensive: 3 };
			return (costOrder[a.costTier] ?? 2) - (costOrder[b.costTier] ?? 2);
		});
	if (ranked.length > 0) return ranked[0]!.id;

	// Fall back to first model
	return meta.models[0]!.id;
}