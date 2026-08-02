import { ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import type CommandCenterPlugin from '../main';
import type { TaskType } from '../providers/provider-types';
import { PROVIDER_REGISTRY } from '../providers/provider-registry';
import { loadWorkflowFromCanvas, loadWorkflowFromNote } from '../workflows/native-workflow-parser';
import { workflowForBase } from '../commands';
import { collectWorkflowInputs } from './workflow-modal';
import { resolveChatContext, type ChatContextAttachment, type ResolvedChatContext } from './chat-context';
import { createObsidianTools } from '../obsidian-tools';
import { DEFAULT_REACT_CONFIG } from '../react';
import type { ReActTraceEvent } from '../react/react-trace';
import { AudioRecorder } from '../audio/audio-recorder';
import { buildTranscriptionCandidates, TranscriberAdapter, sanitizeTranscript, MIN_TRANSCRIPTION_DURATION_MS, type TranscriptionCandidate } from '../audio/transcriber';
import { LiveTranscriber } from '../audio/live-transcriber';
import { processTranscriptionOutput, insertIntoActiveEditor } from '../audio/transcription-integrations';
import { createVaultSearchTool } from '../rag/rag-tool';

export const COMMAND_CENTER_CHAT_VIEW_TYPE = 'command-center-chat';
export const COMMAND_CENTER_CHAT_DISPLAY_TEXT = 'Command Center Chat';

type ChatMode = 'quick' | 'react' | 'workflow';
type MessageRole = 'user' | 'assistant';

interface ChatMessageElements {
	role: MessageRole;
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
	private voiceTargetEl!: HTMLSelectElement;
	private voiceOutputTarget: 'chat' | 'note' | 'canvas' | 'note+audio' | 'canvas+audio' | 'all' = 'chat';
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
	private isLiveMode = false;
	private liveTranscriber: LiveTranscriber | null = null;
	private readonly animationFrames = new Set<number>();

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
		this.voiceTargetEl = composer.createEl('select', {
			cls: 'cc-voice-target',
			attr: { 'aria-label': 'Voice output target', title: 'Where voice transcription goes' },
		});
		for (const [value, label] of [
			['chat', 'Chat'],
			['note', 'Note'],
			['canvas', 'Canvas'],
			['note+audio', 'Note + Audio'],
			['canvas+audio', 'Canvas + Audio'],
			['all', 'All'],
		] as const) {
			this.voiceTargetEl.createEl('option', { value, text: label });
		}
		this.registerDomEvent(this.voiceTargetEl, 'change', () => {
			this.voiceOutputTarget = this.voiceTargetEl.value as typeof this.voiceOutputTarget;
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
				placeholder: 'Message command center…',
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
			attr: { type: 'button', 'aria-label': 'Send message', title: 'Send (enter)' },
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
		this.registerDomEvent(this.microphoneEl, 'click', (event) => { void this.toggleRecording(event); });
		this.registerDomEvent(this.submitEl, 'click', () => { void this.sendCurrentMessage(); });

		this.contextFile = this.plugin.app.workspace.getActiveFile();
		await this.refreshDetectedContext();
		this.updateHeader();
		void this.refreshSttStatus();
		// The daemon can start or stop outside this view (settings, dashboard,
		// command palette), so keep the native header indicator current.
		this.statusRefreshTimer = this.registerInterval(window.setInterval(() => this.updateHeader(), 1_000));
		this.textareaEl.focus();
	}

	async onClose(): Promise<void> {
		this.isOpen = false;
		this.isSending = false;
		this.contextFile = null;
		this.stopRecordingTimer();
		this.transcriptionAbort?.abort();
		this.transcriptionAbort = null;
		if (this.liveTranscriber) {
			void this.liveTranscriber.cancel();
			this.liveTranscriber = null;
		}
		if (this.audioRecorder) void this.audioRecorder.cancel();
		this.audioRecorder = null;
		this.isTranscribing = false;
		this.isLiveMode = false;
		if (this.statusRefreshTimer !== null) {
			window.clearInterval(this.statusRefreshTimer);
			this.statusRefreshTimer = null;
		}
		this.detachTraceListener?.();
		this.detachTraceListener = null;
		for (const frame of this.animationFrames) window.cancelAnimationFrame(frame);
		this.animationFrames.clear();
		this.plugin.daemon.setToolConfirmationHandler(null);
		this.contextResolveGeneration++;
		this.detectedContext = { cleanedPrompt: '', contextString: '', attachments: [] };
		this.dismissedAttachments.clear();
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
			if (sections[index]) keptSections.push(sections[index]);
		});
		return {
			cleanedPrompt: resolved.cleanedPrompt,
			attachments: keptAttachments,
			contextString: keptSections.length ? `# Attached context\n\n${keptSections.join('\n\n---\n\n')}` : '',
		};
	}

	private resizeTextarea(): void {
		this.textareaEl.setCssStyles({ height: 'auto', overflowY: 'hidden' });
		this.textareaEl.setCssStyles({ height: `${Math.min(this.textareaEl.scrollHeight, 160)}px`, overflowY: this.textareaEl.scrollHeight > 160 ? 'auto' : 'hidden' });
	}

	private async toggleRecording(event?: MouseEvent): Promise<void> {
		if (this.isSending || this.isTranscribing || !this.plugin.settings.speechToTextEnabled) return;
		// Shift+click starts live (chunked) transcription; regular click is push-to-talk.
		if (event?.shiftKey || this.liveTranscriber) {
			await this.toggleLiveRecording();
			return;
		}
		if (this.audioRecorder?.isRecording()) {
			await this.stopRecordingAndTranscribe();
			return;
		}
		this.hideComposerNotice();
		const recorder = new AudioRecorder({ mimeType: 'audio/webm', deviceId: this.plugin.settings.audioInputDeviceId || undefined });
		this.audioRecorder = recorder;
		try {
			await recorder.start();
			if (!this.isOpen || this.audioRecorder !== recorder) {
				await recorder.cancel();
				return;
			}
			this.recordingStartedAt = Date.now();
			this.updateRecordingTimer();
			this.recordingTimer = this.registerInterval(window.setInterval(() => this.updateRecordingTimer(), 1_000));
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
		console.debug('[CC] Chat stopRecordingAndTranscribe: stopping recorder');
		this.isTranscribing = true;
		// Generation counter prevents race when a new recording starts before the
		// previous transcription completes. Capture before any await so the
		// compare-and-swap in the finally block is deterministic.
		const lockedRecorder = recorder;
		this.stopRecordingTimer();
		this.microphoneEl.removeClass('cc-mic-recording');
		this.microphoneEl.addClass('is-transcribing');
		this.microphoneEl.disabled = true;
		this.microphoneEl.setAttribute('aria-label', 'Transcribing voice recording');
		this.microphoneEl.setAttribute('aria-pressed', 'false');
		this.microphoneEl.setAttribute('title', 'Transcribing...');
		this.recordingTimerEl.removeClass('is-visible');
		this.showComposerNotice('Transcribing...');

		// ── Silence / short-audio guard ─────────────────
		const durationMs = lockedRecorder.getDurationMs();
		const peakLevel = lockedRecorder.getPeakLevel();
		console.debug(`[CC] Chat recording stats: ${durationMs}ms, peakLevel=${peakLevel.toFixed(4)}`);
		if (durationMs < MIN_TRANSCRIPTION_DURATION_MS || peakLevel < 0.02) {
			console.debug('[CC] Chat audio too short or silent — discarding');
			this.hideComposerNotice();
			this.isTranscribing = false;
			if (this.isOpen) this.resetMicrophoneUi();
			if (this.audioRecorder === lockedRecorder) this.audioRecorder = null;
			return;
		}

		const controller = new AbortController();
		this.transcriptionAbort = controller;
		try {
			const audio = await lockedRecorder.stop();
			console.debug(`[CC] Chat got audio blob: ${audio.size} bytes, type=${audio.type}`);
			const rawText = await this.transcribeWithFallback(audio, controller.signal);
			// Sanitize: strip Whisper hallucination artifacts.
			const text = sanitizeTranscript(rawText);
			if (!text) {
				console.debug('[CC] Chat transcript sanitized to empty — likely silence hallucination');
				this.hideComposerNotice();
				if (this.isOpen) this.showComposerNotice('No speech detected — try again.', true);
				window.setTimeout(() => { if (this.isOpen) this.hideComposerNotice(); }, 2500);
				return;
			}
			// Guard: if a new recording started while transcribing, discard this result.
			if (!this.isOpen || this.audioRecorder !== lockedRecorder) {
				console.debug('[CC] Chat transcription discarded: recorder was superseded');
				return;
			}
			// Insert at cursor position, not blindly at end of value.
			const el = this.textareaEl;
			const before = el.value.slice(0, el.selectionStart);
			const after = el.value.slice(el.selectionEnd);
			const spacer = before && !/\s$/.test(before) ? ' ' : '';
			el.value = `${before}${spacer}${text}${after}`;
			// Move cursor to end of inserted text.
			const newPos = before.length + spacer.length + text.length;
			el.setSelectionRange(newPos, newPos);
			this.resizeTextarea();
			await this.refreshDetectedContext();
			el.focus();
			this.hideComposerNotice();
		} catch (error) {
			if (this.isOpen) this.showComposerNotice(`Transcription failed: ${(error as Error).message}`, true);
		} finally {
			if (this.transcriptionAbort === controller) this.transcriptionAbort = null;
			// Only null-out audioRecorder if we're still the one who captured it.
			if (this.audioRecorder === lockedRecorder) this.audioRecorder = null;
			this.isTranscribing = false;
			if (this.isOpen) this.resetMicrophoneUi();
		}
	}

	/* ─── Live (chunked) transcription ───────────────────── */

	private async toggleLiveRecording(): Promise<void> {
		if (this.liveTranscriber) {
			await this.stopLiveTranscription();
			return;
		}
		const candidates = this.getTranscriptionCandidates();
		if (!candidates.length) {
			this.showComposerNotice('Enable an OpenAI-compatible transcription provider first.', true);
			return;
		}
		this.hideComposerNotice();
		this.isLiveMode = true;
		this.showComposerNotice('Live transcription... (Shift+click to stop)');
		const controller = new AbortController();
		this.transcriptionAbort = controller;
		this.liveTranscriber = new LiveTranscriber({
			plugin: this.plugin,
			candidates,
			chunkDurationMs: 3000,
			signal: controller.signal,
			callbacks: {
				onInterim: text => {
					if (!this.isOpen) return;
					this.textareaEl.value = text;
					this.resizeTextarea();
				},
				onStateChange: state => {
					if (!this.isOpen) return;
					if (state === 'recording') {
						this.microphoneEl.addClass('cc-mic-recording', 'cc-mic-live');
						this.microphoneEl.setAttribute('aria-label', 'Stop live transcription');
						this.microphoneEl.setAttribute('title', 'Stop live transcription (Shift+click)');
						this.recordingTimerEl.addClass('is-visible');
						this.showComposerNotice('Live transcription... (Shift+click to stop)');
					} else if (state === 'transcribing') {
						this.microphoneEl.addClass('is-transcribing');
					} else if (state === 'error') {
						this.showComposerNotice('Live transcription error — click to retry.', true);
					}
				},
				onError: error => {
					if (this.isOpen) this.showComposerNotice(`Live STT: ${error.message}`, true);
				},
			},
		});
		try {
			await this.liveTranscriber.start();
		} catch (error) {
			this.liveTranscriber = null;
			this.isLiveMode = false;
			if (this.transcriptionAbort === controller) this.transcriptionAbort = null;
			if (!this.isOpen) return;
			this.showComposerNotice(`Live transcription unavailable: ${(error as Error).message}`, true);
			this.resetMicrophoneUi();
		}
	}

	private async stopLiveTranscription(): Promise<void> {
		const transcriber = this.liveTranscriber;
		if (!transcriber) return;
		this.liveTranscriber = null;
		this.isLiveMode = false;
		try {
			const text = await transcriber.stop();
			if (!this.isOpen) return;

			if (text) {
				const existing = this.textareaEl.value;
				const target = this.voiceOutputTarget;

				if (target === 'chat' || target === 'all') {
					this.textareaEl.value = existing && !/\s$/.test(existing) ? `${existing} ${text}` : `${existing}${text}`;
					this.resizeTextarea();
					this.textareaEl.focus();
					this.textareaEl.setSelectionRange(this.textareaEl.value.length, this.textareaEl.value.length);
					await this.refreshDetectedContext();
				}

				if (target === 'note' || target === 'note+audio' || target === 'all') {
					const inserted = insertIntoActiveEditor(this.plugin.app, text);
					if (!inserted) {
						await processTranscriptionOutput(this.plugin, text, undefined, {
							insertIntoNote: true,
							saveAudio: target === 'note+audio' || target === 'all',
						});
					}
				}

				if (target === 'canvas' || target === 'canvas+audio' || target === 'all') {
					await processTranscriptionOutput(this.plugin, text, undefined, {
						createCanvas: true,
						saveAudio: target === 'canvas+audio' || target === 'all',
					});
				}
			}
		} catch (error) {
			if (this.isOpen) this.showComposerNotice(`Live transcription: ${(error as Error).message}`, true);
		} finally {
			this.transcriptionAbort?.abort();
			this.transcriptionAbort = null;
			if (this.isOpen) {
				this.hideComposerNotice();
				this.resetMicrophoneUi();
			}
		}
	}

	private getTranscriptionCandidates(): TranscriptionCandidate[] {
		return buildTranscriptionCandidates(this.plugin.settings, {
			hasApiKey: providerId => this.plugin.credentialVault.has(providerId),
		});
	}

	private async refreshSttStatus(): Promise<void> {
		const candidate = this.getTranscriptionCandidates()[0];
		this.sttStatusEl.setText(candidate ? `STT: ${candidate.label}` : this.plugin.settings.speechToTextEnabled ? 'STT: not configured' : 'STT: disabled');
		this.sttStatusEl.toggleClass('is-unavailable', !this.plugin.settings.speechToTextEnabled || !candidate);
		if (!candidate?.local) return;
		try {
			const models = await this.withTimeout(
				new TranscriberAdapter({
					providerId: candidate.providerId,
					getSettings: () => this.plugin.settings,
				}).fetchLiveAudioModels(),
				5_000,
				'Local model discovery timed out',
			);
			if (!this.isOpen || models.length === 0) return;
			this.sttStatusEl.setText(`STT: ${candidate.providerId === 'lmstudio' ? 'Local LM Studio' : 'Local Ollama'} (${models[0]})`);
		} catch {
			// Keep the configured label; actual transcription performs provider fallback.
		}
	}

	private async transcribeWithFallback(audio: Blob, signal: AbortSignal): Promise<string> {
		const candidates = this.getTranscriptionCandidates();
		console.debug(`[CC] Chat transcribeWithFallback: ${candidates.length} candidate(s)`, candidates.map(c => c.label));
		if (!candidates.length) throw new Error('Enable speech to text and configure a local or cloud transcription provider.');
		const errors: string[] = [];
		for (let index = 0; index < candidates.length; index++) {
			if (signal.aborted) throw new Error('Transcription cancelled.');
			const candidate = candidates[index]!;
			const label = index > 0 ? `${candidate.label} · fallback ${index}` : candidate.label;
			console.debug(`[CC] Trying transcription candidate ${index + 1}/${candidates.length}: ${candidate.label}`);
			this.sttStatusEl.setText(`STT: ${label}`);
			this.showComposerNotice(`Transcribing via ${label}...`);
			try {
				const transcriber = new TranscriberAdapter({
					providerId: candidate.providerId,
					getSettings: () => this.plugin.settings,
					defaultModel: candidate.model,
					maxAttempts: candidate.local ? 1 : 2,
					getApiKey: id => this.plugin.credentialVault.get(id),
					signal,
				});
				if (candidate.local) {
					this.showComposerNotice(`Discovering ${candidate.label} models...`);
					try { await this.withTimeout(transcriber.fetchLiveAudioModels(), 5_000, `${candidate.label} model discovery timed out`); }
					catch { console.debug(`[CC] Local model discovery failed for ${candidate.label}, trying implicit model`); }
				}
				this.showComposerNotice(`Transcribing via ${label}...`);
				const text = await this.withTimeout(
					transcriber.transcribe(audio, candidate.model),
					candidate.local ? 15_000 : 60_000,
					`${candidate.label} timed out`,
				);
				console.debug(`[CC] Transcription succeeded from ${candidate.label} (${text.length} chars)`);
				this.sttStatusEl.setText(`STT: ${candidate.label}`);
				return text.trim();
			} catch (error) {
				const msg = (error as Error).message;
				console.error(`[CC] Transcription failed for ${candidate.label}:`, error);
				errors.push(`${candidate.label}: ${msg}`);
				this.showComposerNotice(`${candidate.label} failed: ${msg}`, true);
				// Brief pause so the user can see the fallback error before the next attempt
				if (index < candidates.length - 1) await this.safeDelay(800);
			}
		}
		const finalErr = `All transcription providers failed. ${errors.join(' | ')}`;
		console.error('[CC]', finalErr);
		throw new Error(finalErr);
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

	private safeDelay(ms: number): Promise<void> {
		return new Promise(resolve => window.setTimeout(resolve, ms));
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
		this.microphoneEl.removeClass('cc-mic-recording', 'is-transcribing', 'cc-mic-live');
		this.microphoneEl.disabled = this.isSending || !this.plugin.settings.speechToTextEnabled;
		this.microphoneEl.setAttribute('aria-label', 'Start voice recording');
		this.microphoneEl.setAttribute('aria-pressed', 'false');
		this.microphoneEl.setAttribute('title', 'Record voice message (Shift+click for live)');
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
		const message = { role, bubble, content, markdown: text, renderVersion: 0 };
		if (role === 'assistant') {
			const read = bubble.createEl('button', { text: '🔊 Read aloud', cls: 'cc-read-aloud', attr: { 'aria-label': 'Read AI response aloud' } });
			this.registerDomEvent(read, 'click', () => this.plugin.accessibilityAudio.speak(message.markdown));
		}
		void this.renderMessage(message);
		this.pinnedToBottom = true;
		this.scrollToBottom(true);
		return message;
	}

	private async renderMessage(message: ChatMessageElements): Promise<void> {
		const version = ++message.renderVersion;

		// Skip re-render if the user is currently selecting text inside this message
		// so streaming doesn't wipe their selection mid-copy.
		if (this.isSelectionInside(message.content)) return;

		const staging = createDiv();
		await MarkdownRenderer.render(this.plugin.app, message.markdown, staging, this.contextFile?.path ?? '', this);
		if (!this.isOpen || version !== message.renderVersion) return;
		// Check again after the async render, in case the selection started during the await.
		if (this.isSelectionInside(message.content)) return;
		message.content.replaceChildren(...Array.from(staging.childNodes));
		this.scrollToBottom();
	}

	/** True when the active DOM selection is anchored inside the given element. */
	private isSelectionInside(el: HTMLElement): boolean {
		const selection = document.getSelection();
		if (!selection || selection.isCollapsed) return false;
		if (selection.anchorNode && el.contains(selection.anchorNode)) return true;
		if (selection.focusNode && el.contains(selection.focusNode)) return true;
		return false;
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
		details.createEl('summary', { text: '[⚡ React trace]' });
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
		// Keep the user prompt intact; attached context is surfaced in the UI and
		// should not be concatenated into the chat prompt here.
		const enrichedPrompt = prompt;
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
			if (assistant.markdown.trim()) {
				this.plugin.accessibilityAudio.cue('complete');
				if (this.plugin.settings.autoReadAiResponses) this.plugin.accessibilityAudio.speak(assistant.markdown);
			}
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
		this.plugin.daemon.setToolConfirmationHandler(request => this.plugin.requestDashboardApproval(request));
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
		this.microphoneEl.disabled = sending || this.isTranscribing || !this.plugin.settings.speechToTextEnabled;
		this.textareaEl.disabled = sending;
		this.updateHeader();
		if (!sending) this.textareaEl.focus();
	}
}
