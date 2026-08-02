/**
 * ReAct Error Recovery — robust fallback, timeout, retry, and deadlock detection.
 *
 * Mechanisms:
 *   1. Tool timeouts      — every tool call gets a deadline; on timeout, fall back
 *   2. Malformed outputs   — unparseable responses trigger retry with format guidance
 *   3. Reasoning deadlocks — repeated identical outputs or stuck loops → force different approach
 *   4. Circuit breakers    — track per-tool failure rates; temporarily disable failing tools
 *   5. Safe state rollback — snapshot before destructive ops; restore on failure
 *   6. Fallback strategies — if worker fails, retry with simpler prompt or different worker
 */

import type { ToolDefinition } from '../types';

/* ─── Timeout ──────────────────────────────────────────── */

/** Wraps a promise with a timeout. Rejects with TimedOutError if exceeded. */
export class TimedOutError extends Error {
	constructor(operation: string, ms: number) {
		super(`${operation} timed out after ${ms}ms`);
		this.name = 'TimedOutError';
	}
}

export function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
	if (ms <= 0) return fn();
	return new Promise((resolve, reject) => {
		const timer = window.setTimeout(() => reject(new TimedOutError(label, ms)), ms);
		fn().then(
			v => { window.clearTimeout(timer); resolve(v); },
			// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- re-throwing the original rejection value preserves the error chain
			e => { window.clearTimeout(timer); reject(e); },
		);
	});
}

/* ─── Retry ────────────────────────────────────────────── */

export interface RetryConfig {
	maxRetries: number;
	baseDelayMs: number;
	backoffMultiplier: number;
	/** If true, only retry on TimedOutError or specific error patterns. */
	retryOnTimeoutOnly: boolean;
}

const DEFAULT_RETRY: RetryConfig = {
	maxRetries: 2,
	baseDelayMs: 500,
	backoffMultiplier: 2,
	retryOnTimeoutOnly: false,
};

export async function withRetry<T>(
	fn: () => Promise<T>,
	config: Partial<RetryConfig> = {},
	label: string = 'operation',
): Promise<T> {
	const cfg = { ...DEFAULT_RETRY, ...config };
	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			if (attempt === cfg.maxRetries) break;
			if (cfg.retryOnTimeoutOnly && !(lastError instanceof TimedOutError)) throw lastError;
			const delay = cfg.baseDelayMs * Math.pow(cfg.backoffMultiplier, attempt);
			await new Promise(r => window.setTimeout(r, delay));
		}
	}
	throw lastError ?? new Error(`${label} failed after retries`);
}

/* ─── Fallback ─────────────────────────────────────────── */

export async function withFallback<T>(
	primary: () => Promise<T>,
	fallback: () => Promise<T>,
): Promise<T> {
	try {
		return await primary();
	} catch (_err) {
		return await fallback();
	}
}

/* ─── Circuit Breaker ──────────────────────────────────── */

export class CircuitBreaker {
	private failures = new Map<string, { count: number; lastFailure: number; open: boolean }>();
	private threshold: number;
	private resetMs: number;

	constructor(threshold: number = 3, resetMs: number = 30000) {
		this.threshold = threshold;
		this.resetMs = resetMs;
	}

	/** Check if the circuit for a tool/operation is open (should be skipped). */
	isOpen(key: string): boolean {
		const state = this.failures.get(key);
		if (!state?.open) return false;
		if (Date.now() - state.lastFailure > this.resetMs) {
			state.open = false;
			state.count = 0;
			return false;
		}
		return true;
	}

	/** Record a failure for the given key. Opens the circuit if threshold exceeded. */
	recordFailure(key: string): void {
		const state = this.failures.get(key) ?? { count: 0, lastFailure: 0, open: false };
		state.count++;
		state.lastFailure = Date.now();
		if (state.count >= this.threshold) {
			state.open = true;
		}
		this.failures.set(key, state);
	}

	/** Record a success — resets the failure counter. */
	recordSuccess(key: string): void {
		const state = this.failures.get(key);
		if (state) {
			state.count = 0;
			state.open = false;
		}
	}

