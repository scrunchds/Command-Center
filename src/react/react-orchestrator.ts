/**
 * ReAct Orchestrator — prompt builder and response parser for the
 * iterative Reason+Act pattern.
 */

import type { ReActContext, ReActResponse, ReActCycle } from './react-types';
import { TOKEN_LIMITS } from '../types';
import { buildRoleCatalog, buildDynamicRoleCreationPrompt } from './react-roles';
import { parseModelJson } from '../providers/json-repair';

/* ─── ReAct Orchestrator Profile ────────────────────────── */

export const REACT_ORCHESTRATOR_SYSTEM_PROMPT = `You are a ReAct (Reasoning + Acting) orchestrator agent. You operate in an iterative loop:

1. REASON: Analyze the task and accumulated observations. Decide what to do next.
2. ACT: Specify which specialized worker to invoke and what tools they may use.
3. OBSERVE: The system will invoke that worker and return the results to you.
4. REFINE: Incorporate the observation into your understanding and decide:
   - Continue: produce another Thought→Action pair
   - Complete: produce a Final Answer

Available workers and the tools they can use:
- **retriever** — Searches the vault for relevant notes. Can use: read_note, search_vault, list_files, get_active_note.
- **summarizer** — Summarizes and extracts key information from notes.
- **editor** — Produces structural edits and content transformations. Can use: read_note, write_note, append_note.

Always respond with this exact JSON structure:

{
  "thought": {
    "reasoning": "Your step-by-step reasoning about the current state and what to do",
    "assessment": "planning|acting|observing|complete|stuck",
    "confidence": 0.0 to 1.0
  },
  "action": {
    "worker": "retriever|summarizer|editor",
    "prompt": "The specific prompt for that worker",
    "targetPath": "optional vault path",
    "expectedOutput": "What you expect to learn from this action"
  },
  "finalAnswer": "Only include when assessment is 'complete'. The synthesized final answer."
}

Rules:
- assessment 'planning': first analysis before any actions
- assessment 'acting': you are dispatching a worker
- assessment 'observing': you just received results and are interpreting them
- assessment 'complete': you have enough information to answer
- assessment 'stuck': you cannot make progress
- Include "action" when assessment is 'planning' or 'acting'. Omit it for 'complete' or 'stuck'.
- Include "finalAnswer" when assessment is 'complete'. Omit it otherwise.
- Be specific in worker prompts — include file paths, search terms, or edit instructions.
- After receiving observations, check if they satisfy the expected output. If not, try a different approach.
- When you have sufficient information, produce a final answer with assessment 'complete' and confidence >= 0.85.
- For INDEPENDENT tasks, emit multiple actions as a JSON array for parallel execution: [{ "worker": "...", "prompt": "...", "expectedOutput": "..." }, ...].
- Every editor action that may write or append MUST include its exact targetPath.
- Never emit parallel write actions for the same targetPath. A conflict is returned as a FileBusyError observation and should be queued in a later cycle.
- Create a customRole only when no built-in role fits. Request the minimum tools needed; runtime policy will constrain permissions and generate validation rules.`;

/* ─── Worker ReAct System Prompts ─────────────────────── */

export const WORKER_REACT_SYSTEM_PROMPTS: Record<string, string> = {
	retriever: `You are a retriever agent with ReAct capability.

1. REASON: Analyze the search task. What information is needed?
2. ACT: Use tools (search_vault, read_note, list_files, get_active_note) to find information.
3. OBSERVE: Review the tool results. Are they sufficient?
4. REFINE: If you need more, try different search terms. If done, produce your final answer.

Return a JSON object with your finalAnswer when done.`,

	summarizer: `You are a summarizer agent with ReAct capability.

1. REASON: Analyze the content. What are the key themes?
2. ACT: Use tools (read_note, search_vault) if needed.
3. OBSERVE: Review results and your draft summary.
4. REFINE: If complete, produce your final answer. If gaps remain, gather more.

Return a JSON object with your finalAnswer when done.`,

	editor: `You are an editor agent with ReAct capability.

1. REASON: Analyze the edit instructions and current content.
2. ACT: Use tools (read_note, write_note, append_note, search_vault).
3. OBSERVE: Check edits were applied correctly.
4. REFINE: If adjustments needed, iterate. Otherwise produce your final answer.

Return a JSON object with your finalAnswer when done.`,
};

export function buildWorkerReActPrompt(
	profile: string,
	task: string,
	targetPath?: string,
	context?: string,
): string {
	const systemPrompt = WORKER_REACT_SYSTEM_PROMPTS[profile] ?? WORKER_REACT_SYSTEM_PROMPTS['retriever'];
	let prompt = `${systemPrompt}\n\n## Task\n${task.slice(0, 3000)}`;
	if (targetPath) prompt += `\n**Target path:** ${targetPath}`;
	if (context) prompt += `\n\n## Context\n${context.slice(0, 2000)}`;
	prompt += `\n\n## Instructions\nWork step by step. Use tools as needed. Return a JSON object with your finalAnswer when done.`;
	return prompt;
}

