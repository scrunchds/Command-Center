/** Persistent, vault-native long-term memory for chat and agent execution. */

import type { App } from 'obsidian';

export type MemoryCategory = 'facts' | 'preferences' | 'entities' | 'summaries';
export type MemoryCategorySelector = MemoryCategory | 'sessions';

export interface MemoryEntry {
	id: string;
	category: MemoryCategory;
	key: string;
	value: string;
	createdAt: number;
	updatedAt: number;
}

export interface MemoryTurn {
	role: string;
	content: string;
	timestamp?: number;
}

export interface SessionSummaryMetadata {
	date: string;
	sessionId: string;
	topics: string[];
	agentEvalScore: number;
}

export interface SessionSummaryInput {
	sessionId: string;
	summary: string;
	date?: string | Date;
	topics?: string[];
	agentEvalScore?: number;
}

export interface AgentMemoryStoreOptions {
	debounceMs?: number;
	contextCharLimit?: number;
}

interface PersistedMemory {
	version: 1;
	entries: MemoryEntry[];
}

const MEMORY_ROOT = '.command-center';
const MEMORY_NOTES_DIR = `${MEMORY_ROOT}/memory`;
const MEMORY_PATH = `${MEMORY_ROOT}/memory.json`;
const DEFAULT_CONTEXT_LIMIT = 1_500;
const TOKEN_RE = /[\p{L}\p{N}_'-]+/gu;
const TOPIC_STOP_WORDS = new Set([
	'the', 'and', 'that', 'this', 'with', 'from', 'have', 'was', 'were', 'for', 'into',
	'user', 'assistant', 'session', 'created', 'completed', 'about', 'your', 'their',
]);

function normalize(value: string): string {
	return value.toLocaleLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function tokens(value: string): Set<string> {
	return new Set(normalize(value).match(TOKEN_RE) ?? []);
}

function similarity(left: string, right: string): number {
	const a = tokens(left), b = tokens(right);
	if (!a.size && !b.size) return 1;
	let intersection = 0;
	for (const term of a) if (b.has(term)) intersection++;
	return intersection / Math.max(1, a.size + b.size - intersection);
}

function canonicalCategory(category: MemoryCategorySelector): MemoryCategory {
	return category === 'sessions' ? 'summaries' : category;
}

function titleCase(value: string): string {
	return value.replace(/(^|[-_ ])\p{L}/gu, match => match.toUpperCase());
}

function cleanScalar(value: string): string {
	return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function yamlString(value: string): string {
	return JSON.stringify(cleanScalar(value));
}

function clampScore(score: number | undefined): number {
	return Number.isFinite(score) ? Math.max(0, Math.min(1, score as number)) : 0;
}

function inferTopics(text: string, limit = 6): string[] {
	const counts = new Map<string, number>();
	for (const term of normalize(text).match(TOKEN_RE) ?? []) {
		if (term.length < 3 || TOPIC_STOP_WORDS.has(term)) continue;
		counts.set(term, (counts.get(term) ?? 0) + 1);
	}
	return [...counts]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, limit)
		.map(([term]) => term);
}

function normalizeTopics(topics: string[] | undefined, summary: string): string[] {
	const source = topics?.length ? topics : inferTopics(summary);
	const unique = new Map<string, string>();
	for (const topic of source) {
		const clean = cleanScalar(topic).slice(0, 80);
		if (clean) unique.set(normalize(clean), clean);
	}
	return [...unique.values()].slice(0, 12);
}

function truncateLine(value: string, available: number): string {
	if (available <= 0) return '';
	if (value.length <= available) return value;
	if (available === 1) return '…';
	return `${value.slice(0, available - 1).trimEnd()}…`;
}

/**
 * Format recalled memory as a bounded Markdown prompt fragment. Entries are
 * expected in relevance order. Summaries are intentionally omitted because
 * they are verbose and facts/preferences/entities provide the durable signal.
 */
export function formatMemoryContext(entries: readonly MemoryEntry[], maxChars = DEFAULT_CONTEXT_LIMIT): string {
	const ceiling = Math.max(0, Math.floor(maxChars));
	if (!ceiling) return '';
	const useful = entries.filter(entry => entry.category !== 'summaries');
	if (!useful.length) return '';

	const lines: string[] = ['## Persistent Memory'];
	let length = lines[0]?.length ?? 0;
	for (const category of ['preferences', 'facts', 'entities'] as const) {
		const categoryEntries = useful.filter(entry => entry.category === category);
		if (!categoryEntries.length) continue;
		const heading = `### ${titleCase(category)}`;
		const additions = [heading, ...categoryEntries.map(entry =>
			`- **${cleanScalar(entry.key)}:** ${cleanScalar(entry.value)}`)];
		for (const line of additions) {
			const separator = '\n';
			const available = ceiling - length - separator.length;
			if (available <= 0) return lines.join('\n').slice(0, ceiling);
			const bounded = truncateLine(line, available);
			if (!bounded) return lines.join('\n').slice(0, ceiling);
			lines.push(bounded);
			length += separator.length + bounded.length;
			if (bounded !== line) return lines.join('\n');
		}
	}
	return lines.join('\n').slice(0, ceiling);
}

/**
 * Stores structured memory in `.command-center/memory.json`. All persistence
 * uses the Obsidian Vault API; rapid changes are coalesced into one write.
 */
export class AgentMemoryStore {
	private readonly app: App;
	private readonly entries = new Map<string, MemoryEntry>();
	private readonly debounceMs: number;
	private readonly contextCharLimit: number;
	private loadPromise: Promise<void>;
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private flushChain: Promise<void> = Promise.resolve();
	private dirty = false;

	constructor(app: App, options: AgentMemoryStoreOptions = {}) {
		this.app = app;
		this.debounceMs = Math.max(0, options.debounceMs ?? 500);
		this.contextCharLimit = Math.max(0, options.contextCharLimit ?? DEFAULT_CONTEXT_LIMIT);
		this.loadPromise = this.load();
	}

	/** Await initial vault hydration; useful during plugin startup and tests. */
	async ready(): Promise<void> { await this.loadPromise; }

	/** Store or semantically update one durable memory slot. */
	async storeMemoryItem(category: MemoryCategory, key: string, value: unknown): Promise<MemoryEntry> {
		await this.ready();
		const cleanCategory = canonicalCategory(category);
		const cleanKey = cleanScalar(key);
		const serialized = typeof value === 'string' ? value : JSON.stringify(value);
		const cleanValue = cleanScalar(serialized ?? '');
		if (!cleanKey || !cleanValue) throw new Error('Memory key and value must be non-empty.');

		const normalizedKey = normalize(cleanKey);
		let existing = [...this.entries.values()].find(entry =>
			entry.category === cleanCategory && (
				normalize(entry.key) === normalizedKey || similarity(entry.key, cleanKey) >= 0.8
			));
		const now = Date.now();
		if (existing) {
			existing.key = cleanKey;
			existing.value = cleanValue;
			existing.updatedAt = now;
		} else {
			existing = {
				id: `${cleanCategory}:${normalizedKey}:${now}:${this.entries.size}`,
				category: cleanCategory,
				key: cleanKey,
				value: cleanValue,
				createdAt: now,
				updatedAt: now,
			};
			this.entries.set(existing.id, existing);
		}
		this.dirty = true;
		this.scheduleFlush();
		return { ...existing };
	}

	/** Backward-compatible alias used by chat and agent integrations. */
	async addFact(category: MemoryCategorySelector, key: string, value: unknown): Promise<MemoryEntry> {
		return this.storeMemoryItem(canonicalCategory(category), key, value);
	}

	getFacts(category?: MemoryCategorySelector): MemoryEntry[] {
		const selected = category ? canonicalCategory(category) : null;
		return [...this.entries.values()]
			.filter(entry => !selected || entry.category === selected)
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.map(entry => ({ ...entry }));
	}

	/** Rank memories by exact phrase, token coverage, key match, and recency. */
	searchMemory(query: string, limit = 20): MemoryEntry[] {
		const normalizedQuery = normalize(query);
		const queryTokens = tokens(query);
		if (!queryTokens.size || limit <= 0) return [];
		return [...this.entries.values()].map(entry => {
			const keyTokens = tokens(entry.key);
			const valueTokens = tokens(`${entry.category} ${entry.value}`);
			let keyOverlap = 0, valueOverlap = 0;
			for (const term of queryTokens) {
				if (keyTokens.has(term)) keyOverlap++;
				if (valueTokens.has(term)) valueOverlap++;
			}
			const phrase = normalize(`${entry.key} ${entry.value}`).includes(normalizedQuery) ? 1 : 0;
			const score = phrase * 2 + (keyOverlap * 1.5 + valueOverlap) / queryTokens.size;
			return { entry, score };
		}).filter(result => result.score > 0)
			.sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt)
			.slice(0, Math.floor(limit))
			.map(result => ({ ...result.entry }));
	}

	async summarizeSession(sessionId: string, turns: MemoryTurn[]): Promise<MemoryEntry> {
		const usable = turns.filter(turn => turn.content.trim()).slice(-12);
		const summary = usable.map(turn => {
			const role = turn.role === 'assistant' ? 'Assistant' : turn.role === 'user' ? 'User' : turn.role;
			return `${role}: ${cleanScalar(turn.content).slice(0, 500)}`;
		}).join('\n');
		return this.storeSessionSummary({
			sessionId,
			summary: summary || 'Session completed without retained turns.',
		});
	}

	/** Persist a consolidated summary and emit its standalone Markdown note. */
	async storeSessionSummary(input: SessionSummaryInput): Promise<MemoryEntry> {
		await this.ready();
		const sessionId = cleanScalar(input.sessionId);
		const summary = input.summary.trim();
		if (!sessionId || !summary) throw new Error('Session ID and summary must be non-empty.');
		const entry = await this.storeMemoryItem('summaries', sessionId, summary);
		const date = input.date instanceof Date
			? input.date.toISOString()
			: input.date ? new Date(input.date).toISOString() : new Date().toISOString();
		const metadata: SessionSummaryMetadata = {
			date,
			sessionId,
			topics: normalizeTopics(input.topics, summary),
			agentEvalScore: clampScore(input.agentEvalScore),
		};
		await this.writeSummaryNote(metadata, summary);
		return entry;
	}

	/** Concise memory block suitable for a system prompt. */
	getSystemMemoryPrompt(query?: string, limit = 12, maxChars = this.contextCharLimit): string {
		const candidates = query?.trim() ? this.searchMemory(query, limit * 2) : this.getFacts();
		return formatMemoryContext(candidates.slice(0, Math.max(0, limit)), maxChars);
	}

	formatMemoryContext(query?: string, maxChars = this.contextCharLimit): string {
		const candidates = query?.trim() ? this.searchMemory(query) : this.getFacts();
		return formatMemoryContext(candidates, maxChars);
	}

	async flushToDisk(): Promise<void> {
		await this.ready();
		if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
		if (!this.dirty && this.app.vault.getAbstractFileByPath(MEMORY_PATH)) {
			await this.flushChain;
			return;
		}
		const payload = JSON.stringify({ version: 1, entries: this.getFacts() } satisfies PersistedMemory, null, 2);
		this.dirty = false;
		const write = async (): Promise<void> => {
			try {
				await this.ensureFolder(MEMORY_ROOT);
				const file = this.app.vault.getAbstractFileByPath(MEMORY_PATH);
				if (file) await this.app.vault.modify(file as never, payload);
				else await this.app.vault.create(MEMORY_PATH, payload);
			} catch (error) {
				this.dirty = true;
				throw error;
			}
		};
		this.flushChain = this.flushChain.then(write, write);
		await this.flushChain;
	}

	/** Lifecycle hook: cancel debounce and wait for all pending persistence. */
	async forceFlush(): Promise<void> { await this.flushToDisk(); }

	private scheduleFlush(): void {
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = setTimeout(() => {
			void this.flushToDisk().catch(error =>
				console.warn('[Command Center] Unable to persist agent memory:', error));
		}, this.debounceMs);
	}

	private async ensureFolder(path: string): Promise<void> {
		if (this.app.vault.getAbstractFileByPath(path)) return;
		const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
		if (parent) await this.ensureFolder(parent);
		if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.createFolder(path);
	}

	private async writeSummaryNote(metadata: SessionSummaryMetadata, summary: string): Promise<void> {
		await this.ensureFolder(MEMORY_NOTES_DIR);
		const safeSession = metadata.sessionId.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'session';
		const day = metadata.date.slice(0, 10);
		const basePath = `${MEMORY_NOTES_DIR}/${day}-${safeSession}`;
		let path = `${basePath}.md`, suffix = 2;
		while (this.app.vault.getAbstractFileByPath(path)) path = `${basePath}-${suffix++}.md`;
		const topics = metadata.topics.length
			? `\n${metadata.topics.map(topic => `  - ${yamlString(topic)}`).join('\n')}`
			: ' []';
		const body = [
			'---',
			`date: ${yamlString(metadata.date)}`,
			`session_id: ${yamlString(metadata.sessionId)}`,
			`topics:${topics}`,
			`agent_eval_score: ${metadata.agentEvalScore}`,
			'---', '',
			`# Session Summary — ${metadata.sessionId}`, '',
			summary.trim(), '',
		].join('\n');
		await this.app.vault.create(path, body);
	}

	private async load(): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(MEMORY_PATH);
		if (!file) return;
		try {
			const raw = await this.app.vault.read(file as never);
			const parsed = JSON.parse(raw) as Partial<PersistedMemory>;
			if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
				this.dirty = true;
				return;
			}
			for (const candidate of parsed.entries) {
				if (!candidate || typeof candidate !== 'object') continue;
				const legacy = candidate as unknown as Record<string, unknown>;
				if (typeof legacy.id !== 'string' || typeof legacy.key !== 'string' || typeof legacy.value !== 'string') continue;
				const category = legacy.category === 'sessions' ? 'summaries' : legacy.category;
				if (category !== 'facts' && category !== 'preferences' && category !== 'entities' && category !== 'summaries') continue;
				const createdAt = typeof legacy.createdAt === 'number' && Number.isFinite(legacy.createdAt) ? legacy.createdAt : Date.now();
				const updatedAt = typeof legacy.updatedAt === 'number' && Number.isFinite(legacy.updatedAt) ? legacy.updatedAt : createdAt;
				this.entries.set(legacy.id, {
					id: legacy.id, category, key: legacy.key, value: legacy.value, createdAt, updatedAt,
				});
			}
		} catch (error) {
			// Corrupt or unreadable state is non-fatal. Keep a clean in-memory store;
			// the next mutation replaces the invalid file with valid schema data.
			this.entries.clear();
			this.dirty = true;
			console.warn('[Command Center] Unable to load agent memory; starting clean:', error);
		}
	}
}

export { MEMORY_PATH as AGENT_MEMORY_PATH, MEMORY_NOTES_DIR as AGENT_MEMORY_NOTES_DIR };
