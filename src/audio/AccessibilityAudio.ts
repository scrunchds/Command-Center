import type CommandCenterPlugin from '../main';
import { buildTranscriptionCandidates, TranscriberAdapter, type TranscriptionCandidate } from './transcriber';
import { AudioRecorder } from './audio-recorder';

export type AudioCue = 'start' | 'stop' | 'complete' | 'attention';

/** Optional callback surface for UI components to show per-provider status during transcription fallback. */
export type TranscriptionStatusCallback = (phase: 'connecting' | 'transcribing' | 'fallback' | 'done' | 'error', message: string) => void;

/** Shared dictation, speech, and cue boundary for dashboard and chat surfaces. */
export class AccessibilityAudio {
	private utterance: SpeechSynthesisUtterance | null = null;
	private context: AudioContext | null = null;

	constructor(private readonly plugin: CommandCenterPlugin) {}

	async dictate(signal?: AbortSignal, onStatus?: TranscriptionStatusCallback): Promise<{ recorder: AudioRecorder; stop: () => Promise<string> }> {
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
				return this.transcribe(audio, signal, onStatus);
			},
		};
	}

	async transcribe(audio: Blob, signal?: AbortSignal, onStatus?: TranscriptionStatusCallback): Promise<string> {
		const candidates = this.transcriptionCandidates();
		if (!this.plugin.settings.speechToTextEnabled) throw new Error('Enable speech to text in Command Center settings.');
		if (!candidates.length) throw new Error('Enable a local or cloud speech-to-text provider in Command Center settings.');
		const errors: string[] = [];
		for (let index = 0; index < candidates.length; index++) {
			if (signal?.aborted) throw new Error('Transcription cancelled.');
			const candidate = candidates[index]!;
			const label = index > 0 ? `${candidate.label} (fallback ${index})` : candidate.label;
			onStatus?.(index > 0 ? 'fallback' : 'transcribing', label);
			try {
				const adapter = new TranscriberAdapter({
					providerId: candidate.providerId,
					getSettings: () => this.plugin.settings,
					getApiKey: id => this.plugin.credentialVault.get(id),
					defaultModel: candidate.model,
					maxAttempts: candidate.local ? 1 : 2,
					signal,
				});
				// Warm up local models before transcription
				if (candidate.local) {
					onStatus?.('connecting', `Discovering ${candidate.label} models...`);
					try {
						await adapter.fetchLiveAudioModels();
					} catch {
						// Non-fatal — the endpoint may still support an implicit model.
					}
				}
				onStatus?.('transcribing', `${label} — processing audio...`);
				const text = (await adapter.transcribe(audio, candidate.model)).trim();
				onStatus?.('done', label);
				return text;
			} catch (error) {
				const msg = (error as Error).message;
				errors.push(`${candidate.label}: ${msg}`);
				onStatus?.('error', `${candidate.label} failed: ${msg}`);
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
