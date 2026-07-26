/**
 * ReAct Types — core data structures for the Reason+Act loop.
 *
 * The ReAct pattern structures agent cognition as an iterative cycle:
 *   Thought → Action → Observation → (refine) → Thought → ...
 *
 * The orchestrator reasons about the task, decides which specialized
 * worker to invoke (with optional tool calls), observes the result,
 * then decides whether to continue or produce a final answer.
 */

import type { TaskResult } from '../types';
import type { ReActTraceDetail } from './react-trace';

/* ─── ReAct State ──────────────────────────────────────── */

/** Complete working memory for one ReAct execution. */
export interface ReActContext {
	/** Unique identifier for this ReAct session. */
	sessionId: string;
	/** The original user task or question. */
	task: string;
	/** Optional target note path anchoring the task. */
	targetPath?: string;
	/** Accumulated thought→action→observation cycles. */
	cycles: ReActCycle[];
	/** Metadata about the execution run. */
	meta: ReActMeta;
}

/** A single Reason→Act→Observe iteration. */
export interface ReActCycle {
	/** Zero-based index of this cycle in the session. */
	index: number;
	/** The orchestrator's reasoning about what to do next. */
	thought: ReActThought;
	/** The worker invocation (or null if this is a final answer). */
	action: ReActAction | null;
	/** The result of invoking the worker + any tool calls. */
	observation: ReActObservation | null;
	/** Timestamp when this cycle began. */
	startedAt: number;
	/** Timestamp when this cycle completed. */
	completedAt: number;
}

/* ─── Cycle Components ─────────────────────────────────── */

/** The orchestrator's reasoning — either a plan to act or a final answer. */
export interface ReActThought {
	/** Natural-language explanation of the current reasoning. */
	reasoning: string;
	/** The current assessment of progress toward the goal. */
	assessment: 'planning' | 'acting' | 'observing' | 'complete' | 'stuck';
	/** If complete, this is the final synthesized answer. */
	finalAnswer?: string;
	/** Confidence in this thought (0-1). Used for loop-termination heuristics. */
	confidence: number;
	/** Parsed structured actions retained from the orchestrator response. */
	actions?: ReActAction[];
	/** Raw model exchange retained for trace replay. */
	traceDetail?: ReActTraceDetail;
}

/** An instruction to invoke a specialized worker. */
export interface ReActAction {
	/** Which worker to invoke. */
	worker: 'retriever' | 'summarizer' | 'editor';
	/** Optional specialized role (researcher, analyst, writer, reviewer, planner, fact-checker). */
	role?: string;
	/** The prompt to send to that worker. */
	prompt: string;
	/** Optional target path for file-specific actions. */
	targetPath?: string;
	/** Expected output shape or success criteria. */
	expectedOutput: string;
	/** Inline runtime persona definition when no registered role fits. */
	customRole?: Partial<import('./react-roles').AgentRole>;
}

/** The result of a worker invocation. */
export interface ReActObservation {
	/** Raw output from the worker. */
	output: string;
	/** Structured result (if the worker returned JSON). */
	structuredResult?: TaskResult;
	/** Whether the action succeeded or failed. */
	success: boolean;
	/** If failed, the error message. */
	error?: string;
	/** Key facts or insights extracted from the observation. */
	keyInsights: string[];
	/** Did this observation change our understanding? */
	surprised: boolean;
}

/* ─── Loop Configuration ────────────────────────────────── */

export interface ReActConfig {
	/** Maximum number of Reason→Act cycles before forced termination. */
	maxCycles: number;
	/** Minimum confidence threshold to auto-terminate with a final answer. */
	confidenceThreshold: number;
	/** Maximum total characters in the accumulated context before compaction. */
	maxContextChars: number;
	/** Whether to stream intermediate thoughts to the UI. */
	streamThoughts: boolean;
}

export const DEFAULT_REACT_CONFIG: ReActConfig = {
	maxCycles: 5,
	confidenceThreshold: 0.85,
	maxContextChars: 24_000,
	streamThoughts: true,
};

