import { ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import type CommandCenterPlugin from '../main';
import type { ProviderId, TaskType } from '../providers/provider-types';
import { PROVIDER_REGISTRY } from '../providers/provider-registry';
import { loadWorkflowFromCanvas, loadWorkflowFromNote } from '../workflows/native-workflow-parser';
import { workflowForBase } from '../commands';
import { collectWorkflowInputs } from './workflow-modal';
import { resolveChatContext, type ChatContextAttachment, type ResolvedChatContext } from './chat-context';
import { createObsidianTools } from '../obsidian-tools';
import { DEFAULT_REACT_CONFIG } from '../react';
import type { ReActTraceEvent } from '../react/react-trace';
import type { ToolConfirmationDecision, ToolConfirmationRequest } from '../types';
import { ChatActionCard } from './chat-action-card';
import { AudioRecorder } from '../audio/audio-recorder';
import { TranscriberAdapter } from '../audio/transcriber';
import { createVaultSearchTool } from '../rag/rag-tool';

export const COMMAND_CENTER_CHAT_VIEW_TYPE = 'command-center-chat';
export const COMMAND_CENTER_CHAT_DISPLAY_TEXT = 'Command Center Chat';

type ChatMode = 'quick' | 'react' | 'workflow';
type MessageRole = 'user' | 'assistant';

interface ChatMessageElements {
	bubble: HTMLElement;
	content: HTMLElement;
	markdown: string;
	renderVersion: number;
	trace?: { details: HTMLDetailsElement; content: HTMLElement; lines: string[] };
}

/** A compact, sidebar-friendly conversational surface for Command Center. */
export class CommandCenterChatView extends ItemView {
	private readonly plugin: CommandCenterPlugin;
	private mode: ChatMode = 'quick';
	private historyEl!: HTMLElement;
	private textareaEl!: HTMLTextAreaElement;
	private modeSelectEl!: HTMLSelectElement;
	private submitEl!: HTMLButtonElement;
	private microphoneEl!: HTMLButtonElement;
	private recordingTimerEl!: HTMLElement;
	private composerNoticeEl!: HTMLElement;
	private sttStatusEl!: HTMLElement;
	private statusDotEl!: HTMLElement;
	private statusTextEl!: HTMLElement;
	private routeLabelEl!: HTMLElement;
	private contextEl!: HTMLElement;
	private contextFile: TFile | null = null;
	private detectedContext: ResolvedChatContext = { cleanedPrompt: '', contextString: '', attachments: [] };
	private dismissedAttachments = new Set<string>();
	private contextResolveGeneration = 0;
	private isOpen = false;
	private isSending = false;
	private pinnedToBottom = true;
	private detachTraceListener: (() => void) | null = null;
	private statusRefreshTimer: number | null = null;
	private recordingTimer: number | null = null;
	private recordingStartedAt = 0;
	private audioRecorder: AudioRecorder | null = null;
	private transcriptionAbort: AbortController | null = null;
	private isTranscribing = false;
	private readonly animationFrames = new Set<number>();
	private readonly actionCards = new Set<ChatActionCard>();

	constructor(leaf: WorkspaceLeaf, plugin: CommandCenterPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return COMMAND_CENTER_CHAT_VIEW_TYPE; }
	getDisplayText(): string { return COMMAND_CENTER_CHAT_DISPLAY_TEXT; }
	getIcon(): string { return 'message-square'; }

	async onOpen(): Promise<void> {
		this.isOpen = true;
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('cc-chat-view');

		const header = container.createDiv({ cls: 'cc-chat-header' });
		const heading = header.createDiv({ cls: 'cc-chat-heading' });
		const status = heading.createDiv({ cls: 'cc-chat-status' });
		this.statusDotEl = status.createSpan({ cls: 'cc-chat-status-dot' });
		this.statusTextEl = status.createSpan();
		this.routeLabelEl = heading.createDiv({ cls: 'cc-chat-route-label' });

		this.modeSelectEl = header.createEl('select', {
			cls: 'cc-chat-mode-select',
			attr: { 'aria-label': 'Chat mode' },
		});
		for (const [value, label] of [
			['quick', 'Quick'], ['react', 'ReAct Agent'], ['workflow', 'Workflow'],
		] as const) this.modeSelectEl.createEl('option', { value, text: label });

		this.historyEl = container.createDiv({
			cls: 'cc-chat-history',
			attr: { role: 'log', 'aria-live': 'polite', 'aria-label': 'Chat history' },
		});
		this.addMessage('assistant', 'How can I help with your vault?');

		const composer = container.createDiv({ cls: 'cc-chat-composer' });
		this.contextEl = composer.createDiv({ cls: 'cc-chat-context-pills' });
		this.sttStatusEl = composer.createDiv({
			cls: 'cc-chat-stt-status',
			attr: { 'aria-label': 'Active speech-to-text provider and model' },
		});
		this.recordingTimerEl = composer.createDiv({
			cls: 'cc-chat-recording-timer',
			text: '00:00',
			attr: { role: 'timer', 'aria-live': 'off', 'aria-label': 'Recording duration' },
		});
		this.composerNoticeEl = composer.createDiv({
			cls: 'cc-chat-composer-notice',
			attr: { role: 'status', 'aria-live': 'polite' },
		});
		const inputRow = composer.createDiv({ cls: 'cc-chat-input-row' });
		this.textareaEl = inputRow.createEl('textarea', {
			cls: 'cc-chat-input',
			attr: {
				placeholder: 'Message Command Center…',
				rows: '1',
				'aria-label': 'Chat message',
			},
		});
		this.microphoneEl = inputRow.createEl('button', {
			cls: 'cc-chat-microphone',
			text: '🎙️',
			attr: { type: 'button', 'aria-label': 'Start voice recording', title: 'Record voice message' },
		});
		this.submitEl = inputRow.createEl('button', {
			cls: 'cc-chat-submit mod-cta',
			attr: { type: 'button', 'aria-label': 'Send message', title: 'Send (Enter)' },
		});
		setIcon(this.submitEl, 'send');

		this.registerDomEvent(this.historyEl, 'scroll', () => {
			const distance = this.historyEl.scrollHeight - this.historyEl.scrollTop - this.historyEl.clientHeight;
			this.pinnedToBottom = distance <= 24;
		});
		this.registerDomEvent(this.modeSelectEl, 'change', () => {
			this.mode = this.modeSelectEl.value as ChatMode;
			this.updateHeader();
		});
		this.registerDomEvent(this.textareaEl, 'input', () => {
			this.resizeTextarea();
			void this.refreshDetectedContext();
		});
		this.registerDomEvent(this.textareaEl, 'keydown', (event: KeyboardEvent) => {
			if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
				event.preventDefault();
				if (this.audioRecorder?.isRecording()) void this.stopRecordingAndTranscribe();
				else void this.sendCurrentMessage();
			}
		});
		this.registerDomEvent(this.microphoneEl, 'click', () => { void this.toggleRecording(); });
		this.registerDomEvent(this.submitEl, 'click', () => { void this.sendCurrentMessage(); });

		this.contextFile = this.plugin.app.workspace.getActiveFile();
		await this.refreshDetectedContext();
		this.updateHeader();
		void this.refreshSttStatus();
		// The daemon can start or stop outside this view (settings, dashboard,
		// command palette), so keep the native header indicator current.
		this.statusRefreshTimer = window.setInterval(() => this.updateHeader(), 1_000);
		this.textareaEl.focus();
	}

	async onClose(): Promise<void> {
		this.isOpen = false;
		this.isSending = false;
		this.contextFile = null;
		this.stopRecordingTimer();
		this.transcriptionAbort?.abort();
		this.transcriptionAbort = null;
		if (this.audioRecorder) void this.audioRecorder.cancel();
		this.audioRecorder = null;
		this.isTranscribing = false;
		if (this.statusRefreshTimer !== null) {
			window.clearInterval(this.statusRefreshTimer);
			this.statusRefreshTimer = null;
		}
		this.detachTraceListener?.();
		this.detachTraceListener = null;
		for (const frame of this.animationFrames) window.cancelAnimationFrame(frame);
		this.animationFrames.clear();
		this.plugin.daemon.setToolConfirmationHandler(null);
		for (const card of this.actionCards) card.dispose();
		this.actionCards.clear();
		this.contextResolveGeneration++;
		this.detectedContext = { cleanedPrompt: '', contextString: '', attachments: [] };
		this.dismissedAttachments.clear();
		if (this.plugin.commandCenterChatView === this) this.plugin.commandCenterChatView = null;
		// DOM listeners were registered through ItemView.registerDomEvent and are
		// released with the view component; clearing the subtree drops references.
		this.containerEl.children[1]?.empty();
	}

	private updateHeader(): void {
		if (!this.isOpen) return;
		const daemonError = Boolean(this.plugin.daemon.startError);
		const daemonRunning = this.plugin.daemon.isRunning() && !daemonError;
		this.statusDotEl.toggleClass('busy', this.isSending);
		this.statusDotEl.toggleClass('ready', !this.isSending && daemonRunning);
		this.statusDotEl.toggleClass('offline', !this.isSending && !daemonRunning);
		this.statusTextEl.setText(this.isSending
			? 'Working'
			: daemonRunning ? 'Daemon online' : daemonError ? 'Daemon error' : 'Daemon offline');
		this.statusDotEl.setAttribute('aria-label', this.statusTextEl.textContent ?? 'Daemon status');

		if (this.mode === 'workflow') {
			this.routeLabelEl.setText('Native workflow engine');
			return;
		}
		const taskType: TaskType = this.mode === 'react' ? 'reasoning' : 'fast';
		const route = this.plugin.settings.multiProvider.routing[taskType];
		const provider = PROVIDER_REGISTRY[route.providerId]?.label ?? route.providerId;
		this.routeLabelEl.setText(`${provider} · ${route.modelId}`);
	}

	private attachmentKey(attachment: ChatContextAttachment): string {
		return `${attachment.type}:${attachment.path ?? attachment.name}`;
	}

	private async refreshDetectedContext(): Promise<void> {
		const generation = ++this.contextResolveGeneration;
		const resolved = await resolveChatContext(this.plugin.app, this.textareaEl?.value ?? '', { suggestRecent: true });
		if (!this.isOpen || generation !== this.contextResolveGeneration) return;
		this.detectedContext = resolved;
		// A mention typed again after being removed should become attachable again.
		const currentKeys = new Set(resolved.attachments.map(attachment => this.attachmentKey(attachment)));
		for (const key of this.dismissedAttachments) if (!currentKeys.has(key)) this.dismissedAttachments.delete(key);
		this.renderContextPills();
	}

	private renderContextPills(): void {
		this.contextEl.empty();
		for (const attachment of this.detectedContext.attachments) {
			const key = this.attachmentKey(attachment);
			if (this.dismissedAttachments.has(key)) continue;
			this.createContextPill(attachment, () => {
				this.dismissedAttachments.add(key);
				this.renderContextPills();
			});
		}
		this.contextEl.toggleClass('is-empty', this.contextEl.childElementCount === 0);
	}

	private createContextPill(attachment: ChatContextAttachment, dismiss: () => void): void {
		const { name, type } = attachment;
		const pill = this.contextEl.createDiv({ cls: `cc-chat-context-pill${attachment.suggested ? ' is-suggested' : ''}` });
		if (attachment.suggested) pill.setAttribute('title', `Suggested context: ${attachment.path ?? name}`);
		const icon = pill.createSpan();
		setIcon(icon, type === 'selection' ? 'text-select' : type === 'base' ? 'database' : 'file-text');
		pill.createSpan({ text: name, cls: 'cc-chat-context-name' });
		const remove = pill.createEl('button', {
			cls: 'cc-chat-context-remove',
			attr: { type: 'button', 'aria-label': `Remove ${name} context` },
		});
		setIcon(remove, 'x');
		this.registerDomEvent(remove, 'click', dismiss);
	}

	private activeResolvedContext(resolved: ResolvedChatContext): ResolvedChatContext {
		const sections = resolved.contextString
			? resolved.contextString.replace(/^# Attached context\n\n/, '').split('\n\n---\n\n')
			: [];
		const keptAttachments: ChatContextAttachment[] = [];
		const keptSections: string[] = [];
		resolved.attachments.forEach((attachment, index) => {
			if (this.dismissedAttachments.has(this.attachmentKey(attachment))) return;
			keptAttachments.push(attachment);
			if (sections[index]) keptSections.push(sections[index]!);
		});
		return {
			cleanedPrompt: resolved.cleanedPrompt,
			attachments: keptAttachments,
			contextString: keptSections.length ? `# Attached context\n\n${keptSections.join('\n\n---\n\n')}` : '',
		};
	}

	private resizeTextarea(): void {
		this.textareaEl.style.height = 'auto';
		this.textareaEl.style.height = `${Math.min(this.textareaEl.scrollHeight, 160)}px`;
	}

	private async toggleRecording(): Promise<void> {
		if (this.isSending || this.isTranscribing) return;
		if (this.audioRecorder?.isRecording()) {
			await this.stopRecordingAndTranscribe();
			return;
		}
		this.hideComposerNotice();
		const recorder = new AudioRecorder({ mimeType: 'audio/webm' });
		this.audioRecorder = recorder;
		try {
			await recorder.start();
			if (!this.isOpen || this.audioRecorder !== recorder) {
				await recorder.cancel();
				return;
			}
			this.recordingStartedAt = Date.now();
			this.updateRecordingTimer();
			this.recordingTimer = window.setInterval(() => this.updateRecordingTimer(), 1_000);
			this.microphoneEl.addClass('cc-mic-recording');
			this.microphoneEl.setAttribute('aria-label', 'Stop voice recording');
			this.microphoneEl.setAttribute('aria-pressed', 'true');
			this.microphoneEl.setAttribute('title', 'Stop and transcribe');
			this.recordingTimerEl.addClass('is-visible');
		} catch (error) {
			this.audioRecorder = null;
			this.showComposerNotice(`Microphone unavailable: ${(error as Error).message}`, true);
		}
	}

	private async stopRecordingAndTranscribe(): Promise<void> {
		const recorder = this.audioRecorder;
		if (!recorder || recorder.getState() !== 'recording' || this.isTranscribing) return;
		this.isTranscribing = true;
		this.stopRecordingTimer();
		this.microphoneEl.removeClass('cc-mic-recording');
		this.microphoneEl.addClass('is-transcribing');
		this.microphoneEl.disabled = true;
		this.microphoneEl.setAttribute('aria-label', 'Transcribing voice recording');
		this.microphoneEl.setAttribute('aria-pressed', 'false');
		this.microphoneEl.setAttribute('title', 'Transcribing...');
		this.recordingTimerEl.removeClass('is-visible');
		this.showComposerNotice('Transcribing...');
		const controller = new AbortController();
		this.transcriptionAbort = controller;
		try {
			const audio = await recorder.stop();
			const text = await this.transcribeWithFallback(audio, controller.signal);
			if (!this.isOpen || this.audioRecorder !== recorder) return;
			if (text) {
				const existing = this.textareaEl.value;
				this.textareaEl.value = existing && !/\s$/.test(existing) ? `${existing} ${text}` : `${existing}${text}`;
				this.resizeTextarea();
				await this.refreshDetectedContext();
				this.textareaEl.focus();
				this.textareaEl.setSelectionRange(this.textareaEl.value.length, this.textareaEl.value.length);
			}
			this.hideComposerNotice();
		} catch (error) {
			if (this.isOpen) this.showComposerNotice(`Transcription failed: ${(error as Error).message}`, true);
		} finally {
			if (this.transcriptionAbort === controller) this.transcriptionAbort = null;
			if (this.audioRecorder === recorder) this.audioRecorder = null;
			this.isTranscribing = false;
			if (this.isOpen) this.resetMicrophoneUi();
		}
	}

	private getTranscriptionCandidates(): Array<{ providerId: ProviderId; model?: string; label: string; local: boolean }> {
		const settings = this.plugin.settings.multiProvider;
		const configured = (settings.defaults as Record<string, unknown>).transcriptionModel;
		const configuredModel = typeof configured === 'string' && configured.trim() ? configured.trim() : undefined;
		// Prefer local inference, then fall through to hosted OpenAI-compatible STT.
		const order: ProviderId[] = ['lmstudio', 'ollama', 'groq', 'openai', 'deepinfra', 'openrouter', 'custom'];
		return order.flatMap(providerId => {
			const credentials = settings.credentials[providerId];
			const meta = PROVIDER_REGISTRY[providerId];
			if (!credentials?.enabled || (!credentials.baseUrl && !meta.defaultBaseUrl) || (meta.requiresKey && !credentials.apiKey)) return [];
			const local = providerId === 'lmstudio' || providerId === 'ollama';
			const persisted = settings.liveModels?.[providerId]?.find(model => /(whisper|speech[-_ ]?to[-_ ]?text|transcri|\bstt\b)/i.test(model.id));
			const model = persisted?.id ?? configuredModel ?? (providerId === 'groq' ? 'whisper-large-v3' : local ? undefined : 'whisper-large-v3-turbo');
			const providerLabel = providerId === 'lmstudio' ? 'Local LM Studio' : providerId === 'ollama' ? 'Local Ollama' : meta.label;
			return [{ providerId, model, label: `${providerLabel} (${model ?? 'automatic Whisper'})`, local }];
		});
	}

	private async refreshSttStatus(): Promise<void> {
		const candidate = this.getTranscriptionCandidates()[0];
		this.sttStatusEl.setText(candidate ? `STT: ${candidate.label}` : 'STT: not configured');
		this.sttStatusEl.toggleClass('is-unavailable', !candidate);
		if (!candidate?.local) return;
		try {
			const models = await new TranscriberAdapter({
				providerId: candidate.providerId,
				getSettings: () => this.plugin.settings,
			}).fetchLiveAudioModels();
			if (!this.isOpen || models.length === 0) return;
			this.sttStatusEl.setText(`STT: ${candidate.providerId === 'lmstudio' ? 'Local LM Studio' : 'Local Ollama'} (${models[0]})`);
		} catch {
			// Keep the configured label; actual transcription performs provider fallback.
		}
	}

	private async transcribeWithFallback(audio: Blob, signal: AbortSignal): Promise<string> {
		const candidates = this.getTranscriptionCandidates();
		if (!candidates.length) throw new Error('Enable an OpenAI-compatible provider (such as LM Studio, Groq, or OpenAI) for transcription.');
		const errors: string[] = [];
		for (let index = 0; index < candidates.length; index++) {
			if (signal.aborted) throw new Error('Transcription cancelled.');
			const candidate = candidates[index]!;
			this.sttStatusEl.setText(`STT: ${candidate.label}${index ? ' · fallback' : ''}`);
			try {
				const transcriber = new TranscriberAdapter({
					providerId: candidate.providerId,
					getSettings: () => this.plugin.settings,
					defaultModel: candidate.model,
					maxAttempts: candidate.local ? 1 : 2,
					signal,
				});
				if (candidate.local) {
					try { await this.withTimeout(transcriber.fetchLiveAudioModels(), 5_000, `${candidate.label} model discovery timed out`); }
					catch { /* The transcription endpoint may still support an implicit model. */ }
				}
				const text = await this.withTimeout(
					transcriber.transcribe(audio, candidate.model),
					candidate.local ? 15_000 : 60_000,
					`${candidate.label} timed out`,
				);
				this.sttStatusEl.setText(`STT: ${candidate.label}`);
				return text.trim();
			} catch (error) {
				errors.push(`${candidate.label}: ${(error as Error).message}`);
			}
		}
		throw new Error(`All transcription providers failed. ${errors.join(' | ')}`);
	}

	private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
			promise.then(
				value => { window.clearTimeout(timer); resolve(value); },
				error => { window.clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
			);
		});
	}

	private updateRecordingTimer(): void {
		const seconds = Math.max(0, Math.floor((Date.now() - this.recordingStartedAt) / 1_000));
		const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
		this.recordingTimerEl.setText(`${minutes}:${(seconds % 60).toString().padStart(2, '0')}`);
	}

	private stopRecordingTimer(): void {
		if (this.recordingTimer !== null) window.clearInterval(this.recordingTimer);
		this.recordingTimer = null;
	}

	private resetMicrophoneUi(): void {
		this.microphoneEl.removeClass('cc-mic-recording', 'is-transcribing');
		this.microphoneEl.disabled = this.isSending;
		this.microphoneEl.setAttribute('aria-label', 'Start voice recording');
		this.microphoneEl.setAttribute('aria-pressed', 'false');
		this.microphoneEl.setAttribute('title', 'Record voice message');
		this.recordingTimerEl.removeClass('is-visible');
		this.recordingTimerEl.setText('00:00');
	}

	private showComposerNotice(message: string, isError = false): void {
		this.composerNoticeEl.setText(message);
		this.composerNoticeEl.toggleClass('is-error', isError);
		this.composerNoticeEl.addClass('is-visible');
	}

	private hideComposerNotice(): void {
		this.composerNoticeEl.removeClass('is-visible', 'is-error');
		this.composerNoticeEl.setText('');
	}

	private addMessage(role: MessageRole, text = ''): ChatMessageElements {
		const row = this.historyEl.createDiv({ cls: `cc-chat-message cc-chat-message-${role}` });
		const bubble = row.createDiv({ cls: 'cc-chat-bubble' });
		const content = bubble.createDiv({ cls: 'cc-chat-message-content' });
		bubble.createDiv({
			cls: 'cc-chat-message-time',
			text: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date()),
			attr: { title: new Date().toLocaleString() },
		});
		const message = { bubble, content, markdown: text, renderVersion: 0 };
		void this.renderMessage(message);
		this.pinnedToBottom = true;
		this.scrollToBottom(true);
		return message;
	}

	private async renderMessage(message: ChatMessageElements): Promise<void> {
		const version = ++message.renderVersion;
		const staging = document.createElement('div');
		await MarkdownRenderer.render(this.plugin.app, message.markdown, staging, this.contextFile?.path ?? '', this);
		if (!this.isOpen || version !== message.renderVersion) return;
		message.content.replaceChildren(...Array.from(staging.childNodes));
		this.scrollToBottom();
	}

	private setMessage(message: ChatMessageElements, markdown: string): void {
		message.markdown = markdown;
		void this.renderMessage(message);
	}

	private appendMessage(message: ChatMessageElements, delta: string): void {
		message.markdown += delta;
		void this.renderMessage(message);
	}

	private scrollToBottom(force = false): void {
		if (!force && !this.pinnedToBottom) return;
		const frame = window.requestAnimationFrame(() => {
			this.animationFrames.delete(frame);
			if (!this.isOpen || (!force && !this.pinnedToBottom)) return;
			this.historyEl.scrollTop = this.historyEl.scrollHeight;
			this.pinnedToBottom = true;
		});
		this.animationFrames.add(frame);
	}

	private ensureTraceBlock(message: ChatMessageElements): NonNullable<ChatMessageElements['trace']> {
		if (message.trace) return message.trace;
		const details = message.bubble.createEl('details', { cls: 'cc-chat-react-trace' });
		details.createEl('summary', { text: '[⚡ ReAct Trace]' });
		const content = details.createDiv({ cls: 'cc-chat-react-trace-content' });
		message.trace = { details, content, lines: [] };
		return message.trace;
	}

	private appendTrace(message: ChatMessageElements, event: ReActTraceEvent): void {
		const trace = this.ensureTraceBlock(message);
		const cycle = event.cycleIndex >= 0 ? `C${event.cycleIndex + 1} ` : '';
		trace.lines.push(`${cycle}${event.agent} · ${event.label}${event.content ? ` — ${event.content}` : ''}`);
		if (trace.lines.length > 80) trace.lines.splice(0, trace.lines.length - 80);
		trace.content.setText(trace.lines.join('\n'));
		this.scrollToBottom();
	}

	/** Insert and immediately dispatch a prompt supplied by a global UI surface. */
	async submitExternalPrompt(prompt: string, mode: ChatMode = this.mode): Promise<void> {
		if (!this.isOpen) throw new Error('The chat panel is not open.');
		if (this.isSending) throw new Error('The chat panel is already processing a message.');
		this.mode = mode;
		this.modeSelectEl.value = mode;
		this.updateHeader();
		this.textareaEl.value = prompt;
		this.resizeTextarea();
		await this.refreshDetectedContext();
		await this.sendCurrentMessage();
	}

	private async sendCurrentMessage(): Promise<void> {
		const input = this.textareaEl.value.trim();
		if (!input || this.isSending) return;
		const resolved = this.activeResolvedContext(await resolveChatContext(this.plugin.app, input, { suggestRecent: true }));
		const prompt = resolved.cleanedPrompt || input;
		const enrichedPrompt = resolved.contextString ? `${prompt}\n\n${resolved.contextString}` : prompt;
		this.textareaEl.value = '';
		this.detectedContext = { cleanedPrompt: '', contextString: '', attachments: [] };
		this.dismissedAttachments.clear();
		this.resizeTextarea();
		this.renderContextPills();
		this.addMessage('user', input);
		const assistant = this.addMessage('assistant', '');
		assistant.bubble.addClass('is-pending');
		this.setSending(true);

		try {
			if (this.mode === 'workflow') await this.runWorkflow(enrichedPrompt, assistant);
			else await this.runTask(enrichedPrompt, assistant);
		} catch (error) {
			if (this.isOpen) this.setMessage(assistant, `**Error:** ${(error as Error).message}`);
			new Notice(`Command Center chat failed: ${(error as Error).message}`);
		} finally {
			assistant.bubble.removeClass('is-pending');
			this.setSending(false);
			this.scrollToBottom();
		}
	}

	private async runTask(prompt: string, assistant: ChatMessageElements): Promise<void> {
		this.plugin.requireInitialized();
		if (this.mode === 'react') {
			await this.runReActTask(prompt, assistant);
			return;
		}
		let streamed = '';
		const result = await this.plugin.conversations.executeProviderTurn(
			this.plugin.dispatcher,
			prompt,
			'fast',
			delta => {
				streamed += delta;
				if (this.isOpen) this.appendMessage(assistant, delta);
			},
		);
		if (!streamed) this.setMessage(assistant, result.output || result.summary || 'Task completed.');
	}

	private requestToolConfirmation(request: ToolConfirmationRequest): Promise<ToolConfirmationDecision> {
		if (!this.isOpen) return Promise.resolve('rejected');
		const row = this.historyEl.createDiv({ cls: 'cc-chat-message cc-chat-message-action' });
		const card = new ChatActionCard(row, {
			...request,
			timeoutMs: request.timeoutMs ?? 60_000,
		});
		this.actionCards.add(card);
		this.scrollToBottom();
		return card.wait().finally(() => {
			this.actionCards.delete(card);
			this.scrollToBottom();
		});
	}

	private async runReActTask(prompt: string, assistant: ChatMessageElements): Promise<void> {
		const ready = await this.plugin.ensureDaemonRunning();
		if (!ready) throw new Error(this.plugin.daemon.startError ?? 'Pi daemon is unavailable.');
		this.ensureTraceBlock(assistant);
		this.detachTraceListener?.();
		let traceSessionId: string | null = null;
		this.detachTraceListener = this.plugin.daemon.addTraceListener(event => {
			// executeReActSession emits session:start synchronously before its first
			// await. Bind this bubble to that session and ignore unrelated traces.
			if (traceSessionId === null && event.type === 'session:start') traceSessionId = event.sessionId;
			if (this.isOpen && event.sessionId === traceSessionId) this.appendTrace(assistant, event);
		});
		let answer = '';
		let finalReceived = false;
		this.plugin.daemon.setToolConfirmationHandler(request => this.requestToolConfirmation(request));
		try {
			const response = await this.plugin.router.withJitModel('reasoning', () =>
				this.plugin.daemon.executeReActSession(
					prompt,
					this.contextFile?.path,
					[...createObsidianTools(this.plugin.app), createVaultSearchTool(this.plugin.hybridRetriever)],
					DEFAULT_REACT_CONFIG,
					event => {
						if (!this.isOpen) return;
						if (event.type === 'thought' || event.type === 'action_complete') {
							// Pi emits model token deltas through these event types.
							answer += event.data;
							this.appendMessage(assistant, event.data);
						} else if (event.type === 'final_answer') {
							finalReceived = true;
							answer = event.data;
							this.setMessage(assistant, event.data);
						}
					},
				),
			);
			if (response.error) throw new Error(response.error);
			const final = response.result?.output || response.result?.summary;
			// Raw thought/action deltas provide immediate feedback while Pi works,
			// but the completed response must replace that transient model output.
			if (final && !finalReceived) this.setMessage(assistant, final);
			else if (!final && !answer.trim()) this.setMessage(assistant, 'ReAct session completed.');
		} finally {
			this.detachTraceListener?.();
			this.detachTraceListener = null;
			this.plugin.daemon.setToolConfirmationHandler(null);
		}
	}

	private async runWorkflow(prompt: string, assistant: ChatMessageElements): Promise<void> {
		this.plugin.requireInitialized();
		const file = this.contextFile ?? this.plugin.app.workspace.getActiveFile();
		if (!file || (file.extension !== 'md' && file.extension !== 'canvas' && file.extension !== 'base')) {
			throw new Error('Attach or open a Markdown, Canvas, or Base workflow first.');
		}
		const workflow = file.extension === 'base'
			? await workflowForBase(file, this.plugin)
			: file.extension === 'canvas'
				? await loadWorkflowFromCanvas(file, this.plugin.app)
				: loadWorkflowFromNote(file, this.plugin.app);
		if (workflow.steps.length === 0) throw new Error('The active workflow has no executable steps.');

		const inputs = Object.keys(workflow.inputs).length > 0
			? await collectWorkflowInputs(this.plugin.app, workflow)
			: {};
		if (inputs === null) throw new Error('Workflow input was cancelled.');
		const promptKey = ['prompt', 'message', 'query', 'task'].find(key => key in workflow.inputs);
		if (promptKey) inputs[promptKey] = prompt;
		else inputs.chatPrompt = prompt;

		this.setMessage(assistant, `*Running ${workflow.name}…*`);
		let streamed = '';
		const onStream = (delta: string) => {
			const firstDelta = streamed.length === 0;
			streamed += delta;
			if (!this.isOpen) return;
			// Replace the temporary running label before rendering model output.
			if (firstDelta) this.setMessage(assistant, delta);
			else this.appendMessage(assistant, delta);
		};
		const context = file.extension === 'base'
			? (await this.plugin.workflowEngine.executeOnTargets(workflow, inputs, file, this.plugin.app, { onStream }))[0]?.context
			: await this.plugin.workflowEngine.execute(workflow, inputs, { onStream });
		if (!context) throw new Error(`Workflow ${workflow.name} did not process any targets.`);
		if (!streamed && this.isOpen) {
			const outputs = Object.values(context.stepResults).filter((value): value is string => typeof value === 'string');
			this.setMessage(assistant, outputs.at(-1) ?? `Workflow **${workflow.name}** completed.`);
		}
	}

	private setSending(sending: boolean): void {
		this.isSending = sending;
		if (!this.isOpen) return;
		this.submitEl.disabled = sending;
		this.microphoneEl.disabled = sending || this.isTranscribing;
		this.textareaEl.disabled = sending;
		this.updateHeader();
		if (!sending) this.textareaEl.focus();
	}
}
