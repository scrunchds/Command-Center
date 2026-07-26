import type {
	ProviderError, ProviderFallbackConfig, ProviderId,
} from './provider-types';

/** How the fallback pipeline should react to a normalized provider error. */
export type ProviderFailureAction = 'fail' | 'fallback-immediate' | 'fallback-backoff';

/**
 * Permanent request errors fail immediately. Authentication is provider-local,
 * so another configured adapter may still work, but it must not incur backoff.
 * Only transient failures use exponential backoff and affect circuit state.
 */
export function classifyProviderFailure(
	error: ProviderError | undefined,
	config: ProviderFallbackConfig,
): ProviderFailureAction {
	if (!error) return 'fail';

	switch (error.code) {
		case 'auth_failed':
			return 'fallback-immediate';
		case 'rate_limited':
			return config.fallbackOnRateLimit ? 'fallback-backoff' : 'fail';
		case 'timeout':
			return config.fallbackOnTimeout ? 'fallback-backoff' : 'fail';
		case 'connection_failed':
		case 'server_error':
			return 'fallback-backoff';
		case 'invalid_request':
		case 'context_exceeded':
		case 'content_filtered':
		case 'unknown':
		default:
			return 'fail';
	}
}

export function isTransientProviderError(error: ProviderError | undefined): boolean {
	return error?.retryable === true;
}

export type ProviderCircuitState = 'closed' | 'open' | 'half-open';

interface CircuitEntry {
	failures: number;
	openedAt: number;
}

/** Provider-keyed circuit breaker that records transient failures only. */
export class ProviderCircuitBreaker {
	private readonly entries = new Map<ProviderId, CircuitEntry>();

	constructor(
		private readonly failureThreshold = 3,
		private readonly resetAfterMs = 30_000,
	) {}

	getState(providerId: ProviderId, now = Date.now()): ProviderCircuitState {
		const entry = this.entries.get(providerId);
		if (!entry || entry.failures < this.failureThreshold) return 'closed';
		return now - entry.openedAt >= this.resetAfterMs ? 'half-open' : 'open';
	}

	canRequest(providerId: ProviderId, now = Date.now()): boolean {
		return this.getState(providerId, now) !== 'open';
	}

	recordSuccess(providerId: ProviderId): void {
		this.entries.delete(providerId);
	}

	recordFailure(providerId: ProviderId, error: ProviderError | undefined, now = Date.now()): void {
		if (!isTransientProviderError(error)) return;
		const current = this.entries.get(providerId);
		const failures = (current?.failures ?? 0) + 1;
		this.entries.set(providerId, {
			failures,
			openedAt: failures >= this.failureThreshold ? now : (current?.openedAt ?? 0),
		});
	}

	getFailureCount(providerId: ProviderId): number {
		return this.entries.get(providerId)?.failures ?? 0;
	}

	reset(providerId?: ProviderId): void {
		if (providerId) this.entries.delete(providerId);
		else this.entries.clear();
	}
}
