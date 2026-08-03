import { App, TFolder } from 'obsidian';
import type { ProviderDispatcher } from '../dispatcher';
import type { OnboardingConfig } from './OnboardingTypes';
import { parseModelJson } from '../providers/json-repair';
import { TEMPLATE_DIRECTORY, TemplateGenerator, type TemplateProposal } from '../templates/TemplateGenerator';
import { GENERATED_WORKFLOW_DIRECTORY, WorkflowGenerator, type WorkflowProposal } from '../workflows/WorkflowGenerator';
import { WorkflowBuilder } from '../workflows/WorkflowBuilder';
import type { ConfigManager } from '../engine/ConfigManager';
import { LOGIC_DISCOVERY_SYSTEM_PROMPT } from '../ingestion/LogicDiscovery';

export const INTERVIEW_COMPLETE_SIGNAL = 'COMMAND_CENTER_INTERVIEW_COMPLETE';
export const SYNTHESIS_COMPLETE_SIGNAL = 'COMMAND_CENTER_SYNTHESIS_COMPLETE';
export type InterviewPhase = 'topology' | 'life-map' | 'capacity' | 'triage' | 'focus' | 'style' | 'confirmation' | 'synthesis';
export interface InterviewTurn { role: 'user' | 'assistant'; content: string; }
export interface InterviewReply { message: string; complete: boolean; config?: OnboardingConfig; redacted?: boolean; synthesis?: InterviewSynthesis; }
export interface InterviewSynthesis { config: OnboardingConfig; templates: TemplateProposal[]; workflows: WorkflowProposal[]; }
export interface InterviewCompletion { config: OnboardingConfig; templatePaths: string[]; workflowPaths: string[]; }

const SECRET_LABEL = /\b(?:api[_ -]?key|password|passphrase|access[_ -]?token|secret|credential)s?\b/i;
const SECRET_VALUE = /\b(?:sk|xox[baprs]|gh[pousr])[-_][A-Za-z0-9_-]{10,}\b|\b[A-Za-z0-9_-]{28,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/i;
const ENDPOINT_VALUE = /\b(?:https?|wss?):\/\/[^\s<>()]+|\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?):\d{2,5}\b|\bport\s*[:=]?\s*\d{2,5}\b/i;
const PHASES: InterviewPhase[] = ['topology', 'life-map', 'capacity', 'triage', 'focus', 'style', 'confirmation', 'synthesis'];

export interface VaultTopologySnapshot {
	folders: string[];
	rootMarkdownFiles: string[];
	proposedIndexAnchors: string[];
	empty: boolean;
}

/** Local guard used by both the modal and engine before any model boundary. */
export function containsProtectedSetupInput(value: string): boolean {
	return SECRET_LABEL.test(value) || SECRET_VALUE.test(value) || ENDPOINT_VALUE.test(value);
}

/** Adaptive natural-language interview with an explicit post-interview asset approval boundary. */
export class InterviewEngine {
	private turns: InterviewTurn[] = [];
	private phaseIndex = 0;
	private vaultTopology: VaultTopologySnapshot = { folders: [], rootMarkdownFiles: [], proposedIndexAnchors: [], empty: true };
	private pendingSynthesis: InterviewSynthesis | null = null;

	constructor(private readonly app: App, private readonly dispatcher: ProviderDispatcher, private readonly configs: ConfigManager) {}

	async start(): Promise<string> {
		this.turns = [];
		this.phaseIndex = 0;
		this.pendingSynthesis = null;
		this.vaultTopology = this.inspectTopology();
		return 'To begin without making assumptions about your vault, tell me about your background and the kind of work or life context this system needs to support. We will discuss its structure only after I understand what it needs to do for you.';
	}

