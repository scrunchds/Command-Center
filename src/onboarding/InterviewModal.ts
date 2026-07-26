import { App, Component, MarkdownRenderer, Modal, Notice } from 'obsidian';
import type { OnboardingConfig } from './OnboardingTypes';
import { containsProtectedSetupInput, type InterviewEngine, type InterviewSynthesis } from './InterviewEngine';

export interface InterviewModalOptions { onComplete?: (config: OnboardingConfig) => void | Promise<void>; }

/** Native chat interview plus explicit checklist approval for synthesized assets. */
export class InterviewModal extends Modal {
	private history: HTMLElement | null = null;
	private input: HTMLTextAreaElement | null = null;
	private send: HTMLButtonElement | null = null;
	private status: HTMLElement | null = null;
	private composer: HTMLElement | null = null;
	private approval: HTMLElement | null = null;
	private phase: HTMLElement | null = null;
	private renderer = new Component();
	private busy = false;

	constructor(app: App, private readonly engine: InterviewEngine, private readonly options: InterviewModalOptions = {}) { super(app); }

	onOpen(): void {
		this.renderer.load();
		this.modalEl.addClass('cc-onboarding-modal');
		this.contentEl.empty();
		this.contentEl.createEl('h2', { text: 'Command Center — Start Here' });
		this.phase = this.contentEl.createDiv({ cls: 'cc-onboarding-phase' });
		this.updatePhase();
		this.contentEl.createDiv({ cls: 'cc-onboarding-security', text: 'Do not enter API keys, passwords, tokens, URLs, hosts, ports, or endpoint values. Configure credentials and provider endpoints only in Settings → Command Center.' });
		this.history = this.contentEl.createDiv({ cls: 'cc-onboarding-history' });
		this.composer = this.contentEl.createDiv({ cls: 'cc-onboarding-composer' });
		this.input = this.composer.createEl('textarea', { cls: 'cc-onboarding-input', attr: { rows: '3', placeholder: 'Answer in your own words…' } });
		this.input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void this.submit(); } });
		const actions = this.composer.createDiv({ cls: 'cc-onboarding-actions' });
		const skip = actions.createEl('button', { text: 'Skip optional question' });
		skip.addEventListener('click', () => void this.submit('Skip this optional question; record no invented value and continue with the information already provided.'));
		this.send = actions.createEl('button', { cls: 'mod-cta', text: 'Send' });
		this.send.addEventListener('click', () => void this.submit());
		this.status = this.composer.createDiv({ cls: 'cc-onboarding-status' });
		void this.engine.start().then(message => this.render('assistant', message)).catch(error => this.setStatus((error as Error).message, true));
	}

	onClose(): void { this.renderer.unload(); this.history = null; this.input = null; this.send = null; this.status = null; this.composer = null; this.approval = null; this.phase = null; this.contentEl.empty(); }

	private async submit(explicitText?: string): Promise<void> {
		const text = explicitText ?? this.input?.value.trim() ?? '';
		if (!text || this.busy) return;
		if (containsProtectedSetupInput(text)) {
			if (this.input) this.input.value = '';
			this.setStatus('Protected credential or endpoint-like input was blocked locally. Configure it in Settings → Command Center.', true);
			new Notice('Protected setup input was blocked and not submitted.');
			return;
		}
		if (this.input) this.input.value = '';
		await this.render('user', explicitText ? '_Optional question skipped._' : text);
		this.setBusy(true);
		this.setStatus('Processing…');
		try {
			const reply = await this.engine.answer(text);
			await this.render('assistant', reply.message);
			this.updatePhase();
			if (reply.synthesis) this.renderApproval(reply.synthesis);
			else this.setStatus(reply.redacted ? 'Credential-like content was not sent.' : '');
		} catch (error) { this.setStatus((error as Error).message, true); }
		finally { this.setBusy(false); this.input?.focus(); }
	}

	private renderApproval(synthesis: InterviewSynthesis): void {
		this.approval?.remove();
		this.composer?.addClass('is-hidden');
		this.approval = this.contentEl.createDiv({ cls: 'cc-onboarding-approval' });
		this.approval.createEl('h3', { text: 'Choose assets to create' });
		this.approval.createEl('p', { text: 'Nothing below is created until you confirm. Uncheck anything you do not want.' });
		const templateInputs = this.renderChecklist('Templates', synthesis.templates);
		const workflowInputs = this.renderChecklist('Workflows', synthesis.workflows);
		const actions = this.approval.createDiv({ cls: 'modal-button-container' });
		const back = actions.createEl('button', { text: 'Cancel selection' });
		back.addEventListener('click', () => { this.approval?.remove(); this.approval = null; this.composer?.removeClass('is-hidden'); this.setStatus('Asset creation cancelled; close or reset the interview to revise answers.'); });
		const create = actions.createEl('button', { text: 'Create selected assets', cls: 'mod-cta' });
		create.addEventListener('click', async () => {
			create.disabled = true; back.disabled = true; this.setStatus('Creating approved assets and saving configuration…');
			try {
				const result = await this.engine.completeSynthesis(selected(templateInputs), selected(workflowInputs));
				await this.options.onComplete?.(result.config);
				this.approval?.empty();
				this.approval?.createEl('h3', { text: 'Command Center initialized' });
				this.approval?.createEl('p', { text: `Created ${result.templatePaths.length} template(s) and ${result.workflowPaths.length} workflow(s).` });
				this.setStatus('Configuration and approved assets initialized.');
				new Notice('Command Center configuration and approved assets initialized.');
			} catch (error) { create.disabled = false; back.disabled = false; this.setStatus((error as Error).message, true); }
		});
	}

	private renderChecklist<T extends { id: string; name: string; description: string }>(heading: string, items: T[]): Array<{ id: string; input: HTMLInputElement }> {
		if (!this.approval) return [];
		this.approval.createEl('h4', { text: heading });
		return items.map(item => {
			const row = this.approval!.createEl('label', { cls: 'cc-onboarding-asset-option' });
			const input = row.createEl('input', { type: 'checkbox' }); input.checked = true;
			const copy = row.createDiv(); copy.createEl('strong', { text: item.name }); copy.createDiv({ text: item.description });
			return { id: item.id, input };
		});
	}
	private async render(role: 'user' | 'assistant', content: string): Promise<void> {
		if (!this.history) return;
		const row = this.history.createDiv({ cls: `cc-onboarding-message cc-onboarding-${role}` });
		await MarkdownRenderer.render(this.app, content, row.createDiv({ cls: 'cc-onboarding-bubble' }), '', this.renderer);
		this.history.scrollTop = this.history.scrollHeight;
	}
	private updatePhase(): void {
		if (!this.phase) return;
		const labels: Record<string, string> = {
			topology: 'Vault Topology Discovery', 'life-map': 'Life Mapping & Active Tracks',
			capacity: 'Metrics, Habits & Dynamic Capacity', triage: 'Inbox Triage & Eat the Frog',
			focus: 'Momentum & Focus Rules', style: 'Writing Style & Persona Alignment',
			confirmation: 'Review & Confirmation', synthesis: 'Blueprint Asset Approval',
		};
		const phase = this.engine.getPhase();
		this.phase.setText(phase === 'confirmation' || phase === 'synthesis'
			? labels[phase] ?? phase
			: `Phase ${this.engine.getPhaseNumber()} of 6 — ${labels[phase] ?? phase}`);
	}
	private setBusy(value: boolean): void { this.busy = value; if (this.send) this.send.disabled = value; if (this.input) this.input.disabled = value; }
	private setStatus(text: string, error = false): void { if (!this.status) return; this.status.setText(text); this.status.toggleClass('is-error', error); }
}

function selected(items: Array<{ id: string; input: HTMLInputElement }>): string[] { return items.filter(item => item.input.checked).map(item => item.id); }
