/**
 * Retriever worker — searches and retrieves relevant notes.
 * Vault context sliced to respect modelConfig.maxTokens minus overhead.
 */

import type { WorkerProfile } from '../types';

export const profile: WorkerProfile = {
	name: 'retriever',
	label: 'Retriever',
	description: 'Searches and retrieves relevant notes from the vault',
	systemPrompt:
		'You are a retriever agent. Given a query or note reference, find relevant ' +
		'notes in the vault and return their paths, summaries, and relevance scores.',
	modelConfig: { maxTokens: 2048, temperature: 0.2 },
};

export interface RetrievalResult {
	matches: RetrievalMatch[];
	query: string;
}

export interface RetrievalMatch {
	path: string;
	title: string;
	relevance: number;
	excerpt: string;
}

const CHARS_PER_TOKEN = 4;
const INSTRUCTION_OVERHEAD = `
You are acting as the retriever agent.

## Query
~query~

## Vault Context (available notes)
~context~

## Task
Search the vault for notes relevant to the query above.
Return a JSON object with:
- "matches": array of {"path":string,"title":string,"relevance":number,"excerpt":string}
- "query": the original query`.length;

export function buildRetrieverPrompt(query: string, vaultContext?: string, maxTokens?: number): string {
	const cap = Math.floor((maxTokens ?? profile.modelConfig?.maxTokens ?? 2048) * CHARS_PER_TOKEN);
	const queryLen = query.length;

	if (vaultContext) {
		const ctxBudget = Math.max(200, cap - INSTRUCTION_OVERHEAD - queryLen - 100);
		vaultContext = vaultContext.length > ctxBudget
			? vaultContext.slice(0, ctxBudget) + '\n\n[vault context truncated for token budget]'
			: vaultContext;
	}

	return `
You are acting as the retriever agent.

## Query
${query}

${vaultContext ? `## Vault Context (available notes)\n${vaultContext}\n` : ''}
## Task
Search the vault for notes relevant to the query above.
Return a JSON object with:
- "matches": array of { "path": string, "title": string, "relevance": number (0-1), "excerpt": string }
- "query": the original query

If no relevant notes are found, return an empty matches array.
`.trim();
}

export function parseRetrievalResponse(output: string): RetrievalResult {
	try { return JSON.parse(output) as RetrievalResult; }
	catch { return { matches: [], query: 'Unknown (parse fallback)' }; }
}
