/**
 * LiveTranscriber — sequential chunked transcription for near-real-time STT.
 *
 * Records audio in small chunks (~2–4 s) and transcribes each through the
 * existing TranscriberAdapter / provider fallback chain.  Chunks are processed
 * one at a time (FIFO) so that results arrive in order.  The caller receives
 * partial text via onInterim as each chunk is transcribed, and the full
 * accumulated text via onFinal when stop() resolves.
 *
 * No WebSocket or streaming-STT endpoint is required — this works with any
 * OpenAI-compatible /v1/audio/transcriptions provider (OpenRouter, Groq,
 * OpenAI, LM Studio, etc.).
 */

import type CommandCenterPlugin from '../main';
import type { ProviderId } from '../providers/provider-types';

import { AudioRecorder } from './audio-recorder';
import { TranscriberAdapter } from './transcriber';

export type LiveTranscriberState = 'idle' | 'starting' | 'recording' | 'transcribing' | 'stopped' | 'error';

export interface LiveTranscriberCallbacks {
	onInterim?: (text: string) => void;
	onFinal?: (text: string) => void;
	onStateChange?: (state: LiveTranscriberState) => void;
	onError?: (error: Error) => void;
	onDurationChange?: (durationMs: number) => void;
	onAudioLevel?: (level: number) => void;
}

export interface SttCandidate {
	providerId: ProviderId;
	model?: string;
	label: string;
	local: boolean;
}

export interface LiveTranscriberOptions {
	/** Plugin instance for settings and credential vault access. */
	plugin: CommandCenterPlugin;
	/** Ordered list of STT providers/models to try; reuses the same fallback logic as the chat view. */
	candidates: SttCandidate[];
	/** Duration of each audio chunk in milliseconds (default 3000). */
	chunkDurationMs?: number;
	/** Abort signal to cancel the entire live session. */
	signal?: AbortSignal;
	callbacks?: LiveTranscriberCallbacks;
}

export class LiveTranscriber {
	private readonly options: LiveTranscriberOptions;
	private readonly candidates: SttCandidate[];
	private readonly chunkDurationMs: number;
	private readonly callbacks: LiveTranscriberCallbacks;
	private recorder: AudioRecorder | null = null;
	private state: LiveTranscriberState = 'idle';
	private accumulatedText = '';
	private chunkQueue: Blob[] = [];
	private transcribing = false;
	private stopped = false;
	private pendingStop = false;
	private stopResolve: ((text: string) => void) | null = null;
	private stopReject: ((error: Error) => void) | null = null;
	private candidateIndex = 0;
	private signal: AbortSignal | undefined;
	/** Peak audio level during the current chunk window (0–1). Used to skip silent chunks. */
	private peakLevel = 0;
	/** True once we've received at least one audio level sample. */
	private hasLevelData = false;

	/** Minimum audio level required to consider a chunk as containing speech. */
	private readonly SILENCE_THRESHOLD = 0.04;

	constructor(options: LiveTranscriberOptions) {
		this.options = options;
		this.candidates = options.candidates;
		this.chunkDurationMs = options.chunkDurationMs ?? 3000;
		this.callbacks = options.callbacks ?? {};
		this.signal = options.signal;

		if (this.signal?.aborted) throw new Error('Live transcription cancelled.');
		this.signal?.addEventListener('abort', () => { void this.cancel(); }, { once: true });
	}

	getState(): LiveTranscriberState { return this.state; }
	getAccumulatedText(): string { return this.accumulatedText; }

	/** Start recording and begin chunked transcription. */
	async start(): Promise<void> {
		if (this.state !== 'idle') throw new Error(`Cannot start live transcription while ${this.state}.`);
		this.setState('starting');

		const recorder = new AudioRecorder({
			mimeType: 'audio/webm',
			deviceId: this.options.plugin.settings.audioInputDeviceId || undefined,
			timesliceMs: this.chunkDurationMs,
			onChunk: (chunk, isLast) => this.handleChunk(chunk, isLast),
			onDurationChange: ms => this.callbacks.onDurationChange?.(ms),
			onAudioLevel: level => {
				// Track peak level for silence detection.
				if (level > this.peakLevel) this.peakLevel = level;
				if (!this.hasLevelData && level > 0.01) this.hasLevelData = true;
				this.callbacks.onAudioLevel?.(level);
			},
		});
		this.recorder = recorder;

		try {
			await recorder.start();
			if (this.signal?.aborted || this.stopped) {
				await recorder.cancel();
				return;
			}
			this.setState('recording');
		} catch (error) {
			this.recorder = null;
			this.setState('error');
			const err = error instanceof Error ? error : new Error(String(error));
			this.callbacks.onError?.(err);
			throw err;
		}
	}

