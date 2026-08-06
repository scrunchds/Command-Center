import { App, Component, MarkdownRenderer, Notice, TFile } from 'obsidian';
import type CommandCenterPlugin from '../main';
import type { OnboardingConfig } from '../onboarding/OnboardingTypes';
import type { ApiConnectorConfig } from '../connectors/ApiConnectorManager';
import {
	containsProtectedSetupInput,
	type InterviewEngine,
	type InterviewSynthesis,
} from '../onboarding/InterviewEngine';

export interface DashboardOnboardingOptions {
	onComplete?: (config: OnboardingConfig) => void | Promise<void>;
	onConnectorApproved?: (connector: ApiConnectorConfig) => void | Promise<void>;
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
		const back = actions.createEl('button', { text: '← back', attr: { 'aria-label': 'Go back to the previous question', title: 'Go back to the previous question' } });
		this.renderer.registerDomEvent(back, 'click', () => void this.goBack());
		const skip = actions.createEl('button', { text: 'Skip optional question' });
		this.renderer.registerDomEvent(skip, 'click', () => void this.submit('Skip this optional question; record no invented value and continue.'));
		const skipPhase = actions.createEl('button', { text: 'Skip this topic', attr: { 'aria-label': 'Skip this entire topic', title: 'Skip this entire topic' } });
		this.renderer.registerDomEvent(skipPhase, 'click', () => void this.skipCurrentPhase());
		const dictate = actions.createEl('button', { text: '🎙 Dictate', attr: { 'aria-label': 'Start dictation' } });
		this.renderer.registerDomEvent(dictate, 'click', () => void this.toggleDictation(dictate));
		this.send = actions.createEl('button', { text: 'Send', cls: 'mod-cta' });
		this.renderer.registerDomEvent(this.send, 'click', () => void this.submit());
		this.status = this.composer.createDiv({ cls: 'cc-onboarding-status' });
		try {
			// Resume an in-progress interview if one was persisted, instead of
			// always starting fresh. This makes onboarding persistent across
			// dashboard close/reopen and Obsidian restarts.
			const resumed = await this.restoreProgress();
			if (!resumed) {
				await this.render('assistant', await this.engine.start());
			}
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
			button.setText('■ stop dictation');
			this.setStatus('Listening…');
		} catch (error) { this.setStatus((error as Error).message, true); }
	}

	private async submit(explicitText?: string): Promise<void> {
		const text = explicitText ?? this.input.value.trim();
		if (!text || this.busy) return;
		if (containsProtectedSetupInput(text)) {
			this.input.value = '';
			this.setStatus('Credential-like setup input was blocked locally. Links, paths, hosts, ports, and endpoint values are allowed; use Settings for credentials.', true);
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
			if (reply.workflowApproval) this.renderWorkflowApproval(reply.workflowApproval.workflows);
			if (reply.connectorApproval) this.renderConnectorApproval(reply.connectorApproval.connector);
			if (reply.complete) {
				if (reply.config) await this.options.onComplete?.(reply.config);
				this.clearPersistedProgress();
				this.options.onClose?.();
				new Notice('Command center onboarding complete.');
			}
			else this.setStatus(reply.redacted ? 'Credential-like content was not sent.' : '');
		} catch (error) {
			this.setStatus((error as Error).message, true);
		} finally {
			this.persistProgress();
			this.setBusy(false);
			this.input.focus();
		}
	}

	private async goBack(): Promise<void> {
		if (this.busy) return;
		try {
			this.engine.rewind();
			this.persistProgress();
			// Re-render the last assistant message state by showing the previous
			// question text.
			this.setStatus('You can now correct or extend your previous answer.');
			this.input.focus();
			this.updatePhase();
			// Keep the turn history visible; just clear the input for a fresh answer.
			this.input.placeholder = 'Revise your previous answer…';
			new Notice('Returned to the previous question.');
		} catch (error) {
			this.setStatus((error as Error).message, true);
		}
	}

	private async skipCurrentPhase(): Promise<void> {
		if (this.busy) return;
		this.engine.skipPhase();
		this.persistProgress();
		this.updatePhase();
		await this.submit('Skip this topic entirely; record no invented values for this section and continue.');
	}

	/** Persist interview progress so closing the dashboard does not lose it. */
	private persistProgress(): void {
		// Persist to a vault note under .command-center/ so the interview
		// survives dashboard close without using vault.adapter directly.
		const path = '.command-center/interview-progress.json';
		const content = this.engine.serialize();
		const existing = this.plugin.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			void this.plugin.app.vault.process(existing, () => content).catch(() => undefined);
		} else {
			void this.plugin.app.vault.create(path, content).catch(() => undefined);
		}
	}

	/** Restore a previously persisted interview session. Returns true if state was restored. */
	private async restoreProgress(): Promise<boolean> {
		try {
			const file = this.plugin.app.vault.getAbstractFileByPath('.command-center/interview-progress.json');
			if (!(file instanceof TFile)) return false;
			const data = await this.plugin.app.vault.read(file);
			if (!data) return false;
			this.engine.deserialize(data);
			const turns = this.engine.getTurns();
			if (!turns.length) return false;
			// Replay persisted turns into the visible history.
			for (const turn of turns) {
				if (turn.role === 'user' || turn.role === 'assistant') {
					await this.render(turn.role, turn.content);
				}
			}
			this.updatePhase();
			// Re-surface any pending approval gate that was interrupted.
			const synthesis = this.engine.getPendingSynthesis();
			if (synthesis) this.renderApproval(synthesis);
			const connector = this.engine.getPendingConnector();
			if (connector) this.renderConnectorApproval(connector);
			this.setStatus('Resumed your previous interview. Continue where you left off.');
			return true;
		} catch {
			return false;
		}
	}

	/** Delete the persisted progress file once onboarding completes. */
	private clearPersistedProgress(): void {
		const path = '.command-center/interview-progress.json';
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			void this.plugin.app.fileManager.trashFile(file).catch(() => undefined);
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
				this.clearPersistedProgress();
				// Setup is complete: leave the onboarding surface immediately so the
				// dashboard cannot continue to suggest that setup is pending.
				this.options.onClose?.();
				new Notice(`Command center initialized. Created ${result.templatePaths.length} template(s) and ${result.workflowPaths.length} workflow(s).`);
			} catch (error) {
				create.disabled = revise.disabled = false;
				this.setStatus((error as Error).message, true);
			}
		})());
	}

	private renderConnectorApproval(connector: ApiConnectorConfig): void {
		this.approval?.remove();
		this.approval = this.host.createDiv({ cls: 'cc-onboarding-approval' });
		this.approval.createEl('h3', { text: `Review ${connector.label} connector` });
		this.approval.createEl('p', { text: `Base URL: ${connector.baseUrl}. Credentials are configured separately in Settings and are not stored in chat.` });
		for (const endpoint of connector.endpoints) {
			this.approval.createDiv({ text: `${endpoint.method} ${endpoint.path} — ${endpoint.description}`, cls: 'cc-onboarding-asset-option' });
		}
		const approve = this.approval.createEl('button', { text: 'Approve connector', cls: 'mod-cta' });
		this.renderer.registerDomEvent(approve, 'click', () => void (async () => {
			approve.disabled = true;
			try {
				await this.options.onConnectorApproved?.({ ...connector, enabled: true });
				this.engine.approvePendingConnector();
				this.approval?.remove();
				this.approval = null;
				this.setStatus('Connector approved and registered. Configure its credential reference in Settings if required.');
				new Notice('Connector registered.');
			} catch (error) { approve.disabled = false; this.setStatus((error as Error).message, true); }
		})());
	}

	/** Show an explicit approval gate for orchestrator-proposed workflows. */
	private renderWorkflowApproval(workflows: InterviewSynthesis['workflows']): void {
		this.approval?.remove();
		this.composer.removeClass('is-hidden');
		this.approval = this.host.createDiv({ cls: 'cc-onboarding-approval' });
		this.approval.createEl('h3', { text: 'Review proposed workflows' });
		this.approval.createEl('p', { text: 'These workflows map to the templates just created. Nothing is written until you explicitly approve them.' });
		for (const workflow of workflows) {
			const row = this.approval.createDiv({ cls: 'cc-onboarding-asset-option' });
			row.createEl('strong', { text: workflow.name });
			row.createDiv({ text: workflow.description });
		}
		const approve = this.approval.createEl('button', { text: 'Approve and create workflows', cls: 'mod-cta' });
		this.renderer.registerDomEvent(approve, 'click', () => void (async () => {
			approve.disabled = true;
			this.setBusy(true);
			this.setStatus('Creating approved workflows…');
			try {
				const result = await this.engine.approvePendingWorkflows();
				await this.options.onComplete?.(result.config);
				this.clearPersistedProgress();
				this.options.onClose?.();
				new Notice(`Command center initialized. Created ${result.workflowPaths.length} workflow(s).`);
			} catch (error) {
				approve.disabled = false;
				this.setStatus((error as Error).message, true);
			} finally {
				this.persistProgress();
				this.setBusy(false);
			}
		})());
	}

	/** Show a compact "what next" guide after the interview completes. */
	private renderNextSteps(): void {
		if (!this.approval) return;
		const steps = this.approval.createDiv({ cls: 'cc-onboarding-next-steps' });
		steps.createEl('h4', { text: 'Next steps' });
		const list = steps.createEl('ol');
		list.createEl('li', { text: 'Configure providers: Settings → command center → providers.' });
		list.createEl('li', { text: 'Add API keys via the "set API key" button on each provider card.' });
		list.createEl('li', { text: 'Open the chat panel (command center: Open chat panel) to start working.' });
		list.createEl('li', { text: 'Run your first morning cycle from the dashboard when ready.' });
		steps.createDiv({ cls: 'cc-onboarding-next-steps-hint', text: 'You can also use local-only mode (LM Studio / Ollama) with no API keys — see Settings → Command Center → Quick start.' });
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
