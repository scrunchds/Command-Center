import type CommandCenterPlugin from '../main';
import type { ProviderId } from '../providers/provider-types';
import { PROVIDER_REGISTRY } from '../providers/provider-registry';
import { AudioRecorder } from './audio-recorder';
import { TranscriberAdapter } from './transcriber';

export type AudioCue = 'start' | 'stop' | 'complete' | 'attention';

/** Shared dictation, speech, and cue boundary for dashboard and chat surfaces. */
export class AccessibilityAudio {
	private utterance: SpeechSynthesisUtterance | null = null;
	private context: AudioContext | null = null;

	constructor(private readonly plugin: CommandCenterPlugin) {}

	async dictate(signal?: AbortSignal): Promise<{ recorder: AudioRecorder; stop: () => Promise<string> }> {
		const recorder = new AudioRecorder({ mimeType: 'audio/webm' });
		await recorder.start();
		this.cue('start');
		return {
			recorder,
			stop: async () => {
				const audio = await recorder.stop();
				this.cue('stop');
				return this.transcribe(audio, signal);
			},
		};
	}

	async transcribe(audio: Blob, signal?: AbortSignal): Promise<string> {
		const candidates = this.transcriptionCandidates();
		if (!candidates.length) throw new Error('Enable a local or cloud speech-to-text provider in Command Center settings.');
		const errors: string[] = [];
		for (const candidate of candidates) {
			if (signal?.aborted) throw new Error('Transcription cancelled.');
			try {
				const adapter = new TranscriberAdapter({
					providerId: candidate.providerId,
					getSettings: () => this.plugin.settings,
					getApiKey: id => this.plugin.credentialVault.get(id),
					defaultModel: candidate.model,
					maxAttempts: candidate.local ? 1 : 2,
					signal,
				});
				return (await adapter.transcribe(audio, candidate.model)).trim();
			} catch (error) {
				errors.push(`${candidate.label}: ${(error as Error).message}`);
			}
		}
		throw new Error(`All transcription providers failed. ${errors.join(' | ')}`);
	}

	speak(text: string): boolean {
		if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') return false;
		const clean = text.replace(/```[\s\S]*?```/g, ' code block ').replace(/[*_#>`~[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
		if (!clean) return false;
		this.stopSpeaking();
		const utterance = new SpeechSynthesisUtterance(clean.slice(0, 20_000));
		utterance.rate = 1;
		utterance.onend = () => { if (this.utterance === utterance) this.utterance = null; };
		utterance.onerror = () => { if (this.utterance === utterance) this.utterance = null; };
		this.utterance = utterance;
		window.speechSynthesis.speak(utterance);
		return true;
	}

	stopSpeaking(): void {
		if ('speechSynthesis' in window) window.speechSynthesis.cancel();
		this.utterance = null;
	}

	cue(kind: AudioCue): void {
		if (!this.plugin.settings.audioCues) return;
		try {
			this.context ??= new AudioContext();
			const oscillator = this.context.createOscillator();
			const gain = this.context.createGain();
			const frequencies: Record<AudioCue, number> = { start: 520, stop: 390, complete: 660, attention: 300 };
			oscillator.frequency.value = frequencies[kind];
			gain.gain.setValueAtTime(0.025, this.context.currentTime);
			gain.gain.exponentialRampToValueAtTime(0.0001, this.context.currentTime + 0.12);
			oscillator.connect(gain).connect(this.context.destination);
			oscillator.start();
			oscillator.stop(this.context.currentTime + 0.12);
		} catch { /* Audio cues are optional and never block work. */ }
	}

	dispose(): void {
		this.stopSpeaking();
		void this.context?.close();
		this.context = null;
	}

	private transcriptionCandidates(): Array<{ providerId: ProviderId; model?: string; label: string; local: boolean }> {
		const settings = this.plugin.settings.multiProvider;
		const configured = (settings.defaults as Record<string, unknown>).transcriptionModel;
		const configuredModel = typeof configured === 'string' && configured.trim() ? configured.trim() : undefined;
		const order: ProviderId[] = ['lmstudio', 'ollama', 'groq', 'openai', 'deepinfra', 'openrouter', 'custom'];
		return order.flatMap(providerId => {
			const credentials = settings.credentials[providerId];
			const meta = PROVIDER_REGISTRY[providerId];
			if (!credentials?.enabled || (!credentials.baseUrl && !meta.defaultBaseUrl)) return [];
			if (meta.requiresKey && !this.plugin.credentialVault.has(providerId)) return [];
			const local = providerId === 'lmstudio' || providerId === 'ollama';
			const persisted = settings.liveModels?.[providerId]?.find(model => /(whisper|speech[-_ ]?to[-_ ]?text|transcri|\bstt\b)/i.test(model.id));
			const model = persisted?.id ?? configuredModel ?? (providerId === 'groq' ? 'whisper-large-v3' : local ? undefined : 'whisper-large-v3-turbo');
			return [{ providerId, model, label: meta.label, local }];
		});
	}
}
