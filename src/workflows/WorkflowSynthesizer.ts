import type { ProviderDispatcher } from '../dispatcher';
import { AGENT_TAXONOMY, isStandardAgentRole, type StandardAgentRole } from '../engine/AgentTypes';
import { parseModelJson } from '../providers/json-repair';
import { WorkflowBuilder } from './WorkflowBuilder';
import type { WorkflowDefinition, WorkflowInputSchema, WorkflowStep } from './workflow-types';

/**
 * Worker profile that routes a step through the autonomous ReAct tool-calling
 * loop (the "mini-Claude" executor) rather than a single prompt dispatch.
 * The engine treats any `workerProfile` starting with `react` as agentic,
 * mirroring the convention already used by the command-palette executor.
 */
export const AGENTIC_WORKER_PROFILE = 'react-orchestrator';

export interface SynthesizeOptions {
	/** Vault-relative context the model may use to ground the plan (optional). */
	contextNote?: string;
	/** Stream the generation model's raw output (optional). */
	onStream?: (delta: string) => void;
}

/**
 * Turns a natural-language goal into a validated, agent/tier-bound workflow DAG
 * whose every step executes as an autonomous tool-calling sub-agent.
 *
 * Generation is a single model call. The emitted JSON is coerced to the native
 * `WorkflowDefinition` shape, each step is bound to `react-orchestrator` so the
 * engine routes it through the ReAct loop, and the result is validated by
 * `WorkflowBuilder.build` — the same contract used for onboarding-generated
 * workflows — before it is returned to the caller. The caller is responsible
 * for surfacing an approval card before execution.
 */
export class WorkflowSynthesizer {
	constructor(
		private readonly dispatcher: ProviderDispatcher,
		private readonly getStyleGuide?: () => string,
	) {}

	async synthesize(goal: string, options: SynthesizeOptions = {}): Promise<WorkflowDefinition> {
		const trimmed = goal.trim();
		if (!trimmed) throw new Error('Workflow goal is empty.');

		const systemPrompt = buildSynthesisSystemPrompt(this.getStyleGuide?.() ?? '', options.contextNote);
		const response = await this.dispatcher.dispatch(
			{
				systemPrompt,
				userPrompt: `Goal:\n${trimmed}`,
				taskId: `workflow-synthesis:${Date.now()}`,
				onStream: options.onStream,
			},
			'reasoning',
		);
		if (!response.success) throw new Error(response.error ?? 'Workflow synthesis failed.');

		const definition = coerceDefinition(response.output, trimmed);
		// Validate the full agent/tier/dependency contract before exposing it.
		new WorkflowBuilder().build(definition);
		return definition;
	}
}

/** Build the constrained system prompt that asks the model for a workflow DAG. */
function buildSynthesisSystemPrompt(styleGuide: string, contextNote?: string): string {
	const roles = (Object.keys(AGENT_TAXONOMY) as StandardAgentRole[])
		.map(role => `- ${role}: ${AGENT_TAXONOMY[role].description} (tier: ${AGENT_TAXONOMY[role].requiredTier})`)
		.join('\n');
	const context = contextNote ? `\n\nVault context (use only as background; do not invent paths):\n${contextNote}` : '';
	return `You design executable workflow DAGs for an Obsidian agent system. Given a goal, emit ONE JSON object describing a workflow whose steps each run as an autonomous, tool-calling sub-agent (a ReAct loop with vault tools: search, read_note, write_note, append_note).

Respond with ONLY a JSON object in this exact shape (no prose, no markdown fences):
{
  "id": "kebab-case-id",
  "name": "Short human title",
  "description": "What this workflow accomplishes",
  "version": "1",
  "inputs": {
    "inputName": { "type": "string|number|boolean|array|object", "description": "...", "required": true }
  },
  "steps": [
    {
      "id": "step-id",
      "name": "Short step name",
      "assignedAgent": "Orchestrator|TriageAgent|IndexerAgent|HealthReadinessAgent|SystemArchitect",
      "requiredTier": "tier1_local|tier2_reasoning",
      "fallbackPolicy": "fallback_to_cloud|ask_user",
      "actionType": "read|summarize|propose|write|index",
      "promptTemplate": "The full instruction for this step. Reference inputs as {{inputs.name}} and prior outputs as {{steps.step-id.result}}.",
      "dependsOn": ["prior-step-id"],
      "condition": "optional side-effect-free expression over inputs/steps, e.g. inputs.confirm === true",
      "outputKey": "optional-alias"
    }
  ]
}

Allowed assignedAgent values and their required tiers:
${roles}

Rules:
- Each step MUST set assignedAgent, requiredTier (matching the role), fallbackPolicy, actionType, promptTemplate, and dependsOn.
- dependsOn forms a DAG: every referenced id must exist earlier. Cycles and unknown deps are rejected.
- Order steps so dependencies precede dependents.
- Keep steps minimal and composable; prefer 2–6 steps.
- promptTemplate must be self-contained; it runs inside a tool-calling agent, so it may instruct searching/reading/writing.
- Do NOT include workerProfile, stepNumber, or role; the system assigns them.
- Emit ONLY the JSON.${context ? `${context}` : ''}

Follow this runtime style guide for promptTemplate tone:
<style-guide>
${styleGuide}
</style-guide>`;
}

