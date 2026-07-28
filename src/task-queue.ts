/**
 * Task Queue — FIFO queue with configurable concurrency limits.
 *
 * Manages the lifecycle of agent tasks: enqueue, dequeue, run, complete/fail.
 * Ensures that no more than `concurrency` tasks run simultaneously.
 * Emits events for status bar updates and UI integration.
 */

import type { Task, TaskResult, QueueEntry, QueueStats } from './types';
import { TOKEN_LIMITS } from './types';

/**
 * Streaming callback type for real-time output during task execution.
 */
export type TaskStreamCallback = (delta: string, taskId: string) => void;

export type TaskQueueEvent = 'enqueued' | 'started' | 'completed' | 'failed' | 'drained';

export type TaskQueueListener = (event: TaskQueueEvent, task: Task) => void;

export interface TaskExecutor {
	execute(task: Task): Promise<TaskResult>;
}

export class TaskQueue {
	private queue: QueueEntry[] = [];
	private activeCount = 0;
	private readonly activeTasks = new Map<string, Task>();
	private completedCount = 0;
	private failedCount = 0;
	private readonly maxConcurrency: number;
	private readonly executor: TaskExecutor;
	private listeners: Map<TaskQueueEvent, TaskQueueListener[]> = new Map();
	constructor(executor: TaskExecutor, maxConcurrency: number = 2) {
		this.executor = executor;
		this.maxConcurrency = maxConcurrency;
	}

	/* ─── Public API ─────────────────────────────────── */

	enqueue(task: Task, callbacks?: { onComplete?: (result: TaskResult) => void; onError?: (error: string) => void }): void {
		// Reject oversized prompts before they enter the queue
		if (task.prompt.length > TOKEN_LIMITS.MAX_PROMPT_CHARS) {
			const err = `Prompt too large (${task.prompt.length} chars, max ${TOKEN_LIMITS.MAX_PROMPT_CHARS})`;
			callbacks?.onError?.(err);
			return;
		}

		const entry: QueueEntry = {
			task: { ...task, status: 'queued', createdAt: Date.now() },
			enqueuedAt: Date.now(),
			onComplete: callbacks?.onComplete,
			onError: callbacks?.onError,
		};

		this.queue.push(entry);
		this.emit('enqueued', entry.task);

		if (this.activeCount === 0) void this.processNext();
	}

	getStats(): QueueStats {
		return {
			pending: this.queue.length,
			running: this.activeCount,
			completed: this.completedCount,
			failed: this.failedCount,
			total: this.completedCount + this.failedCount + this.queue.length + this.activeCount,
		};
	}

	/** Read-only task IDs used by dashboard telemetry; prompts remain private. */
	getTaskStates(): ReadonlyArray<{ id: string; status: 'queued' | 'running' }> {
		return [
			...[...this.activeTasks.values()].map(task => ({ id: task.id, status: 'running' as const })),
			...this.queue.map(entry => ({ id: entry.task.id, status: 'queued' as const })),
		];
	}

	clear(): void {
		this.queue = [];
	}

	on(event: TaskQueueEvent, listener: TaskQueueListener): void {
		const existing = this.listeners.get(event) ?? [];
		existing.push(listener);
		this.listeners.set(event, existing);
	}

	off(event: TaskQueueEvent, listener: TaskQueueListener): void {
		const existing = this.listeners.get(event);
		if (existing) {
			this.listeners.set(
				event,
				existing.filter((l) => l !== listener),
			);
		}
	}

	/* ─── Internal Processing ────────────────────────── */

	private async processNext(): Promise<void> {
		while (this.queue.length > 0 && this.activeCount < this.maxConcurrency) {
			const entry = this.queue.shift()!;
			this.activeCount++;
			entry.task.status = 'running';
			this.activeTasks.set(entry.task.id, entry.task);
			entry.task.startedAt = Date.now();
			this.emit('started', entry.task);

			void this.runTask(entry).finally(() => {
				this.activeTasks.delete(entry.task.id);
				this.activeCount--;
				void this.processNext();
			});
		}

		if (this.activeCount === 0 && this.queue.length === 0) {
			this.emit('drained', {
				id: '', workerProfile: '', prompt: '', status: 'completed' as const,
				createdAt: Date.now(),
			});
		}
	}

	private async runTask(entry: QueueEntry): Promise<void> {
		try {
			// Thread the task-level stream callback through to the executor
			const result = await this.executor.execute(entry.task);
			entry.task.status = 'completed';
			entry.task.completedAt = Date.now();
			entry.task.result = result;
			this.completedCount++;
			this.emit('completed', entry.task);
			entry.onComplete?.(result);
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			entry.task.status = 'failed';
			entry.task.completedAt = Date.now();
			entry.task.error = errorMsg;
			this.failedCount++;
			this.emit('failed', entry.task);
			entry.onError?.(errorMsg);
		}
	}

	private emit(event: TaskQueueEvent, task: Task): void {
		const listeners = this.listeners.get(event);
		if (listeners) {
			for (const listener of listeners) {
				try {
					listener(event, task);
				} catch {
					// prevent listener errors from breaking the queue
				}
			}
		}
	}
}