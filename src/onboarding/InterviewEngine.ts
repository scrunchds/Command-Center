import { App, TFile, TFolder, normalizePath } from 'obsidian';
import type { ProviderDispatcher } from '../dispatcher';
import type { OnboardingConfig } from './OnboardingTypes';
import { parseModelJson } from '../providers/json-repair';
import { GENERATED_WORKFLOW_DIRECTORY, WorkflowGenerator, type WorkflowFormat, type WorkflowProposal } from '../workflows/WorkflowGenerator';
import { WorkflowBuilder } from '../workflows/WorkflowBuilder';
import { AGENTIC_WORKER_PROFILE } from '../workflows/WorkflowSynthesizer';
import type { ConfigManager } from '../engine/ConfigManager';
import { LOGIC_DISCOVERY_SYSTEM_PROMPT } from '../ingestion/LogicDiscovery';
import { getCapabilityRegistry } from '../capabilities';
import type { ToolDefinition } from '../types';
import type { ProviderToolResult } from '../providers/provider-types';
import { withGlobalChatInteractionStyle } from '../prompts/interaction-style';
import { TemplateGenerator, TEMPLATE_DIRECTORY, type TemplateProposal } from '../templates/TemplateGenerator';

/** Resolved placement for generated assets, supplied by the host plugin. */
export interface InterviewAssetPaths {
	workflowDirectory: string;
	workflowFormat: WorkflowFormat;
	templateDirectory: string;
	profilePath: string;
}

/** Optional hooks letting the interview update placement live as the user decides. */
export interface InterviewAssetHooks {
	/** Resolve the currently configured asset paths. */
	getAssetPaths?: () => InterviewAssetPaths;
	/** Update one or more asset paths and refresh dependent components. */
	updateAssetPaths?: (patch: Partial<InterviewAssetPaths>) => Promise<void>;
}

export const INTERVIEW_COMPLETE_SIGNAL = 'COMMAND_CENTER_INTERVIEW_COMPLETE';
export const SYNTHESIS_COMPLETE_SIGNAL = 'COMMAND_CENTER_SYNTHESIS_COMPLETE';
export type InterviewPhase = 'topology' | 'life-map' | 'capacity' | 'triage' | 'focus' | 'style' | 'confirmation' | 'synthesis';
export interface InterviewTurn { role: 'user' | 'assistant'; content: string; }
export interface ActionWorkflowApproval { workflows: WorkflowProposal[]; message: string; }
export interface ActionConnectorApproval { connector: import('../connectors/ApiConnectorManager').ApiConnectorConfig; message: string; }
export interface InterviewReply { message: string; complete: boolean; config?: OnboardingConfig; redacted?: boolean; synthesis?: InterviewSynthesis; workflowApproval?: ActionWorkflowApproval; connectorApproval?: ActionConnectorApproval; }
export interface InterviewSynthesis { config: OnboardingConfig; templates: TemplateProposal[]; workflows: WorkflowProposal[]; }
export interface InterviewCompletion { config: OnboardingConfig; templatePaths: string[]; workflowPaths: string[]; }

