/**
 * Shared fallback-execution pipeline.
 *
 * `ProviderDispatcher` (chat path) and `ModelRouter` (dashboard path) both
 * walk an ordered provider chain with the same circuit-breaker / usability /
 * failure-classification / backoff logic. This module is that single loop.
 *
 * Routing outcomes are preserved byte-for-byte: the chain is still built and
 * ordered by each caller (they differ — ModelRouter sorts fallbacks by
 * observed success probability; ProviderDispatcher keeps configured order),
 * and each caller owns its own `ProviderCircuitBreaker` instance. Only the
 * per-provider execution step is shared.
 *
 * Optional concerns are injected via `FallbackHooks` so the two callers keep
 * their distinct behavior without duplicating the loop:
 *  - `onAttempt`: ModelRouter records EMA metrics + pushes a `RouteAttempt`.
 *  - `shouldSkip`: ModelRouter gates fallbacks (i > 0) on capability match.
 *  - `backoff`:    both use the same backoff; injected only to avoid a circular
 *                  import back into the caller's `_delay`.
 */

import type {
	ProviderId, ProviderRequest, ProviderResponse,
	ProviderFallbackConfig, ProviderError,
} from './provider-types';
import {
	classifyProviderFailure, ProviderCircuitBreaker, type ProviderFailureAction,
} from './provider-recovery';
import type { ResolvedRoute } from '../routing/routing-table';

/** Per-attempt hook: record metrics, push a `RouteAttempt`, etc. */
export type FallbackOnAttempt = (
	providerId: ProviderId, modelId: string, attemptIndex: number,
	response: ProviderResponse | null, error: ProviderError | null | undefined,
	latencyMs: number,
) => void;

/**
 * Capability gate for *fallback* attempts (i > 0). Return `true` to skip the
 * provider (a capability gap). The primary (i === 0) is never gated.
 */
export type FallbackShouldSkip = (
	providerId: ProviderId, taskType: ResolvedRoute['taskType'], attemptIndex: number,
) => boolean | { reason: string };

/** Backoff sleeper. Returns the delay actually awaited (0 for none). */
export type FallbackBackoff = (
	action: ProviderFailureAction, config: ProviderFallbackConfig,
	attemptIndex: number, chainLength: number,
) => Promise<void>;

export interface FallbackHooks {
	onAttempt?: FallbackOnAttempt;
	shouldSkip?: FallbackShouldSkip;
	backoff?: FallbackBackoff;
}

export interface FallbackResult {
	response: ProviderResponse;
	/** Per-provider attempt log. Empty when the caller supplies no `onAttempt`. */
	attempts: unknown[];
}

/**
 * Execute `request` across `chain`, starting at `route`'s provider/model and
 * falling back on transient failures. Stops immediately on request-level
 * (400/schema/context/content) failures — those aren't fixed by switching
 * providers.
 *
 * `route.providerId` must equal `chain[0]`; the caller is responsible for
 * building the chain with the primary first.
 */
export async function executeFallbackChain(
	request: ProviderRequest,
	route: ResolvedRoute,
	chain: ProviderId[],
	fallback: ProviderFallbackConfig,
	circuitBreaker: ProviderCircuitBreaker,
	factory: {
		get: (id: ProviderId) => { complete: (req: ProviderRequest) => Promise<ProviderResponse> };
		isUsable: (id: ProviderId) => boolean;
		resolveModelForTask: (id: ProviderId, taskType: ResolvedRoute['taskType']) => string;
	},
	hooks: FallbackHooks = {},
): Promise<FallbackResult> {
	const attempts: unknown[] = [];
	let lastResponse: ProviderResponse | null = null;
	const backoff = hooks.backoff ?? defaultBackoff;

	for (let i = 0; i < Math.min(chain.length, fallback.maxAttempts); i++) {
		const providerId = chain[i]!;
		const t0 = Date.now();

		// Capability gate (fallbacks only — the primary is the configured choice).
		if (hooks.shouldSkip) {
			const skip = hooks.shouldSkip(providerId, route.taskType, i);
			if (skip) {
				const reason = typeof skip === 'object' ? skip.reason : 'skipped';
				hooks.onAttempt?.(providerId, 'skipped', i, null, null, 0);
				attempts.push({ providerId, modelId: 'skipped', attemptIndex: i, success: false, error: reason, latencyMs: 0 });
				continue;
			}
		}

		if (!circuitBreaker.canRequest(providerId)) {
			hooks.onAttempt?.(providerId, 'skipped', i, null, null, 0);
			attempts.push({ providerId, modelId: 'skipped', attemptIndex: i, success: false, error: `Provider ${providerId} circuit is open after transient failures.`, latencyMs: 0 });
			continue;
		}
		if (!factory.isUsable(providerId)) {
			hooks.onAttempt?.(providerId, 'unavailable', i, null, null, 0);
			attempts.push({ providerId, modelId: 'unavailable', attemptIndex: i, success: false, error: `Provider ${providerId} not available.`, latencyMs: 0 });
			continue;
		}

		// The primary uses the route's model; fallbacks use a live/registry default.
		const modelId = i === 0
			? route.modelId
			: factory.resolveModelForTask(providerId, route.taskType);
		const providerReq: ProviderRequest = {
			...request,
			config: { ...route.config, model: modelId },
		};

		try {
			const provider = factory.get(providerId);
			const response = await provider.complete(providerReq);
			const elapsed = response.latencyMs || Date.now() - t0;

			hooks.onAttempt?.(providerId, modelId, i, response, null, elapsed);
			attempts.push({ providerId, modelId, attemptIndex: i, success: response.success, error: response.error, latencyMs: elapsed });

			if (response.success) {
				circuitBreaker.recordSuccess(providerId);
				return { response, attempts };
			}

			const action = classifyProviderFailure(response.typedError, fallback);
			circuitBreaker.recordFailure(providerId, response.typedError);
			if (action !== 'fail') {
				lastResponse = response;
				await backoff(action, fallback, i, chain.length);
				continue;
			}
			// Request-level failure — not made valid by changing providers.
			return { response, attempts };
		} catch (err) {
			const elapsed = Date.now() - t0;
			const typedErr = (err as Record<string, unknown>)?.code
				? (err as ProviderError)
				: undefined;
			hooks.onAttempt?.(providerId, modelId, i, null, typedErr, elapsed);
			attempts.push({ providerId, modelId, attemptIndex: i, success: false, error: (err as Error).message, latencyMs: elapsed });

			const action = classifyProviderFailure(typedErr, fallback);
			circuitBreaker.recordFailure(providerId, typedErr);
			if (action !== 'fail') {
				await backoff(action, fallback, i, chain.length);
				continue;
			}
			return {
				response: {
					output: '', success: false, error: (err as Error).message,
					typedError: typedErr, providerId, latencyMs: 0,
				},
				attempts,
			};
		}
	}

	// Exhausted the chain (or hit maxAttempts) on transient failures.
	return {
		response: lastResponse ?? {
			output: '', success: false,
			error: 'All providers failed.',
			latencyMs: 0,
		},
		attempts,
	};
}

/** Shared backoff: only `fallback-backoff` waits, and only mid-chain. */
export async function defaultBackoff(
	action: ProviderFailureAction, config: ProviderFallbackConfig,
	attemptIndex: number, chainLength: number,
): Promise<void> {
	if (action === 'fallback-backoff' && attemptIndex < chainLength - 1) {
		await new Promise<void>(r => window.setTimeout(r, config.backoffMs * Math.pow(2, attemptIndex)));
	}
}
