/**
 * Provider Types v2 — shared interfaces for multi-provider LLM integration.
 *
 * Refined with: typed errors, capability introspection, lifecycle hooks,
 * token counting, and normalized tool call contracts.
 */

import type { ToolDefinition } from '../types';

/* ─── Provider Identity ────────────────────────────────── */

export type ProviderId =
	| 'pi-daemon' | 'openai' | 'anthropic' | 'google-gemini'
	| 'openrouter' | 'ollama' | 'groq' | 'deepinfra'
	| 'mistral' | 'cohere' | 'lmstudio' | 'custom';

export interface ProviderMeta {
	id: ProviderId;
	label: string;
	description: string;
	icon: string;
	requiresKey: boolean;
	defaultBaseUrl?: string;
	models: ProviderModel[];
	/** Declares what this provider can do. Used by the dispatcher for smart routing. */
	capabilities: ProviderCapabilities;
}

/** Granular capability flags for intelligent provider selection. */
export interface ProviderCapabilities {
	streaming: boolean;
	toolCalling: boolean;
	vision: boolean;
	promptCaching: boolean;
	embeddings: boolean;
	tokenCounting: boolean;
	maxContextWindow: number;
}

export interface ProviderModel {
	id: string;
	label: string;
	contextWindow: number;
	maxOutput: number;
	supportsVision: boolean;
	supportsTools: boolean;
	supportsCaching: boolean;
	costTier: 'free' | 'cheap' | 'moderate' | 'expensive';
	strengths: TaskType[];
}

/* ─── Task Routing ─────────────────────────────────────── */

export type TaskType = 'coding' | 'vision' | 'reading' | 'reasoning' | 'fast';

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
	coding: 'Coding / Architecture',
	vision: 'Vision / Multimodal',
	reading: 'Reading / Summarization',
	reasoning: 'Reasoning / ReAct',
	fast: 'Fast / General Utility',
};

export const TASK_TYPE_ICONS: Record<TaskType, string> = {
	coding: '💻', vision: '👁️', reading: '📖', reasoning: '🧠', fast: '⚡',
};

export interface TaskRoute {
	taskType: TaskType;
	providerId: ProviderId;
	modelId: string;
	config?: Partial<ProviderRequestConfig>;
}

export type RoutingTable = Record<TaskType, TaskRoute>;

/** Optional adaptive route selection. Fallbacks remain reliability-first. */
export interface RoutingOptimizationConfig {
	enabled: boolean;
	objective: 'latency' | 'cost' | 'balanced';
	/** Minimum 0..1 task-capability score required for an optimization candidate. */
	minCapabilityScore: number;
	/** Exponential moving-average weight assigned to the newest observation. */
	emaAlpha: number;
}

export interface ProviderTaskMetrics {
	providerId: ProviderId;
	taskType: TaskType;
	samples: number;
	successes: number;
	averageLatencyMs: number;
	averagePromptTokens: number;
	averageCompletionTokens: number;
	averageTotalTokens: number;
	/** Exponential moving estimate used to rank reliability-first fallbacks. */
	successProbability: number;
}

/* ─── Prompt Caching & Token Optimization Types ─────────── */

/**
 * Caching strategy configuration.
 *
 * Anthropic uses `cache_control: {type: "ephemeral"}` on system messages,
 * tool definitions, and content blocks in conversation history.
 * Gemini uses the `CachedContent` API to pre-cache static context.
 */
export interface CacheConfig {
	/** Master switch — disable caching entirely when false. */
	enabled: boolean;

	/**
	 * 'conservative': cache only system prompt + tool definitions
	 * 'aggressive':    also cache the first N conversation turns
	 * 'auto':          let the provider decide based on context length
	 */
	strategy: 'conservative' | 'aggressive' | 'auto';

	/**
	 * Cache the system prompt. Always beneficial when system prompt is >100 chars.
	 * Works for both Anthropic (cache_control) and Gemini (CachedContent).
	 */
	cacheSystemPrompt: boolean;

	/**
	 * Cache tool/function definitions. Saves significant tokens when
	 * many tools are registered (e.g. Obsidian search, read, write tools).
	 */
	cacheTools: boolean;

	/**
	 * Number of oldest conversation turns to mark as cacheable.
	 * 0 = none, 1 = first user message, 2 = first user+assistant, etc.
	 * Only used when strategy is 'aggressive'.
	 */
	cacheHistoryTurns: number;

