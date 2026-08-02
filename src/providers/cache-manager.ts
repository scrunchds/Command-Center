/**
 * Cache Manager — shared prompt caching and token optimization layer.
 *
 * Provides:
 *   - Cache configuration resolution (merge defaults with request config)
 *   - Cache-key generation for dedup (hash of system prompt + tools)
 *   - Token budget optimization: compute optimal maxTokens from context window
 *   - Cache statistics accumulation per provider instance
 *   - Anthropic `cache_control` marker helpers
 *   - Gemini `CachedContent` lifecycle helpers
 */

import * as crypto from 'crypto';
import type {
	CacheConfig, CacheStats,
} from './provider-types';
import { DEFAULT_CACHE_CONFIG } from './provider-types';
import type { ToolDefinition } from '../types';

/* ═══════════════════════════════════════════════════════════
   Cache Configuration
   ═══════════════════════════════════════════════════════════ */

/**
 * Merge a partial cache config (from request) with the defaults.
 */
export function resolveCacheConfig(
	partial?: Partial<CacheConfig>,
): CacheConfig {
	return { ...DEFAULT_CACHE_CONFIG, ...partial };
}

/**
 * Determine whether caching should be active for this request based on
 * estimated token count and the user's strategy.
 */
export function shouldUseCache(
	cfg: CacheConfig,
	systemPrompt: string,
	tools: ToolDefinition[] | undefined,
	historyLength: number,
): boolean {
	if (!cfg.enabled) return false;

	// Estimate approximate token count
	const estimatedTokens =
		Math.ceil(systemPrompt.length / 4) +
		(tools ? tools.reduce((sum, t) => sum + Math.ceil((t.description.length + 200) / 4), 0) : 0) +
		historyLength * 50; // rough estimate per history turn

	return estimatedTokens >= cfg.minCacheTokens;
}

/* ═══════════════════════════════════════════════════════════
   Cache Key Generation
   ═══════════════════════════════════════════════════════════ */

/**
 * Generate a deterministic cache key from the stable parts of a request:
 * system prompt + tool definitions. Used for dedup across calls.
 */
export function generateCacheKey(
	systemPrompt: string,
	tools?: ToolDefinition[],
): string {
	const hashInput = JSON.stringify({
		s: systemPrompt,
		t: tools?.map(t => ({
			n: t.name,
			d: t.description,
			p: t.parameters,
		})),
	});
	return crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 16);
}

/* ═══════════════════════════════════════════════════════════
   Token Budget Optimization
   ═══════════════════════════════════════════════════════════ */

/**
 * Compute the optimal maxTokens value based on:
 *   - model context window
 *   - estimated prompt size
 *   - configured output budget fraction
 *
 * This prevents over-allocating tokens when the remaining context is small,
 * and prevents under-allocating when the model supports large outputs.
 */
export function computeOptimalMaxTokens(
	requestedMaxTokens: number,
	estimatedPromptTokens: number,
	modelContextWindow: number,
	outputBudgetFraction: number,
): number {
	if (outputBudgetFraction <= 0 || outputBudgetFraction > 0.5) {
		outputBudgetFraction = 0.25;
	}
	const remainingWindow = modelContextWindow - estimatedPromptTokens;
	if (remainingWindow <= 0) {
		// Context already exceeded — use the requested max as a last resort
		return Math.min(requestedMaxTokens, 1024);
	}
	const budgetBased = Math.floor(remainingWindow * outputBudgetFraction);
	return Math.min(requestedMaxTokens, Math.max(budgetBased, 256));
}

/**
 * Quick estimate of prompt tokens (chars/4 heuristic).
 */
export function estimatePromptTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/* ═══════════════════════════════════════════════════════════
   Cache Statistics
   ═══════════════════════════════════════════════════════════ */

/**
 * Tracks cache creation/read events and accumulates savings estimates.
 */
export class CacheStatsTracker {
	private _stats: CacheStats = {
		creations: 0,
		reads: 0,
		tokensSaved: 0,
		tokensWritten: 0,
	};

	get stats(): Readonly<CacheStats> {
		return { ...this._stats };
	}

	/** Record a cache creation event. */
	recordCreation(tokensWritten: number): void {
		this._stats.creations++;
		this._stats.tokensWritten += tokensWritten;
	}

	/** Record a cache read (hit) event. */
	recordRead(tokensRead: number): void {
		this._stats.reads++;
		this._stats.tokensSaved += tokensRead;
	}

	/** Update with provider-specific cache info from the last response. */
	updateLastCacheInfo(info: {
		creationTokens?: number;
		readTokens?: number;
		cacheKey?: string;
	}): void {
		this._stats.lastCacheInfo = info;
	}

	/** Reset all counters. */
	reset(): void {
		this._stats = {
			creations: 0, reads: 0,
			tokensSaved: 0, tokensWritten: 0,
		};
	}
}

/* ═══════════════════════════════════════════════════════════
   Anthropic cache_control helpers
   ═══════════════════════════════════════════════════════════ */

/**
 * Wraps a tool definition's top-level fields with `cache_control`
 * if caching is active and the tool set is large enough.
 *
 * Anthropic API: cache_control can be placed on the tool object itself
 * to cache all tool definitions.
 */
