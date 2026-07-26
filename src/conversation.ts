/**
 * Conversation Manager — multi-turn conversation state for agent interactions.
 * Enforces token budgets, auto-evicts stale conversations, and compacts turn history.
 */

import * as crypto from 'crypto';
import type { TaskResult } from './types';
import { TOKEN_LIMITS } from './types';
import type { PiAgentDaemon } from './daemon';
import type { ProviderDispatcher } from './dispatcher';
import type { ProviderMessage, TaskType } from './providers/provider-types';
import { getWorkerProfile } from './workers';
import type { AgentMemoryStore } from './memory/memory-store';
import type { HybridRetriever } from './rag/hybrid-retriever';
import { injectRagContext } from './rag/rag-tool';

export interface Turn {
	id: string;
	role: 'user' | 'assistant' | 'tool';
	content: string;
	timestamp: number;
	taskId?: string;
	metadata?: Record<string, unknown>;
}

export interface Conversation {
	id: string;
	name: string;
	workerProfile: string;
	createdAt: number;
	updatedAt: number;
	turns: Turn[];
}

export class ConversationManager {
	private conversations = new Map<string, Conversation>();
	private activeConversationId: string | null = null;
	private readonly daemon: PiAgentDaemon;
	private readonly onPersist?: () => void;
	private readonly memoryStore?: AgentMemoryStore;
	private readonly retriever?: HybridRetriever;
	private readonly contextCharLimit: number;
	private readonly getStyleGuide?: () => string;
	private readonly MAX_CONVERSATIONS = 20;
	private readonly MAX_TURN_CHARS = TOKEN_LIMITS.MAX_TURN_CHARS;
	private readonly MAX_TURNS = TOKEN_LIMITS.MAX_TURNS;

	constructor(
		daemon: PiAgentDaemon, onPersist?: () => void, memoryStore?: AgentMemoryStore,
		retriever?: HybridRetriever, contextCharLimit = 8_000, getStyleGuide?: () => string,
	) {
		this.daemon = daemon;
		this.onPersist = onPersist;
		this.memoryStore = memoryStore;
		this.retriever = retriever;
		this.contextCharLimit = Math.max(0, contextCharLimit);
		this.getStyleGuide = getStyleGuide;
	}

	/** Rehydrate a stored conversation without auto-activating it. */
	hydrate(conv: Conversation): void {
		this.conversations.set(conv.id, conv);
	}

	create(workerProfile: string, name?: string): Conversation {
		this.evictIfNeeded();
		const id = crypto.randomUUID();
		const conv: Conversation = {
			id, name: name || `Conv ${this.conversations.size + 1}`,
			workerProfile, createdAt: Date.now(), updatedAt: Date.now(), turns: [],
		};
		this.conversations.set(id, conv);
		this.activeConversationId = id;
		return conv;
	}

	getActive(): Conversation | undefined {
		return this.activeConversationId ? this.conversations.get(this.activeConversationId) : undefined;
	}
	get(id: string): Conversation | undefined { return this.conversations.get(id); }
	setActive(id: string): boolean {
		return this.conversations.has(id) ? (this.activeConversationId = id, true) : false;
	}
	delete(id: string): boolean {
		if (this.activeConversationId === id) this.activeConversationId = null;
		return this.conversations.delete(id);
	}
	list(): Conversation[] { return [...this.conversations.values()]; }

	/** Evict the least-recently-updated conversation when over capacity. */
	private evictIfNeeded(): void {
		if (this.conversations.size < this.MAX_CONVERSATIONS) return;
		let oldest: Conversation | undefined;
		for (const c of this.conversations.values()) {
			if (!oldest || c.updatedAt < oldest.updatedAt) oldest = c;
		}
		if (oldest) {
			if (this.activeConversationId === oldest.id) this.activeConversationId = null;
			this.conversations.delete(oldest.id);
		}
	}

	/** Execute a multi-provider turn while retaining this manager's bounded history. */
	async executeProviderTurn(
		dispatcher: ProviderDispatcher,
		message: string,
		taskType?: TaskType,
		onStream?: (delta: string) => void,
	): Promise<TaskResult> {
		let conv = this.getActive();
		if (!conv) conv = this.create('chat', 'Command Center Chat');
		const history: ProviderMessage[] = conv.turns.slice(-this.MAX_TURNS).map(turn => ({
			role: turn.role === 'tool' ? 'tool' : turn.role,
			content: turn.content,
		}));
		this.addTurn(conv, 'user', message);
		this.compactTurns(conv);
		try {
			const context = await this.buildContext(message);
			const styleGuide = this.getStyleGuide?.() ?? '';
			const response = await dispatcher.dispatch({
				systemPrompt: `You are Command Center operating inside an Obsidian vault. Follow the user-authored style guide below; do not substitute a built-in tone.\n\n<style-guide>\n${styleGuide}\n</style-guide>${context}`,
				userPrompt: message,
				history,
				onStream,
			}, taskType);
			if (!response.success) throw new Error(response.error ?? 'Provider request failed.');
			this.addTurn(conv, 'assistant', response.output, undefined, {
				providerId: response.providerId, model: response.model, usage: response.usage,
			});
			this.compactTurns(conv);
			this.onPersist?.();
			await this.retainSession(conv);
			return {
				output: response.output,
				metadata: { providerId: response.providerId, model: response.model, usage: response.usage },
			};
		} catch (error) {
			this.addTurn(conv, 'assistant', `Error: ${(error as Error).message}`);
			this.compactTurns(conv);
			this.onPersist?.();
			throw error;
		}
	}

