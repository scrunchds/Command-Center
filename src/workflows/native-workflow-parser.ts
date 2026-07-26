import type { App, TFile } from 'obsidian';
import type { TaskType } from '../providers/provider-types';
import type { WorkflowDefinition, WorkflowInputSchema, WorkflowStep } from './workflow-types';

const TASK_TYPES = new Set<TaskType>(['coding', 'vision', 'reading', 'reasoning', 'fast']);

const CANVAS_NODE_WIDTH = 360;
const CANVAS_NODE_HEIGHT = 220;
const CANVAS_COLUMN_GAP = 120;
const CANVAS_ROW_GAP = 80;

interface WorkflowCanvasNode {
	id: string;
	type: 'text';
	x: number;
	y: number;
	width: number;
	height: number;
	text: string;
	name: string;
	workerProfile: string;
	promptTemplate: string;
	role?: string;
	taskType?: TaskType;
	outputKey?: string;
	condition?: string;
}

interface WorkflowCanvasEdge {
	id: string;
	fromNode: string;
	fromSide: 'right';
	toNode: string;
	toSide: 'left';
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function text(value: unknown, fallback = ''): string {
	return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function scalarText(value: unknown, fallback = ''): string {
	return typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value, fallback);
}

function fileId(file: TFile): string {
	return text(file.basename, text(file.name).replace(/\.[^.]+$/, '') || 'workflow');
}

function stringArray(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
	return typeof value === 'string' && value ? [value] : [];
}

function parseInput(value: unknown): WorkflowInputSchema {
	const source = record(value) ?? {};
	const inputType = source.type;
	const type = inputType === 'number' || inputType === 'boolean' || inputType === 'array' || inputType === 'object'
		? inputType
		: 'string';
	return {
		type,
		...(typeof source.description === 'string' ? { description: source.description } : {}),
		...(typeof source.required === 'boolean' ? { required: source.required } : {}),
		...('default' in source ? { default: source.default } : {}),
		...(Array.isArray(source.options) ? { options: source.options } : {}),
	};
}

function parseInputs(value: unknown): Record<string, WorkflowInputSchema> {
	const inputs: Record<string, WorkflowInputSchema> = {};
	if (Array.isArray(value)) {
		for (const item of value) {
			const source = record(item);
			if (!source) continue;
			const key = text(source.id, text(source.name, text(source.key)));
			if (key) inputs[key] = parseInput(source);
		}
		return inputs;
	}
	const source = record(value);
	if (source) for (const [key, schema] of Object.entries(source)) inputs[key] = parseInput(schema);
	return inputs;
}

function parseTaskType(value: unknown): TaskType | undefined {
	return typeof value === 'string' && TASK_TYPES.has(value as TaskType) ? value as TaskType : undefined;
}

function parseStep(value: unknown, index: number): WorkflowStep {
	const source = record(value) ?? {};
	const id = text(source.id, `step-${index + 1}`);
	const taskType = parseTaskType(source.taskType);
	return {
		id,
		name: text(source.name, id),
		workerProfile: text(source.workerProfile, text(source.worker, 'orchestrator')),
		...(text(source.role) ? { role: text(source.role) } : {}),
		...(taskType ? { taskType } : {}),
		promptTemplate: text(source.promptTemplate, text(source.prompt, text(source.text))),
		dependsOn: stringArray(source.dependsOn),
		...(text(source.outputKey) ? { outputKey: text(source.outputKey) } : {}),
		...(text(source.condition) ? { condition: text(source.condition) } : {}),
	};
}

/** Load a Markdown workflow using Obsidian's already-parsed metadata cache. */
export function loadWorkflowFromNote(file: TFile, app: App): WorkflowDefinition {
	const frontmatter = record(app.metadataCache.getFileCache(file)?.frontmatter) ?? {};
	const source = record(frontmatter.workflow) ?? frontmatter;
	const id = text(source.id, fileId(file));
	return {
		id,
		name: text(source.name, id),
		description: text(source.description),
		version: scalarText(source.version, '1.0'),
		inputs: parseInputs(source.inputs),
		steps: Array.isArray(source.steps) ? source.steps.map(parseStep) : [],
	};
}

function topologicalSteps(steps: WorkflowStep[]): WorkflowStep[] {
	const positions = new Map(steps.map((step, index) => [step.id, index]));
	const known = new Set(positions.keys());
	for (const step of steps) step.dependsOn = [...new Set(step.dependsOn.filter(id => known.has(id) && id !== step.id))];
	const remaining = new Map(steps.map(step => [step.id, step]));
	const emitted = new Set<string>();
	const sorted: WorkflowStep[] = [];
	while (remaining.size) {
		const ready = [...remaining.values()]
			.filter(step => step.dependsOn.every(id => emitted.has(id)))
			.sort((a, b) => (positions.get(a.id) ?? 0) - (positions.get(b.id) ?? 0));
		if (!ready.length) return steps; // Preserve source order for malformed cyclic graphs.
		for (const step of ready) {
			sorted.push(step);
			emitted.add(step.id);
			remaining.delete(step.id);
		}
	}
	return sorted;
}

function workflowTiers(steps: WorkflowStep[]): WorkflowStep[][] {
	const byId = new Map<string, WorkflowStep>();
	for (const step of steps) {
		if (byId.has(step.id)) throw new Error(`Duplicate workflow step id: ${step.id}`);
		byId.set(step.id, step);
	}
	for (const step of steps) {
		for (const dependency of step.dependsOn) {
			if (!byId.has(dependency)) throw new Error(`Step "${step.id}" depends on unknown step "${dependency}".`);
		}
	}
	const remaining = new Set(steps.map(step => step.id));
	const emitted = new Set<string>();
	const tiers: WorkflowStep[][] = [];
	while (remaining.size) {
		const tier = steps.filter(step => remaining.has(step.id) && step.dependsOn.every(id => emitted.has(id)));
		if (!tier.length) throw new Error(`Cyclic workflow dependency detected among: ${[...remaining].join(', ')}`);
		tiers.push(tier);
		for (const step of tier) {
			remaining.delete(step.id);
			emitted.add(step.id);
		}
	}
	return tiers;
}

function canvasNodeText(step: WorkflowStep): string {
	const metadata = [
		`**Worker:** ${step.workerProfile}`,
		step.role ? `**Role:** ${step.role}` : '',
		step.condition ? `**Condition:** \`${step.condition}\`` : '',
	].filter(Boolean).join('\n');
	return `# ${step.name}\n\n${metadata}\n\n## Prompt\n\n${step.promptTemplate}`;
}

/** Convert a workflow DAG into deterministic native Obsidian Canvas JSON. */
export function exportWorkflowToCanvas(workflow: WorkflowDefinition): string {
	const tiers = workflowTiers(workflow.steps);
	const nodes: WorkflowCanvasNode[] = [];
	for (const [column, tier] of tiers.entries()) {
		for (const [row, step] of tier.entries()) {
			nodes.push({
				id: step.id,
				type: 'text',
				x: column * (CANVAS_NODE_WIDTH + CANVAS_COLUMN_GAP),
				y: row * (CANVAS_NODE_HEIGHT + CANVAS_ROW_GAP),
				width: CANVAS_NODE_WIDTH,
				height: CANVAS_NODE_HEIGHT,
				text: canvasNodeText(step),
				name: step.name,
				workerProfile: step.workerProfile,
				promptTemplate: step.promptTemplate,
				...(step.role ? { role: step.role } : {}),
				...(step.taskType ? { taskType: step.taskType } : {}),
				...(step.outputKey ? { outputKey: step.outputKey } : {}),
				...(step.condition ? { condition: step.condition } : {}),
			});
		}
	}
	const edges: WorkflowCanvasEdge[] = workflow.steps.flatMap(step =>
		step.dependsOn.map((dependency, index) => ({
			id: `edge-${dependency}-${step.id}-${index + 1}`,
			fromNode: dependency,
			fromSide: 'right' as const,
			toNode: step.id,
			toSide: 'left' as const,
		})),
	);
	return JSON.stringify({ nodes, edges }, null, 2);
}

/** Load an Obsidian Canvas workflow and derive dependencies from directed edges. */
export async function loadWorkflowFromCanvas(file: TFile, app: App): Promise<WorkflowDefinition> {
	const parsed = JSON.parse(await app.vault.read(file)) as unknown;
	const canvas = record(parsed) ?? {};
	const nodes = Array.isArray(canvas.nodes) ? canvas.nodes : [];
	const steps = nodes.map((node, index) => {
		const source = record(node) ?? {};
		const data = record(source.data) ?? {};
		return parseStep({
			...data,
			...source,
			id: text(source.id, `step-${index + 1}`),
			name: text(source.name, text(source.label, text(data.name, `Step ${index + 1}`))),
			promptTemplate: text(source.promptTemplate, text(source.prompt, text(source.text, text(data.promptTemplate, text(data.prompt, text(data.text)))))) ,
			workerProfile: text(source.workerProfile, text(source.worker, text(data.workerProfile, text(data.worker, 'orchestrator')))),
			role: text(source.role, text(data.role)),
			dependsOn: [],
		}, index);
	});
	const byId = new Map(steps.map(step => [step.id, step]));
	if (Array.isArray(canvas.edges)) {
		for (const edge of canvas.edges) {
			const source = record(edge);
			if (!source) continue;
			const from = text(source.fromNode);
			const to = text(source.toNode);
			const target = byId.get(to);
			if (from && target && byId.has(from) && !target.dependsOn.includes(from)) target.dependsOn.push(from);
		}
	}
	const id = fileId(file);
	return {
		id,
		name: id,
		description: '',
		version: '1.0',
		inputs: {},
		steps: topologicalSteps(steps),
	};
}
