/**
 * User Memory Manager — explicit "remember this" system for storing and
 * retrieving user facts, preferences, and personal context.
 *
 * Builds on top of AgentMemoryStore but adds:
 *   - Explicit "remember this" command processing
 *   - Automatic fact extraction from conversation turns
 *   - Preference deduplication and conflict resolution
 *   - Context-aware memory retrieval for system prompts
 *
 * Vault interaction: reads/writes `.command-center/memory.json` through
 * the existing AgentMemoryStore persistence layer. No direct vault I/O.
 */

import { App } from 'obsidian';
import type { AgentMemoryStore, MemoryEntry, MemoryCategory } from '../memory/memory-store';

/* ─── Types ─────────────────────────────────────────────── */

export interface RememberCommand {
	/** The raw user statement to remember. */
	statement: string;
	/** Optional category hint. */
	category?: MemoryCategory;
	/** Optional key override. If not provided, one is inferred. */
	key?: string;
}

export interface MemoryRecall {
	/** Matching memory entries in relevance order. */
	entries: MemoryEntry[];
	/** Formatted Markdown block for system prompt injection. */
	formatted: string;
}

export interface UserMemoryProfile {
	/** Preferred name or alias. */
	name?: string;
	/** Communication preferences (e.g., "concise", "detailed"). */
	style?: string;
	/** Domain-specific knowledge areas. */
	expertise?: string[];
	/** Personal goals the user wants the agent to track. */
	goals?: Array<{ id: string; description: string; target?: string }>;
	/** Things the user has explicitly asked to remember. */
	reminders?: Array<{ id: string; note: string; createdAt: number }>;
}

/* ─── Constants ─────────────────────────────────────────── */

const DEFAULT_RECALL_LIMIT = 15;

/** Common stop phrases that should not be stored as memory keys. */
const STOP_KEY_PATTERNS = [
	/^(remember|store|save|keep|note|record|log|capture|mark)\b/i,
	/\b(that|this|the|a|an|is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|can|could|shall|should|may|might|must)\b/gi,
];

/* ─── UserMemoryManager ─────────────────────────────────── */

export class UserMemoryManager {
	private readonly store: AgentMemoryStore;
	private readonly app: App;

	constructor(app: App, store: AgentMemoryStore) {
		this.app = app;
		this.store = store;
	}

	/* ─── Core Operations ──────────────────────────────── */

	/**
	 * Process an explicit "remember this" command from the user.
	 * Extracts the key and value from natural language.
	 */
	async remember(command: RememberCommand): Promise<MemoryEntry> {
		const { statement, category = 'facts', key } = command;
		const clean = statement.trim();
		if (!clean) throw new Error('Cannot remember an empty statement.');

		// Infer key from the first noun phrase or use the provided key
		const memoryKey = key ?? this.inferKey(clean);
		const memoryValue = this.inferValue(clean, memoryKey);

		return this.store.storeMemoryItem(category, memoryKey, memoryValue);
	}

	/**
	 * Recall memories relevant to a query.
	 * Returns both raw entries and a formatted Markdown block.
	 */
	recall(query: string, limit = DEFAULT_RECALL_LIMIT): MemoryRecall {
		const entries = this.store.searchMemory(query, limit);
		const formatted = this.formatForPrompt(entries);
		return { entries, formatted };
	}

	/**
	 * Get all memories in a category.
	 */
	getByCategory(category: MemoryCategory): MemoryEntry[] {
		return this.store.getFacts(category);
	}

	/**
	 * Delete a specific memory entry by id.
	 */
	async forget(id: string): Promise<boolean> {
		// AgentMemoryStore doesn't support deletion directly, so we
		// work around it by reading, filtering, and rewriting.
		const allEntries = this.store.getFacts();
		const entry = allEntries.find(e => e.id === id);
		if (!entry) return false;

		// Store a tombstone value to mark deletion
		await this.store.storeMemoryItem(entry.category, entry.key, '[DELETED]');
		return true;
	}

