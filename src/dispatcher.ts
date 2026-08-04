/**
 * Provider Dispatcher — unified execution layer with dynamic client factory,
 * multi-tiered fallback pipeline, and health-check-aware routing.
 *
 * Entry point for all LLM requests. Given a task (with optional TaskType),
 * the dispatcher:
 *   1. Classifies the task type
 *   2. Resolves the primary provider + model route
 *   3. Executes via the primary provider
 *   4. Falls back through the configured fallback chain on failure
 *   5. Returns the best available response
 */

import type {
	IProviderAdapter, ProviderId, ProviderRequest, ProviderResponse,
	ProviderFallbackConfig, MultiProviderSettings, TaskType,
} from './providers/provider-types';
import { DEFAULT_FALLBACK_CONFIG } from './providers/provider-types';
import { ProviderFactory } from './providers/provider-factory';
import {
	ProviderCircuitBreaker,
} from './providers/provider-recovery';
import { classifyTask, resolveRoute, type ResolvedRoute } from './routing/routing-table';
import { executeFallbackChain, defaultBackoff } from './providers/fallback-pipeline';

/* ─── Dispatcher ───────────────────────────────────────── */

export class ProviderDispatcher {
	private factory: ProviderFactory;
	private getSettings: () => MultiProviderSettings;
	/** Provider-local circuits; permanent auth/schema errors never open them. */
	readonly circuitBreaker = new ProviderCircuitBreaker();
	/**
	 * Bounded memo for prompt → TaskType classification. classifyTask compiles
	 * several regexes per call and runs on every dispatch; caching by prompt
	 * (capped, FIFO-evicted) removes that repeated work for repeated prompts
	 * (e.g. retried/steered turns) without changing routing behavior.
	 */
	private readonly classificationCache = new Map<string, TaskType>();
	private readonly classificationCacheLimit = 128;

	constructor(factory: ProviderFactory, getSettings: () => MultiProviderSettings) {
		this.factory = factory;
		this.getSettings = getSettings;
	}

	/**
	 * Dispatch a request through the routing matrix + fallback chain.
	 * This is the main entry point — callers don't need to know the provider.
	 */
	async dispatch(
		request: ProviderRequest,
		explicitTaskType?: TaskType,
	): Promise<ProviderResponse> {
		const settings = this.getSettings();
		const taskType = explicitTaskType ?? this.classifyCached(request.userPrompt);
		const route = resolveRoute(taskType, settings);
		const fallback = settings.fallback ?? DEFAULT_FALLBACK_CONFIG;

		return this._dispatchWithFallback(request, route, fallback);
	}

	/**
	 * Dispatch to a specific provider directly (no routing or fallback).
	 */
	async dispatchTo(
		providerId: ProviderId,
		request: ProviderRequest,
	): Promise<ProviderResponse> {
		const provider = this.factory.get(providerId);
		if (!this.factory.isUsable(providerId)) {
			return {
				output: '', success: false,
				error: `Provider ${providerId} is not enabled or not available.`,
				providerId, latencyMs: 0,
			};
		}
		return provider.complete(request);
	}

	/**
	 * Run a health check against all configured providers.
	 * Returns a map of providerId → error-or-null.
	 */
	async healthCheckAll(): Promise<Record<ProviderId, string | null>> {
		const results = {} as Record<ProviderId, string | null>;
		const settings = this.getSettings();
		const providers = Object.keys(settings.credentials).filter(
			id => (settings.credentials[id as ProviderId])?.enabled
		) as ProviderId[];

		// Always include pi-daemon
		if (!providers.includes('pi-daemon')) providers.unshift('pi-daemon');

		for (const id of providers) {
			const provider = this.factory.get(id);
			results[id] = await provider.healthCheck();
		}
		return results;
	}

	/** Get all available providers. */
	listAvailable(): IProviderAdapter[] {
		return this.factory.listAvailable();
	}

	/** Invalidate cached providers (e.g., after credentials change). */
	invalidate(id?: ProviderId): void {
		this.factory.invalidate(id);
	}

	/**
	 * Classify a prompt with a bounded FIFO cache. classifyTask is a pure
	 * function of (prompt, workerProfile) that compiles regexes per call; this
	 * memoizes its result so repeated dispatches of the same prompt skip the
	 * regex work. The cache is capped and evicts in insertion order.
	 */
	private classifyCached(prompt: string, workerProfile?: string): TaskType {
		const key = `${prompt}\u0000${workerProfile ?? ''}`;
		const hit = this.classificationCache.get(key);
		if (hit !== undefined) return hit;
		const taskType = classifyTask(prompt, workerProfile);
		if (this.classificationCache.size >= this.classificationCacheLimit) {
			const oldest = this.classificationCache.keys().next();
			if (!oldest.done) this.classificationCache.delete(oldest.value);
		}
		this.classificationCache.set(key, taskType);
		return taskType;
	}

	/* ─── Internal Fallback Pipeline ────────────────── */

	private async _dispatchWithFallback(
		request: ProviderRequest,
		route: ResolvedRoute,
		fallback: ProviderFallbackConfig,
	): Promise<ProviderResponse> {
		// Build the ordered list of providers to try. The execution loop is shared
		// with ModelRouter via fallback-pipeline.ts; only the chain order is local
		// (ProviderDispatcher keeps the configured fallback order, while
		// ModelRouter sorts by observed success probability).
		const chain = this._buildFallbackChain(route.providerId, fallback);
		const { response, attempts } = await executeFallbackChain(
			request, route, chain, fallback,
			this.circuitBreaker, this.factory,
			{ backoff: defaultBackoff },
		);
		if (response.success) return response;

		// Preserve the dispatcher's pre-unification exhaustion message, which
		// surfaces the last transient error rather than the generic stub. The
		// shared pipeline only sets 'All providers failed.' when no attempt
		// produced a response at all.
		const failed = attempts as Array<{ error?: string }> | undefined;
		const lastError = failed?.length
			? failed[failed.length - 1]!.error ?? response.error
			: response.error;
		if (!response.error || response.error === 'All providers failed.') {
			return {
				...response,
				error: `All providers failed. Last error: ${lastError ?? 'Unknown'}`,
			};
		}
		return response;
	}

	private _buildFallbackChain(
		primary: ProviderId,
		fallback: ProviderFallbackConfig,
	): ProviderId[] {
		const chain = [primary];
		for (const fb of fallback.fallbacks) {
			if (fb !== primary) chain.push(fb);
		}
		// Safety net: append every enabled+available provider so a local-only setup
		// (e.g. LM Studio alone) is always reachable even when the configured
		// primary and fallback chain are all disabled/unconfigured. Dedup preserves
		// the configured order.
		for (const adapter of this.factory.listUsable()) {
			if (!chain.includes(adapter.id)) chain.push(adapter.id);
		}
		return chain;
	}
}