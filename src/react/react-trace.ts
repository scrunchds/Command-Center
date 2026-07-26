/**
 * ReAct Trace Events — structured, real-time event stream for monitoring
 * and visualizing the multi-agent ReAct execution loop.
 *
 * Every agent thought, tool invocation, observation, correction, and
 * cycle transition is emitted as a typed trace event. The Obsidian
 * dashboard consumes these to render a collapsible execution tree.
 */

/* ─── Trace Event Types ───────────────────────────────── */

export type ReActTraceEventType =
	| 'session:start'
	| 'session:pause'
	| 'session:resume'
	| 'session:end'
	| 'cycle:start'
	| 'cycle:end'
	| 'agent:role:create'
	| 'agent:think:start'
	| 'agent:think:delta'
	| 'agent:think:end'
	| 'agent:act:start'
	| 'agent:act:tool_call'
	| 'agent:act:tool_result'
	| 'agent:observe'
	| 'agent:correct'
	| 'agent:validate'
	| 'agent:error'
	| 'agent:complete';

/* ─── Trace Event ──────────────────────────────────────── */

export interface TraceTokenUsage {
	promptTokens?: number;
	completionTokens?: number;
	totalTokens?: number;
}

export interface TraceToolInvocation {
	name: string;
	arguments: Record<string, unknown>;
	result?: unknown;
	error?: string;
}

/** Audit payload retained independently from the abbreviated row content. */
export interface ReActTraceDetail {
	inputPrompt?: string;
	modelResponse?: string;
	toolInvocations?: TraceToolInvocation[];
	evaluation?: Record<string, unknown>;
	tokenUsage?: TraceTokenUsage;
}

export interface ReActTraceEvent {
	/** Unique event id for tree rendering. */
	id: string;
	/** The ReAct session this event belongs to. */
	sessionId: string;
	/** Parent event id (for tree structure). */
	parentId: string | null;
	/** Which agent emitted this (orchestrator, retriever, summarizer, editor). */
	agent: string;
	/** The event type. */
	type: ReActTraceEventType;
	/** Main cycle index (or -1 for session-level events). */
	cycleIndex: number;
	/** Agent sub-cycle index (or -1). */
	subCycle: number;
	/** Wall-clock timestamp. */
	timestamp: number;
	/** Human-readable label for tree display. */
	label: string;
	/** Detailed text content (thought, observation, tool output, etc.). */
	content: string;
	/** Structured metadata for tool calls, corrections, validations. */
	meta?: Record<string, unknown>;
	/** Full-fidelity data used by replay, detail inspection, and audit export. */
	detail?: ReActTraceDetail;
}

/* ─── Trace Collector ──────────────────────────────────── */

export type TraceEventCallback = (event: ReActTraceEvent) => void;

export type ReActStepAdvance = 'next' | 'resume';

/**
 * Cooperative cycle gate for interactive debugging. Waiting here is deliberately
 * outside provider/tool timeout and retry scopes, so user think time cannot count
 * as an agent failure or pollute circuit-breaker state.
 */
export class ReActStepController {
	private enabled = false;
	private pausedSessionId: string | null = null;
	private resolveWait: ((advance: ReActStepAdvance) => void) | null = null;

	isEnabled(): boolean { return this.enabled; }
	isPaused(): boolean { return this.resolveWait !== null; }
	getPausedSessionId(): string | null { return this.pausedSessionId; }

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (!enabled) this.release('resume');
	}

	/** Wait at a safe cycle boundary only when debugging is currently enabled. */
	wait(sessionId: string): Promise<ReActStepAdvance> {
		if (!this.enabled) return Promise.resolve('resume');
		// A daemon owns one active ReAct session, but defensively release a stale gate.
		this.release('resume');
		this.pausedSessionId = sessionId;
		return new Promise(resolve => { this.resolveWait = resolve; });
	}

	/** Advance exactly one cycle while leaving debug mode enabled. */
	nextStep(): boolean {
		if (!this.resolveWait) return false;
		this.release('next');
		return true;
	}

	/** Disable stepping and release any paused session. */
	resume(): boolean {
		const wasPaused = this.resolveWait !== null;
		this.enabled = false;
		this.release('resume');
		return wasPaused;
	}

	/** Cancel a gate during daemon stop/session cleanup without reporting failure. */
	cancel(): void { this.release('resume'); }

	private release(advance: ReActStepAdvance): void {
		const resolve = this.resolveWait;
		this.resolveWait = null;
		this.pausedSessionId = null;
		resolve?.(advance);
	}
}