/** Coerce raw model output into a validated native WorkflowDefinition. */
function coerceDefinition(output: string, fallbackGoal: string): WorkflowDefinition {
	const raw = parseModelJson<Record<string, unknown>>(output);
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error('Synthesis output is not a workflow object.');
	}

	const name = stringField(raw, 'name') || fallbackGoal.slice(0, 60);
	const id = stringField(raw, 'id') || slugify(name);
	const description = stringField(raw, 'description');
	const version = stringField(raw, 'version') || '1';

	const rawInputs = raw.inputs;
	const inputs: Record<string, WorkflowInputSchema> = rawInputs && typeof rawInputs === 'object' && !Array.isArray(rawInputs)
		? rawInputs as Record<string, WorkflowInputSchema>
		: {};

	const rawSteps = raw.steps;
	if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
		throw new Error('Synthesized workflow has no steps.');
	}

	const steps: WorkflowStep[] = rawSteps.map((value, index) => coerceStep(value, index, id));
	return { id, name, description, version, inputs, steps };
}

function coerceStep(value: unknown, index: number, workflowId: string): WorkflowStep {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`Synthesized step ${index + 1} is invalid.`);
	}
	const source = value as Record<string, unknown>;
	const id = stringField(source, 'id') || `step-${index + 1}`;
	const name = stringField(source, 'name') || `Step ${index + 1}`;
	const promptTemplate = stringField(source, 'promptTemplate') || stringField(source, 'prompt_template');
	if (!promptTemplate) throw new Error(`Synthesized step "${id}" has no promptTemplate.`);

	const assignedAgent = source.assignedAgent ?? source.assigned_agent;
	if (!isStandardAgentRole(assignedAgent)) {
		throw new Error(`Synthesized step "${id}" has an invalid assignedAgent.`);
	}
	const descriptor = AGENT_TAXONOMY[assignedAgent];

	const dependsOn = Array.isArray(source.dependsOn) || Array.isArray(source.depends_on)
		? (source.dependsOn ?? source.depends_on) as unknown[]
		: [];
	const dependsOnStrings = dependsOn.filter((item): item is string => typeof item === 'string');

	// WorkflowBuilder rejects missing/invalid enums, so coerce to safe defaults
	// rather than dropping the field. Defaults keep generated workflows
	// executable even when the model omits an optional-looking attribute.
	const fallbackPolicy = coerceEnum(
		source.fallbackPolicy ?? source.fallback_policy,
		['fallback_to_cloud', 'ask_user'],
		'fallback_to_cloud',
	) as WorkflowStep['fallbackPolicy'];
	const actionType = coerceEnum(
		source.actionType ?? source.action_type,
		['read', 'summarize', 'propose', 'write', 'index'],
		'propose',
	) as WorkflowStep['actionType'];

	const step: WorkflowStep = {
		id,
		name,
		workerProfile: AGENTIC_WORKER_PROFILE,
		role: descriptor.role,
		taskType: descriptor.taskType,
		promptTemplate,
		dependsOn: dependsOnStrings,
		assignedAgent,
		requiredTier: descriptor.requiredTier,
		fallbackPolicy,
		actionType,
	};;
	const condition = stringField(source, 'condition');
	if (condition) step.condition = condition;
	const outputKey = stringField(source, 'outputKey') || stringField(source, 'output_key');
	if (outputKey) step.outputKey = outputKey;
	// Keep the id unique within this workflow; WorkflowBuilder enforces it.
	void workflowId;
	return step;
}

function stringField(source: Record<string, unknown>, key: string): string {
	const value = source[key];
	return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/** Return the value if it is one of the allowed strings, otherwise the default. */
function coerceEnum(value: unknown, allowed: readonly string[], fallback: string): string {
	return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

/** Minimal kebab-case slug for default workflow ids. */
function slugify(value: string): string {
	return value.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48) || 'workflow';
}
