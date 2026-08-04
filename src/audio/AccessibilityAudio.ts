import type CommandCenterPlugin from '../main';
import { buildTranscriptionCandidates, TranscriberAdapter, sanitizeDictation, MIN_TRANSCRIPTION_DURATION_MS, SILENCE_LEVEL_THRESHOLD, type TranscriptionCandidate } from './transcriber';
import { AudioRecorder } from './audio-recorder';
import { TtsAdapter, playTtsBlob } from './tts-adapter';

export type AudioCue = 'start' | 'stop' | 'complete' | 'attention';

/** Optional callback surface for UI components to show per-provider status during transcription fallback. */
export type TranscriptionStatusCallback = (phase: 'connecting' | 'transcribing' | 'fallback' | 'done' | 'error', message: string) => void;

/** Shared dictation, speech, and cue boundary for dashboard and chat surfaces. */
export class AccessibilityAudio {
	private utterance: SpeechSynthesisUtterance | null = null;
	private context: AudioContext | null = null;
	/** AbortController for an in-flight provider TTS request/playback. */
	private ttsAbort: AbortController | null = null;

	constructor(private readonly plugin: CommandCenterPlugin) {}

	async dictate(signal?: AbortSignal, onStatus?: TranscriptionStatusCallback): Promise<{ recorder: AudioRecorder; stop: () => Promise<string> }> {
		if (!this.plugin.settings.speechToTextEnabled) {
			throw new Error('Enable speech to text in Settings to use dictation.');
		}
		const recorder = new AudioRecorder({ mimeType: 'audio/webm', deviceId: this.plugin.settings.audioInputDeviceId || undefined });
		await recorder.start();
		// Delay the start cue 200 ms so any speaker output finishes before the
		// microphone captures it. Even with AEC disabled, an active speaker
		// tone can bleed into the first frames of the recording on Windows.
		window.setTimeout(() => this.cue('start'), 200);
		return {
			recorder,
			stop: async () => {
				// Silence / short-audio guard: reject near-silent or accidental-tap
				// recordings BEFORE sending audio to the provider. Whisper and its
				// hosted derivatives hallucinate filler words ("you", "thank you",
				// "okay", …) on noise-only input; sending it wastes a request and
				// surfaces those artifacts as dictation text.
				const durationMs = recorder.getDurationMs();
				const peakLevel = recorder.getPeakLevel();
				console.debug(`[CC] Dictation stats: ${durationMs}ms, peakLevel=${peakLevel.toFixed(4)}`);
				// Reject only clips that are clearly accidental: too short to contain
				// speech, OR short AND silent. A recording of sufficient length is sent
				// even when the analyser under-measured its level (a known Windows /
				// Electron issue where the AudioContext reports a low RMS); the backend
				// sanitizeDictation() still strips genuine silence hallucinations.
				const tooShort = durationMs < MIN_TRANSCRIPTION_DURATION_MS;
				const shortAndSilent = durationMs < 1500 && peakLevel < SILENCE_LEVEL_THRESHOLD;
				if (tooShort || shortAndSilent) {
					console.debug(`[CC] Dictation audio rejected — tooShort=${tooShort}, shortAndSilent=${shortAndSilent}`);
					onStatus?.('error', 'No speech detected — recording too short or silent.');
					await recorder.stop();
					return '';
				}
				if (peakLevel < SILENCE_LEVEL_THRESHOLD) {
					console.debug(`[CC] Low peakLevel (${peakLevel.toFixed(4)}) but duration ${durationMs}ms — sending anyway.`);
				}
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
		console.debug(`[CC] transcribe() sending blob: ${audio.size} bytes, type=${audio.type}`);
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
					transcriptionPath: candidate.transcriptionPath,
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
				const raw = (await adapter.transcribe(audio, candidate.model)).trim();
				// Strip Whisper silence-hallucination artifacts before returning.
				const text = sanitizeDictation(raw);
				if (text) {
					onStatus?.('done', label);
					return text;
				}
				// Sanitized to empty (silence hallucination) — try the next provider.
				errors.push(`${candidate.label}: no speech detected`);
				onStatus?.('error', `${candidate.label}: no speech detected`);
			} catch (error) {
				const msg = (error as Error).message;
				errors.push(`${candidate.label}: ${msg}`);
				onStatus?.('error', `${candidate.label} failed: ${msg}`);
			}
		}
		throw new Error(`All transcription providers failed. ${errors.join(' | ')}`);
	}