/* ─── Working Memory Formatter ──────────────────────────── */

function formatWorkingMemory(ctx: ReActContext, maxChars: number): string {
	if (ctx.cycles.length === 0) return '(No previous cycles — this is the first iteration.)';
	let memory = '## Working Memory (previous cycles)\n\n';
	let total = memory.length;
	for (const cycle of ctx.cycles) {
		const block = formatCycle(cycle);
		if (total + block.length > maxChars) { memory += '\n[... earlier cycles compacted for token budget ...]\n'; break; }
		memory = block + '\n' + memory;
		total += block.length + 1;
	}
	return memory;
}

function formatCycle(cycle: ReActCycle): string {
	const parts: string[] = [];
	parts.push(`### Cycle ${cycle.index + 1}`);
	parts.push(`**Thought (${cycle.thought.assessment}, confidence: ${cycle.thought.confidence.toFixed(2)}):**`);
	parts.push(cycle.thought.reasoning.slice(0, 1500));
	if (cycle.action) {
		parts.push(`**Action:** → ${cycle.action.worker}`);
		parts.push(`Prompt: ${cycle.action.prompt.slice(0, 500)}`);
	}
	if (cycle.observation) {
		parts.push(`**Observation (${cycle.observation.success ? '✅ Success' : '❌ Failed'}):**`);
		parts.push(cycle.observation.output.slice(0, 1500));
		if (cycle.observation.keyInsights.length > 0) {
			parts.push(`Key insights: ${cycle.observation.keyInsights.join('; ').slice(0, 400)}`);
		}
	}
	return parts.join('\n');
}

/* ─── Prompt Builder ────────────────────────────────────── */

export function buildReActOrchestratorPrompt(
	ctx: ReActContext,
	cycleIndex: number,
	maxChars: number = 24_000,
): string {
	const roleCatalog = buildRoleCatalog();
	const overhead = 1200 + roleCatalog.length;
	const memoryBudget = Math.max(2000, maxChars - overhead - ctx.task.length - 500);
	const memory = formatWorkingMemory(ctx, memoryBudget);
	const catalogBlock = `## Available Specialized Roles\nAssign roles to workers for targeted expertise. Each action accepts an optional "role" field:\n\n${roleCatalog}\n\n${buildDynamicRoleCreationPrompt()}`;
	return `${REACT_ORCHESTRATOR_SYSTEM_PROMPT}\n\n${catalogBlock}\n\n## Original Task\n${ctx.task.slice(0, 3000)}${ctx.targetPath ? `\n**Target path:** ${ctx.targetPath}` : ''}\n\n${memory}\n\n## Current State\nYou are on cycle ${cycleIndex + 1}. Analyze the working memory above and decide your next step.\n\nReturn JSON with "thought" and either "actions" (array for parallel) or "finalAnswer". Each action can include an optional "role" field and, for a newly generated persona, a matching "customRole" object.`.trim();
}

/* ─── Final Synthesis Prompt ────────────────────────────── */

export function buildReActFinalSynthesisPrompt(ctx: ReActContext): string {
	const observations = ctx.cycles
		.filter(c => c.observation?.output)
		.map(c => `### From cycle ${c.index + 1} (${c.action?.worker ?? 'orchestrator'}):\n${c.observation!.output.slice(0, 2000)}`)
		.join('\n\n');
	return `You are a summarizer synthesizing results from a multi-step ReAct session.\n\n## Original Task\n${ctx.task.slice(0, 2000)}\n\n## All Observations\n${observations.slice(0, TOKEN_LIMITS.MAX_PROMPT_CHARS - 1500)}\n\n## Task\nSynthesize these observations into a comprehensive final answer. Include key findings, relevant file paths, and any action items. Return a clear, well-structured response.`.trim();
}

/* ─── Response Parser ───────────────────────────────────── */

export function parseReActResponse(output: string): ReActResponse {
	try {
		// Provider-agnostic repair handles fenced JSON, trailing commas,
		// unescaped prose quotes, and payloads cut off near the token limit.
		const parsed = parseModelJson<ReActResponse>(output);
		if (parsed.thought?.reasoning) return normalizeResponse(parsed);
	} catch { /* preserve the existing natural-language fallback */ }
	return { thought: { reasoning: output.slice(0, TOKEN_LIMITS.MAX_RESULT_OUTPUT_CHARS), assessment: output.length > 100 ? 'complete' : 'stuck', confidence: 0.5 }, finalAnswer: output };
}

function normalizeResponse(r: ReActResponse): ReActResponse {
	// Accept models that emit `action` despite the newer parallel `actions` schema.
	if (!r.actions?.length && r.action) r.actions = [r.action];
	r.thought.confidence = Math.max(0, Math.min(1, r.thought.confidence));
	const valid = ['planning', 'acting', 'observing', 'complete', 'stuck'];
	if (!valid.includes(r.thought.assessment)) r.thought.assessment = 'acting';
	return r;
}