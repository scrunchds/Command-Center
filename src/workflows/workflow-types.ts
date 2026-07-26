import type { ComputeTier, StandardAgentRole, StepFallbackPolicy, WorkflowActionType } from '../engine/AgentTypes';
import type { TaskType } from '../providers/provider-types';

/** Schema for one named workflow input. Input names are the keys in WorkflowDefinition.inputs. */
export interface WorkflowInputSchema {
	type: 'string' | 'number' | 'boolean' | 'array' | 'object';
	description?: string;
	required?: boolean;
	default?: unknown;
	options?: unknown[];
}

/** One executable node in a workflow dependency graph. */
export interface WorkflowStep {
	id: string;
	name: string;
	workerProfile: string;
	role?: string;
	taskType?: TaskType;
	promptTemplate: string;
	dependsOn: string[];
	outputKey?: string;
	condition?: string;
	/** Explicit multi-agent binding used by generated workflows. */
	stepNumber?: number;
	assignedAgent?: StandardAgentRole;
	requiredTier?: ComputeTier;
	fallbackPolicy?: StepFallbackPolicy;
	actionType?: WorkflowActionType;
}

/** Vault-native workflow definition loaded from note metadata or a Canvas graph. */
export interface WorkflowDefinition {
	id: string;
	name: string;
	description: string;
	version: string;
	inputs: Record<string, WorkflowInputSchema>;
	steps: WorkflowStep[];
}

export type WorkflowStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/** Mutable state accumulated while a workflow executes. */
export interface WorkflowExecutionContext {
	inputs: Record<string, unknown>;
	stepResults: Record<string, unknown>;
	stepStatuses: Record<string, WorkflowStepStatus>;
	totalTokens: number;
	totalLatencyMs: number;
}