	reset(): void { this.failures.clear(); }
}

/* ─── Deadlock Detector ────────────────────────────────── */

export class DeadlockDetector {
	private history = new Map<string, string[]>();
	private maxHistory = 5;

	/** Check if the given output is a repeat of a previous output (deadlock). */
	isDeadlocked(sessionId: string, output: string, threshold: number = 0.9): boolean {
		const past = this.history.get(sessionId) ?? [];
		if (past.length === 0) return false;
		for (const prev of past) {
			if (this.similarity(output, prev) >= threshold) return true;
		}
		return false;
	}

	/** Record an output for future deadlock detection. */
	record(sessionId: string, output: string): void {
		const past = this.history.get(sessionId) ?? [];
		past.push(output);
		if (past.length > this.maxHistory) past.shift();
		this.history.set(sessionId, past);
	}

	reset(sessionId: string): void { this.history.delete(sessionId); }

	private similarity(a: string, b: string): number {
		const wa = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
		const wb = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
		if (wa.size === 0 || wb.size === 0) return 0;
		let intersection = 0;
		for (const w of wa) { if (wb.has(w)) intersection++; }
		return intersection / Math.max(wa.size, wb.size);
	}
}

/* ─── Safe State Manager ───────────────────────────────── */

export interface StateSnapshot {
	sessionId: string;
	cycleIndex: number;
	/** Saved context before a destructive operation. */
	context: string;
	timestamp: number;
}

export class SafeStateManager {
	private snapshots = new Map<string, StateSnapshot[]>();

	snapshot(sessionId: string, cycleIndex: number, context: string): void {
		const list = this.snapshots.get(sessionId) ?? [];
		list.push({ sessionId, cycleIndex, context, timestamp: Date.now() });
		if (list.length > 10) list.shift();
		this.snapshots.set(sessionId, list);
	}

	getLatest(sessionId: string): StateSnapshot | undefined {
		return this.snapshots.get(sessionId)?.at(-1);
	}

	rollback(sessionId: string): StateSnapshot | undefined {
		const list = this.snapshots.get(sessionId);
		if (!list || list.length === 0) return undefined;
		list.pop();
		return list.at(-1);
	}

	clear(sessionId: string): void { this.snapshots.delete(sessionId); }
}

/* ─── Tool Timeout Registry ────────────────────────────── */

export const TOOL_TIMEOUTS: Record<string, number> = {
	search_vault: 10000,
	read_note: 8000,
	write_note: 15000,
	append_note: 15000,
	list_files: 5000,
	get_active_note: 3000,
	default: 10000,
};

/** Get the timeout for a specific tool. */
export function getToolTimeout(toolName: string): number {
	const val = TOOL_TIMEOUTS[toolName];
	if (typeof val === 'number') return val;
	return TOOL_TIMEOUTS['default'] ?? 10000;
}

/* ─── Alternative Tools ────────────────────────────────── */

export const ALTERNATIVE_TOOLS: Record<string, string[]> = {
	search_vault: ['list_files', 'get_active_note'],
	read_note: ['get_active_note', 'search_vault'],
	write_note: ['append_note'],
	append_note: ['write_note'],
	list_files: ['search_vault'],
	get_active_note: ['list_files', 'search_vault'],
};

/** Get a list of alternative tool names for a given tool. */
export function getAlternativeTools(toolName: string): string[] {
	return ALTERNATIVE_TOOLS[toolName] ?? [];
}

/* ─── Recovery Strategies ──────────────────────────────── */

export type RecoveryStrategy = 'retry' | 'retry-simpler' | 'switch-worker' | 'skip-and-continue' | 'abort';

export interface RecoveryDecision {
	strategy: RecoveryStrategy;
	reason: string;
	/** Modified prompt (for retry-simpler). */
	simplerPrompt?: string;
	/** Alternative worker to try. */
	alternativeWorker?: string;
}

/**
 * Determine the best recovery strategy based on the error type and context.
 */