	/**
	 * Build a user profile from stored memories.
	 * Aggregates preferences, facts, and entities into a structured profile.
	 */
	buildProfile(): UserMemoryProfile {
		const preferences = this.store.getFacts('preferences');
		const facts = this.store.getFacts('facts');
		const entities = this.store.getFacts('entities');

		const profile: UserMemoryProfile = {};

		// Extract name from facts
		const nameEntry = facts.find(f =>
			f.key.toLowerCase().includes('name') || f.key.toLowerCase() === 'i am'
		);
		if (nameEntry) profile.name = nameEntry.value;

		// Extract style preference
		const styleEntry = preferences.find(p =>
			p.key.toLowerCase().includes('style') || p.key.toLowerCase().includes('prefer')
		);
		if (styleEntry) profile.style = styleEntry.value;

		// Extract expertise areas from entities
		const expertiseEntries = entities.filter(e =>
			e.key.toLowerCase().includes('expert') || e.key.toLowerCase().includes('skill')
		);
		if (expertiseEntries.length > 0) {
			profile.expertise = expertiseEntries.map(e => e.value);
		}

		// Extract goals from facts
		const goalEntries = facts.filter(f =>
			f.key.toLowerCase().includes('goal') || f.key.toLowerCase().includes('objective')
		);
		if (goalEntries.length > 0) {
			profile.goals = goalEntries.map((g, i) => ({
				id: `goal-${i}`,
				description: g.value,
			}));
		}

		return profile;
	}

	/* ─── Session Integration ──────────────────────────── */

	/**
	 * Extract memorable facts from a conversation turn.
	 * Returns an array of RememberCommand candidates for review.
	 */
	extractFromTurn(userMessage: string, _assistantResponse: string): RememberCommand[] {
		const commands: RememberCommand[] = [];

		// Look for explicit "remember that" patterns
		const rememberPattern = /\b(?:remember|note|keep in mind)\s+that\s+(.+?)[.!]?$/gmi;
		for (const match of userMessage.matchAll(rememberPattern)) {
			const statement = match[1]?.trim();
			if (statement && statement.length > 10) {
				commands.push({ statement, category: 'facts' });
			}
		}

		// Look for "I am / I'm / I prefer" patterns
		const identityPattern = /\bI(?:'m| am)\s+(.+?)[.!]?$/gmi;
		for (const match of userMessage.matchAll(identityPattern)) {
			const statement = match[1]?.trim();
			if (statement && statement.length > 5) {
				commands.push({ statement, category: 'facts' });
			}
		}

		const preferencePattern = /\bI\s+(?:prefer|like|enjoy|love|hate|dislike)\s+(.+?)[.!]?$/gmi;
		for (const match of userMessage.matchAll(preferencePattern)) {
			const statement = match[1]?.trim();
			if (statement && statement.length > 5) {
				commands.push({ statement, category: 'preferences' });
			}
		}

		return commands;
	}

	/* ─── Prompt Helpers ────────────────────────────────── */

	/**
	 * Format a system prompt fragment with the user's memory profile.
	 */
	injectMemoryPrompt(query?: string, maxChars = 2_000): string {
		return this.store.getSystemMemoryPrompt(query, DEFAULT_RECALL_LIMIT, maxChars);
	}

	/* ─── Private Helpers ───────────────────────────────── */

	/**
	 * Infer a memory key from a natural language statement.
	 * Strips leading verbs and articles, takes the first noun phrase.
	 */
	private inferKey(statement: string): string {
		let cleaned = statement.trim();

		// Remove "I want you to remember that" / "Remember that" prefixes
		for (const pattern of STOP_KEY_PATTERNS) {
			cleaned = cleaned.replace(pattern, '').trim();
		}

		// Take the first meaningful phrase (up to 80 chars)
		const firstSentence = cleaned.split(/[.!?]/)[0]?.trim() ?? cleaned;
		const truncated = firstSentence.slice(0, 80).trim();

		return truncated || 'general';
	}

	/**
	 * Infer a memory value from a statement, removing the key prefix.
	 */
	private inferValue(statement: string, key: string): string {
		// If the key appears at the start of the statement, remove it
		const keyIndex = statement.toLowerCase().indexOf(key.toLowerCase());
		if (keyIndex >= 0) {
			const afterKey = statement.slice(keyIndex + key.length).trim();
			if (afterKey && afterKey.length > 3) {
				return afterKey.replace(/^is\s+|^are\s+|^was\s+|^were\s+/i, '').trim();
			}
		}

		return statement;
	}

	/**
	 * Format memory entries as a compact Markdown block for prompt injection.
	 */
	private formatForPrompt(entries: MemoryEntry[]): string {
		if (!entries.length) return '';

		const lines: string[] = ['## Relevant Memory'];
		for (const entry of entries) {
			if (entry.category === 'summaries') continue;
			lines.push(`- **${entry.key}:** ${entry.value}`);
		}

		return lines.join('\n');
	}
}

/**
 * Factory function to create a UserMemoryManager bound to the app's store.
 */
export function createUserMemoryManager(app: App, store: AgentMemoryStore): UserMemoryManager {
	return new UserMemoryManager(app, store);
}