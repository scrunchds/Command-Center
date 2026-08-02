import { App, Component, MarkdownRenderer, Notice } from 'obsidian';
import type CommandCenterPlugin from '../main';
import type { OnboardingConfig } from '../onboarding/OnboardingTypes';
import {
	containsProtectedSetupInput,
	type InterviewEngine,
	type InterviewSynthesis,
} from '../onboarding/InterviewEngine';

export interface DashboardOnboardingOptions {
	onComplete?: (config: OnboardingConfig) => void | Promise<void>;
	onClose?: () => void;
}

/** Embedded first-run discovery surface for the Command Center dashboard. */
export class DashboardOnboarding {
	private history!: HTMLElement;
	private input!: HTMLTextAreaElement;
	private send!: HTMLButtonElement;
	private status!: HTMLElement;
	private composer!: HTMLElement;
	private approval: HTMLElement | null = null;
	private phase!: HTMLElement;
	private busy = false;
	private dictationStop: (() => Promise<string>) | null = null;
	private readonly dictationStatusCallback: import('../audio/AccessibilityAudio').TranscriptionStatusCallback = (phase, message) => {
		if (phase === 'error') this.setStatus?.(message, true);
		else if (phase === 'connecting' || phase === 'transcribing') this.setStatus?.(message);
	};

	constructor(
		private readonly app: App,
		private readonly plugin: CommandCenterPlugin,
		private readonly host: HTMLElement,
		private readonly renderer: Component,
		private readonly engine: InterviewEngine,
		private readonly options: DashboardOnboardingOptions = {},
	) {}

