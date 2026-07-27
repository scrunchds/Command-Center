import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { LogicDiscoveryState, TriptychDiscoveryHook } from '../ingestion/LogicDiscovery';

export const COMMAND_DECK_VIEW_TYPE = 'command-center-triptych-deck';
export const COMMAND_DECK_DISPLAY_TEXT = 'Command Deck';

/** Triptych shell: stable perimeter tools surrounding a replaceable Center Stage. */
export class CommandDeck extends ItemView implements TriptychDiscoveryHook {
	private centerStage: HTMLElement | null = null;
	private discoveryState: LogicDiscoveryState | null = null;
	private answerHandler: ((answer: string) => void) | null = null;

	constructor(leaf: WorkspaceLeaf) { super(leaf); }
	getViewType(): string { return COMMAND_DECK_VIEW_TYPE; }
	getDisplayText(): string { return COMMAND_DECK_DISPLAY_TEXT; }
	getIcon(): string { return 'layout-dashboard'; }

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass('cc-command-deck');
		this.renderRail(root.createDiv({ cls: 'cc-deck-rail cc-deck-rail-left' }), 'Core tools', ['Route', 'Retrieve', 'Triage']);
		this.centerStage = root.createDiv({ cls: 'cc-deck-center-stage' });
		this.renderRail(root.createDiv({ cls: 'cc-deck-rail cc-deck-rail-right' }), 'Context tools', ['Graph', 'Memory', 'History']);
		this.renderCenter();
	}

	async onClose(): Promise<void> { this.centerStage = null; this.discoveryState = null; }
	setAnswerHandler(handler: (answer: string) => void): void { this.answerHandler = handler; }
	openDiscovery(state: LogicDiscoveryState): void { this.discoveryState = state; this.renderCenter(); }
	updateDiscovery(state: LogicDiscoveryState): void { this.discoveryState = state; this.renderCenter(); }
	closeDiscovery(): void { this.discoveryState = null; this.renderCenter(); }

	private renderRail(container: HTMLElement, title: string, tools: string[]): void {
		container.createEl('h3', { text: title });
		for (const tool of tools) container.createEl('button', { text: tool, cls: 'cc-deck-tool' }).disabled = true;
	}

	private renderCenter(): void {
		if (!this.centerStage) return;
		this.centerStage.empty();
		this.centerStage.createEl('h2', { text: 'Center Stage' });
		if (!this.discoveryState) {
			this.centerStage.createEl('p', { text: 'Select a perimeter tool to bring its workspace into focus.', cls: 'cc-deck-empty' });
			return;
		}
		const transcript = this.centerStage.createDiv({ cls: 'cc-deck-transcript' });
		for (const turn of this.discoveryState.turns) transcript.createDiv({ text: turn.content, cls: `cc-deck-turn cc-deck-turn-${turn.role}` });
		transcript.createDiv({ text: this.discoveryState.nextQuestion, cls: 'cc-deck-turn cc-deck-turn-assistant' });
		const input = this.centerStage.createEl('textarea', { cls: 'cc-deck-answer', attr: { placeholder: 'Respond to the observed pattern…' } });
		const submit = this.centerStage.createEl('button', { text: 'Continue discovery', cls: 'mod-cta' });
		submit.addEventListener('click', () => { const value = input.value.trim(); if (value && this.answerHandler) this.answerHandler(value); });
	}
}
