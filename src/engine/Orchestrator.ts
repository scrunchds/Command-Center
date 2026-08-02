import type { ProviderDispatcher } from '../dispatcher';
import { AGENT_TAXONOMY, type ComputeTier } from './AgentTypes';
import type { ProviderId, ProviderRequest, ProviderResponse, TaskType } from '../providers/provider-types';
import { isLocalBaseUrl, ProviderError, sanitizeBaseUrl } from '../providers/provider-types';
import type { MultiProviderSettings } from '../providers/provider-types';
import { WorkflowBuilder, type BoundWorkflowPlan, type BoundWorkflowStep } from '../workflows/WorkflowBuilder';

export interface OrchestratorExecutionContext {
	inputs: Record<string, unknown>;
	stepResults: Record<string, ProviderResponse>;
}
export interface OrchestratorOptions {
	onStream?: (delta: string, step: BoundWorkflowStep) => void;
	askUser?: (step: BoundWorkflowStep, error: string) => Promise<'retry' | 'skip' | 'cancel'>;
}

/** Executes persisted multi-agent plans through settings-owned tier routes. */
export class Orchestrator {
	private readonly workflowBuilder = new WorkflowBuilder();
	constructor(
		private readonly dispatcher: ProviderDispatcher,
		private readonly getSettings: () => MultiProviderSettings,
		private readonly getStyleGuide: () => string,
	) {}

	async executeJson(value: unknown, inputs: Record<string, unknown> = {}, options: OrchestratorOptions = {}): Promise<OrchestratorExecutionContext> {
		return this.execute(this.workflowBuilder.parse(value), inputs, options);
	}

	async execute(plan: BoundWorkflowPlan, inputs: Record<string, unknown> = {}, options: OrchestratorOptions = {}): Promise<OrchestratorExecutionContext> {
		const context: OrchestratorExecutionContext = { inputs, stepResults: {} };
		const remaining = new Map(plan.steps.map(step => [step.id, step]));
		while (remaining.size) {
			const ready = [...remaining.values()].filter(step => step.depends_on.every(dependency => context.stepResults[dependency]?.success));
			if (!ready.length) throw new Error(`Workflow ${plan.workflow_id} has cyclic, missing, or skipped dependencies: ${[...remaining.keys()].join(', ')}.`);
			ready.sort((a, b) => a.step_number - b.step_number);
			const results = await Promise.all(ready.map(async step => ({ step, response: await this.executeStep(plan, step, interpolate(step.prompt_template, context), options) })));
			for (const { step, response } of results) {
				remaining.delete(step.id);
				if (response) context.stepResults[step.id] = response;
			}
		}
		return context;
	}

	private async executeStep(plan: BoundWorkflowPlan, step: BoundWorkflowStep, prompt: string, options: OrchestratorOptions): Promise<ProviderResponse | null> {
		const descriptor = AGENT_TAXONOMY[step.assigned_agent];
		if (descriptor.requiredTier !== step.required_tier) throw new Error(`Step ${step.id} has an invalid agent/tier binding.`);
		const request: ProviderRequest = {
			taskId: `${plan.workflow_id}:${step.step_number}:${step.id}`,
			systemPrompt: `Agent: ${step.assigned_agent}\nResponsibility: ${descriptor.description}\nAction: ${step.action_type}\n\n<style-guide>\n${this.getStyleGuide()}\n</style-guide>`,
			userPrompt: prompt,
			onStream: delta => options.onStream?.(delta, step),
		};
		try {
			const response = await this.dispatchTier(step.required_tier, descriptor.taskType, request);
			if (!response.success) throw new Error(response.error ?? `Step ${step.id} failed.`);
			return response;
		} catch (error) {
			if (step.required_tier === 'tier1_local' && step.fallback_policy === 'fallback_to_cloud') {
				const cloud = cloudProviderFor(this.getSettings());
				if (!cloud) throw new Error(`No enabled cloud reasoning provider is configured for fallback from ${step.id}.`);
				const response = await this.dispatcher.dispatchTo(cloud.providerId, { ...request, config: { ...request.config, ...(cloud.modelId ? { model: cloud.modelId } : {}) } });
				if (!response.success) throw new Error(response.error ?? `Cloud fallback failed for ${step.id}.`);
				return response;
			}
			if (step.fallback_policy === 'ask_user' && options.askUser) {
				const decision = await options.askUser(step, (error as Error).message);
				if (decision === 'skip') return { output: '', success: true, providerId: 'custom', latencyMs: 0 };
				if (decision === 'retry') return this.executeStep(plan, step, prompt, options);
			}
			throw error;
		}
	}

	private async dispatchTier(tier: ComputeTier, taskType: TaskType, request: ProviderRequest): Promise<ProviderResponse> {
		const settings = this.getSettings();
		if (tier === 'tier2_reasoning') {
			const cloud = cloudProviderFor(settings);
			if (!cloud) throw new ProviderError('connection_failed', 'No enabled cloud reasoning provider is configured for tier2_reasoning.', 'custom');
			return this.dispatcher.dispatchTo(cloud.providerId, { ...request, config: { ...request.config, ...(cloud.modelId ? { model: cloud.modelId } : {}) } });
		}
		const local = localProviderFor(settings, taskType);
		if (!local) throw new ProviderError('connection_failed', 'No enabled local provider is configured for tier1_local.', 'custom');
		return this.dispatcher.dispatchTo(local.providerId, { ...request, config: { ...request.config, ...(local.modelId ? { model: local.modelId } : {}) } });
	}
}

function localProviderFor(settings: MultiProviderSettings, taskType: TaskType): { providerId: ProviderId; modelId?: string } | null {
	const configuredRoute = settings.routing?.[taskType];
	if (configuredRoute) {
		const credentials = settings.credentials[configuredRoute.providerId];
		if (credentials?.enabled && isLocalBaseUrl(sanitizeBaseUrl(credentials.baseUrl))) return { providerId: configuredRoute.providerId, modelId: configuredRoute.modelId };
	}
	for (const providerId of ['lmstudio', 'ollama', 'custom'] as const) {
		const credentials = settings.credentials[providerId];
		if (credentials?.enabled && isLocalBaseUrl(sanitizeBaseUrl(credentials.baseUrl))) return { providerId };
	}
	return null;
}
function cloudProviderFor(settings: MultiProviderSettings): { providerId: ProviderId; modelId: string } | null {
	const route = settings.routing?.reasoning;
	if (route) {
		const credentials = settings.credentials[route.providerId];
		if (credentials?.enabled && !isLocalBaseUrl(sanitizeBaseUrl(credentials.baseUrl))) return { providerId: route.providerId, modelId: route.modelId };
	}
	for (const [id, credentials] of Object.entries(settings.credentials)) {
		if (credentials?.enabled && !isLocalBaseUrl(sanitizeBaseUrl(credentials.baseUrl))) return { providerId: id as ProviderId, modelId: '' };
	}
	return null;
}

function interpolate(template: string, context: OrchestratorExecutionContext): string {
	return template.replace(/\{\{\s*(inputs|steps)\.([\w.-]+)\s*}}/g, (_match, root: string, path: string) => {
		let value: unknown = root === 'inputs' ? context.inputs : context.stepResults;
		for (const segment of path.split('.')) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[segment] : undefined;
		return value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
	});
}
