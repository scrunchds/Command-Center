import type { TopographyMap, TopographyNode } from './TopographySweep';

export type DiscoveryPatternKind = 'inbox' | 'daily-notes' | 'index-anchor' | 'managed-folder' | 'tag-cluster' | 'frontmatter-schema';

export interface SocraticTurn {
	role: 'user' | 'assistant';
	content: string;
}

export interface DiscoveryEvidence {
	kind: DiscoveryPatternKind;
	candidate: string;
	observations: string[];
	userConfirmed: boolean;
}

export interface LogicDiscoveryState {
	turns: SocraticTurn[];
	evidence: DiscoveryEvidence[];
	nextQuestion: string;
}

/** Rendering boundary for a discovery mode hosted by the canonical dashboard. */
export interface DashboardDiscoveryHost {
	openDiscovery(state: LogicDiscoveryState): void | Promise<void>;
	updateDiscovery(state: LogicDiscoveryState): void;
	closeDiscovery(): void;
}

export const LOGIC_DISCOVERY_SYSTEM_PROMPT = `You are Command Center's Socratic Triage consultant — a metacognitive partner, not a prescription engine. Your role is to help the user examine and negotiate how their own system works, not to grade it against a generic productivity framework.

Follow this two-stage conversational framework:

Stage 1 — The Contextual Baseline
- Begin with an open-ended interview before mentioning, summarizing, or referring to any files, folders, tags, links, frontmatter, note counts, or other TopographySweep evidence.
- Learn the user's background and working context, their core goals, the purpose the vault serves, and the kinds of information, commitments, or outcomes they track.
- Ask focused questions one at a time. Listen for the user's language, constraints, desired pace, tolerances, and definitions of success.
- Do not diagnose the vault or recommend an organizational pattern until this baseline has been established.
- Periodically reflect back what you have heard in the user's own language before proceeding. "Let me check if I'm understanding you correctly: you mentioned X, Y, and Z as core priorities. Does that feel complete?"

Stage 2 — Topographical Negotiation
- Only after the contextual baseline is established, introduce relevant observations from TopographySweep as neutral evidence rather than rules.
- Connect each observation to a goal or constraint the user stated. Point out anomalies gently, without labeling them as mistakes or dictating a solution.
- Frame change as a negotiation. For example: "I notice you manage these files manually. Since your goal is rapid output, why not explore automated ingestion?"
- Ask whether an observed pattern is intentional, incidental, obsolete, or serving a purpose that is not yet visible. Require user confirmation before promoting any inferred pattern into an organizational rule.

Metacognitive Principles
- Mirror the user's language: adopt their terms for things. If they call it a "capture bucket," use that phrase, not "inbox."
- Offer adaptive depth: after a response, ask whether they want to explore the topic further or keep it at a high level. "We can go deeper on this, or move to the next area. What's your preference?"
- Preserve useful friction: if a user's workflow has deliberate inefficiencies, investigate before optimizing. "You mentioned this process takes extra steps — is that intentional, or something you'd like to streamline?"
- Calibrate confidence: when a user seems uncertain, offer options rather than demanding a definitive answer. "Some people prefer X, others Y. Which resonates more with you?"

Conversational Dynamics
1. Reflect before advancing: after every 2-3 user answers, pause to reflect back what you've learned. "Here's what I understand so far about your system..." Let the user correct or refine before moving on.
2. Surface assumptions: when a user describes a process, gently ask about the reasoning behind it. "You mentioned you organize by project. What led you to that approach?" This reveals whether the pattern is intentional or inherited.
3. Connect the dots: when a user's answers in different phases reveal a pattern, point it out. "Earlier you said you value quick capture, and now you're describing a complex folder structure. How do those relate for you?"
4. Explore tradeoffs: after a user makes a choice, ask about what they're giving up. "Prioritizing speed means you might see less structure upfront. Does that tradeoff work for you?"
5. Evaluate satisfaction: ask the user how satisfied they are with their current approach before suggesting changes. "On a scale of 1-10, how well does your current capture system serve you?"
6. Future-proof: after establishing the current state, ask about how their needs might change. "Do you see your vault's role changing in the next 6 months?"
7. Propose capabilities as hypotheses: when suggesting a capability, frame it as a testable idea. "What if your weekly review could auto-summarize your inbox? Would that be useful, or would it get in the way?"

Subjective Efficiency
- Never assume a standard definition of "efficient," "organized," "clean," or "messy." A structure that appears irregular may be highly optimized for this user.
- Question the why gently. Adapt every assessment and recommendation strictly to the user's stated goals, constraints, habits, and preferred cognitive style.
- Preserve useful friction and intentional exceptions. If evidence conflicts with the user's account, investigate the difference rather than privileging the evidence.

Vault as Source of Truth
- The vault is the single source of truth for everything inside it. TopographySweep evidence is a cache, not ground truth. Before you name, describe, count, or refer to any folder, file, note, tag, frontmatter field, link, or index, it must come from a live tool result (list_files, search_vault, read_note) or the TopographySweep evidence shown to you.
- When the user asks to see, show, list, or verify their vault's structure or contents, call the list_files tool with path "/" and recursive true first, then report ONLY what it returns. Never answer from memory or infer "typical" folders.
- Never invent folders, files, notes, indexes, inboxes, daily-notes locations, tags, or frontmatter. If you are unsure whether something exists, say so and offer to check with a tool rather than guessing. A live tool result always overrides stale evidence.
- You may PROPOSE paths that do not yet exist, but label them clearly as proposals and never describe them as if they already exist. When the user explicitly agrees to create, move, rename, restructure, edit, or delete content, perform the change directly with the available vault tools (write_note, append_note, list_files, and any other enabled capability); the host's write gate confirms destructive or bulk actions. Only describe the new state after a tool returns success, and never claim a change was made unless the tool confirmed it.

Capability Expansion
- Act as a visionary consultant as well as a careful interviewer.
- Based on the user's stated goals, proactively suggest capabilities they may not have considered, such as automated tagging, ingestion pipelines, multi-agent summaries, semantic linking, graph-aware retrieval, recurring synthesis, or safe dry-run triage.
- Present capabilities as optional possibilities with a clear connection to the user's goals, tradeoffs, and required level of control. Do not present novelty as inherently beneficial.
- Invite the user to accept, reject, defer, or reshape each possibility.

Throughout both stages, remain curious, concise, nonjudgmental, and consent-led. Treat topology as evidence, the user's explanation as essential context, and the resulting vault logic as a jointly negotiated hypothesis. Every answer is a doorway to deeper understanding, not a checkbox.`;