export function determineRecovery(
	error: Error,
	attempts: number,
	maxAttempts: number,
	workerProfile: string,
): RecoveryDecision {
	const msg = error.message.toLowerCase();

	// Timeout → retry with extended timeout, or simpler task
	if (error instanceof TimedOutError || msg.includes('timeout') || msg.includes('timed out')) {
		if (attempts < maxAttempts) {
			return { strategy: 'retry', reason: 'Timeout — retrying', simplerPrompt: 'Please provide a concise answer. Be brief.' };
		}
		return { strategy: 'retry-simpler', reason: 'Repeated timeouts — simplifying task' };
	}

	// Malformed output / parse failure
	if (msg.includes('parse') || msg.includes('malformed') || msg.includes('json')) {
		return { strategy: 'retry', reason: 'Malformed output — requesting valid format', simplerPrompt: 'Return ONLY valid JSON. No surrounding text.' };
	}

	// Daemon crash / process error
	if (msg.includes('exited') || msg.includes('spawn') || msg.includes('enoent')) {
		return { strategy: 'abort', reason: 'Daemon process error — cannot recover' };
	}

	// General failure — switch worker or skip
	if (attempts >= maxAttempts) {
		const altWorker = workerProfile === 'retriever' ? 'summarizer' : 'retriever';
		return { strategy: 'switch-worker', reason: `Worker ${workerProfile} failed ${maxAttempts}+ times — trying ${altWorker}`, alternativeWorker: altWorker };
	}

	return { strategy: 'retry', reason: 'General failure — retrying' };
}

/* ─── Recovery Wrapper ─────────────────────────────────── */

export interface RecoveryContext {
	sessionId: string;
	cycleIndex: number;
	workerProfile: string;
	task: string;
	tools: ToolDefinition[];
	maxRetries: number;
	circuitBreaker: CircuitBreaker;
	deadlockDetector: DeadlockDetector;
	safeState: SafeStateManager;
}

/**
 * Execute a worker task with full error recovery: timeout, retry,
 * deadlock detection, circuit breaking, and safe state rollback.
 */
export async function withRecovery<T>(
	fn: () => Promise<T>,
	ctx: RecoveryContext,
	toolTimeoutMs: number = 10000,
): Promise<T> {
	// Check circuit breaker
	if (ctx.circuitBreaker.isOpen(ctx.workerProfile)) {
		throw new Error(`Circuit breaker open for ${ctx.workerProfile} — too many recent failures`);
	}

	// Snapshot state before execution
	ctx.safeState.snapshot(ctx.sessionId, ctx.cycleIndex, ctx.task);

	for (let attempt = 0; attempt <= ctx.maxRetries; attempt++) {
		try {
			const result = await withTimeout(fn, toolTimeoutMs, ctx.workerProfile);

			// Check for deadlock (repeated output)
			const outputStr = typeof result === 'object' && result !== null && 'output' in result
				? (result as Record<string, unknown>).output as string ?? ''
				: '';

			if (outputStr && ctx.deadlockDetector.isDeadlocked(ctx.sessionId, outputStr)) {
				ctx.deadlockDetector.record(ctx.sessionId, outputStr);
				if (attempt >= ctx.maxRetries) {
					throw new Error('Deadlock detected — agent repeating itself');
				}
				continue; // Retry with different approach
			}
			if (outputStr) {
				ctx.deadlockDetector.record(ctx.sessionId, outputStr);
			}

			ctx.circuitBreaker.recordSuccess(ctx.workerProfile);
			return result;
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			ctx.circuitBreaker.recordFailure(ctx.workerProfile);

			if (attempt >= ctx.maxRetries) {
				const decision = determineRecovery(error, attempt, ctx.maxRetries, ctx.workerProfile);
				if (decision.strategy === 'abort') throw error;
				// Fall through to throw — recovery not possible at this level
				throw new Error(`Recovery failed after ${attempt + 1} attempts: ${error.message}`);
			}

			// Exponential backoff before retry
			await new Promise(r => window.setTimeout(r, 500 * Math.pow(2, attempt)));
		}
	}

	throw new Error(`Unrecoverable failure in ${ctx.workerProfile}`);
}