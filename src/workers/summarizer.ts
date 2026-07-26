/**
 * Summarizer worker — generates concise summaries.
 * Content sliced to respect modelConfig.maxTokens minus overhead.
 */

import type { WorkerProfile } from '../types';

export const profile: WorkerProfile = {
	name: 'summarizer',
	label: 'Summarizer',
	description: 'Generates concise summaries of note content',
	systemPrompt:
		'You are a summarizer agent. Read the provided note content and produce a ' +
		'concise, well-structured summary capturing key points, themes, and actionable items.',
	modelConfig: { maxTokens: 2048, temperature: 0.4 },
};

export interface SummaryResult {
	title: string;
	keyPoints: string[];
	themes: string[];
	actionableItems: string[];
	oneLineSummary: string;
}

const CHARS_PER_TOKEN = 4;
const INSTRUCTION_OVERHEAD = `
You are acting as the summarizer agent.

## Note
**Path:** ~path~

\`\`\`
\`\`\`

## Task
Summarize the above note. Return a JSON object with:
- "title": suggested title for the summary
- "keyPoints": array of strings (3-7 key points)
- "themes": array of strings (main themes or topics)
- "actionableItems": array of strings (action items, if any)
- "oneLineSummary": a single sentence summary`.length;

export function buildSummarizerPrompt(noteContent: string, notePath: string, maxTokens?: number): string {
	const cap = Math.floor((maxTokens ?? profile.modelConfig?.maxTokens ?? 2048) * CHARS_PER_TOKEN);
	const bodyBudget = Math.max(500, cap - INSTRUCTION_OVERHEAD - notePath.length - 200);

	const body = noteContent.length > bodyBudget
		? noteContent.slice(0, bodyBudget) + '\n\n[note truncated for token budget]'
		: noteContent;

	return `
You are acting as the summarizer agent.

## Note
**Path:** ${notePath}

\`\`\`
${body}
\`\`\`

## Task
Summarize the above note. Return a JSON object with:
- "title": suggested title for the summary
- "keyPoints": array of strings (3-7 key points)
- "themes": array of strings (main themes or topics)
- "actionableItems": array of strings (action items, if any)
- "oneLineSummary": a single sentence summary
`.trim();
}

export function parseSummaryResponse(output: string): SummaryResult {
	try { return JSON.parse(output) as SummaryResult; }
	catch {
		return {
			title: 'Summary',
			keyPoints: [output.slice(0, 500)],
			themes: [], actionableItems: [],
			oneLineSummary: output.slice(0, 200),
		};
	}
}