	/**
	 * Minimum combined prompt+tool token count before caching kicks in.
	 * Avoids caching tiny prompts where the overhead isn't worth it.
	 * Default: 1024 tokens (~4000 characters).
	 */
	minCacheTokens: number;

	/**
	 * For Gemini: TTL for cached content in seconds.
	 * Default: 300 (5 minutes). Max: 604800 (7 days).
	 */
	cacheTtlSeconds: number;

	/**
	 * Enable token budget optimization.
	 * When true, the provider sets maxTokens to a percentage of the
	 * remaining context window to avoid wasteful over-allocation.
	 */
	tokenBudgetOptimization: boolean;

	/**
	 * Fraction of remaining context window to allocate for output.
	 * Range: 0.1–0.5. Default: 0.25 (25% of remaining window).
	 */
	outputBudgetFraction: number;
}

/** Default caching configuration — conservative, unoptimized. */
export const DEFAULT_CACHE_CONFIG: CacheConfig = {
	enabled: false,
	strategy: 'conservative',
	cacheSystemPrompt: true,
	cacheTools: true,
	cacheHistoryTurns: 0,
	minCacheTokens: 1024,
	cacheTtlSeconds: 300,
	tokenBudgetOptimization: false,
	outputBudgetFraction: 0.25,
};

/** Caching statistics accumulated across requests. */
export interface CacheStats {
	/** Number of cache creations (new cache entries written). */
	creations: number;
	/** Number of cache reads (cache hit). */
	reads: number;
	/** Estimated tokens saved by cache reads. */
	tokensSaved: number;
	/** Total tokens written to cache. */
	tokensWritten: number;
	/** Provider-specific cache metadata from the last response. */
	lastCacheInfo?: {
		creationTokens?: number;
		readTokens?: number;
		cacheKey?: string;
	};
}

/* ─── Image & Multimodal Types ────────────────────────────── */

/** A processed image ready for provider payload embedding. */
export interface ImageContent {
	mimeType: string;
	data: string;       // base64-encoded
	alt?: string;       // alt text if available
	originalPath: string; // original reference for debugging
}

/**
 * A single content block in a multimodal message.
 * Each provider formats these differently in `buildRequestBody()`.
 */
export type ContentBlock =
	| { type: 'text'; text: string }
	| { type: 'image'; image: ImageContent };

/* ─── Typed Errors ─────────────────────────────────────── */

export type ProviderErrorCode =
	| 'auth_failed'
	| 'rate_limited'
	| 'timeout'
	| 'connection_failed'
	| 'invalid_request'
	| 'server_error'
	| 'context_exceeded'
	| 'content_filtered'
	| 'unknown';

export class ProviderError extends Error {
	readonly code: ProviderErrorCode;
	readonly statusCode: number;
	readonly providerId: ProviderId;
	readonly retryable: boolean;

	constructor(
		code: ProviderErrorCode,
		message: string,
		providerId: ProviderId,
		statusCode: number = 0,
	) {
		super(message);
		this.name = 'ProviderError';
		this.code = code;
		this.statusCode = statusCode;
		this.providerId = providerId;
		this.retryable = RETRYABLE_CODES.has(code);
	}
}

const RETRYABLE_CODES = new Set<ProviderErrorCode>([
	'rate_limited', 'timeout', 'connection_failed', 'server_error',
]);

/** Classify an HTTP error into a typed ProviderError. */
export function classifyHttpError(
	status: number, body: string, providerId: ProviderId,
): ProviderError {
	const lower = body.toLowerCase();

	if (status === 401 || status === 403) {
		return new ProviderError('auth_failed', 'Authentication failed — check your API key.', providerId, status);
	}
	// Classify malformed requests before inspecting body keywords. A schema error
	// mentioning a "rate" field must not be mistaken for a transient 429.
	if (status === 400) {
		if (lower.includes('context') || lower.includes('token') || lower.includes('length')) {
			return new ProviderError('context_exceeded', 'Prompt exceeds context window.', providerId, status);
		}
		if (lower.includes('content') || lower.includes('filter') || lower.includes('safety')) {
			return new ProviderError('content_filtered', 'Content filtered by provider safety systems.', providerId, status);
		}
		return new ProviderError('invalid_request', body.slice(0, 200), providerId, status);
	}
	if (status === 408 || status === 504) {
		return new ProviderError('timeout', `Provider request timed out (HTTP ${status}).`, providerId, status);
	}
	if (status === 429 || lower.includes('rate limit') || lower.includes('rate_limit') || lower.includes('quota exceeded')) {
		return new ProviderError('rate_limited', 'Rate limit exceeded.', providerId, status);
	}
	if (status >= 500) {
		return new ProviderError('server_error', `Provider server error (HTTP ${status}).`, providerId, status);
	}
	return new ProviderError('unknown', `HTTP ${status}: ${body.slice(0, 200)}`, providerId, status);
}

