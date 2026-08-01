import type CommandCenterPlugin from '../main';
import { buildTranscriptionCandidates, TranscriberAdapter, type TranscriptionCandidate } from './transcriber';
import { AudioRecorder } from './audio-recorder';

export type AudioCue = 'start' | 'stop' | 'complete' | 'attention';

/** Shared dictation, speech, and cue boundary for dashboard and chat surfaces. */
export class AccessibilityAudio {
	private utterance: SpeechSynthesisUtterance | null = null;
	private context: AudioContext | null = null;

	constructor(private readonly plugin: CommandCenterPlugin) {}

	async dictate(signal?: AbortSignal): Promise<{ recorder: AudioRecorder; stop: () => Promise<string> }> {
		if (!this.plugin.settings.speechToTextEnabled) {
			throw new Error('Enable speech to text in Settings to use dictation.');
		}
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
		if (!this.plugin.settings.speechToTextEnabled) throw new Error('Enable speech to text in Command Center settings.');
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
		if (!this.plugin.settings.textToSpeechEnabled) return false;
		if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') return false;
		const clean = text.replace(/```[\s\S]*?```/g, ' code block ').replace(/[*_#>`~[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
		if (!clean) return false;
		this.stopSpeaking();
		const utterance = new SpeechSynthesisUtterance(clean.slice(0, 20_000));
		utterance.rate = this.resolveRate();
		const voice = this.resolveVoice();
		if (voice) {
			utterance.voice = voice;
			if (voice.lang) utterance.lang = voice.lang;
		}
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
		} catch {
			/* Audio cues are optional and never block work. */
		}
	}

	dispose(): void {
		this.stopSpeaking();
		void this.context?.close();
		this.context = null;
	}

	private resolveRate(): number {
		const value = Number(this.plugin.settings.textToSpeechRate);
		if (!Number.isFinite(value)) return 1;
		return Math.min(3, Math.max(0.5, value));
	}

	private resolveVoice(): SpeechSynthesisVoice | null {
		const voices = this.availableVoices();
		if (!voices.length) return null;
		const configured = this.plugin.settings.textToSpeechVoice.trim();
		if (configured) {
			const exact = voices.find(voice => voice.name === configured);
			if (exact) return exact;
		}
		return voices.find(voice => voice.default) ?? voices[0] ?? null;
	}

	private availableVoices(): SpeechSynthesisVoice[] {
		if (!('speechSynthesis' in window) || typeof window.speechSynthesis.getVoices !== 'function') return [];
		return window.speechSynthesis.getVoices().filter(voice => voice && typeof voice.name === 'string');
	}

	private transcriptionCandidates(): TranscriptionCandidate[] {
		return buildTranscriptionCandidates(this.plugin.settings, {
			hasApiKey: (providerId) => this.plugin.credentialVault.has(providerId),
		});
	}
}
