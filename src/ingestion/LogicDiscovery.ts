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

/** Hook implemented by the Triptych Command Deck center/context panes. */
export interface TriptychDiscoveryHook {
	openDiscovery(state: LogicDiscoveryState): void | Promise<void>;
	updateDiscovery(state: LogicDiscoveryState): void;
	closeDiscovery(): void;
}

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

	constructor(private readonly topography: TopographyMap, private readonly deck: TriptychDiscoveryHook) {}

	async start(): Promise<LogicDiscoveryState> {
		this.turns = [];
		this.evidence = this.observeCandidates();
		const state = this.state(this.initialQuestion());
		await this.deck.openDiscovery(state);
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
		this.deck.updateDiscovery(state);
		return state;
	}

	finish(): void {
		this.deck.closeDiscovery();
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
		const noteCount = this.topography.nodes.size;
		const folderCount = [...this.topography.folders.keys()].filter(Boolean).length;
		return `I observed ${noteCount} Markdown note(s) across ${folderCount} visible folder(s). Where do new or unfinished items naturally land today? I will treat folder and tag patterns only as evidence, not rules.`;
	}

	private nextQuestion(): string {
		const candidate = this.evidence.find(item => !item.userConfirmed);
		if (!candidate) return 'Which of these observed patterns should Command Center respect, and which are incidental or obsolete?';
		return `I observed evidence around “${candidate.candidate}”: ${candidate.observations[0]}. Does that reflect an organizational pattern you intentionally use?`;
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
