import { App, normalizePath, TFile, TFolder } from 'obsidian';
import { CONFIG_DIRECTORY } from '../engine/ConfigSerializer';
import { safeAssetName } from '../templates/TemplateGenerator';
import { WorkflowBuilder } from './WorkflowBuilder';
import type { WorkflowDefinition, WorkflowStep } from './workflow-types';

export const GENERATED_WORKFLOW_DIRECTORY = `${CONFIG_DIRECTORY}/workflows`;

export type WorkflowFormat = 'md' | 'json';

export interface WorkflowGeneratorOptions {
	/** Vault-relative directory to write into. Defaults to the hidden generated dir. */
	directory?: string;
	/** Output format. `md` writes editable frontmatter; `json` writes the raw DAG. */
	format?: WorkflowFormat;
}

export interface WorkflowProposal {
	id: string;
	name: string;
	description: string;
	fileName: string;
	definition: WorkflowDefinition;
}

/** Serialize a workflow definition as an editable Markdown note with YAML frontmatter. */
export function workflowDefinitionToMarkdown(def: WorkflowDefinition): string {
	const fm: Record<string, unknown> = {
		id: def.id,
		name: def.name,
		description: def.description,
		version: def.version,
	};
	if (Object.keys(def.inputs).length) fm.inputs = def.inputs;
	fm.steps = def.steps.map(step => {
		const entry: Record<string, unknown> = {
			id: step.id,
			name: step.name,
			workerProfile: step.workerProfile,
			promptTemplate: step.promptTemplate,
			dependsOn: step.dependsOn,
		};
		if (step.role) entry.role = step.role;
		if (step.taskType) entry.taskType = step.taskType;
		if (step.outputKey) entry.outputKey = step.outputKey;
		if (step.condition) entry.condition = step.condition;
		if (step.stepNumber != null) entry.stepNumber = step.stepNumber;
		if (step.assignedAgent) entry.assignedAgent = step.assignedAgent;
		if (step.requiredTier) entry.requiredTier = step.requiredTier;
		if (step.fallbackPolicy) entry.fallbackPolicy = step.fallbackPolicy;
		if (step.actionType) entry.actionType = step.actionType;
		return entry;
	});
	const yaml = stringifyFrontmatter(fm);
	const body = renderWorkflowBody(def);
	return `---\n${yaml}---\n\n${body}\n`;
}

/** Render a human-readable body summarizing the workflow for manual editing. */
function renderWorkflowBody(def: WorkflowDefinition): string {
	const lines: string[] = [];
	lines.push(`# ${def.name}`);
	if (def.description) lines.push('');
	lines.push(def.description);
	lines.push('');
	lines.push('## Steps');
	for (const step of def.steps) {
		lines.push('');
		lines.push(`### ${step.name}`);
		const meta = [
			`**id:** \`${step.id}\``,
			`**worker:** \`${step.workerProfile}\``,
			step.role ? `**role:** ${step.role}` : '',
			step.assignedAgent ? `**agent:** ${step.assignedAgent}` : '',
			step.requiredTier ? `**tier:** ${step.requiredTier}` : '',
			step.fallbackPolicy ? `**fallback:** ${step.fallbackPolicy}` : '',
			step.actionType ? `**action:** ${step.actionType}` : '',
			step.dependsOn.length ? `**depends on:** ${step.dependsOn.map(d => `\`${d}\``).join(', ')}` : '',
			step.condition ? `**condition:** \`${step.condition}\`` : '',
		].filter(Boolean);
		lines.push(meta.join(' · '));
		lines.push('');
		lines.push('```');
		lines.push(step.promptTemplate.trim());
		lines.push('```');
	}
	return lines.join('\n');
}

/**
 * Minimal, deterministic YAML emitter for workflow frontmatter. Only handles
 * the scalar / array / nested-object shapes the generator produces; keeps the
 * file readable and hand-editable without pulling in a YAML dependency.
 */
function stringifyFrontmatter(value: unknown, indent = 0): string {
	const pad = '  '.repeat(indent);
	if (value === null || value === undefined) return '""';
	if (typeof value === 'string') {
		// Quote strings that look like numbers/booleans or contain YAML specials.
		if (/^\s*$/.test(value)) return '""';
		if (/^(-?\d+(\.\d+)?|true|false|null)\s*$/.test(value) || /[:#\-?[\]{}],&*!|>%@`"'#]/.test(value) || value.includes('\n')) {
			return JSON.stringify(value);
		}
		return value;
	}
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) {
		if (value.length === 0) return '[]';
		return value.map(item => `${pad}- ${stringifyFrontmatter(item, indent + 1)}`).join('\n');
	}
	if (typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null);
		if (entries.length === 0) return '{}';
		return entries.map(([key, v]) => {
			const child = stringifyFrontmatter(v, indent + 1);
			if (child.includes('\n')) return `${pad}${key}:\n${child}`;
			return `${pad}${key}: ${child}`;
		}).join('\n');
	}
	return JSON.stringify(value);
}

/** Persists approved workflows only after enforcing explicit role/tier binding. */
export class WorkflowGenerator {
	private readonly builder = new WorkflowBuilder();
	private readonly directory: string;
	private readonly format: WorkflowFormat;

	constructor(
		private readonly app: App,
		options: WorkflowGeneratorOptions = {},
	) {
		this.directory = options.directory ?? GENERATED_WORKFLOW_DIRECTORY;
		this.format = options.format ?? 'json';
	}

	async generate(proposals: ReadonlyArray<WorkflowProposal>): Promise<string[]> {
		await this.ensureDirectory(this.directory);
		const paths: string[] = [];
		for (const proposal of proposals) {
			// build() validates role/tier bindings and dependency integrity.
			// For .json we persist the resulting bound contract; for .md we
			// persist the original camelCase WorkflowDefinition so Obsidian's
			// native loadWorkflowFromNote can read it back from frontmatter.
			const plan = this.builder.build(proposal.definition);
			const fileName = safeAssetName(proposal.fileName, this.format === 'md' ? '.md' : '.json');
			const path = normalizePath(`${this.directory}/${fileName}`);
			const content = this.format === 'md'
				? `${workflowDefinitionToMarkdown(proposal.definition).trim()}\n`
				: `${JSON.stringify(plan, null, 2)}\n`;
			await this.upsert(path, content);
			paths.push(path);
		}
		return paths;
	}

	private async ensureDirectory(path: string): Promise<void> {
		let current = '';
		for (const segment of path.split('/')) {
			current = normalizePath(current ? `${current}/${segment}` : segment);
			const entry = this.app.vault.getAbstractFileByPath(current);
			if (entry instanceof TFolder) continue;
			if (entry) throw new Error(`A file blocks generated asset directory ${current}.`);
			await this.app.vault.createFolder(current);
		}
	}
	private async upsert(path: string, content: string): Promise<void> {
		const entry = this.app.vault.getAbstractFileByPath(path);
		if (entry instanceof TFile) await this.app.vault.modify(entry, content);
		else if (entry) throw new Error(`${path} is not a file.`);
		else await this.app.vault.create(path, content);
	}
}

/** Re-exported for callers that import the step type alongside the generator. */
export type { WorkflowStep };
