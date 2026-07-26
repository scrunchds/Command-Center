import { Modal } from 'obsidian';
import type CommandCenterPlugin from '../main';
import { AudioRecorder } from '../audio/audio-recorder';
import { TranscriberAdapter } from '../audio/transcriber';
import type { ProviderId } from '../providers/provider-types';
import { PROVIDER_REGISTRY } from '../providers/provider-registry';
import { resolveChatContext } from './chat-context';

export type VoicePromptMode = 'quick' | 'react' | 'workflow';
interface SttCandidate { providerId: ProviderId; model?: string; label: string; local: boolean }

/** Floating, auto-starting voice capture used by the global palette command. */
export class VoicePromptModal extends Modal {
	private readonly plugin: CommandCenterPlugin;
	private recorder: AudioRecorder | null = null;
	private durationEl!: HTMLElement;
	private levelFillEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private sttBadgeEl!: HTMLElement;
	private doneEl!: HTMLButtonElement;
	private cancelEl!: HTMLButtonElement;
	private mode: VoicePromptMode = 'quick';
	private closed = false;
	private finishing = false;
	private transcriptionAbort: AbortController | null = null;

	constructor(plugin: CommandCenterPlugin) { super(plugin.app); this.plugin = plugin; }

	onOpen(): void {
		this.closed = false;
		this.finishing = false;
		this.modalEl.addClass('cc-voice-prompt-modal');
		this.titleEl.setText('Quick Voice Prompt');
		this.contentEl.empty();

		const hero = this.contentEl.createDiv({ cls: 'cc-voice-prompt-hero' });
		this.sttBadgeEl = hero.createDiv({ cls: 'cc-voice-stt-badge', text: 'STT: detecting...' });
		hero.createDiv({ cls: 'cc-voice-microphone cc-mic-recording', text: '🎙️', attr: { 'aria-hidden': 'true' } });
		this.durationEl = hero.createDiv({ cls: 'cc-voice-duration', text: '00:00', attr: { role: 'timer' } });
		this.statusEl = hero.createDiv({ cls: 'cc-voice-prompt-status', text: 'Requesting microphone access...' });
		const meter = hero.createDiv({ cls: 'cc-voice-level', attr: { role: 'meter', 'aria-label': 'Microphone audio level', 'aria-valuemin': '0', 'aria-valuemax': '100' } });
		this.levelFillEl = meter.createDiv({ cls: 'cc-voice-level-fill' });

		const modeSelect = this.contentEl.createEl('select', { cls: 'cc-voice-mode-select', attr: { 'aria-label': 'Voice prompt mode' } });
		for (const [value, text] of [['quick', 'Quick'], ['react', 'ReAct'], ['workflow', 'Workflow']] as const) modeSelect.createEl('option', { value, text });
		modeSelect.addEventListener('change', () => { this.mode = modeSelect.value as VoicePromptMode; });

		const actions = this.contentEl.createDiv({ cls: 'cc-voice-prompt-actions' });
		this.doneEl = actions.createEl('button', { cls: 'mod-cta', text: 'Done & Send', attr: { type: 'button' } });
		this.cancelEl = actions.createEl('button', { text: 'Cancel', attr: { type: 'button' } });
		this.doneEl.disabled = true;
		this.doneEl.addEventListener('click', () => { void this.finishAndDispatch(); });
		this.cancelEl.addEventListener('click', () => this.close());
		this.scope.register([], 'Enter', event => { event.preventDefault(); void this.finishAndDispatch(); return false; });
		void this.refreshSttBadge();
		void this.beginRecording();
	}

	onClose(): void {
		this.closed = true;
		this.transcriptionAbort?.abort();
		this.transcriptionAbort = null;
		const recorder = this.recorder;
		this.recorder = null;
		if (recorder) void recorder.cancel();
		this.contentEl.empty();
	}

	private candidates(): SttCandidate[] {
		const settings = this.plugin.settings.multiProvider;
		const configured = (settings.defaults as Record<string, unknown>).transcriptionModel;
		const configuredModel = typeof configured === 'string' && configured.trim() ? configured.trim() : undefined;
		const order: ProviderId[] = ['lmstudio', 'ollama', 'groq', 'openai', 'deepinfra', 'openrouter', 'custom'];
		return order.flatMap(providerId => {
			const credentials = settings.credentials[providerId];
			const meta = PROVIDER_REGISTRY[providerId];
			if (!credentials?.enabled || (!credentials.baseUrl && !meta.defaultBaseUrl) || (meta.requiresKey && !credentials.apiKey)) return [];
			const local = providerId === 'lmstudio' || providerId === 'ollama';
			const saved = settings.liveModels?.[providerId]?.find(model => /(whisper|speech[-_ ]?to[-_ ]?text|transcri|\bstt\b)/i.test(model.id));
			const model = saved?.id ?? configuredModel ?? (providerId === 'groq' ? 'whisper-large-v3' : local ? undefined : 'whisper-large-v3-turbo');
			const provider = providerId === 'lmstudio' ? 'LM Studio / Local' : providerId === 'ollama' ? 'Ollama / Local' : meta.label;
			return [{ providerId, model, label: `${provider}${model ? ` / ${model}` : ' / Whisper'}`, local }];
		});
	}

