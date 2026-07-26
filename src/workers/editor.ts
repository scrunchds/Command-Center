/**
 * Editor worker — structural edits and content transformations.
 * Content sliced to respect modelConfig.maxTokens minus overhead.
 */

import type { WorkerProfile } from '../types';

export const profile: WorkerProfile = {
	name: 'editor',
	label: 'Editor',
	description: 'Performs structural edits and content transformations on notes',
	systemPrompt:
		'You are an editor agent. Given a note and instructions, produce structural ' +
		'edits (insert, update, delete) that transform the note content as requested. ' +
		'Return a list of edit operations.',
	modelConfig: { maxTokens: 4096, temperature: 0.3 },
};

export interface EditOperation {
	type: 'insert' | 'update' | 'delete';
	path?: string;
	position?: 'before' | 'after' | 'replace';
	oldText?: string;
	newText?: string;
	lineStart?: number;
	lineEnd?: number;
}

export interface EditPlan {
	operations: EditOperation[];
	rationale: string;
}

const CHARS_PER_TOKEN = 4;
const INSTRUCTION_OVERHEAD = `
You are acting as the editor agent.

## Note
**Path:** ~path~

\`\`\`
\`\`\`

## Instructions
~instructions~

## Task
Produce a list of edit operations to transform the note according to the instructions.
Return a JSON object with:
- "operations": array of {"type":"insert|update|delete","oldText"?:string,"newText"?:string,"lineStart"?:number,"lineEnd"?:number,"position"?:string}
- "rationale": string explaining the edits`.length;

export function buildEditorPrompt(noteContent: string, notePath: string, instructions: string, maxTokens?: number): string {
	const cap = Math.floor((maxTokens ?? profile.modelConfig?.maxTokens ?? 4096) * CHARS_PER_TOKEN);
	// Split budget between note body and instructions (60/40)
	const noteBudget = Math.floor(Math.max(300, (cap - INSTRUCTION_OVERHEAD - notePath.length - 300) * 0.6));
	const instrBudget = Math.floor(Math.max(200, (cap - INSTRUCTION_OVERHEAD - notePath.length - 300) * 0.4));

	const body = noteContent.length > noteBudget
		? noteContent.slice(0, noteBudget) + '\n\n[note truncated for token budget]'
		: noteContent;
	const instr = instructions.length > instrBudget
		? instructions.slice(0, instrBudget) + ' [instructions truncated for token budget]'
		: instructions;

	return `
You are acting as the editor agent.

## Note
**Path:** ${notePath}

\`\`\`
${body}
\`\`\`

## Instructions
${instr}

## Task
Produce a list of edit operations to transform the note according to the instructions.
Return a JSON object with:
- "operations": array of { "type": "insert"|"update"|"delete", "oldText"?: string, "newText"?: string, "lineStart"?: number, "lineEnd"?: number, "position"?: "before"|"after"|"replace" }
- "rationale": string explaining the edits
`.trim();
}

export function parseEditResponse(output: string): EditPlan {
	try { return JSON.parse(output) as EditPlan; }
	catch { return { operations: [], rationale: 'Failed to parse edit plan from worker output.' }; }
}