	async executeTurn(message: string, targetPath?: string, onStream?: (delta: string) => void): Promise<TaskResult> {
		let conv = this.getActive();
		if (!conv) {
			conv = this.create('default-orchestrator');
		}

		// Add user turn (compacted)
		this.addTurn(conv, 'user', message);
		this.compactTurns(conv);

		const taskId = crypto.randomUUID();
		const wrapper = onStream ? (d: string, tid: string) => { if (tid === taskId) onStream(d); } : undefined;

		try {
			const response = await this.daemon.executeTask({
				taskId, workerProfile: conv.workerProfile,
				prompt: this.buildPrompt(conv, message), targetPath,
			}, wrapper);

			const result = response.result || {};
			const output = (result.output || result.summary || JSON.stringify(result))
				.slice(0, this.MAX_TURN_CHARS);

			this.addTurn(conv, 'assistant', output, taskId, result.metadata);
			this.compactTurns(conv);
			this.onPersist?.();
			await this.retainSession(conv);
			return result;
		} catch (err) {
			const errMsg = `Error: ${(err as Error).message}`.slice(0, this.MAX_TURN_CHARS);
			this.addTurn(conv, 'assistant', errMsg, taskId);
			this.compactTurns(conv);
			this.onPersist?.();
			throw err;
		}
	}

	private addTurn(conv: Conversation, role: Turn['role'], content: string, taskId?: string, metadata?: Record<string, unknown>): void {
		conv.turns.push({
			id: crypto.randomUUID(), role,
			content: content.slice(0, this.MAX_TURN_CHARS), timestamp: Date.now(), taskId, metadata,
		});
		conv.updatedAt = Date.now();
	}

	/** Trim turns down to MAX_TURNS from the tail of the window. */
	private compactTurns(conv: Conversation): void {
		if (conv.turns.length > this.MAX_TURNS) {
			conv.turns = conv.turns.slice(-this.MAX_TURNS);
		}
	}

	private async buildContext(query: string): Promise<string> {
		const context = await injectRagContext(this.retriever, query, {
			existingContext: this.memoryStore?.getSystemMemoryPrompt(query) ?? '',
			limit: 5,
			charBudget: this.contextCharLimit,
			logger: { warn: (message: string, error: unknown) => console.warn(message.replace('Passive RAG', 'Passive chat retrieval'), error) },
		});
		return context ? `\n\n${context}` : '';
	}

	private async retainSession(conv: Conversation): Promise<void> {
		if (!this.memoryStore) return;
		try {
			await this.memoryStore.summarizeSession(conv.id, conv.turns.map(turn => ({
				role: turn.role, content: turn.content, timestamp: turn.timestamp,
			})));
		} catch (error) { console.warn('[CC] Unable to retain conversation memory:', error); }
	}

	async steer(message: string): Promise<void> { await this.daemon.steer(message); }
	async followUp(message: string): Promise<void> { await this.daemon.followUp(message); }
	async abort(): Promise<void> { await this.daemon.abort(); }

	private buildPrompt(conv: Conversation, newMsg: string): string {
		const profile = getWorkerProfile(conv.workerProfile);
		const hint = profile ? `You are the "${profile.label}" agent.\n\n` : '';
		const recent = conv.turns.slice(-this.MAX_TURNS);
		const history = recent.length > 0
			? '## History\n' + recent.map(t =>
				`### ${t.role === 'user' ? 'User' : 'Assistant'}\n${t.content.slice(0, this.MAX_TURN_CHARS)}`
			).join('\n\n') + '\n\n'
			: '';
		// Enforce total prompt budget
		let prompt = `${hint}${history}## Request\n${newMsg.slice(0, this.MAX_TURN_CHARS * 2)}`;
		if (prompt.length > TOKEN_LIMITS.MAX_PROMPT_CHARS) {
			prompt = prompt.slice(0, TOKEN_LIMITS.MAX_PROMPT_CHARS) + '\n\n[prompt truncated]';
		}
		return prompt;
	}
}
