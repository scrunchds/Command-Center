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
			m('gpt-4o', 'GPT-4o', 128_000, 16384, { vision: true, strengths: ['reasoning', 'coding', 'vision', 'reading'] }),
			m('gpt-4o-mini', 'GPT-4o Mini', 128_000, 16384, { vision: true, cost: 'cheap', strengths: ['fast', 'reading', 'reasoning'] }),
			m('o1', 'o1', 200_000, 100_000, { vision: true, tools: false, cost: 'expensive', strengths: ['reasoning', 'coding'] }),
			m('o3-mini', 'o3-mini', 200_000, 100_000, { tools: false, strengths: ['reasoning', 'coding'] }),
		],
	},
	'anthropic': {
		id: 'anthropic', label: 'Anthropic', icon: '🎭',
		description: 'Claude models with tools and caching.',
		requiresKey: true, defaultBaseUrl: 'https://api.anthropic.com/v1',
		capabilities: caps({ vision: true, promptCaching: true, tokenCounting: true, maxContextWindow: 200_000 }),
		models: [
			m('claude-3-5-sonnet-20241022', 'Claude 3.5 Sonnet', 200_000, 8192, { vision: true, cache: true, strengths: ['coding', 'reasoning', 'reading', 'vision'] }),
			m('claude-3-opus-20240229', 'Claude 3 Opus', 200_000, 4096, { vision: true, cache: true, cost: 'expensive', strengths: ['reasoning', 'reading', 'coding'] }),
			m('claude-3-5-haiku-20241022', 'Claude 3.5 Haiku', 200_000, 8192, { vision: true, cache: true, cost: 'cheap', strengths: ['fast', 'reading', 'reasoning'] }),
		],
	},
	'google-gemini': {
		id: 'google-gemini', label: 'Google Gemini', icon: '🔮',
		description: 'Long-context multimodal Gemini models.',
		requiresKey: true, defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
		capabilities: caps({ vision: true, promptCaching: true, tokenCounting: true, maxContextWindow: 2_097_152 }),
		models: [
			m('gemini-1.5-pro', 'Gemini 1.5 Pro', 2_097_152, 8192, { vision: true, strengths: ['reading', 'reasoning', 'vision'] }),
			m('gemini-1.5-flash', 'Gemini 1.5 Flash', 1_048_576, 8192, { vision: true, cost: 'cheap', strengths: ['fast', 'reading', 'vision'] }),
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
			m('llama-3.1-70b-versatile', 'Llama 3.1 70B', 128_000, 8192, { cost: 'cheap', strengths: ['reasoning', 'coding', 'fast'] }),
			m('llama-3.1-8b-instant', 'Llama 3.1 8B', 128_000, 8192, { cost: 'cheap', strengths: ['fast', 'reading'] }),
			m('mixtral-8x7b-32768', 'Mixtral 8x7B', 32_000, 4096, { cost: 'cheap', strengths: ['reasoning', 'reading'] }),
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
			m('mistral-small-latest', 'Mistral Small', 32_000, 4096, { cost: 'cheap', strengths: ['fast', 'reading'] }),
			m('codestral-latest', 'Codral', 32_000, 4096, { strengths: ['coding', 'reasoning'] }),
		],
	},
	'cohere': {
		id: 'cohere', label: 'Cohere', icon: '🔗',
		description: 'Command models optimized for RAG.',
		requiresKey: true, defaultBaseUrl: 'https://api.cohere.com/v2',
		capabilities: caps({ vision: false, maxContextWindow: 128_000 }),
		models: [
			m('command-r-plus-08-2024', 'Command R+', 128_000, 4096, { strengths: ['reasoning', 'reading'] }),
			m('command-r-08-2024', 'Command R', 128_000, 4096, { cost: 'cheap', strengths: ['fast', 'reading'] }),
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
	coding:    { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
	vision:    { provider: 'openai', model: 'gpt-4o' },
	reading:   { provider: 'google-gemini', model: 'gemini-1.5-pro' },
	reasoning: { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
	fast:      { provider: 'groq', model: 'llama-3.1-8b-instant' },
};

/**
 * Default models for providers with dedicated STT models.
 * Used by the transcription fallback chain to pick the right model ID.
 */
export const DEFAULT_STT_MODELS: Partial<Record<ProviderId, string>> = {
	'xai': 'grok-stt',
	'groq': 'whisper-large-v3',
	'openai': 'whisper-large-v3-turbo',
	'deepinfra': 'whisper-large-v3-turbo',
	'openrouter': 'openai/whisper-large-v3',
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