export function applyAnthropicToolCache(
	tools: Record<string, unknown>[],
	cacheConfig: CacheConfig,
	_cacheKey?: string,
): Record<string, unknown>[] {
	if (!cacheConfig.enabled || !cacheConfig.cacheTools || tools.length === 0) {
		return tools;
	}
	// Anthropic allows cache_control on tool arrays via the last tool's cache_control
	// (the entire tools array is cached as a single unit)
	const lastTool = { ...tools[tools.length - 1] };
	lastTool.cache_control = { type: 'ephemeral' };
	const result = [...tools.slice(0, -1), lastTool];
	return result;
}

/**
 * Wrap system prompt in the array format required for caching.
 *
 * Anthropic API:
 *   system: [
 *     { type: "text", text: "...", cache_control: { type: "ephemeral" } }
 *   ]
 */
export function buildAnthropicSystemBlock(
	systemPrompt: string,
	cacheConfig: CacheConfig,
): string | Record<string, unknown>[] {
	if (!cacheConfig.enabled || !cacheConfig.cacheSystemPrompt || !systemPrompt) {
		return systemPrompt;
	}
	return [
		{
			type: 'text',
			text: systemPrompt,
			cache_control: { type: 'ephemeral' },
		},
	];
}

/**
 * Add `cache_control` to content blocks of early conversation turns.
 *
 * Only the *first* user message (index 0) gets cache_control on its
 * text content block. Later turns are never cached because they change.
 */
export function applyAnthropicMessageCache(
	msgContent: Record<string, unknown>[],
	messageIndex: number,
	cacheConfig: CacheConfig,
): Record<string, unknown>[] {
	if (!cacheConfig.enabled) return msgContent;
	if (cacheConfig.strategy !== 'aggressive') return msgContent;
	if (cacheConfig.cacheHistoryTurns <= 0) return msgContent;
	if (messageIndex >= cacheConfig.cacheHistoryTurns) return msgContent;

	// Only cache user messages (assistant + tool messages change per turn)
	// For the first N user turns, mark the text content block as cacheable
	const textBlock = msgContent.find(b => b.type === 'text');
	if (textBlock && !textBlock.cache_control) {
		textBlock.cache_control = { type: 'ephemeral' };
	}
	return msgContent;
}

/* ═══════════════════════════════════════════════════════════
   Gemini CachedContent helpers
   ═══════════════════════════════════════════════════════════ */

/**
 * A simplified in-memory cache for Gemini CachedContent references.
 *
 * In production this would make HTTP calls to the Gemini CachedContent API.
 * For now, we track cache keys and pretend we've cached the content;
 * the real API integration is ready to be plugged in.
 */
export class GeminiCacheStore {
	/** Map of cacheKey → { name, createdAt, ttl } */
	private _entries = new Map<string, {
		name: string;
		createdAt: number;
		ttlMs: number;
		systemPrompt: string;
		toolsChecksum: string;
	}>();

	/**
	 * Check if the cache is hit for a given cache key.
	 * Returns the cached content name if valid, null otherwise.
	 */
	lookup(cacheKey: string): string | null {
		const entry = this._entries.get(cacheKey);
		if (!entry) return null;
		const age = Date.now() - entry.createdAt;
		if (age >= entry.ttlMs) {
			this._entries.delete(cacheKey);
			return null;
		}
		return entry.name;
	}

	/**
	 * Store a new cache entry.
	 */
	store(
		cacheKey: string,
		name: string,
		ttlSeconds: number,
		systemPrompt: string,
		toolsChecksum: string,
	): void {
		this._entries.set(cacheKey, {
			name,
			createdAt: Date.now(),
			ttlMs: ttlSeconds * 1000,
			systemPrompt,
			toolsChecksum,
		});
	}

	/**
	 * Generate a Gemini-compatible TTL string from seconds.
	 */
	static ttlString(seconds: number): string {
		if (seconds >= 86400) {
			const days = Math.floor(seconds / 86400);
			const remaining = seconds % 86400;
			return `${days}d${remaining > 0 ? `${remaining}s` : ''}`;
		}
		if (seconds >= 3600) {
			const hours = Math.floor(seconds / 3600);
			const remaining = seconds % 3600;
			return `${hours}h${remaining > 0 ? `${remaining}m` : ''}`;
		}
		return `${seconds}s`;
	}

	/**
	 * Compute a tools checksum for cache dedup.
	 */
	static toolsChecksum(tools?: ToolDefinition[]): string {
		if (!tools || tools.length === 0) return '';
		const hashInput = tools.map(t => `${t.name}:${t.description}`).join('|');
		return crypto.createHash('md5').update(hashInput).digest('hex').slice(0, 8);
	}

	/** Clear all cached entries. */
	clear(): void {
		this._entries.clear();
	}

	/** Remove expired entries. */
	prune(): number {
		const now = Date.now();
		let removed = 0;
		for (const [key, entry] of this._entries) {
			if (now - entry.createdAt >= entry.ttlMs) {
				this._entries.delete(key);
				removed++;
			}
		}
		return removed;
	}
}
