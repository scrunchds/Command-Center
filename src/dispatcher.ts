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
	ProviderFallbackConfig, ProviderError, MultiProviderSettings, TaskType,
} from './providers/provider-types';
import { DEFAULT_FALLBACK_CONFIG } from './providers/provider-types';
import { ProviderFactory } from './providers/provider-factory';
import {
	classifyProviderFailure, ProviderCircuitBreaker, type ProviderFailureAction,
} from './providers/provider-recovery';
import { classifyTask, resolveRoute, type ResolvedRoute } from './routing/routing-table';

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
		// Build the ordered list of providers to try
		const chain = this._buildFallbackChain(route.providerId, fallback);
		let lastError: string | undefined;

		for (let i = 0; i < Math.min(chain.length, fallback.maxAttempts); i++) {
			const providerId = chain[i]!;
			const provider = this.factory.get(providerId);

			if (!this.circuitBreaker.canRequest(providerId)) {
				lastError = `Provider ${providerId} circuit is open after transient failures.`;
				continue;
			}

			if (!this.factory.isUsable(providerId)) {
				lastError = `Provider ${providerId} not available.`;
				continue;
			}

			// Use the route model for the primary, a live/registry default for fallbacks.
			const modelId = i === 0
				? route.modelId
				: this.factory.resolveModelForTask(providerId, route.taskType);

			const providerRequest: ProviderRequest = {
				...request,
				config: { ...route.config, model: modelId },
			};

			try {
				const response = await provider.complete(providerRequest);

				if (!response.success) {
					const action = classifyProviderFailure(response.typedError, fallback);
					this.circuitBreaker.recordFailure(providerId, response.typedError);
					if (action !== 'fail') {
						lastError = response.error;
						await this._backoffFor(action, fallback, i, chain.length);
						continue;
					}
					// Request-level failures (400/schema/context/content) are not made
					// valid by changing providers. Return immediately without backoff.
					return response;
				}

				this.circuitBreaker.recordSuccess(providerId);
				return response;
			} catch (err) {
				const typedErr = (err as Record<string, unknown>)?.code
					? (err as ProviderError)
					: undefined;
				const action = classifyProviderFailure(typedErr, fallback);
				this.circuitBreaker.recordFailure(providerId, typedErr);
				if (action !== 'fail') {
					lastError = typedErr?.message ?? (err as Error).message;
					await this._backoffFor(action, fallback, i, chain.length);
					continue;
				}
				return {
					output: '', success: false, error: (err as Error).message,
					typedError: typedErr, providerId, latencyMs: 0,
				};
			}
		}

		return {
			output: '', success: false,
			error: `All providers failed. Last error: ${lastError ?? 'Unknown'}`,
			latencyMs: 0,
		};
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

	private async _backoffFor(
		action: ProviderFailureAction,
		config: ProviderFallbackConfig,
		attemptIndex: number,
		chainLength: number,
	): Promise<void> {
		if (action === 'fallback-backoff' && attemptIndex < chainLength - 1) {
			await this._delay(config.backoffMs * Math.pow(2, attemptIndex));
		}
	}

	private _delay(ms: number): Promise<void> {
		return new Promise(r => window.setTimeout(r, ms));
	}
}