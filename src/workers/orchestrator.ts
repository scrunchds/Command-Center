/**
 * Orchestrator worker — coordinates multi-step workflows.
 * Content sliced to respect modelConfig.maxTokens minus overhead.
 */

import type { WorkerProfile } from '../types';

export const profile: WorkerProfile = {
	name: 'orchestrator',
	label: 'Orchestrator',
	description: 'Coordinates multi-step agent workflows across the vault',
	systemPrompt:
		'You are an orchestrator agent. Analyze the given note and determine which ' +
		'specialized agents (retriever, summarizer, editor) should process it. Return a ' +
		'plan with ordered steps.',
	modelConfig: { maxTokens: 4096, temperature: 0.3 },
};

export interface OrchestratorPlan {
	steps: OrchestratorStep[];
	rationale: string;
}
export interface OrchestratorStep {
	worker: 'retriever' | 'summarizer' | 'editor';
	prompt: string;
	targetPath?: string;
	dependsOn?: string[];
}

/** Approximate char→token ratio for budget estimation. */
const CHARS_PER_TOKEN = 4;

function budget(modelTokens: number): number {
	return Math.floor(modelTokens * CHARS_PER_TOKEN);
}

const INSTRUCTION_OVERHEAD = `
You are acting as the orchestrator agent.

## Note
**Path:** ~path~

\`\`\`
\`\`\`

## Task
Analyze the above note and produce a plan of steps for specialized agents.
Return your response as a JSON object with:
- "steps": array of {"worker":"retriever|summarizer|editor","prompt":string,"targetPath"?:string,"dependsOn"?:string[]}
- "rationale": string explaining your plan`.length;

export function buildOrchestratorPrompt(noteContent: string, notePath: string, maxTokens?: number): string {
	const cap = budget(maxTokens ?? profile.modelConfig?.maxTokens ?? 4096);
	const bodyBudget = Math.max(500, cap - INSTRUCTION_OVERHEAD - notePath.length - 200);

	const body = noteContent.length > bodyBudget
		? noteContent.slice(0, bodyBudget) + '\n\n[note truncated for token budget]'
		: noteContent;

	return `
You are acting as the orchestrator agent.

## Note
**Path:** ${notePath}

\`\`\`
${body}
\`\`\`

## Task
Analyze the above note and produce a plan of steps for specialized agents.
Return your response as a JSON object with:
- "steps": array of { "worker": "retriever"|"summarizer"|"editor", "prompt": string, "targetPath"?: string, "dependsOn"?: string[] }
- "rationale": string explaining your plan

Focus on: extracting key information, finding related notes, summarizing content, and suggesting edits.
`.trim();
}

export function parsePlanResponse(output: string): OrchestratorPlan {
	try { return JSON.parse(output) as OrchestratorPlan; }
	catch {
		return {
			steps: [{ worker: 'summarizer', prompt: 'Summarize:\n\n' + output }],
			rationale: 'Fallback: orchestrator output was not structured JSON.',
		};
	}
}