	/**
	 * Stop recording and wait for all pending chunk transcriptions to finish.
	 * Returns the full accumulated transcription text.
	 */
	async stop(): Promise<string> {
		if (this.stopped) return this.accumulatedText;
		this.stopped = true;
		this.pendingStop = true;

		if (this.recorder) {
			try {
				// The recorder's stop() call will fire onChunk(..., true) for the
				// final accumulated blob, which gets queued.  We keep the recorder
				// reference so the stop event can still fire, but we don't wait for
				// the stop promise since we handle the final chunk via onChunk.
				await this.recorder.stop().catch(() => undefined);
			} catch { /* Final chunk is handled via onChunk(isLast=true). */ }
			this.recorder = null;
		}

		// If a transcription is still in flight, wait for it.
		if (this.transcribing) {
			await new Promise<string>((resolve, reject) => {
				this.stopResolve = resolve;
				this.stopReject = reject;
			});
		}

		this.setState('stopped');
		this.callbacks.onFinal?.(this.accumulatedText);
		return this.accumulatedText;
	}

	/** Cancel immediately; discard any pending transcriptions. */
	async cancel(): Promise<void> {
		this.stopped = true;
		if (this.recorder) {
			await this.recorder.cancel().catch(() => undefined);
			this.recorder = null;
		}
		this.chunkQueue = [];
		this.transcribing = false;
		if (this.stopReject) {
			this.stopReject(new Error('Live transcription cancelled.'));
			this.stopReject = null;
			this.stopResolve = null;
		}
		this.setState('stopped');
	}

	private handleChunk(chunk: Blob, _isLast: boolean): void {
		if (this.stopped) return;
		if (chunk.size === 0) return;

		// Skip silent chunks (no speech detected) to avoid hallucinated filler
		// text from the provider (e.g., "Thank you." for empty audio).
		// Only gate when we have actual level data — if the analyser failed,
		// fall back to transcribing everything.
		if (this.hasLevelData && this.peakLevel < this.SILENCE_THRESHOLD) {
			this.peakLevel = 0;
			return;
		}
		// Reset peak for the next chunk window.
		this.peakLevel = 0;

		this.chunkQueue.push(chunk);
		void this.processQueue();
	}

	private async processQueue(): Promise<void> {
		if (this.transcribing) return;
		if (this.chunkQueue.length === 0) {
			if (this.pendingStop && this.stopResolve) {
				this.stopResolve(this.accumulatedText);
				this.stopResolve = null;
				this.stopReject = null;
			}
			return;
		}

		this.transcribing = true;
		this.setState('transcribing');

		while (this.chunkQueue.length > 0 && !this.stopped) {
			const chunk = this.chunkQueue.shift()!;
			try {
				const text = await this.transcribeChunk(chunk);
				if (text && !this.stopped) {
					// Append with a space separator if the existing text doesn't end with one.
					if (this.accumulatedText && !/\s$/.test(this.accumulatedText)) {
						this.accumulatedText += ' ';
					}
					this.accumulatedText += text;
					this.callbacks.onInterim?.(this.accumulatedText);
				}
			} catch (error) {
				if (this.stopped) return;
				const err = error instanceof Error ? error : new Error(String(error));
				this.callbacks.onError?.(err);
				// Continue with the next chunk on non-fatal errors.
			}
		}

		this.transcribing = false;
		if (this.state === 'transcribing') this.setState('recording');

		// If there are more chunks queued (arrived during transcription), process them.
		if (this.chunkQueue.length > 0) {
			void this.processQueue();
		} else if (this.pendingStop && this.stopResolve) {
			this.stopResolve(this.accumulatedText);
			this.stopResolve = null;
			this.stopReject = null;
		}
	}

	private async transcribeChunk(chunk: Blob): Promise<string> {
		if (this.signal?.aborted) throw new Error('Live transcription cancelled.');

		// Try each candidate in order, like the existing transcribeWithFallback pattern.
		const errors: string[] = [];
		const startIndex = this.candidateIndex;

		for (let i = 0; i < this.candidates.length; i++) {
			const idx = (startIndex + i) % this.candidates.length;
			const candidate = this.candidates[idx]!;
			if (this.signal?.aborted) throw new Error('Live transcription cancelled.');

			try {
				const adapter = new TranscriberAdapter({
					providerId: candidate.providerId,
					getSettings: () => this.options.plugin.settings,
					getApiKey: id => this.options.plugin.credentialVault.get(id),
					defaultModel: candidate.model,
					maxAttempts: candidate.local ? 1 : 2,
					signal: this.signal,
				});
				// For local providers, discover models first.
				if (candidate.local) {
					try { await adapter.fetchLiveAudioModels(); } catch { /* Try implicit model. */ }
				}
				const text = await adapter.transcribe(chunk, candidate.model);
				if (text) {
					// Remember the working candidate for the next chunk.
					this.candidateIndex = idx;
					return text.trim();
				}
			} catch (error) {
				errors.push(`${candidate.label}: ${(error as Error).message}`);
			}
		}
		throw new Error(`All transcription providers failed for live chunk. ${errors.join(' | ')}`);
	}

	private setState(state: LiveTranscriberState): void {
		this.state = state;
		this.callbacks.onStateChange?.(state);
	}
}