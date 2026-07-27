import { App, Modal, normalizePath, Notice } from 'obsidian';
import type { VaultTopography } from './TopographySweep';

export const USER_LOGIC_PROFILE_PATH = '.obsidian/plugins/command-center/user_logic_profile.json';

export interface UserLogicProfile {
	schemaVersion: 1;
	generatedAt: string;
	organizationPreference: string;
	vaultPurpose: string;
	confirmedPatterns: Array<{ kind: 'tag' | 'hub' | 'folder'; value: string; preference: string }>;
	conversation: Array<{ role: 'assistant' | 'user'; content: string }>;
}

type Stage = 'organization' | 'purpose' | 'topology' | 'complete';

/** Native conversational modal: one contextual question at a time, never a form. */
export class LogicDiscoveryLoop extends Modal {
	private stage: Stage = 'organization';
	private conversation: UserLogicProfile['conversation'] = [];
	private organizationPreference = '';
	private vaultPurpose = '';
	private patterns: UserLogicProfile['confirmedPatterns'] = [];
	private candidateIndex = 0;
	private transcript!: HTMLElement;
	private input!: HTMLTextAreaElement;

	constructor(app: App, private readonly topography: VaultTopography, private readonly outputPath = USER_LOGIC_PROFILE_PATH) { super(app); }

	onOpen(): void {
		this.contentEl.empty();
		this.setTitle('Logic Discovery');
		this.contentEl.createEl('p', { text: 'A conversational check-in. Your existing structure is evidence, not a rule.' });
		this.transcript = this.contentEl.createDiv({ cls: 'cc-discovery-transcript' });
		this.input = this.contentEl.createEl('textarea', { cls: 'cc-discovery-input', attr: { placeholder: 'Respond in your own words…', rows: '4' } });
		const submit = this.contentEl.createEl('button', { text: 'Continue', cls: 'mod-cta' });
		submit.addEventListener('click', () => { void this.submit(); });
		this.ask('Before I interpret your vault, how do you naturally prefer to organize or retrieve thoughts?');
		this.input.focus();
	}

	onClose(): void { this.input?.value && (this.input.value = ''); this.contentEl.empty(); }

	private async submit(): Promise<void> {
		const answer = this.input.value.trim();
		if (!answer) { new Notice('Please answer in your own words.'); return; }
		this.conversation.push({ role: 'user', content: answer });
		this.renderTurn('user', answer);
		this.input.value = '';
		if (this.stage === 'organization') {
			this.organizationPreference = answer; this.stage = 'purpose';
			this.ask('What role should this vault play in your work or life, and what should agents help you accomplish?');
			return;
		}
		if (this.stage === 'purpose') { this.vaultPurpose = answer; this.stage = 'topology'; this.askNextObservation(); return; }
		if (this.stage === 'topology') {
			const candidate = this.candidates()[this.candidateIndex];
			if (candidate) this.patterns.push({ ...candidate, preference: answer });
			this.candidateIndex += 1;
			if (this.candidateIndex < this.candidates().length) this.askNextObservation();
			else { this.stage = 'complete'; await this.save(); }
		}
	}

	private candidates(): Array<{ kind: 'tag' | 'hub' | 'folder'; value: string }> {
		const tag = this.topography.tags[0];
		const hub = this.topography.hubs[0];
		const folder = [...this.topography.folders].sort((a, b) => b.noteCount - a.noteCount).find(item => item.path);
		return [
			...(tag ? [{ kind: 'tag' as const, value: tag.tag }] : []),
			...(hub ? [{ kind: 'hub' as const, value: hub.path }] : []),
			...(folder ? [{ kind: 'folder' as const, value: folder.path }] : []),
		];
	}

	private askNextObservation(): void {
		const candidate = this.candidates()[this.candidateIndex];
		if (!candidate) { void this.save(); return; }
		const question = candidate.kind === 'tag'
			? `I notice “${candidate.value}” is one of your most-used tags. Is that intentional, and should agents default to it, ask first, or leave it untouched?`
			: candidate.kind === 'hub'
				? `“${candidate.value}” is heavily linked. Does it function as a map of content, or does it serve another purpose agents should respect?`
				: `The folder “${candidate.value}” contains a notable concentration of notes. Is that an intentional boundary, an incidental pattern, or something in transition?`;
		this.ask(question);
	}

	private ask(content: string): void { this.conversation.push({ role: 'assistant', content }); this.renderTurn('assistant', content); }
	private renderTurn(role: 'assistant' | 'user', content: string): void { this.transcript.createDiv({ cls: `cc-discovery-turn cc-discovery-${role}`, text: content }); }

	private async save(): Promise<void> {
		const profile: UserLogicProfile = { schemaVersion: 1, generatedAt: new Date().toISOString(), organizationPreference: this.organizationPreference, vaultPurpose: this.vaultPurpose, confirmedPatterns: this.patterns, conversation: this.conversation };
		await this.app.vault.adapter.write(normalizePath(this.outputPath), JSON.stringify(profile, null, 2));
		this.ask('Thank you. I saved the negotiated logic profile for future agent formatting.');
		this.input.disabled = true;
		new Notice('User logic profile saved.');
	}
}