const SECRET_LABEL = /\b(?:api[_ -]?key|password|passphrase|access[_ -]?token|secret|credential)s?\b/i;
const SECRET_VALUE = /\b(?:sk|xox[baprs]|gh[pousr])[-_][A-Za-z0-9_-]{10,}\b|\b[A-Za-z0-9_-]{28,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/i;
const PHASES: InterviewPhase[] = ['topology', 'life-map', 'capacity', 'triage', 'focus', 'style', 'confirmation', 'synthesis'];

type OnboardingStage = 1 | 2 | 3 | 4;
const ACTION_BLOCK = /```(action-profile|action-templates|workflow-config|action-api-connector)\s*([\s\S]*?)```/gi;
const APPROVAL = /^(?:yes|approve|approved|looks good|go ahead|create them|do it|proceed)\b/i;

export interface VaultTopologySnapshot {
	folders: string[];
	rootMarkdownFiles: string[];
	proposedIndexAnchors: string[];
	empty: boolean;
}

/** Local guard used by both the modal and engine before any model boundary. */
export function containsProtectedSetupInput(value: string): boolean {
	return SECRET_LABEL.test(value) || SECRET_VALUE.test(value);
}

/** Adaptive natural-language interview with an explicit post-interview asset approval boundary. */
export class InterviewEngine {
	private turns: InterviewTurn[] = [];
	private phaseIndex = 0;
	private vaultTopology: VaultTopologySnapshot = { folders: [], rootMarkdownFiles: [], proposedIndexAnchors: [], empty: true };
	private pendingSynthesis: InterviewSynthesis | null = null;
	private pendingWorkflowActions: WorkflowProposal[] | null = null;
	private pendingActionConfig: OnboardingConfig | null = null;
	private pendingConnector: import('../connectors/ApiConnectorManager').ApiConnectorConfig | null = null;
	private stage: OnboardingStage = 1;
	private readonly actionConfirmations: string[] = [];

	constructor(
		private readonly app: App,
		private readonly dispatcher: ProviderDispatcher,
		private readonly configs: ConfigManager,
		private readonly getTools: () => ToolDefinition[] = () => getCapabilityRegistry().getEnabledToolDefinitions(true),
		private readonly confirmTool?: (tool: ToolDefinition, params: Record<string, unknown>) => Promise<boolean>,
		private readonly assetHooks?: InterviewAssetHooks,
	) {}

	private assetPaths(): InterviewAssetPaths {
		return this.assetHooks?.getAssetPaths?.() ?? {
			workflowDirectory: GENERATED_WORKFLOW_DIRECTORY,
			workflowFormat: 'json',
			templateDirectory: TEMPLATE_DIRECTORY,
			profilePath: '.command-center/profile.json',
		};
	}

	private workflowGenerator(): WorkflowGenerator {
		const { workflowDirectory, workflowFormat } = this.assetPaths();
		return new WorkflowGenerator(this.app, { directory: workflowDirectory, format: workflowFormat });
	}

	private templateGenerator(): TemplateGenerator {
		// TemplateGenerator is folder-oriented; a future patch threads the
		// configured template directory through it. For now it keeps the
		// hidden default, which the Paths settings tab can migrate later.
		return new TemplateGenerator(this.app);
	}

	async start(): Promise<string> {
		this.turns = [];
		this.phaseIndex = 0;
		this.pendingSynthesis = null;
		this.pendingWorkflowActions = null;
		this.pendingActionConfig = null;
		this.pendingConnector = null;
		this.stage = 1;
		this.actionConfirmations.length = 0;
		this.vaultTopology = this.inspectTopology();
		const summary = this.vaultTopology.empty
			? 'Your vault appears empty, so we will build its structure from scratch.'
			: `I have already scanned your vault and found ${this.vaultTopology.folders.length} folder${this.vaultTopology.folders.length === 1 ? '' : 's'}${this.vaultTopology.rootMarkdownFiles.length ? ` and ${this.vaultTopology.rootMarkdownFiles.length} root note${this.vaultTopology.rootMarkdownFiles.length === 1 ? '' : 's'}` : ''}. I will use that as context and never assume a structure you have not confirmed.`;
		return `${summary} To begin, tell me about your background and the kind of work or life context this system needs to support. We will discuss your vault's structure only after I understand what it needs to do for you — but you can ask me "what did you find?" at any time and I will share what I observed.`;
	}

	async answer(raw: string): Promise<InterviewReply> {
		const answer = raw.trim();
		if (!answer) throw new Error('Answer cannot be empty.');
		if (containsProtectedSetupInput(answer)) return {
			message: 'Credential-like content was removed and was not sent to a model or stored. Revoke or rotate it if it was real, then configure credentials through Settings → Command Center. Links, paths, hosts, ports, and endpoint values are allowed in chat.',
			complete: false, redacted: true,
		};
		if (this.pendingSynthesis) throw new Error('Review and approve the proposed assets before continuing.');
		if (this.pendingConnector) return { message: 'The connector proposal is awaiting approval. Review it and approve it, or tell me what to revise.', complete: false, connectorApproval: { connector: this.pendingConnector, message: 'Review the connector definition before saving it.' } };
		if (this.pendingWorkflowActions && APPROVAL.test(answer)) {
			const completion = await this.approvePendingWorkflows();
			return { message: 'The approved workflows are now in your vault. Command Center is initialized; you can continue from the dashboard.', complete: true, config: completion.config };
		}
		// A proposal is not a dead end. Treat a revision as Socratic feedback and
		// return it to the ORCHESTRATOR instead of interpreting it as approval.
		const workflowRevision = this.pendingWorkflowActions;
		if (workflowRevision) {
			this.pendingWorkflowActions = null;
			this.turns.push({ role: 'assistant', content: `Workflow proposal awaiting revision:\n${JSON.stringify(workflowRevision)}` });
		}
		this.turns.push({ role: 'user', content: answer });
		const tools = this.getTools();
		console.debug('[Command Center] Interview tools available:', tools.map(tool => tool.name));
		const capabilityInventory = tools.length
			? `\\n\\nLIVE CAPABILITY INVENTORY (authoritative for this turn):\\n${tools.map(tool => `- ${tool.name}: ${tool.description}`).join('\\n')}\\nUse these capabilities when relevant. Do not claim that API integrations, external connections, vault mutations, or other listed operations are impossible.`
			: '\\n\\nLIVE CAPABILITY INVENTORY: No capabilities are currently enabled.';
		const response = await this.dispatcher.dispatch({
			systemPrompt: withGlobalChatInteractionStyle(`${this.systemPrompt()}${workflowRevision ? '\\n\\nThe user is revising this workflow proposal. Reflect on their feedback, ask clarifying questions where needed, and do not emit workflow-config until they explicitly approve the revised proposal.' : ''}${capabilityInventory}\n\nTOOL EXECUTION: Use the supplied Obsidian tools whenever the user asks you to inspect, search, create, update, append, move, rename, or delete vault content. Do not claim a filesystem action completed unless the corresponding tool returned success.`),
			userPrompt: answer,
			history: [
				...this.turns.slice(0, -1).map(turn => ({ role: turn.role, content: turn.content })),
				...this.actionConfirmations.map(content => ({ role: 'assistant' as const, content })),
			],
			tools,
			onToolCall: async (name: string, params: Record<string, unknown>): Promise<ProviderToolResult> => {
				const tool = tools.find(candidate => candidate.name === name);
				if (!tool) return { toolCallId: name, content: '', error: `Unknown tool: ${name}` };
				try {
					if (tool.confirmation && !(await (this.confirmTool?.(tool, params) ?? Promise.resolve(true)))) {
						return { toolCallId: name, content: '', error: 'Tool execution was not approved.' };
					}
					console.debug('[Command Center] Interview executing tool:', name);
					const result = await tool.execute(name, params);
					console.debug('[Command Center] Interview tool completed:', name);
					return { toolCallId: name, content: result.content.map(item => item.text).join('') };
				} catch (error) {
					console.warn('[Command Center] Interview tool failed:', name, error);
					return { toolCallId: name, content: '', error: error instanceof Error ? error.message : String(error) };
				}
			},
			config: { temperature: 0.2, maxTokens: 8192 },
		}, 'reasoning');
		if (!response.success) throw new Error(response.error ?? 'Interview model did not respond.');
		const actionResult = await this.processActionBlocks(response.output);
		if (actionResult) {
			this.turns.push({ role: 'assistant', content: actionResult.message });
			return actionResult;
		}
		if (response.output.includes(SYNTHESIS_COMPLETE_SIGNAL)) {
			const envelope = parseModelJson<{ signal: string; config: unknown; templates: TemplateProposal[]; workflows: WorkflowProposal[] }>(response.output);
			if (envelope.signal !== SYNTHESIS_COMPLETE_SIGNAL) throw new Error('Invalid synthesis completion signal.');
			const config = this.configs.validate(envelope.config);
			this.pendingSynthesis = { config, templates: this.validateTemplates(envelope.templates), workflows: this.validateWorkflows(envelope.workflows) };
			this.phaseIndex = PHASES.indexOf('synthesis');
			return { message: 'Your configuration is ready. Choose the tailored templates and workflows you want Command Center to create.', complete: false, synthesis: this.getPendingSynthesis() ?? undefined };
		}
		this.turns.push({ role: 'assistant', content: response.output });
		this.advancePhase(response.output);
		return { message: response.output, complete: false };
	}

	async approvePendingWorkflows(): Promise<InterviewCompletion> {
		if (!this.pendingWorkflowActions || !this.pendingActionConfig) throw new Error('No complete workflow proposal is awaiting approval.');
		const workflows = this.pendingWorkflowActions;
		const { workflowDirectory } = this.assetPaths();
		const paths = await this.workflowGenerator().generate(workflows);
		const config: OnboardingConfig = {
			...this.pendingActionConfig,
			enabledWorkflows: workflows.map((item, index) => ({ id: item.id, name: item.name, path: paths[index] ?? `${workflowDirectory}/${item.fileName}` })),
		};
		const saved = await this.configs.save(config);
		this.pendingWorkflowActions = null;
		this.pendingActionConfig = null;
		this.stage = 4;
		this.actionConfirmations.push(`[System: Workflows physically written to the vault: ${paths.join(', ')}. Proceed to handoff.]`);
		return { config: saved, templatePaths: [], workflowPaths: paths };
	}

	async completeSynthesis(templateIds: ReadonlyArray<string>, workflowIds: ReadonlyArray<string>): Promise<InterviewCompletion> {
		if (!this.pendingSynthesis) throw new Error('No synthesized assets are awaiting approval.');
		const templateSet = new Set(templateIds), workflowSet = new Set(workflowIds);
		const templates = this.pendingSynthesis.templates.filter(item => templateSet.has(item.id));
		const workflows = this.pendingSynthesis.workflows.filter(item => workflowSet.has(item.id));
		// Validate all selected workflow contracts before writing either asset
		// class, preventing a malformed workflow from leaving a partial batch.
		const builder = new WorkflowBuilder();
		for (const workflow of workflows) builder.build(workflow.definition);
		const { workflowDirectory, templateDirectory } = this.assetPaths();
		const templatePaths = await this.templateGenerator().generate(templates);
		const workflowPaths = await this.workflowGenerator().generate(workflows);
		const config: OnboardingConfig = {
			...this.pendingSynthesis.config,
			activeTemplates: templates.map((item, index) => ({ id: item.id, name: item.name, path: templatePaths[index] ?? `${templateDirectory}/${item.fileName}` })),
			enabledWorkflows: workflows.map((item, index) => ({ id: item.id, name: item.name, path: workflowPaths[index] ?? `${workflowDirectory}/${item.fileName}` })),
		};
		const saved = await this.configs.save(config);
		this.pendingSynthesis = null;
		return { config: saved, templatePaths, workflowPaths };
	}

	getPhase(): InterviewPhase { return PHASES[this.phaseIndex] ?? 'synthesis'; }
	getPhaseNumber(): number { return Math.min(6, this.phaseIndex + 1); }
	getTopologySnapshot(): VaultTopologySnapshot {
		return { ...this.vaultTopology, folders: [...this.vaultTopology.folders], rootMarkdownFiles: [...this.vaultTopology.rootMarkdownFiles], proposedIndexAnchors: [...this.vaultTopology.proposedIndexAnchors] };
	}
	getTurns(): InterviewTurn[] { return this.turns.map(turn => ({ ...turn })); }
	getPendingSynthesis(): InterviewSynthesis | null { return this.pendingSynthesis ? { ...this.pendingSynthesis, templates: [...this.pendingSynthesis.templates], workflows: [...this.pendingSynthesis.workflows] } : null; }
	getPendingConnector(): import('../connectors/ApiConnectorManager').ApiConnectorConfig | null { return this.pendingConnector ? { ...this.pendingConnector, endpoints: this.pendingConnector.endpoints.map(endpoint => ({ ...endpoint })) } : null; }
	approvePendingConnector(): import('../connectors/ApiConnectorManager').ApiConnectorConfig {
		if (!this.pendingConnector) throw new Error('No connector proposal is awaiting approval.');
		const connector = this.pendingConnector;
		this.pendingConnector = null;
		return connector;
	}

	/** Revert to the previous turn — lets the user correct a mistake. */
	rewind(): string {
		if (this.turns.length < 2 || this.phaseIndex <= 0) throw new Error('No previous question to return to.');
		// Remove the last assistant response and user answer
		this.turns.pop(); // last assistant response
		this.turns.pop(); // last user answer
		this.phaseIndex--;
		const previous = this.turns[this.turns.length - 1];
		return previous?.content ?? 'Let us revisit the previous topic.';
	}

	/** Skip to the next phase (user explicitly declines to answer). */
	skipPhase(): void {
		if (this.phaseIndex < PHASES.length - 2) this.phaseIndex++;
	}

	/** Serialize the interview state for persistence. */
	serialize(): string {
		return JSON.stringify({ turns: this.turns, phaseIndex: this.phaseIndex, stage: this.stage, pendingSynthesis: this.pendingSynthesis, pendingWorkflowActions: this.pendingWorkflowActions, pendingActionConfig: this.pendingActionConfig, pendingConnector: this.pendingConnector, actionConfirmations: this.actionConfirmations });
	}

	/** Restore a previously persisted interview state. */
	deserialize(data: string): void {
		try {
			const parsed = JSON.parse(data) as { turns: InterviewTurn[]; phaseIndex: number; stage?: OnboardingStage; pendingSynthesis?: InterviewSynthesis | null; pendingWorkflowActions?: WorkflowProposal[] | null; pendingActionConfig?: unknown; pendingConnector?: import('../connectors/ApiConnectorManager').ApiConnectorConfig | null; actionConfirmations?: string[] };
			if (Array.isArray(parsed.turns) && typeof parsed.phaseIndex === 'number' && parsed.phaseIndex >= 0 && parsed.phaseIndex < PHASES.length) {
				this.turns = parsed.turns;
				this.phaseIndex = parsed.phaseIndex;
				this.stage = parsed.stage === 1 || parsed.stage === 2 || parsed.stage === 3 || parsed.stage === 4 ? parsed.stage : 1;
				if (parsed.pendingSynthesis) {
					this.pendingSynthesis = {
						config: this.configs.validate(parsed.pendingSynthesis.config),
						templates: this.validateTemplates(parsed.pendingSynthesis.templates),
						workflows: this.validateWorkflows(parsed.pendingSynthesis.workflows),
					};
				}
				this.pendingWorkflowActions = Array.isArray(parsed.pendingWorkflowActions) ? this.validateWorkflows(parsed.pendingWorkflowActions) : null;
				this.pendingActionConfig = parsed.pendingActionConfig ? this.configs.validate(parsed.pendingActionConfig) : null;
				this.pendingConnector = parsed.pendingConnector ? this.validateConnector(parsed.pendingConnector) : null;
				this.actionConfirmations.splice(0, this.actionConfirmations.length, ...(parsed.actionConfirmations ?? []));
			}
		} catch { /* Invalid state; start fresh. */ }
	}

	/** Build a human-readable summary of the collected configuration. */
	buildSummary(): string {
		const lines: string[] = [];
		lines.push('# Command Center — Interview Summary');
		lines.push(`> Completed on ${new Date().toLocaleString()}`);
		lines.push('');
		lines.push('## Configuration Overview');
		lines.push('');
		for (const turn of this.turns) {
			if (turn.role === 'user') {
				const preview = turn.content.length > 200 ? turn.content.slice(0, 200) + '…' : turn.content;
				lines.push(`- **You said:** ${preview}`);
			}
		}
		lines.push('');
		lines.push('> The interview has been completed. Review the configuration in the plugin settings if needed.');
		return lines.join('\n');
	}

	private async processActionBlocks(output: string): Promise<InterviewReply | null> {
		const blocks: Array<{ kind: string; value: unknown }> = [];
		for (const match of output.matchAll(ACTION_BLOCK)) {
			const kind = match[1];
			const json = match[2];
			if (!kind || json === undefined) throw new Error('The orchestrator produced an incomplete action block.');
			try { blocks.push({ kind, value: parseModelJson(json) }); }
			catch { throw new Error(`The orchestrator produced an invalid ${kind} action block.`); }
		}
		if (!blocks.length) return null;
		let message = output.replace(ACTION_BLOCK, '').trim();
		for (const block of blocks) {
			if (block.kind === 'action-profile') {
				await this.writeProfile(block.value);
				this.stage = 2;
				this.actionConfirmations.push('[System: Profile physically written to the vault. Proceed to template discovery.]');
			} else if (block.kind === 'action-templates') {
				const payload = block.value as { templates?: TemplateProposal[] };
				const templates = this.validateTemplates(payload.templates);
				await this.templateGenerator().generate(templates);
				this.stage = 3;
				this.actionConfirmations.push('[System: Templates physically written to the vault. Proceed to workflow suggestion.]');
			} else if (block.kind === 'action-api-connector') {
				this.pendingConnector = this.validateConnector(block.value);
				message += `${message ? '\n\n' : ''}I have a connector proposal ready. Please review it and explicitly approve it before it is added.`;
				return { message, complete: false, connectorApproval: { connector: this.pendingConnector, message: 'Review the connector definition before saving it.' } };
			} else if (block.kind === 'workflow-config') {
				const payload = block.value as { workflows?: WorkflowProposal[]; config?: unknown };
				this.pendingWorkflowActions = this.validateWorkflows(payload.workflows);
				if (!payload.config) throw new Error('The workflow proposal must include the interview-derived configuration.');
				this.pendingActionConfig = this.configs.validate(payload.config);
				this.stage = 3;
				message += `${message ? '\\n\\n' : ''}I have a workflow proposal ready. Please review it and explicitly approve it before I create the workflow files.`;
				return { message, complete: false, workflowApproval: { workflows: this.pendingWorkflowActions, message: 'Review the proposed workflows, then explicitly approve them.' } };
			}
		}
		return { message, complete: this.stage === 4 };
	}

	private validateConnector(value: unknown): import('../connectors/ApiConnectorManager').ApiConnectorConfig {
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The connector action must contain a JSON object.');
		const connector = value as import('../connectors/ApiConnectorManager').ApiConnectorConfig;
		if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(connector.id) || !connector.label?.trim() || !connector.baseUrl?.trim() || !Array.isArray(connector.endpoints) || connector.endpoints.length < 1 || connector.endpoints.length > 50) throw new Error('The connector proposal is incomplete.');
		try { const url = new URL(connector.baseUrl); if (url.protocol !== 'https:') throw new Error('Connectors require HTTPS base URLs.'); } catch { throw new Error('The connector base URL is invalid.'); }
		if (connector.auth?.credentialRef && /api.?key|token|secret|password/i.test(connector.auth.credentialRef)) throw new Error('Credential references must be opaque names, not secrets.');
		return { ...connector, enabled: false, endpoints: connector.endpoints.map(endpoint => ({ ...endpoint, path: endpoint.path.trim() })) };
	}

	private async writeProfile(value: unknown): Promise<void> {
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The profile action must contain a JSON object.');
		const { profilePath } = this.assetPaths();
		const path = normalizePath(profilePath);
		const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
		if (parent) await this.ensureFolder(parent);
		const content = `${JSON.stringify(value, null, 2)}\\n`;
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) await this.app.vault.modify(existing, content);
		else if (existing) throw new Error('The profile path is blocked by a non-file entry.');
		else await this.app.vault.create(path, content);
	}

	private async ensureFolder(path: string): Promise<void> {
		const normalized = normalizePath(path);
		const existing = this.app.vault.getAbstractFileByPath(normalized);
		if (existing) return;
		const parent = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
		if (parent) await this.ensureFolder(parent);
		await this.app.vault.createFolder(normalized);
	}

	private advancePhase(output: string): void {
		const marker = /\[PHASE_COMPLETE(?::\s*([a-z-]+))?]/i.exec(output);
		if (marker && this.phaseIndex < PHASES.length - 2) this.phaseIndex++;
	}
	private inspectTopology(): VaultTopologySnapshot {
		const loaded = this.app.vault.getAllLoadedFiles();
		const folders = loaded.filter((entry): entry is TFolder => entry instanceof TFolder && Boolean(entry.path) && !entry.path.startsWith('.'))
			.map(folder => folder.path).sort((a, b) => a.localeCompare(b)).slice(0, 200);
		const rootMarkdownFiles = this.app.vault.getMarkdownFiles().filter(file => !file.path.includes('/') && !file.path.startsWith('.'))
			.map(file => file.path).sort((a, b) => a.localeCompare(b)).slice(0, 100);
		return {
			folders,
			rootMarkdownFiles,
			proposedIndexAnchors: folders.map(path => `${path}/_index.md`),
			empty: folders.length === 0 && rootMarkdownFiles.length === 0,
		};
	}
	private validateTemplates(value: unknown): TemplateProposal[] {
		if (!Array.isArray(value) || value.length < 2 || value.length > 4) throw new Error('Synthesis must propose 2–4 templates.');
		return value.map((item, index) => {
			if (!item || typeof item !== 'object') throw new Error(`Template proposal ${index + 1} is invalid.`);
			const proposal = item as TemplateProposal;
			if (!proposal.id?.trim() || !proposal.name?.trim() || !proposal.description?.trim() || !proposal.fileName?.trim() || !proposal.content?.trim()) throw new Error(`Template proposal ${index + 1} is incomplete.`);
			return proposal;
		});
	}
	private validateWorkflows(value: unknown): WorkflowProposal[] {
		if (!Array.isArray(value) || value.length < 2 || value.length > 3) throw new Error('Synthesis must propose 2–3 workflows.');
		const builder = new WorkflowBuilder();
		const ids = new Set<string>();
		return value.map((item, index) => {
			if (!item || typeof item !== 'object') throw new Error(`Workflow proposal ${index + 1} is invalid.`);
			const proposal = item as WorkflowProposal;
			if (!proposal.id?.trim() || !proposal.name?.trim() || !proposal.description?.trim() || !proposal.fileName?.trim() || !proposal.definition) throw new Error(`Workflow proposal ${index + 1} is incomplete.`);
			if (ids.has(proposal.id)) throw new Error(`Workflow proposal ID is duplicated: ${proposal.id}.`);
			ids.add(proposal.id);
			// Make every onboarding-generated step an autonomous tool-calling
			// sub-agent (a ReAct mini-Claude), consistent with the plugin's
			// agentic model. The engine routes any `react*` workerProfile through
			// the ReAct loop with the gated capability surface.
			for (const step of proposal.definition.steps) step.workerProfile = AGENTIC_WORKER_PROFILE;
			// Validate every agent/tier/fallback/action binding before approval is
			// shown, so asset creation cannot partially fail on malformed metadata.
			builder.build(proposal.definition);
			return proposal;
		});
	}

	private systemPrompt(): string {
		return `${LOGIC_DISCOVERY_SYSTEM_PROMPT}

OPERATING MODEL — You are the ORCHESTRATOR for a conversational onboarding state machine layered over the discovery interview below. Preserve the adaptive, methodology-agnostic interview: ask one focused question at a time, reflect the user's language, and never invent paths, structures, metrics, or policies. The state machine describes how you operate, not a replacement for discovery.

Stage 1 — Interview: discover work type, preferred tone, and directory preferences alongside the existing topology, life-map, capacity, triage, focus, style, and confirmation questions. When the user has explicitly confirmed this profile, emit one machine-only fenced block named action-profile with a JSON object containing primary_use, tone, and directory_preferences.
Stage 2 — Proactive templates: actively propose a Daily Notes structure and other foundational templates derived from the conversation. Explain the proposal conversationally first. When the user accepts, emit one machine-only fenced action-templates block containing paths (suggested paths only) and complete templates. The Daily Notes template must be included when it fits the user's needs.
Integration discovery: when the user wants to connect an external API, use any public documentation link they provide as context, clarify the desired data and operations, then propose a declarative action-api-connector block. You are authorized to perform this integration workflow: inspect public documentation with the available web/search/read tools, construct a connector proposal from documented endpoints, register the approved connector, and make its generated tools available to chat and workflows. Do not tell the user that Command Center is unable to perform API integrations or external connections; instead, explain what can be done now, what requires user approval, and what authentication must be configured in Settings. Never invent undocumented endpoints. Ask for explicit approval before registering the connector.
Stage 3 — Proactive workflows: use a Discovery → Proposal → Execution loop. Propose 2–3 workflows mapped to the templates, ask for explicit approval, and only then emit a machine-only fenced workflow-config block containing the interview-derived config and validated workflow proposals. Never imply that workflows exist until the system confirms physical writes.
Stage 4 — Handoff: after the system confirmation, conclude the conversation and let the UI refresh to the normal dashboard.
Action blocks are implementation instructions, not user-facing prose. Never put action blocks in a sentence or expose them intentionally; the host strips them from the visible conversation, executes them through Obsidian vault APIs, and supplies a system confirmation in the conversation context. The host can register declarative REST connectors and MCP-backed tools; this is an available operation, not a prohibited one. Never request credentials, tokens, passwords, or secrets in chat. Links, paths, hosts, ports, endpoint values, and public documentation URLs are acceptable context; required credential values are configured through Settings.

You are also responsible for turning the jointly negotiated logic into Command Center configuration. Ask exactly one focused question at a time. Never assume folder names, paths, metrics, thresholds, task syntax, policies, writing tone, persona, templates, or workflows. Extract one cumulative configuration from natural-language answers. VAULT GROUNDING (HARD RULE) — The vault is the single source of truth for everything inside it. Treat every vault fact as unverified until a tool confirms it.
• Existence: before you name, describe, count, or refer to any folder, file, note, tag, frontmatter field, link, or index, it must appear in a live tool result (list_files, search_vault, read_note, or get_active_note) or the topology snapshot below. If a user asks to see/show/list/verify the vault's structure or contents, call list_files with path "/" and recursive true first, then report ONLY what it returns. If the vault has one top-level folder, say so and list only its real children.
• Contents: never state what a note says, what tags it has, or what frontmatter it holds without reading it via read_note (or search_vault for tag/field-scoped facts). Paraphrase from the tool output, not from assumption or memory.
• No invention: never invent or assume folders, files, notes, indexes, inboxes, daily-notes locations, tags, or frontmatter — including common-sounding names like Projects, Content, Recipes, Academic, Business, Reviews, or an Index file. If you are not sure it exists, say you do not know and offer to check with a tool.
• Staleness: the topology snapshot below is a cache captured at interview start and may be stale or partial; a live tool result always overrides it. You may reference the snapshot when the user asks "what did you find?" without a fresh tool call, and when proposing managed indexes, but never assert a folder exists based on the snapshot alone if the user's account or a newer tool call says otherwise.
• Creating vs. claiming: you may PROPOSE paths, folders, or files that do not exist yet, but you must label them as proposals and never describe them as if they already exist.
• Modification is allowed and expected: when the user explicitly agrees to create, move, rename, restructure, edit, or delete vault content, you are authorized to perform those changes directly using the write_note, append_note, and list_files tools (and any other enabled vault capability). The vault's absolute write gate will confirm destructive or bulk actions through the host; you do not need to refuse an agreed change. After the tool returns success, describe the vault's new state only from what the tool result confirms. Do not claim a change was made unless the corresponding tool returned success.

ASSET PLACEMENT — the user controls where generated files are written. Current placement: workflows → ${this.assetPaths().workflowDirectory} (format: ${this.assetPaths().workflowFormat}), templates → ${this.assetPaths().templateDirectory}, profile → ${this.assetPaths().profilePath}. When proposing templates or workflows, tell the user where they will be saved and offer to place them in a visible folder instead of the hidden default if they prefer to edit them by hand. If the user asks to change where files are stored, call the appropriate capability or tell them the Paths tab in Settings controls it; do not invent a path you cannot write to.

SECURITY: Never request, accept, repeat, inspect, or store credential values such as API keys, passwords, access tokens, or secrets. Public documentation and operational connection details are allowed: links, paths, hosts, ports, endpoint values, and API schemas may be inspected and discussed. Direct only credential-value setup to the native Obsidian Settings → Command Center UI. Do not confuse protecting secrets with refusing an API integration.
PATH HYGIENE: When you propose or mention a vault path, folder, or file name, never prepend or surround it with emoji, icons, decorative symbols, box-drawing characters, smart quotes, or backticks. Emit the bare relative path only (for example "Workflows" or "Daily Notes/2026-08-06.md"), not "📁 Workflows" or "📂 Templates". The host strips such decorations, but they must not appear in action blocks or config values either.
CURRENT PHASE: ${this.getPhase()}
VAULT TOPOLOGY DISCOVERED (context only; never select without consent): ${JSON.stringify(this.vaultTopology)}

AVAILABLE CAPABILITIES (instruments you can propose the user adopt):
${getCapabilityRegistry().describeEnabled() || 'No capabilities registered yet.'}

PHASE ORDER — each phase is a reflective conversation, not a form field:
1 topology: begin with the user's context and goals. Ask about their background, what the vault serves, and what success looks like to them. Only after establishing this baseline, explore their current organization — what folders they use, what works, what causes friction. Ask about intentionality: "Is this structure something you actively designed, or did it evolve?" Reflect back what you heard before proposing any changes. Never ask for credentials or secrets; paths, URLs, hosts, ports, and endpoint values may be discussed when relevant to the user's goal.
2 life-map: discover life/work domains and active 30–90 day projects. Ask about the user's definition of completion, not just deadlines. "What tells you a project is done?" Connect domains to the organizational structure discussed earlier.
3 capacity: discover only metrics the user tracks, input style, and their own scoring bounds (min/max, weight, direction) and threshold/action rules. Never invent numbers. If the user is unsure, offer 2-3 examples of what others track and let them adapt. Ask about their satisfaction with their current tracking approach.
4 triage: discover capture handling, default proposal action, explicit move/archive destinations, destructive opt-ins, task syntax/status property, user-defined frogRolloverThreshold, and delayed-task response policy. Ask about what currently causes friction in their capture workflow. "What happens to a note or task when it arrives and you don't have time to process it?"
5 focus: discover whether Quick Wins are wanted and, if so, user-defined count/duration; discover defaultPriorityCap. Ask how they define a "good day" to calibrate focus rules. "If you had to pick one thing that makes a day feel productive, what would it be?"
6 style: discover writing style, interview/challenge persona, and vocabulary to use or avoid. Offer to adapt the system's language to match theirs. Ask about how they prefer to receive feedback or challenge.
7 confirmation: show a concise complete summary using the user's own terms. Before asking for confirmation, ask: "Does this configuration feel like it represents how you actually work?" Let them refine before finalizing.

If the user is unsure or requests suggestions, offer 2–3 context-specific options with tradeoffs, but do not select one. Mark an internally complete phase with [PHASE_COMPLETE: phase-name].

After explicit confirmation, perform synthesis. Propose 2–4 templates derived only from discovered domains/project types/style and 2–3 native workflows derived only from reported friction/rules. Output only fenced JSON:
{"signal":"${SYNTHESIS_COMPLETE_SIGNAL}","config":{complete OnboardingConfig},"templates":[{"id":"...","name":"...","description":"...","fileName":"...md","content":"complete Markdown"}],"workflows":[{"id":"...","name":"...","description":"...","fileName":"...json","definition":{"id":"...","name":"...","description":"...","version":"1","inputs":{},"steps":[{"id":"...","name":"...","workerProfile":"...","promptTemplate":"...","dependsOn":[],"stepNumber":1,"assignedAgent":"Orchestrator|TriageAgent|IndexerAgent|HealthReadinessAgent|SystemArchitect","requiredTier":"tier1_local|tier2_reasoning","fallbackPolicy":"fallback_to_cloud|ask_user","actionType":"read|summarize|propose|write|index"}]}}]}
Every workflow step MUST include stepNumber, assignedAgent, requiredTier, fallbackPolicy, and actionType. Bind Orchestrator, HealthReadinessAgent, and SystemArchitect to tier2_reasoning; bind TriageAgent and IndexerAgent to tier1_local. Set every step's workerProfile to "react-orchestrator" so each step executes as an autonomous, tool-calling sub-agent (a ReAct loop with vault tools) rather than a single prompt. Build dependency-aware multi-agent plans, not flat scripts.
The config must contain only interview-derived values and no credentials or endpoint values. It must include canonical topology.inboxFolders, topology.dailyNotesFolder, topology.dailyNoteNameTemplate, capacity.rules, triage.defaultAction/destinations/frogRolloverThreshold, focus.defaultPriorityCap, compute.endpoints as an empty array (transport configuration belongs exclusively to native Settings), every managed path/purpose/scope, optional style dailyNoteLayout/timestampConvention/reflectionPrompts/formattingDirectives when supplied, and the compatibility dailyNotes/inbox/health fields. Do not add activeTemplates or enabledWorkflows; the plugin records those only after user approval.`;
	}
}