const BASELINE_QUESTIONS = [
	'To begin without making assumptions about your vault, tell me about your background and the kind of work or life context this system needs to support.',
	'What are the core goals you want this vault to advance, and what would success feel like in your own terms?',
	'What purpose does the vault serve today, and what kinds of information, commitments, decisions, or outcomes do you use it to track?',
] as const;

const WORD = /[\p{L}\p{N}_/-]+/gu;
const tokens = (value: string): Set<string> => new Set((value.toLocaleLowerCase().match(WORD) ?? []).filter(token => token.length > 1));
const intersects = (left: Set<string>, right: Set<string>): boolean => [...left].some(value => right.has(value));

/**
 * Socratic, observation-led discovery scaffold. It cross-references user
 * language with sweep evidence but never promotes a candidate without consent.
 */
export class LogicDiscovery {
	private turns: SocraticTurn[] = [];
	private evidence: DiscoveryEvidence[] = [];

	constructor(private readonly topography: TopographyMap, private readonly dashboard: DashboardDiscoveryHost) {}

	async start(): Promise<LogicDiscoveryState> {
		this.turns = [];
		this.evidence = this.observeCandidates();
		const state = this.state(this.initialQuestion());
		await this.dashboard.openDiscovery(state);
		return state;
	}

	answer(content: string): LogicDiscoveryState {
		const value = content.trim();
		if (!value) throw new Error('Discovery answer cannot be empty.');
		this.turns.push({ role: 'user', content: value });
		const answerTokens = tokens(value);
		this.evidence = this.evidence.map(item => ({
			...item,
			userConfirmed: item.userConfirmed || intersects(answerTokens, tokens(item.candidate)),
		}));
		const nextQuestion = this.nextQuestion();
		this.turns.push({ role: 'assistant', content: nextQuestion });
		const state = this.state(nextQuestion);
		this.dashboard.updateDiscovery(state);
		return state;
	}

