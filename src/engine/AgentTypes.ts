import type { TaskType } from '../providers/provider-types';

export const STANDARD_AGENT_ROLES = [
	'Orchestrator', 'TriageAgent', 'IndexerAgent', 'HealthReadinessAgent', 'SystemArchitect',
] as const;
export type StandardAgentRole = typeof STANDARD_AGENT_ROLES[number];

export const COMPUTE_TIERS = ['tier1_local', 'tier2_reasoning'] as const;
export type ComputeTier = typeof COMPUTE_TIERS[number];
export type StepFallbackPolicy = 'fallback_to_cloud' | 'ask_user';
export type WorkflowActionType = 'read' | 'summarize' | 'propose' | 'write' | 'index';

export interface AgentDescriptor {
	role: StandardAgentRole;
	description: string;
	requiredTier: ComputeTier;
	workerProfile: string;
	taskType: TaskType;
}

/** Stable role taxonomy. Provider/model IDs remain settings-owned and are never embedded here. */
export const AGENT_TAXONOMY: Readonly<Record<StandardAgentRole, AgentDescriptor>> = {
	Orchestrator: {
		role: 'Orchestrator',
		description: 'Strategic interview runner, master synthesis engine, and daily note compiler.',
		requiredTier: 'tier2_reasoning', workerProfile: 'orchestrator', taskType: 'reasoning',
	},
	TriageAgent: {
		role: 'TriageAgent',
		description: 'Fast folder sweeper, inbox note parser, and metadata extractor.',
		requiredTier: 'tier1_local', workerProfile: 'retriever', taskType: 'fast',
	},
	IndexerAgent: {
		role: 'IndexerAgent',
		description: 'In-place stationary index and frontmatter updater.',
		requiredTier: 'tier1_local', workerProfile: 'editor', taskType: 'fast',
	},
	HealthReadinessAgent: {
		role: 'HealthReadinessAgent',
		description: 'Metric evaluator, capacity calculator, and rolling delayed-item auditor.',
		requiredTier: 'tier2_reasoning', workerProfile: 'react-analyst', taskType: 'reasoning',
	},
	SystemArchitect: {
		role: 'SystemArchitect',
		description: 'Template generator and workflow synthesis builder.',
		requiredTier: 'tier2_reasoning', workerProfile: 'react-orchestrator', taskType: 'reasoning',
	},
};

export function isStandardAgentRole(value: unknown): value is StandardAgentRole {
	return typeof value === 'string' && (STANDARD_AGENT_ROLES as readonly string[]).includes(value);
}
export function isComputeTier(value: unknown): value is ComputeTier {
	return typeof value === 'string' && (COMPUTE_TIERS as readonly string[]).includes(value);
}