	private async refreshSttBadge(): Promise<void> {
		const candidate = this.candidates()[0];
		this.sttBadgeEl.setText(candidate?.label ?? 'STT not configured');
		if (!candidate?.local) return;
		try {
			const models = await new TranscriberAdapter({ providerId: candidate.providerId, getSettings: () => this.plugin.settings }).fetchLiveAudioModels();
			if (!this.closed && models[0]) this.sttBadgeEl.setText(`${candidate.providerId === 'lmstudio' ? 'LM Studio / Local' : 'Ollama / Local'} / ${models[0]}`);
		} catch { /* Keep configured endpoint badge; dispatch performs fallback. */ }
	}

	private async beginRecording(): Promise<void> {
		const recorder = new AudioRecorder({
			mimeType: 'audio/webm',
			onDurationChange: duration => { if (!this.closed) this.durationEl.setText(this.formatDuration(duration)); },
			onAudioLevel: level => {
				if (this.closed) return;
				const percent = Math.round(level * 100);
				this.levelFillEl.style.width = `${percent}%`;
				this.levelFillEl.parentElement?.setAttribute('aria-valuenow', String(percent));
			},
		});
		this.recorder = recorder;
		try {
			await recorder.start();
			if (this.closed || this.recorder !== recorder) { await recorder.cancel(); return; }
			this.statusEl.setText('Listening...');
			this.doneEl.disabled = false;
		} catch (error) {
			this.recorder = null;
			if (!this.closed) this.showError(`Microphone unavailable: ${(error as Error).message}`);
		}
	}

	private async finishAndDispatch(): Promise<void> {
		const recorder = this.recorder;
		if (this.finishing || !recorder?.isRecording()) return;
		this.finishing = true;
		this.doneEl.disabled = true;
		this.statusEl.removeClass('is-error');
		this.statusEl.setText('Transcribing audio...');
		this.statusEl.addClass('is-loading');
		const controller = new AbortController();
		this.transcriptionAbort = controller;
		try {
			const blob = await recorder.stop();
			const spokenText = await this.transcribeWithFallback(blob, controller.signal);
			if (!spokenText) throw new Error('The transcription was empty.');
			this.statusEl.setText('Resolving vault context...');
			const resolved = await resolveChatContext(this.plugin.app, spokenText);
			if (this.closed || controller.signal.aborted) return;
			this.statusEl.setText('Dispatching...');
			await this.plugin.dispatchVoicePrompt(this.mode, spokenText, resolved);
			if (!this.closed) this.close();
		} catch (error) {
			if (!this.closed && !controller.signal.aborted) this.showError(`Voice prompt failed: ${(error as Error).message}`);
		} finally {
			if (this.transcriptionAbort === controller) this.transcriptionAbort = null;
			this.recorder = null;
			this.finishing = false;
		}
	}

	private async transcribeWithFallback(blob: Blob, signal: AbortSignal): Promise<string> {
		const candidates = this.candidates();
		if (!candidates.length) throw new Error('Enable an OpenAI-compatible transcription provider.');
		const errors: string[] = [];
		for (const candidate of candidates) {
			if (signal.aborted) throw new Error('Transcription cancelled.');
			this.sttBadgeEl.setText(candidate.label);
			const adapter = new TranscriberAdapter({ providerId: candidate.providerId, getSettings: () => this.plugin.settings, defaultModel: candidate.model, maxAttempts: candidate.local ? 1 : 2, signal });
			try {
				if (candidate.local) try { await adapter.fetchLiveAudioModels(); } catch { /* Try implicit local model. */ }
				return await adapter.transcribe(blob, candidate.model);
			} catch (error) { errors.push(`${candidate.label}: ${(error as Error).message}`); }
		}
		throw new Error(`All transcription providers failed. ${errors.join(' | ')}`);
	}

	private showError(message: string): void { this.statusEl.removeClass('is-loading'); this.statusEl.addClass('is-error'); this.statusEl.setText(message); }
	private formatDuration(durationMs: number): string {
		const seconds = Math.max(0, Math.floor(durationMs / 1_000));
		return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
	}
}
