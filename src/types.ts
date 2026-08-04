/**
 * Command Center — shared types for the agentic OS layer.
 */

import type { StandardAgentRole } from './engine/AgentTypes';

/* ─── Task Types ─────────────────────────────────────────── */

/** Hard limits enforced pre-enqueue and at the RPC bridge. */
export const TOKEN_LIMITS = {
	/** Maximum prompt length (characters) before a task is rejected at enqueue. */
	MAX_PROMPT_CHARS: 32_000,
	/** Maximum characters retained per stored task (prompt + result). */
	MAX_STORED_CHARS: 2_000,
	/** Maximum conversation turns kept in context window. */
	MAX_TURNS: 10,
	/** Maximum characters per turn in conversation history. */
	MAX_TURN_CHARS: 1_500,
	/** Maximum character length for TaskResult.output in history. */
	MAX_RESULT_OUTPUT_CHARS: 3_000,
} as const;

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface Task {
	id: string;
	workerProfile: string;
	/** Explicit compute preference for role-directed routing. */
	preferredTier?: 'tier1_local' | 'tier2_reasoning';
	workerRole?: StandardAgentRole;
	prompt: string;
	targetPath?: string;
	status: TaskStatus;
	createdAt: number;
	startedAt?: number;
	completedAt?: number;
	result?: TaskResult;
	error?: string;
	/** Optional streaming callback for real-time output deltas. */
	onStream?: (delta: string) => void;
}

export interface TaskResult {
	summary?: string;
	output?: string;
	changes?: string[];
	metadata?: Record<string, unknown>;
}

/* ─── Worker Profile Types ──────────────────────────────── */

/**
 * Static worker-profile keys that index the `workers/` prompt registry
 * (orchestrator/retriever/summarizer/editor). Each carries a system prompt
 * and token/temperature config. This is the smallest, most stable vocabulary:
 * ReAct-capable profiles (`react-orchestrator`, `react-analyst`) and the
 * `pi-daemon` sentinel are NOT here because they have no static prompt entry —
 * they resolve their prompt at runtime. See `AgentWorkerProfile` in
 * `execution/ExecutionRouter.ts` for the execution-modality superset and
 * `StandardAgentRole` in `engine/AgentTypes.ts` for the role taxonomy.
 */
export type WorkerProfileName = 'orchestrator' | 'retriever' | 'summarizer' | 'editor';

export interface WorkerProfile {
	name: WorkerProfileName;
	label: string;
	description: string;
	systemPrompt: string;
	modelConfig?: ModelConfig;
}

export interface ModelConfig {
	maxTokens: number;
	temperature?: number;
	model?: string;
}

/* ─── Agent Task Payload (RPC transport) ────────────────── */

export interface AgentTaskPayload {
	taskId: string;
	workerProfile: string;
	prompt: string;
	targetPath?: string;
	tools?: ToolDefinition[];
}

export interface AgentTaskResponse {
	taskId: string;
	result?: TaskResult;
	error?: string;
	complete: boolean;
}

/* ─── Daemon Status ─────────────────────────────────────── */

export type DaemonStatus = 'stopped' | 'running' | 'busy' | 'error';

/* ─── Vault Watcher Types ───────────────────────────────── */

export type VaultEventType = 'created' | 'modified' | 'deleted' | 'renamed';

export interface VaultEvent {
	type: VaultEventType;
	filePath: string;
	oldPath?: string;
	timestamp: number;
}

/* ─── Task Queue Types ──────────────────────────────────── */

export interface QueueEntry {
	task: Task;
	enqueuedAt: number;
	onComplete?: (result: TaskResult) => void;
	onError?: (error: string) => void;
}

export interface QueueStats {
	pending: number;
	running: number;
	completed: number;
	failed: number;
	total: number;
}

/* ─── Tool Definition (for pi agent function calling) ───── */

export interface ToolParameterProperty {
	type: string | string[];
	description?: string;
	default?: unknown;
	items?: { type: string };
}

export interface ToolParameter {
	type: string;
	properties?: Record<string, ToolParameterProperty>;
	required?: string[];
}

export interface ToolConfirmationRequest {
	toolName: string;
	targetPaths: string[];
	proposedChanges: string;
	timeoutMs?: number;
}

export type ToolConfirmationDecision = 'approved' | 'rejected' | 'timed-out';
export type ToolConfirmationHandler = (request: ToolConfirmationRequest) => Promise<ToolConfirmationDecision>;

export interface ToolDefinition {
	name: string;
	label: string;
	description: string;
	parameters: ToolParameter;
	/** Return a request only when this invocation is destructive enough to pause. */
	confirmation?: (params: Record<string, unknown>) => Promise<ToolConfirmationRequest | null>;
	execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{
		content: Array<{ type: string; text: string }>;
		details: Record<string, unknown>;
	}>;
}