/** Classify a thrown error (fetch failure, AbortError, etc.) into a ProviderError. */
export function classifyThrowError(
	err: unknown, providerId: ProviderId,
): ProviderError {
	if (err instanceof ProviderError) return err;
	const msg = err instanceof Error ? err.message : String(err);
	const name = err instanceof Error ? err.name : '';

	const lower = msg.toLowerCase();
	if (name === 'AbortError' || lower.includes('timeout') || lower.includes('timed out') ||
		lower.includes('etimedout') || lower.includes('econnaborted')) {
		return new ProviderError('timeout', 'Request timed out.', providerId);
	}
	if (lower.includes('fetch') || lower.includes('econnrefused') || lower.includes('econnreset') ||
		lower.includes('enotfound') || lower.includes('enetunreach') || lower.includes('ehostunreach') ||
		lower.includes('socket hang up') || lower.includes('network')) {
		return new ProviderError('connection_failed', msg, providerId);
	}
	return new ProviderError('unknown', msg, providerId);
}

/* ─── Request / Response ───────────────────────────────── */

export interface ProviderRequest {
	systemPrompt: string;
	userPrompt: string;
	tools?: ToolDefinition[];
	history?: ProviderMessage[];
	config?: Partial<ProviderRequestConfig>;
	taskId?: string;
	onStream?: (delta: string) => void;
	onToolCall?: (name: string, params: Record<string, unknown>) => Promise<ProviderToolResult>;
	/**
	 * Preprocessed images to embed in the user message.
	 * Populated by the pipeline's `preprocessPrompt()` step.
	 * Each provider adapter formats these according to its API.
	 */
	images?: ImageContent[];
}

export interface ProviderConfig {
	/** Seconds a local server should retain the loaded model before auto-eviction. Defaults to 300. */
	ttl?: number;
	/** Ollama-compatible model retention duration, such as "5m" or 300 seconds. */
	keepAlive?: string | number;
}

export interface ProviderRequestConfig extends ProviderConfig {
	temperature: number;
	maxTokens: number;
	topP: number;
	stop: string[];
	model?: string;
	/** Prompt caching and token optimization configuration. */
	cacheConfig?: Partial<CacheConfig>;
	extra: Record<string, unknown>;
}

export const DEFAULT_PROVIDER_CONFIG: ProviderRequestConfig = {
	temperature: 0.7, maxTokens: 4096, topP: 1.0, stop: [],
	// These values are stripped from cloud requests by the HTTP adapter. They
	// make every local entry point (chat, ReAct helpers, workflows, and audio)
	// opt into bounded model residency without requiring per-route overrides.
	ttl: 300, keepAlive: '5m', extra: {},
};

export type LocalRuntime = 'lmstudio' | 'ollama' | 'unknown';

/** True for loopback, link-local, or private-LAN endpoints hosting local models. */
export function isLocalBaseUrl(baseUrl: string): boolean {
	try {
		const hostname = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
		if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') ||
			hostname === '::1' || hostname === '0.0.0.0') return true;
		if (/^127(?:\.\d{1,3}){3}$/.test(hostname) || /^10(?:\.\d{1,3}){3}$/.test(hostname) ||
			/^192\.168(?:\.\d{1,3}){2}$/.test(hostname) || /^169\.254(?:\.\d{1,3}){2}$/.test(hostname)) return true;
		const match172 = /^172\.(\d{1,3})(?:\.\d{1,3}){2}$/.exec(hostname);
		if (match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31) return true;
		return hostname.startsWith('fc') || hostname.startsWith('fd') || /^fe[89ab]/.test(hostname);
	} catch {
		return false;
	}
}