/** Retained history is bounded independently from the 50-row virtualized UI tail. */
const MAX_RETAINED_TRACE_EVENTS = 2_000;

/**
 * Collects trace events and maintains a tree structure for rendering.
 * Events are emitted in real-time to a callback and also accumulated
 * for historical review.
 */
export class ReActTraceCollector {
	private events: ReActTraceEvent[] = [];
	private callback: TraceEventCallback | null = null;
	private readonly listeners = new Set<TraceEventCallback>();
	private counter = 0;

	constructor(callback?: TraceEventCallback) {
		this.callback = callback ?? null;
	}

	setCallback(cb: TraceEventCallback | null): void { this.callback = cb; }

	/** Subscribe alongside the legacy single view callback. */
	addListener(listener: TraceEventCallback): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	/**
	 * Detach a listener only when it is still the active listener. This prevents
	 * a closing view from disconnecting a newer view that replaced it.
	 */
	clearCallback(cb?: TraceEventCallback): void {
		if (!cb || this.callback === cb) this.callback = null;
	}

	/** Emit a new trace event. Returns the event for chaining. */
	emit(
		sessionId: string,
		parentId: string | null,
		agent: string,
		type: ReActTraceEventType,
		cycleIndex: number,
		subCycle: number,
		label: string,
		content: string,
		meta?: Record<string, unknown>,
		detail?: ReActTraceDetail,
	): ReActTraceEvent {
		const event: ReActTraceEvent = {
			id: `trace-${++this.counter}-${type}`,
			sessionId,
			parentId,
			agent,
			type,
			cycleIndex,
			subCycle,
			timestamp: Date.now(),
			label,
			content,
			meta,
			detail,
		};
		this.events.push(event);
		if (this.events.length > MAX_RETAINED_TRACE_EVENTS) {
			this.events.splice(0, this.events.length - MAX_RETAINED_TRACE_EVENTS);
		}
		if (this.callback) {
			try { this.callback(event); } catch { /* guard */ }
		}
		for (const listener of this.listeners) {
			try { listener(event); } catch { /* guard */ }
		}
		return event;
	}

	/** Return all events in chronological order. */
	getEvents(): ReActTraceEvent[] {
		return [...this.events];
	}

	/** Return events for a specific session. */
	getSessionEvents(sessionId: string): ReActTraceEvent[] {
		return this.events.filter(e => e.sessionId === sessionId);
	}

	/** Build a nested tree from the flat event list. */
	buildTree(sessionId: string): ReActTraceNode[] {
		const events = this.getSessionEvents(sessionId);
		const nodeMap = new Map<string, ReActTraceNode>();
		const roots: ReActTraceNode[] = [];

		for (const evt of events) {
			const node: ReActTraceNode = {
				event: evt,
				children: [],
				depth: 0,
			};
			nodeMap.set(evt.id, node);
		}

		for (const evt of events) {
			const node = nodeMap.get(evt.id)!;
			if (evt.parentId && nodeMap.has(evt.parentId)) {
				const parent = nodeMap.get(evt.parentId)!;
				node.depth = parent.depth + 1;
				parent.children.push(node);
			} else {
				node.depth = 0;
				roots.push(node);
			}
		}

		return roots;
	}

	/** Clear all events. */
	clear(): void { this.events = []; this.counter = 0; }
}

/* ─── Trace Tree Node ──────────────────────────────────── */

export interface ReActTraceNode {
	event: ReActTraceEvent;
	children: ReActTraceNode[];
	depth: number;
}