	async open(): Promise<void> {
		this.host.empty();
		this.host.addClass('cc-dashboard-onboarding');
		const heading = this.host.createDiv({ cls: 'cc-dashboard-workspace-heading' });
		heading.createDiv( { text: 'COMMAND CENTER DASHBOARD', cls: 'cc-dashboard-workspace-kicker' });
		heading.createEl('h2', { text: 'Start here' });
		heading.createEl('p', {
			text: 'Establish context and goals first. Vault structure and optional capabilities are negotiated only after the system understands what you need it to serve.',
		});
		const close = heading.createEl('button', { text: 'Return to operations' });
		this.renderer.registerDomEvent(close, 'click', () => this.options.onClose?.());

		this.phase = this.host.createDiv({ cls: 'cc-onboarding-phase' });
		this.updatePhase();
		this.host.createDiv({
			cls: 'cc-onboarding-security',
			text: 'Never enter credentials, secrets, or provider endpoints here. Configure them only in Settings → Command Center.',
		});
		this.history = this.host.createDiv({ cls: 'cc-onboarding-history' });
		this.composer = this.host.createDiv({ cls: 'cc-onboarding-composer' });
		this.input = this.composer.createEl('textarea', {
			cls: 'cc-onboarding-input',
			attr: { rows: '3', placeholder: 'Answer in your own words…' },
		});
		this.renderer.registerDomEvent(this.input, 'keydown', (event) => {
			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				void this.submit();
			}
		});
		const actions = this.composer.createDiv({ cls: 'cc-onboarding-actions' });
		const skip = actions.createEl('button', { text: 'Skip optional question' });
		this.renderer.registerDomEvent(skip, 'click', () => void this.submit('Skip this optional question; record no invented value and continue.'));
		const dictate = actions.createEl('button', { text: '🎙 Dictate', attr: { 'aria-label': 'Start dictation' } });
		this.renderer.registerDomEvent(dictate, 'click', () => void this.toggleDictation(dictate));
		this.send = actions.createEl('button', { text: 'Send', cls: 'mod-cta' });
		this.renderer.registerDomEvent(this.send, 'click', () => void this.submit());
		this.status = this.composer.createDiv({ cls: 'cc-onboarding-status' });
		try {
			await this.render('assistant', await this.engine.start());
			this.input.focus();
		} catch (error) {
			this.setStatus((error as Error).message, true);
		}
	}

	private async toggleDictation(button: HTMLButtonElement): Promise<void> {
		if (this.dictationStop) {
			button.disabled = true;
			button.setText('Transcribing…');
			const stop = this.dictationStop;
			this.dictationStop = null;
			try {
				const text = await stop();
				if (text.trim()) {
					this.input.value = [this.input.value.trim(), text].filter(Boolean).join(' ');
					this.setStatus('Dictation inserted. Review it before sending.');
					this.plugin.accessibilityAudio.cue('complete');
				} else {
					this.setStatus('Dictation was empty — nothing inserted.', true);
				}
			} catch (error) { this.setStatus((error as Error).message, true); }
			finally { button.disabled = false; button.setText('🎙 Dictate'); }
			return;
		}
		try {
			if (!this.plugin.settings.speechToTextEnabled) throw new Error('Enable speech to text in Settings to use dictation.');
			const session = await this.plugin.accessibilityAudio.dictate(undefined, this.dictationStatusCallback);
			this.dictationStop = session.stop;
			button.setText('■ Stop dictation');
			this.setStatus('Listening…');
		} catch (error) { this.setStatus((error as Error).message, true); }
	}

	private async submit(explicitText?: string): Promise<void> {
		const text = explicitText ?? this.input.value.trim();
		if (!text || this.busy) return;
		if (containsProtectedSetupInput(text)) {
			this.input.value = '';
			this.setStatus('Protected setup input was blocked locally. Use Settings → Command Center.', true);
			new Notice('Protected setup input was blocked and not submitted.');
			return;
		}
		this.input.value = '';
		await this.render('user', explicitText ? '_Optional question skipped._' : text);
		this.setBusy(true);
		this.setStatus('Processing…');
		try {
			const reply = await this.engine.answer(text);
			await this.render('assistant', reply.message);
			this.updatePhase();
			if (reply.synthesis) this.renderApproval(reply.synthesis);
			else this.setStatus(reply.redacted ? 'Credential-like content was not sent.' : '');
		} catch (error) {
			this.setStatus((error as Error).message, true);
		} finally {
			this.setBusy(false);
			this.input.focus();
		}
	}

	private renderApproval(synthesis: InterviewSynthesis): void {
		this.approval?.remove();
		this.composer.addClass('is-hidden');
		this.approval = this.host.createDiv({ cls: 'cc-onboarding-approval' });
		this.approval.createEl('h3', { text: 'Approve operational assets' });
		this.approval.createEl('p', { text: 'Nothing is written until you approve it. Uncheck anything you do not want.' });
		const templates = this.checklist('Templates', synthesis.templates);
		const workflows = this.checklist('Workflows', synthesis.workflows);
		const actions = this.approval.createDiv({ cls: 'cc-onboarding-actions' });
		const revise = actions.createEl('button', { text: 'Reject and revise' });
		const create = actions.createEl('button', { text: 'Approve selected assets', cls: 'mod-cta' });
		this.renderer.registerDomEvent(revise, 'click', () => {
			this.approval?.remove();
			this.approval = null;
			this.composer.removeClass('is-hidden');
			this.setStatus('No assets were created.');
		});
		this.renderer.registerDomEvent(create, 'click', () => void (async () => {
			create.disabled = revise.disabled = true;
			this.setStatus('Creating approved assets…');
			try {
				const result = await this.engine.completeSynthesis(selected(templates), selected(workflows));
				await this.options.onComplete?.(result.config);
				this.approval?.empty();
				this.approval?.createEl('h3', { text: 'Command center initialized' });
				this.approval?.createEl('p', { text: `Created ${result.templatePaths.length} template(s) and ${result.workflowPaths.length} workflow(s).` });
				this.setStatus('Approved configuration and assets initialized.');
				new Notice('Command Center initialized.');
			} catch (error) {
				create.disabled = revise.disabled = false;
				this.setStatus((error as Error).message, true);
			}
		})());
	}

	private checklist<T extends { id: string; name: string; description: string }>(heading: string, items: T[]): Array<{ id: string; input: HTMLInputElement }> {
		this.approval!.createEl('h4', { text: heading });
		return items.map((item) => {
			const row = this.approval!.createEl('label', { cls: 'cc-onboarding-asset-option' });
			const input = row.createEl('input', { type: 'checkbox' });
			input.checked = true;
			const copy = row.createDiv();
			copy.createEl('strong', { text: item.name });
			copy.createDiv({ text: item.description });
			return { id: item.id, input };
		});
	}

	private async render(role: 'user' | 'assistant', content: string): Promise<void> {
		const row = this.history.createDiv({ cls: `cc-onboarding-message cc-onboarding-${role}` });
		const bubble = row.createDiv({ cls: 'cc-onboarding-bubble' });
		await MarkdownRenderer.render(this.app, content, bubble, '', this.renderer);
		if (role === 'assistant') {
			const read = row.createEl('button', { text: '🔊 Read aloud', cls: 'cc-read-aloud', attr: { 'aria-label': 'Read assistant response aloud' } });
			this.renderer.registerDomEvent(read, 'click', () => this.plugin.accessibilityAudio.speak(content));
			if (this.plugin.settings.autoReadAiResponses) this.plugin.accessibilityAudio.speak(content);
			this.plugin.accessibilityAudio.cue('complete');
		}
		this.history.scrollTop = this.history.scrollHeight;
	}

	private updatePhase(): void {
		const labels: Record<string, string> = {
			topology: 'Context and Organic Structure', 'life-map': 'Domains and Active Outcomes',
			capacity: 'Capacity on Your Terms', triage: 'Triage and Mutation Boundaries',
			focus: 'Focus Constraints', style: 'Language and Sparring Style',
			confirmation: 'Review and Confirmation', synthesis: 'Asset Approval',
		};
		const phase = this.engine.getPhase();
		const label = labels[phase] ?? phase;
		this.phase.setText(phase === 'confirmation' || phase === 'synthesis' ? label : `Discovery ${this.engine.getPhaseNumber()} of 6 — ${label}`);
	}

	private setBusy(value: boolean): void { this.busy = value; this.send.disabled = value; this.input.disabled = value; }
	private setStatus(text: string, error = false): void { this.status.setText(text); this.status.toggleClass('is-error', error); }
}

function selected(items: Array<{ id: string; input: HTMLInputElement }>): string[] {
	return items.filter((item) => item.input.checked).map((item) => item.id);
}
