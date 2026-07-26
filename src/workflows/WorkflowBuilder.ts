import {
	AGENT_TAXONOMY, isComputeTier, isStandardAgentRole,
	type ComputeTier, type StandardAgentRole, type StepFallbackPolicy, type WorkflowActionType,
} from '../engine/AgentTypes';
import type { WorkflowDefinition, WorkflowInputSchema, WorkflowStep } from './workflow-types';

export interface BoundWorkflowStep {
	step_number: number;
	name: string;
	assigned_agent: StandardAgentRole;
	required_tier: ComputeTier;
	fallback_policy: StepFallbackPolicy;
	action_type: WorkflowActionType;
	id: string;
	prompt_template: string;
	depends_on: string[];
	condition?: string;
	output_key?: string;
}

export interface BoundWorkflowPlan {
	workflow_id: string;
	title: string;
	description: string;
	version: string;
	inputs: WorkflowDefinition['inputs'];
	steps: BoundWorkflowStep[];
}

/** Converts the native DAG into the persisted agent/tier-bound workflow contract. */
export class WorkflowBuilder {
	build(definition: WorkflowDefinition): BoundWorkflowPlan {
		if (!definition?.id?.trim() || !definition.name?.trim() || !Array.isArray(definition.steps) || !definition.steps.length) throw new Error('Generated workflow is incomplete.');
		const ids = new Set<string>();
		const steps = definition.steps.map((step, index) => this.bindStep(step, index + 1, ids));
		for (const step of steps) for (const dependency of step.depends_on) if (!ids.has(dependency)) throw new Error(`Workflow ${definition.name} references unknown dependency ${dependency}.`);
		return {
			workflow_id: definition.id.trim(), title: definition.name.trim(), description: definition.description?.trim() ?? '',
			version: definition.version?.trim() || '1', inputs: definition.inputs ?? {}, steps,
		};
	}

	/** Loads the persisted snake_case contract for direct Orchestrator execution. */
	parse(value: unknown): BoundWorkflowPlan {
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Workflow plan must be an object.');
		const source = value as Record<string, unknown>;
		const rawSteps = source.steps;
		if (typeof source.workflow_id !== 'string' || typeof source.title !== 'string' || !Array.isArray(rawSteps)) throw new Error('Workflow plan is incomplete.');
		const definition: WorkflowDefinition = {
			id: source.workflow_id, name: source.title, description: typeof source.description === 'string' ? source.description : '',
			version: typeof source.version === 'string' ? source.version : '1', inputs: parseInputs(source.inputs),
			steps: rawSteps.map((raw, index) => persistedStep(raw, index)),
		};
		return this.build(definition);
	}

	private bindStep(step: WorkflowStep, position: number, ids: Set<string>): BoundWorkflowStep {
		if (!step.id?.trim() || ids.has(step.id) || !step.name?.trim() || !step.promptTemplate?.trim() || !Array.isArray(step.dependsOn)) throw new Error(`Generated workflow has an invalid step at position ${position}.`);
		if (!isStandardAgentRole(step.assignedAgent)) throw new Error(`Workflow step ${step.id} must specify a standard assignedAgent.`);
		if (!isComputeTier(step.requiredTier)) throw new Error(`Workflow step ${step.id} must specify requiredTier.`);
		if (AGENT_TAXONOMY[step.assignedAgent].requiredTier !== step.requiredTier) throw new Error(`Workflow step ${step.id} tier does not match ${step.assignedAgent}.`);
		if (!isFallbackPolicy(step.fallbackPolicy)) throw new Error(`Workflow step ${step.id} must specify fallbackPolicy.`);
		if (!isActionType(step.actionType)) throw new Error(`Workflow step ${step.id} must specify actionType.`);
		const stepNumber = step.stepNumber ?? position;
		if (!Number.isInteger(stepNumber) || stepNumber <= 0) throw new Error(`Workflow step ${step.id} has an invalid stepNumber.`);
		ids.add(step.id);
		return {
			step_number: stepNumber, name: step.name.trim(), assigned_agent: step.assignedAgent,
			required_tier: step.requiredTier, fallback_policy: step.fallbackPolicy, action_type: step.actionType,
			id: step.id.trim(), prompt_template: step.promptTemplate.trim(), depends_on: [...step.dependsOn],
			...(step.condition ? { condition: step.condition } : {}), ...(step.outputKey ? { output_key: step.outputKey } : {}),
		};
	}
}

function persistedStep(value: unknown, index: number): WorkflowStep {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Workflow step ${index + 1} is invalid.`);
	const source = value as Record<string, unknown>;
	return {
		id: stringValue(source.id, `step-${index + 1}`), name: stringValue(source.name), workerProfile: '',
		promptTemplate: stringValue(source.prompt_template), dependsOn: Array.isArray(source.depends_on) ? source.depends_on.filter((item): item is string => typeof item === 'string') : [],
		stepNumber: Number(source.step_number), assignedAgent: source.assigned_agent as StandardAgentRole,
		requiredTier: source.required_tier as ComputeTier, fallbackPolicy: source.fallback_policy as StepFallbackPolicy,
		actionType: source.action_type as WorkflowActionType,
		...(typeof source.condition === 'string' ? { condition: source.condition } : {}),
		...(typeof source.output_key === 'string' ? { outputKey: source.output_key } : {}),
	};
}
function stringValue(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback; }
function parseInputs(value: unknown): Record<string, WorkflowInputSchema> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, WorkflowInputSchema> : {};
}
function isFallbackPolicy(value: unknown): value is StepFallbackPolicy { return value === 'fallback_to_cloud' || value === 'ask_user'; }
function isActionType(value: unknown): value is WorkflowActionType { return ['read', 'summarize', 'propose', 'write', 'index'].includes(String(value)); }
