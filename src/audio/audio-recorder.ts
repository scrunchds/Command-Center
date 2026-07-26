/** Browser-native microphone recording with deterministic stream cleanup. */

export type AudioRecorderState = 'idle' | 'requesting-permission' | 'recording' | 'stopping';
export type AudioRecorderStateCallback = (state: AudioRecorderState) => void;
export type AudioRecorderDurationCallback = (durationMs: number) => void;
/** Normalized microphone level from 0 (silence) to 1. */
export type AudioRecorderLevelCallback = (level: number) => void;

export interface AudioRecorderOptions {
	/** Preferred container/codec. The browser may fall back to its default. */
	mimeType?: string;
	audioBitsPerSecond?: number;
	timesliceMs?: number;
	onStateChange?: AudioRecorderStateCallback;
	onDurationChange?: AudioRecorderDurationCallback;
	onAudioLevel?: AudioRecorderLevelCallback;
}

export class AudioRecorder {
	private readonly options: AudioRecorderOptions;
	private recorder: MediaRecorder | null = null;
	private stream: MediaStream | null = null;
	private chunks: Blob[] = [];
	private state: AudioRecorderState = 'idle';
	private stopPromise: Promise<Blob> | null = null;
	private recordingError: Error | null = null;
	private startGeneration = 0;
	private startedAt = 0;
	private durationTimer: number | null = null;
	private levelFrame: number | null = null;
	private audioContext: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	private listeners = new Set<AudioRecorderStateCallback>();
	private durationListeners = new Set<AudioRecorderDurationCallback>();
	private levelListeners = new Set<AudioRecorderLevelCallback>();

	constructor(options: AudioRecorderOptions = {}) {
		this.options = options;
		if (options.onStateChange) this.listeners.add(options.onStateChange);
		if (options.onDurationChange) this.durationListeners.add(options.onDurationChange);
		if (options.onAudioLevel) this.levelListeners.add(options.onAudioLevel);
	}

	getState(): AudioRecorderState {
		return this.state;
	}

	isRecording(): boolean {
		return this.state === 'recording';
	}

	/** Exposes the live stream for non-recording consumers such as level meters. */
	getMediaStream(): MediaStream | null {
		return this.stream;
	}

	onStateChange(callback: AudioRecorderStateCallback): () => void {
		this.listeners.add(callback);
		return () => this.listeners.delete(callback);
	}

	onDurationChange(callback: AudioRecorderDurationCallback): () => void {
		this.durationListeners.add(callback);
		return () => this.durationListeners.delete(callback);
	}

	onAudioLevel(callback: AudioRecorderLevelCallback): () => void {
		this.levelListeners.add(callback);
		return () => this.levelListeners.delete(callback);
	}