/** Per-agent ReAct loop configuration — smaller scope than the full session. */
export interface AgentReActConfig {
	/** Maximum sub-cycles this agent may run before forced completion. */
	maxSubCycles: number;
	/** The profile name this agent uses (for prompt selection). */
	profile: string;
	/** System prompt override (if empty, uses the default for the profile). */
	systemPrompt?: string;
}

export const DEFAULT_AGENT_REACT_CONFIG: AgentReActConfig = {
	maxSubCycles: 3,
	profile: 'retriever',
};

/** Output from a worker agent's own mini ReAct loop. */
export interface WorkerReActResult {
	/** Final accumulated output from the agent. */
	output: string;
	/** Number of sub-cycles the agent executed. */
	subCycles: number;
	/** Number of tool calls the agent made. */
	toolCalls: number;
	/** Whether the agent successfully completed its task. */
	success: boolean;
	/** Error message if the agent failed. */
	error?: string;
	/** Key insights extracted from the agent's output. */
	keyInsights: string[];
	/** Number of self-corrections the agent applied. */
	corrections: number;
	/** Log of validation events during this agent's run. */
	validationLog: ValidationEvent[];
	/** Full-fidelity prompt/response/tool/usage data for trace inspection. */
	traceDetail?: ReActTraceDetail;
}

/* ─── Self-Correction & Validation ──────────────────────── */

/** Severity of a validation issue. */
export type ValidationSeverity = 'info' | 'warning' | 'error' | 'fatal';

/** A single validation event recorded during agent execution. */
export interface ValidationEvent {
	/** Which checkpoint triggered this (pre-observation, post-response, pre-return). */
	checkpoint: 'pre-response' | 'post-observation' | 'pre-return';
	/** Sub-cycle index when this occurred. */
	subCycle: number;
	/** Severity of the finding. */
	severity: ValidationSeverity;
	/** What was detected. */
	issue: string;
	/** What corrective action was taken (if any). */
	correction?: string;
	/** Timestamp. */
	at: number;
}

/** Result of validating an agent's output. */
export interface ValidationOutcome {
	/** Whether the output passed validation. */
	passed: boolean;
	/** List of issues found. */
	issues: string[];
	/** If not passed, a correction prompt to feed back to the agent. */
	correctionPrompt?: string;
	/** Recommended action: retry, different-approach, or accept-as-is. */
	action: 'accept' | 'retry' | 'retry-different' | 'abort';
}

/* ─── Execution Metadata ────────────────────────────────── */

export interface ReActMeta {
	/** When the ReAct session started. */
	startedAt: number;
	/** When it ended (or 0 if still running). */
	completedAt: number;
	/** Total number of cycles executed. */
	totalCycles: number;
	/** Total daemon invocations (worker calls). */
	daemonCalls: number;
	/** Total tool invocations (read_note, search_vault, etc.). */
	toolCalls: number;
	/** Termination reason. */
	termination: ReActTermination;
}

export type ReActTermination =
	| 'final_answer'     // Orchestrator produced a confident final answer
	| 'max_cycles'       // Hit the cycle limit
	| 'stuck'            // Orchestrator declared itself stuck
	| 'error'            // Unrecoverable error during execution
	| 'aborted';         // User or system aborted

/* ─── ReAct Response Parser Types ───────────────────────── */

/** The structured JSON the orchestrator must return in ReAct mode. */
export interface ReActResponse {
	/** The orchestrator's current thought. */
	thought: {
		reasoning: string;
		assessment: 'planning' | 'acting' | 'observing' | 'complete' | 'stuck';
		confidence: number;
	};
	/** Actions to take next; supports parallel dispatch and inline custom roles. */
	actions?: ReActAction[];
	/** Legacy single-action response accepted for model compatibility. */
	action?: ReActAction;
	/** The final answer (only present when assessment is 'complete'). */
	finalAnswer?: string;
}