	async answer(raw: string): Promise<InterviewReply> {
		const answer = raw.trim();
		if (!answer) throw new Error('Answer cannot be empty.');
		if (containsProtectedSetupInput(answer)) return {
			message: 'Credential or endpoint-like content was removed and was not sent to a model or stored. Revoke or rotate it if it was real, then configure credentials and provider endpoints only in Settings → Command Center.',
			complete: false, redacted: true,
		};
		if (this.pendingSynthesis) throw new Error('Review and approve the proposed assets before continuing.');
		this.turns.push({ role: 'user', content: answer });
		const response = await this.dispatcher.dispatch({
			systemPrompt: this.systemPrompt(), userPrompt: answer,
			history: this.turns.slice(0, -1).map(turn => ({ role: turn.role, content: turn.content })),
			config: { temperature: 0.2, maxTokens: 8192 },
		}, 'reasoning');
		if (!response.success) throw new Error(response.error ?? 'Interview model did not respond.');
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

	async completeSynthesis(templateIds: ReadonlyArray<string>, workflowIds: ReadonlyArray<string>): Promise<InterviewCompletion> {
		if (!this.pendingSynthesis) throw new Error('No synthesized assets are awaiting approval.');
		const templateSet = new Set(templateIds), workflowSet = new Set(workflowIds);
		const templates = this.pendingSynthesis.templates.filter(item => templateSet.has(item.id));
		const workflows = this.pendingSynthesis.workflows.filter(item => workflowSet.has(item.id));
		// Validate all selected workflow contracts before writing either asset
		// class, preventing a malformed workflow from leaving a partial batch.
		const builder = new WorkflowBuilder();
		for (const workflow of workflows) builder.build(workflow.definition);
		const templatePaths = await new TemplateGenerator(this.app).generate(templates);
		const workflowPaths = await new WorkflowGenerator(this.app).generate(workflows);
		const config: OnboardingConfig = {
			...this.pendingSynthesis.config,
			activeTemplates: templates.map((item, index) => ({ id: item.id, name: item.name, path: templatePaths[index] ?? `${TEMPLATE_DIRECTORY}/${item.fileName}` })),
			enabledWorkflows: workflows.map((item, index) => ({ id: item.id, name: item.name, path: workflowPaths[index] ?? `${GENERATED_WORKFLOW_DIRECTORY}/${item.fileName}` })),
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
		return JSON.stringify({ turns: this.turns, phaseIndex: this.phaseIndex });
	}

	/** Restore a previously persisted interview state. */
	deserialize(data: string): void {
		try {
			const parsed = JSON.parse(data) as { turns: InterviewTurn[]; phaseIndex: number };
			if (Array.isArray(parsed.turns) && typeof parsed.phaseIndex === 'number' && parsed.phaseIndex >= 0 && parsed.phaseIndex < PHASES.length) {
				this.turns = parsed.turns;
				this.phaseIndex = parsed.phaseIndex;
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
			// Validate every agent/tier/fallback/action binding before approval is
			// shown, so asset creation cannot partially fail on malformed metadata.
			builder.build(proposal.definition);
			return proposal;
		});
	}

	private systemPrompt(): string {
		return `${LOGIC_DISCOVERY_SYSTEM_PROMPT}

You are also responsible for turning the jointly negotiated logic into Command Center configuration. Ask exactly one focused question at a time. Never assume folder names, paths, metrics, thresholds, task syntax, policies, writing tone, persona, templates, or workflows. Extract one cumulative configuration from natural-language answers. Do not introduce the topology context below until the contextual baseline is established.

SECURITY: Never request, accept, repeat, inspect, or store credentials, API keys, passwords, tokens, secrets, URLs, hosts, ports, or endpoint values. Direct credential and endpoint setup to the native Obsidian Settings → Command Center UI.
CURRENT PHASE: ${this.getPhase()}
VAULT TOPOLOGY DISCOVERED (context only; never select without consent): ${JSON.stringify(this.vaultTopology)}

PHASE ORDER — each phase is a reflective conversation, not a form field:
1 topology: begin with the user's context and goals. Ask about their background, what the vault serves, and what success looks like to them. Only after establishing this baseline, explore their current organization — what folders they use, what works, what causes friction. Ask about intentionality: "Is this structure something you actively designed, or did it evolve?" Reflect back what you heard before proposing any changes. Never ask for credentials, URLs, hosts, ports, or endpoint values; compute transport is configured only in native Settings.
2 life-map: discover life/work domains and active 30–90 day projects. Ask about the user's definition of completion, not just deadlines. "What tells you a project is done?" Connect domains to the organizational structure discussed earlier.
3 capacity: discover only metrics the user tracks, input style, and their own scoring bounds (min/max, weight, direction) and threshold/action rules. Never invent numbers. If the user is unsure, offer 2-3 examples of what others track and let them adapt. Ask about their satisfaction with their current tracking approach.
4 triage: discover capture handling, default proposal action, explicit move/archive destinations, destructive opt-ins, task syntax/status property, user-defined frogRolloverThreshold, and delayed-task response policy. Ask about what currently causes friction in their capture workflow. "What happens to a note or task when it arrives and you don't have time to process it?"
5 focus: discover whether Quick Wins are wanted and, if so, user-defined count/duration; discover defaultPriorityCap. Ask how they define a "good day" to calibrate focus rules. "If you had to pick one thing that makes a day feel productive, what would it be?"
6 style: discover writing style, interview/challenge persona, and vocabulary to use or avoid. Offer to adapt the system's language to match theirs. Ask about how they prefer to receive feedback or challenge.
7 confirmation: show a concise complete summary using the user's own terms. Before asking for confirmation, ask: "Does this configuration feel like it represents how you actually work?" Let them refine before finalizing.

If the user is unsure or requests suggestions, offer 2–3 context-specific options with tradeoffs, but do not select one. Mark an internally complete phase with [PHASE_COMPLETE: phase-name].

After explicit confirmation, perform synthesis. Propose 2–4 templates derived only from discovered domains/project types/style and 2–3 native workflows derived only from reported friction/rules. Output only fenced JSON:
{"signal":"${SYNTHESIS_COMPLETE_SIGNAL}","config":{complete OnboardingConfig},"templates":[{"id":"...","name":"...","description":"...","fileName":"...md","content":"complete Markdown"}],"workflows":[{"id":"...","name":"...","description":"...","fileName":"...json","definition":{"id":"...","name":"...","description":"...","version":"1","inputs":{},"steps":[{"id":"...","name":"...","workerProfile":"...","promptTemplate":"...","dependsOn":[],"stepNumber":1,"assignedAgent":"Orchestrator|TriageAgent|IndexerAgent|HealthReadinessAgent|SystemArchitect","requiredTier":"tier1_local|tier2_reasoning","fallbackPolicy":"fallback_to_cloud|ask_user","actionType":"read|summarize|propose|write|index"}]}}]}
Every workflow step MUST include stepNumber, assignedAgent, requiredTier, fallbackPolicy, and actionType. Bind Orchestrator, HealthReadinessAgent, and SystemArchitect to tier2_reasoning; bind TriageAgent and IndexerAgent to tier1_local. Use workerProfile only as the compatible native worker profile for that assigned agent. Build dependency-aware multi-agent plans, not flat scripts.
The config must contain only interview-derived values and no credentials or endpoint values. It must include canonical topology.inboxFolders, topology.dailyNotesFolder, topology.dailyNoteNameTemplate, capacity.rules, triage.defaultAction/destinations/frogRolloverThreshold, focus.defaultPriorityCap, compute.endpoints as an empty array (transport configuration belongs exclusively to native Settings), every managed path/purpose/scope, optional style dailyNoteLayout/timestampConvention/reflectionPrompts/formattingDirectives when supplied, and the compatibility dailyNotes/inbox/health fields. Do not add activeTemplates or enabledWorkflows; the plugin records those only after user approval.`;
	}
}