	/**
	 * Speak `text`. When a provider TTS is configured (textToSpeechProviderId !=
	 * 'browser'), routes through the provider's /audio/speech (or xAI /v1/tts)
	 * endpoint and plays the returned audio. Falls back to the browser's
	 * speechSynthesis when 'browser' is selected, no provider is available, or the
	 * provider request fails — never silently dropping spoken output.
	 *
	 * Returns true if speech was initiated (provider path is async and may still
	 * fail later; the fallback is invoked on error).
	 */
	speak(text: string): boolean {
		if (!this.plugin.settings.textToSpeechEnabled) return false;
		const clean = text.replace(/```[\s\S]*?```/g, ' code block ').replace(/[*_#>`~[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
		if (!clean) return false;
		const truncated = clean.slice(0, 20_000);
		this.stopSpeaking();

		const providerId = this.plugin.settings.textToSpeechProviderId;
		if (providerId && providerId !== 'browser' && this.canUseProviderTts(providerId === 'auto' ? undefined : providerId)) {
			void this.speakViaProvider(truncated, providerId === 'auto' ? undefined : providerId)
				.catch(error => {
					console.warn('[Command Center] Provider TTS failed, falling back to browser speechSynthesis:', error);
					this.speakViaBrowser(truncated);
				});
			return true;
		}
		return this.speakViaBrowser(truncated);
	}

	private canUseProviderTts(providerId?: import('../providers/provider-types').ProviderId): boolean {
		const settings = this.plugin.settings;
		// Resolve an enabled, TTS-capable provider.
		const candidates = providerId
			? [providerId]
			: (['openai', 'openrouter', 'xai', 'mistral'] as const).filter(id => settings.multiProvider.credentials[id]?.enabled);
		return candidates.some(id => TtsAdapter.supportsProvider(id));
	}

	private async speakViaProvider(text: string, preferred?: import('../providers/provider-types').ProviderId): Promise<void> {
		const providerId = this.resolveTtsProvider(preferred);
		if (!providerId) throw new Error('No TTS-capable provider enabled.');
		this.ttsAbort = new AbortController();
		const adapter = new TtsAdapter({
			providerId,
			getSettings: () => this.plugin.settings,
			getApiKey: id => this.plugin.credentialVault.get(id),
			signal: this.ttsAbort.signal,
		});
		const blob = await adapter.synthesize(text, { speed: this.resolveRate() });
		if (this.ttsAbort.signal.aborted) return;
		await playTtsBlob(blob, this.ttsAbort.signal);
	}

	private resolveTtsProvider(preferred?: import('../providers/provider-types').ProviderId): import('../providers/provider-types').ProviderId | undefined {
		const settings = this.plugin.settings;
		const order: import('../providers/provider-types').ProviderId[] = preferred
			? [preferred, ...(['openai', 'openrouter', 'xai', 'mistral'] as const).filter(id => id !== preferred)]
			: ['openai', 'openrouter', 'xai', 'mistral'];
		for (const id of order) {
			if (settings.multiProvider.credentials[id]?.enabled && TtsAdapter.supportsProvider(id)) {
				return id;
			}
		}
		return undefined;
	}

	private speakViaBrowser(text: string): boolean {
		if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') return false;
		const utterance = new SpeechSynthesisUtterance(text);
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
		this.ttsAbort?.abort();
		this.ttsAbort = null;
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
