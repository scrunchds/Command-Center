/**
 * Providers — barrel export for the multi-provider subsystem.
 */
export type {
	ProviderId, ProviderMeta, ProviderModel, ProviderCapabilities,
	TaskType, TaskRoute, RoutingTable,
	ProviderRequest, ProviderConfig, ProviderRequestConfig, ProviderResponse,
	ProviderUsage, ProviderMessage, ProviderToolCall, ProviderToolResult,
	IProviderAdapter, ProviderFallbackConfig, ProviderCredentials, MultiProviderSettings,
	ProviderErrorCode, ImageContent, ContentBlock,
	CacheConfig, CacheStats,
} from './provider-types';
export {
	DEFAULT_CACHE_CONFIG,
} from './provider-types';
export {
	TASK_TYPE_LABELS, TASK_TYPE_ICONS, DEFAULT_PROVIDER_CONFIG, DEFAULT_FALLBACK_CONFIG,
	ProviderError, classifyHttpError, classifyThrowError, isLocalBaseUrl, detectLocalRuntime,
} from './provider-types';
export { PROVIDER_REGISTRY, getDefaultModelForProvider, DEFAULT_ROUTE_MODELS, DEFAULT_STT_MODELS } from './provider-registry';
export { BaseHttpProvider } from './base-http-provider';
export type { BaseHttpProviderOptions } from './base-http-provider';
export { OpenAICompatibleProvider, toOpenAITools } from './openai-compatible';
export { OpenRouterProvider } from './openrouter';
export { LMStudioProvider } from './lm-studio';
export { XAIProvider, XAI_STT_URL_PATH, XAI_TTS_URL_PATH, XAI_VOICES_URL_PATH } from './xai';
export { AnthropicProvider } from './anthropic';
export { GeminiProvider } from './google-gemini';
export { CohereProvider } from './cohere';
export { PiDaemonAdapter } from './pi-daemon-provider';
export { ProviderFactory } from './provider-factory';
export { JitModelManager } from './jit-manager';
export type { JitModelManagerOptions } from './jit-manager';
export {
	classifyProviderFailure, isTransientProviderError, ProviderCircuitBreaker,
} from './provider-recovery';
export type { ProviderFailureAction, ProviderCircuitState } from './provider-recovery';
export { classifyTask, resolveRoute, buildRoutingTable, DEFAULT_ROUTING } from '../routing/routing-table';
export { ProviderDispatcher } from '../dispatcher';
export { parseModelJson, repairModelJson, stripJsonCodeFence } from './json-repair';
export {
	preprocessPrompt, extractImageRefs, resolveVaultPath,
	readImageAsBase64, isImageFile, mimeFromExtension,
} from './image-utils';
export type { ImageRef } from './image-utils';
export {
	resolveCacheConfig, shouldUseCache, generateCacheKey,
	computeOptimalMaxTokens, estimatePromptTokens,
	buildAnthropicSystemBlock, applyAnthropicToolCache,
	applyAnthropicMessageCache,
	CacheStatsTracker, GeminiCacheStore,
} from './cache-manager';