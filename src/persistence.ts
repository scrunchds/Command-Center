/**
 * PersistenceManager — unified state serialization with versioning, debounced writes,
 * and state validation. Wraps Obsidian's plugin.saveData() / loadData().
 *
 * Layers:
 *   settings   → plugin settings (always saved)
 *   history    → compacted task history log
 *   sessions   → active/last-known conversation list + active ID
 *   queue      → pending task snapshot (rehydrated with status='queued')
 *
 * Schema version is embedded at the top level for migration paths.
 */

import type { Plugin } from 'obsidian';
import { TOKEN_LIMITS } from './types';

/* ─── Schema ────────────────────────────────────────────── */

const CURRENT_SCHEMA = 2;

export interface PersistedData {
	schema: number;
	settings: Record<string, unknown>;
	history: StoredTask[];
	sessions: StoredSessions | null;
	queue: StoredTask[] | null;
}

/** Compacted task stored in history / queue. */
export interface StoredTask {
	id: string;
	workerProfile: string;
	prompt: string;
	targetPath?: string;
	status: string;
	createdAt: number;
	startedAt?: number;
	completedAt?: number;
	error?: string;
	result?: { output?: string; summary?: string; metadata?: Record<string, unknown> };
}

export interface StoredSessions {
	activeId: string | null;
	conversations: StoredConversation[];
}

export interface StoredConversation {
	id: string;
	name: string;
	workerProfile: string;
	createdAt: number;
	updatedAt: number;
	turns: StoredTurn[];
}

export interface StoredTurn {
	id: string;
	role: string;
	content: string;
	timestamp: number;
	taskId?: string;
}

/* ─── Persistence Manager ────────────────────────────────── */

export class PersistenceManager {
	private readonly plugin: Plugin;
	private dirty = false;
	private pendingTimer: number | null = null;
	private readonly debounceMs = 2000;

	// In-memory state mirrors
	private settingsSnapshot: Record<string, unknown> = {};
	private history: StoredTask[] = [];
	private queue: StoredTask[] = [];
	private sessions: StoredSessions | null = null;

	constructor(plugin: Plugin) {
		this.plugin = plugin;
	}

	/* ─── Load ──────────────────────────────────────────── */

	async load(): Promise<PersistedData> {
		const raw = (await this.plugin.loadData()) as Record<string, unknown> | null;
		const data = raw ? this.migrate(raw) : this.empty();
		this.settingsSnapshot = data.settings;
		this.history = data.history;
		this.queue = data.queue ?? [];
		this.sessions = data.sessions;
		return data;
	}

	/** Create a default empty payload. */
	private empty(): PersistedData {
		return { schema: CURRENT_SCHEMA, settings: {}, history: [], sessions: null, queue: [] };
	}

	/** Migrate older schemas to CURRENT_SCHEMA. */
	private migrate(raw: Record<string, unknown>): PersistedData {
		const schema = (raw.schema as number) ?? 1;

		if (schema === CURRENT_SCHEMA) {
			// Already current — validate and return
			return {
				schema, settings: (raw.settings as Record<string, unknown>) ?? {},
				history: this.validateHistory(raw.history),
				sessions: raw.sessions as StoredSessions | null ?? null,
				queue: raw.queue as StoredTask[] | null ?? null,
			};
		}

		// v1 → v2: introduce sessions/queue, keep history + settings
		if (schema === 1) {
			return {
				schema: CURRENT_SCHEMA,
				settings: (raw.settings as Record<string, unknown>) ?? {},
				history: this.validateHistory(raw.taskHistory ?? raw.history),
				sessions: null,
				queue: null,
			};
		}

		// Unknown version: reset to empty, keep settings if possible
		return { schema: CURRENT_SCHEMA, settings: (raw.settings as Record<string, unknown>) ?? {}, history: [], sessions: null, queue: null };
	}

	/** Validate and compact loaded history entries.
	 * Uses runtime type checks on raw deserialized data — the source is
	 * `plugin.loadData()` which returns `unknown`, so inline narrowing
	 * via `Record<string, unknown>` is used with explicit coercion.
	 */
	private validateHistory(raw: unknown): StoredTask[] {
		if (!Array.isArray(raw)) return [];
		return raw
			.filter((e: Record<string, unknown>) => e && typeof e.id === 'string')
			.map((e: Record<string, unknown>) => ({
				id: e.id as string,
				workerProfile: (e.workerProfile as string) ?? 'unknown',
				prompt: (typeof e.prompt === 'string' ? e.prompt : '').slice(0, TOKEN_LIMITS.MAX_STORED_CHARS),
				targetPath: e.targetPath as string | undefined,
				status: (e.status as string) ?? 'completed',
				createdAt: (e.createdAt as number) ?? 0,
				startedAt: e.startedAt as number | undefined,
				completedAt: e.completedAt as number | undefined,
				error: typeof e.error === 'string' ? e.error.slice(0, TOKEN_LIMITS.MAX_STORED_CHARS) : undefined,
				result: e.result ? {
					output: typeof (e.result as Record<string, unknown>).output === 'string' ? ((e.result as Record<string, unknown>).output as string).slice(0, TOKEN_LIMITS.MAX_RESULT_OUTPUT_CHARS) : undefined,
					summary: typeof (e.result as Record<string, unknown>).summary === 'string' ? ((e.result as Record<string, unknown>).summary as string).slice(0, TOKEN_LIMITS.MAX_STORED_CHARS) : undefined,
					metadata: (e.result as Record<string, unknown>).metadata as Record<string, unknown> | undefined,
				} : undefined,
			}))
			.slice(0, 100);
	}

	/* ─── Getters for rehydrated state ──────────────────── */

	getHistory(): StoredTask[] { return this.history; }
	getQueue(): StoredTask[] { return this.queue; }
	getSessions(): StoredSessions | null { return this.sessions; }

	/* ─── Push state (callers: main.ts, conversation.ts, etc.) ─── */

	setSettings(settings: Record<string, unknown>): void {
		this.settingsSnapshot = settings;
		this.markDirty();
	}

	setHistory(history: StoredTask[]): void {
		this.history = history;
		this.markDirty();
	}

	setQueue(queue: StoredTask[]): void {
		this.queue = queue;
		this.markDirty();
	}

	setSessions(sessions: StoredSessions): void {
		this.sessions = sessions;
		this.markDirty();
	}

	/* ─── Debounced flush ────────────────────────────────── */

	private markDirty(): void {
		this.dirty = true;
		if (this.pendingTimer) self.clearTimeout(this.pendingTimer);
		this.pendingTimer = self.setTimeout(() => { void this.flush(); }, this.debounceMs);
	}

	async flush(): Promise<void> {
		if (this.pendingTimer) { self.clearTimeout(this.pendingTimer); this.pendingTimer = null; }
		if (!this.dirty) return;
		this.dirty = false;

		const payload: PersistedData = {
			schema: CURRENT_SCHEMA,
			settings: this.settingsSnapshot,
			history: this.history,
			sessions: this.sessions,
			queue: this.queue,
		};

		try {
			await this.plugin.saveData(payload);
		} catch (err) {
			console.error('[CC] PersistenceManager flush failed:', err);
		}
	}

/** Force immediate write — call on plugin unload. */
	async forceFlush(): Promise<void> {
		if (this.pendingTimer) { self.clearTimeout(this.pendingTimer); this.pendingTimer = null; }
		if (this.dirty) {
			this.dirty = false;
			await this.plugin.saveData({
				schema: CURRENT_SCHEMA,
				settings: this.settingsSnapshot,
				history: this.history,
				sessions: this.sessions,
				queue: this.queue,
			});
		}
	}
}