	applyAssistantResponse(content: string): LogicDiscoveryState {
		const value = content.trim();
		if (!value) throw new Error('Discovery response cannot be empty.');
		if (this.turns.at(-1)?.role === 'assistant') this.turns[this.turns.length - 1] = { role: 'assistant', content: value };
		else this.turns.push({ role: 'assistant', content: value });
		const state = this.state(value);
		this.dashboard.updateDiscovery(state);
		return state;
	}

	finish(): void {
		this.dashboard.closeDiscovery();
	}

	getState(): LogicDiscoveryState {
		return this.state(this.nextQuestion());
	}

	private state(nextQuestion: string): LogicDiscoveryState {
		return {
			turns: this.turns.map(turn => ({ ...turn })),
			evidence: this.evidence.map(item => ({ ...item, observations: [...item.observations] })),
			nextQuestion,
		};
	}

	private initialQuestion(): string {
		return BASELINE_QUESTIONS[0];
	}

	private nextQuestion(): string {
		if (this.turns.filter(turn => turn.role === 'user').length < BASELINE_QUESTIONS.length) {
			return BASELINE_QUESTIONS[this.turns.filter(turn => turn.role === 'user').length] ?? 'What else should I understand about the purpose of your vault before we examine its topology?';
		}
		const candidate = this.evidence.find(item => !item.userConfirmed);
		if (!candidate) return 'Given the goals and working context you described, which observed patterns should Command Center respect, and which are incidental or obsolete? We can also explore optional capabilities—such as automated tagging, semantic linking, or recurring multi-agent synthesis—only where they support your definition of success.';
		return `Now that I understand your context, I notice evidence around “${candidate.candidate}”: ${candidate.observations[0]} I do not assume that is efficient or inefficient. What purpose does this pattern serve for you, and—if it would advance your stated goals—would you like to explore an optional capability such as automation, semantic linking, or multi-agent synthesis?`;
	}

	private observeCandidates(): DiscoveryEvidence[] {
		const evidence: DiscoveryEvidence[] = [];
		for (const folder of this.topography.folders.values()) {
			if (!folder.path) continue;
			const name = folder.path.split('/').pop() ?? folder.path;
			const normalized = name.toLocaleLowerCase();
			if (/inbox|capture|incoming|unsorted/.test(normalized)) evidence.push({
				kind: 'inbox', candidate: folder.path,
				observations: [`The folder contains ${folder.descendantNoteCount} note(s) and its existing name suggests capture.`], userConfirmed: false,
			});
			if (/daily|journal|log/.test(normalized)) evidence.push({
				kind: 'daily-notes', candidate: folder.path,
				observations: [`The folder contains ${folder.descendantNoteCount} note(s) and its existing name suggests chronological notes.`], userConfirmed: false,
			});
			if (folder.descendantNoteCount >= 5) evidence.push({
				kind: 'managed-folder', candidate: folder.path,
				observations: [`It is an established cluster with ${folder.descendantNoteCount} descendant note(s).`], userConfirmed: false,
			});
		}
		for (const [tag, count] of [...this.topography.tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) evidence.push({
			kind: 'tag-cluster', candidate: tag, observations: [`The tag appears in ${count} note(s).`], userConfirmed: false,
		});
		for (const [field, count] of [...this.topography.frontmatterFieldCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) evidence.push({
			kind: 'frontmatter-schema', candidate: field, observations: [`The frontmatter field appears in ${count} note(s).`], userConfirmed: false,
		});
		return this.deduplicate(evidence);
	}

	private deduplicate(items: DiscoveryEvidence[]): DiscoveryEvidence[] {
		const seen = new Set<string>();
		return items.filter(item => {
			const key = `${item.kind}:${item.candidate}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}
}

export function notesMatchingEvidence(topography: TopographyMap, evidence: DiscoveryEvidence): TopographyNode[] {
	const candidateTokens = tokens(evidence.candidate);
	return [...topography.nodes.values()].filter(node =>
		intersects(candidateTokens, tokens(`${node.path} ${node.tags.join(' ')} ${node.frontmatterFields.join(' ')}`)),
	);
}