	async start(): Promise<void> {
		if (this.state !== 'idle') throw new Error(`Cannot start audio recording while ${this.state}.`);
		if (!navigator.mediaDevices?.getUserMedia) {
			throw new Error('Microphone recording is not supported in this environment.');
		}
		if (typeof MediaRecorder === 'undefined') {
			throw new Error('MediaRecorder is not supported in this environment.');
		}

		const generation = ++this.startGeneration;
		this.setState('requesting-permission');
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			if (generation !== this.startGeneration) {
				for (const track of stream.getTracks()) {
					try { track.stop(); } catch { /* Continue releasing all microphone tracks. */ }
				}
				throw new Error('Audio recording was cancelled.');
			}
			this.stream = stream;
			const recorderOptions: MediaRecorderOptions = {};
			const preferred = this.options.mimeType;
			if (preferred && (!MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(preferred))) {
				recorderOptions.mimeType = preferred;
			}
			if (this.options.audioBitsPerSecond) recorderOptions.audioBitsPerSecond = this.options.audioBitsPerSecond;

			this.chunks = [];
			this.recordingError = null;
			this.recorder = new MediaRecorder(this.stream, recorderOptions);
			this.recorder.addEventListener('dataavailable', this.handleData);
			this.recorder.addEventListener('error', this.handleRecorderError);
			this.recorder.start(this.options.timesliceMs);
			this.startedAt = Date.now();
			this.setState('recording');
			this.startProgressMonitoring();
		} catch (error) {
			this.releaseStream();
			this.recorder = null;
			if (this.state !== 'idle') this.setState('idle');
			if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
				throw new Error(`Microphone permission was denied: ${error.message}`);
			}
			throw error;
		}
	}

	stop(): Promise<Blob> {
		if (this.stopPromise) return this.stopPromise;
		const recorder = this.recorder;
		if (!recorder || this.state !== 'recording') {
			const error = this.recordingError ?? new Error('No audio recording is active.');
			this.recordingError = null;
			return Promise.reject(error);
		}

		this.setState('stopping');
		let resolveStop!: (blob: Blob) => void;
		let rejectStop!: (error: Error) => void;
		const promise = new Promise<Blob>((resolve, reject) => {
			resolveStop = resolve;
			rejectStop = reject;
		});
		this.stopPromise = promise;

		const cleanup = (): void => {
			recorder.removeEventListener('dataavailable', this.handleData);
			recorder.removeEventListener('error', this.handleRecorderError);
			recorder.removeEventListener('error', handleStopError);
			recorder.removeEventListener('stop', handleStop);
			this.releaseStream();
			this.recorder = null;
			this.stopPromise = null;
			this.setState('idle');
		};
		const handleStopError = (event: Event): void => {
			const mediaError = (event as Event & { error?: DOMException }).error;
			this.chunks = [];
			cleanup();
			rejectStop(mediaError ?? new Error('Audio recording failed.'));
		};
		const handleStop = (): void => {
			const type = recorder.mimeType || this.options.mimeType || this.chunks[0]?.type || 'audio/webm';
			const blob = new Blob(this.chunks, { type });
			this.chunks = [];
			cleanup();
			resolveStop(blob);
		};
		recorder.addEventListener('stop', handleStop, { once: true });
		recorder.addEventListener('error', handleStopError, { once: true });
		try {
			recorder.stop();
		} catch (error) {
			this.chunks = [];
			cleanup();
			rejectStop(error instanceof Error ? error : new Error(String(error)));
		}
		return promise;
	}

	/** Stop capture and discard any audio. Safe during permission, recording, or stop. */
	async cancel(): Promise<void> {
		this.startGeneration++;
		if (this.stopPromise) {
			await this.stopPromise.then(() => undefined, () => undefined);
			return;
		}
		if (this.state === 'recording') {
			await this.stop().then(() => undefined, () => undefined);
			return;
		}
		this.chunks = [];
		this.recordingError = null;
		this.recorder?.removeEventListener('dataavailable', this.handleData);
		this.recorder?.removeEventListener('error', this.handleRecorderError);
		this.recorder = null;
		this.releaseStream();
		if (this.state !== 'idle') this.setState('idle');
	}

	private readonly handleData = (event: BlobEvent): void => {
		if (event.data.size > 0) this.chunks.push(event.data);
	};

	private readonly handleRecorderError = (event: Event): void => {
		const mediaError = (event as Event & { error?: DOMException }).error;
		this.recordingError = mediaError ?? new Error('Audio recording failed.');
		// If stop() is already settling, its stop event remains authoritative.
		if (this.state === 'stopping') return;
		this.chunks = [];
		this.recorder?.removeEventListener('dataavailable', this.handleData);
		this.recorder?.removeEventListener('error', this.handleRecorderError);
		this.recorder = null;
		this.releaseStream();
		this.setState('idle');
	};

	private setState(state: AudioRecorderState): void {
		this.state = state;
		for (const listener of this.listeners) {
			try { listener(state); } catch { /* UI callbacks cannot break recorder cleanup. */ }
		}
	}

	private startProgressMonitoring(): void {
		this.emitDuration(0);
		this.durationTimer = window.setInterval(() => this.emitDuration(Date.now() - this.startedAt), 250);
		if (this.levelListeners.size === 0 || typeof AudioContext === 'undefined' || typeof window.requestAnimationFrame === 'undefined' || !this.stream) return;
		try {
			this.audioContext = new AudioContext();
			this.analyser = this.audioContext.createAnalyser();
			this.analyser.fftSize = 256;
			this.audioContext.createMediaStreamSource(this.stream).connect(this.analyser);
			const samples = new Uint8Array(this.analyser.fftSize);
			const sampleLevel = (): void => {
				if (!this.analyser || this.state !== 'recording') return;
				this.analyser.getByteTimeDomainData(samples);
				let sum = 0;
				for (const sample of samples) {
					const normalized = (sample - 128) / 128;
					sum += normalized * normalized;
				}
				const level = Math.min(1, Math.sqrt(sum / samples.length));
				for (const listener of this.levelListeners) {
					try { listener(level); } catch { /* Keep metering after a consumer failure. */ }
				}
				this.levelFrame = window.requestAnimationFrame(sampleLevel);
			};
			this.levelFrame = window.requestAnimationFrame(sampleLevel);
		} catch {
			// Duration updates remain available when Web Audio metering is unavailable.
			this.analyser = null;
			const context = this.audioContext;
			this.audioContext = null;
			if (context && context.state !== 'closed') void context.close().catch(() => undefined);
		}
	}

	private emitDuration(durationMs: number): void {
		for (const listener of this.durationListeners) {
			try { listener(Math.max(0, durationMs)); } catch { /* Keep recorder timers isolated. */ }
		}
	}

	private stopProgressMonitoring(): void {
		if (this.durationTimer !== null) window.clearInterval(this.durationTimer);
		this.durationTimer = null;
		if (this.levelFrame !== null && typeof window.cancelAnimationFrame !== 'undefined') window.cancelAnimationFrame(this.levelFrame);
		this.levelFrame = null;
		this.analyser = null;
		const context = this.audioContext;
		this.audioContext = null;
		if (context && context.state !== 'closed') void context.close().catch(() => undefined);
	}

	private releaseStream(): void {
		this.stopProgressMonitoring();
		for (const track of this.stream?.getTracks() ?? []) {
			try { track.stop(); } catch { /* Continue releasing remaining tracks. */ }
		}
		this.stream = null;
	}
}