/** Identify common local engines without treating an arbitrary cloud host as local. */
export function detectLocalRuntime(baseUrl: string, providerId?: ProviderId): LocalRuntime | undefined {
	if (!isLocalBaseUrl(baseUrl)) return undefined;
	if (providerId === 'lmstudio') return 'lmstudio';
	if (providerId === 'ollama') return 'ollama';
	try {
		const url = new URL(baseUrl);
		if (url.port === '1234' || /\/api\/v1(?:\/|$)/i.test(url.pathname)) return 'lmstudio';
		if (url.port === '11434' || /\/api\/(?:generate|chat|tags|ps)(?:\/|$)/i.test(url.pathname)) return 'ollama';
	} catch { /* isLocalBaseUrl already validated the URL. */ }
	return 'unknown';
}

export interface ProviderResponse {
	output: string;
	success: boolean;
	error?: string;
	/** If failed, the typed error for intelligent fallback decisions. */
	typedError?: ProviderError;
	model?: string;
	providerId?: ProviderId;
	usage?: ProviderUsage;
	toolCalls?: ProviderToolCall[];
	latencyMs: number;
}

export interface ProviderUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	/** Tokens read from cache (Anthropic: cache_read_input_tokens). */
	cacheReadTokens?: number;
	/** Tokens written to cache (Anthropic: cache_creation_input_tokens). */
	cacheCreationTokens?: number;
}

export interface ProviderMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	toolCallId?: string;
	toolCalls?: ProviderToolCall[];
}

/** Normalized tool call — arguments are always an object, never a JSON string. */
export interface ProviderToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface ProviderToolResult {
	toolCallId: string;
	content: string;
	error?: string;
}

/* ─── Adapter Interface ────────────────────────────────── */

export interface IProviderAdapter {
	readonly id: ProviderId;
	readonly meta: ProviderMeta;

	/** Whether the provider is configured and ready. */
	isAvailable(): boolean;

	/** Quick connectivity check. Returns null if OK, error message otherwise. */
	healthCheck(): Promise<string | null>;

	/** Send a completion request. */
	complete(request: ProviderRequest): Promise<ProviderResponse>;

	/**
	 * List available models from static registry.
	 * These are the built-in models shipped with the plugin.
	 */
	listModels(): ProviderModel[];

	/**
	 * Fetch live models from the provider's API endpoint.
	 * Returns models with their server-reported capabilities.
	 * Returns an empty array if the provider doesn't support live listing
	 * or if the request fails.
	 */
	fetchLiveModels?(): Promise<ProviderModel[]>;

	/** Best model for a given task type. */
	getDefaultModel(taskType: TaskType): string;

	/** Check if a specific capability is supported. */
	supportsCapability(cap: keyof ProviderCapabilities): boolean;

	/** Count tokens for a given text (if supported). Returns -1 if not available. */
	countTokens(text: string, model?: string): Promise<number>;

	/** Optional: pre-connect or allocate resources before first use. */
	warmup?(): Promise<void>;

	/** Optional: release resources. Called on plugin unload or settings change. */
	dispose?(): void;

	/** Abort any in-flight request. */
	abort(): void;
}

/* ─── Fallback ─────────────────────────────────────────── */

export interface ProviderFallbackConfig {
	primary: ProviderId;
	fallbacks: ProviderId[];
	fallbackOnRateLimit: boolean;
	fallbackOnTimeout: boolean;
	maxAttempts: number;
	backoffMs: number;
}

export const DEFAULT_FALLBACK_CONFIG: ProviderFallbackConfig = {
	primary: 'pi-daemon',
	fallbacks: ['openrouter', 'openai'],
	fallbackOnRateLimit: true,
	fallbackOnTimeout: true,
	maxAttempts: 3,
	backoffMs: 1000,
};

/* ─── Settings ─────────────────────────────────────────── */

export interface ProviderCredentials {
	providerId: ProviderId;
	apiKey: string;
	baseUrl: string;
	enabled: boolean;
}

export interface MultiProviderSettings {
	credentials: Partial<Record<ProviderId, ProviderCredentials>>;
	routing: RoutingTable;
	fallback: ProviderFallbackConfig;
	defaults: Partial<ProviderRequestConfig>;
	/**
	 * Cached live models fetched from provider endpoints.
	 * Persisted so model lists survive page reloads.
	 * Keyed by provider ID, each entry is an array of ProviderModel.
	 */
	liveModels?: Partial<Record<ProviderId, ProviderModel[]>>;
	/** Optional adaptive cost/latency routing; disabled when omitted. */
	optimization?: Partial<RoutingOptimizationConfig>;
}