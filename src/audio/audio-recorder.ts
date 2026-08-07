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
	/** Specific audio input device ID (from enumerateDevices); uses system default if empty. */
	deviceId?: string;
	onStateChange?: AudioRecorderStateCallback;
	onDurationChange?: AudioRecorderDurationCallback;
	onAudioLevel?: AudioRecorderLevelCallback;
	/** Called with each audio chunk as it becomes available (e.g., every timesliceMs). */
	onChunk?: (chunk: Blob, isLast: boolean) => void;
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
	private peakLevel = 0;
	private audioContext: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	// Raw PCM capture (WAV fallback). Populated from the same AudioContext graph
	// that drives the level meter, bypassing the MediaRecorder Opus encoder which
	// on some Windows/Electron builds emits a silent or corrupt track. An
	// AudioWorklet processor (running off the main thread) ships each input
	// block here via its MessagePort; ScriptProcessorNode is deprecated.
	private pcmNode: AudioWorkletNode | null = null;
	private pcmChunks: Float32Array[] = [];
	private pcmSampleRate = 0;
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

	/** Returns the approximate duration of the current recording in milliseconds, or 0 if not recording. */
	getDurationMs(): number {
		if (this.state !== 'recording' || this.startedAt === 0) return 0;
		return Date.now() - this.startedAt;
	}

	/**
	 * Returns the peak RMS audio level observed during recording (0 = silence, 1 = max).
	 * Returns 0 if the recorder is not recording or no level data was collected.
	 */
	getPeakLevel(): number {
		return this.peakLevel;
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
		// If recording is already active but level monitoring was deferred because
		// no listeners existed at start() time, bootstrap it now.
		if (this.state === 'recording' && !this.analyser && !this.levelFrame) {
			void this.bootstrapLevelMonitoring();
		}
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
			// Audio constraints for dictation / transcription capture.
			//
			// echoCancellation stays OFF: on Windows (Chromium / WASAPI) the
			// built-in AEC is aggressive enough to suppress the user's own speech,
			// especially right after audio playback (e.g. cue tones), producing
			// recordings that sound like silence to Whisper.
			//
			// autoGainControl + noiseSuppression stay ON: disabling AGC leaves a
			// low-gain microphone so quiet that Whisper (and hosted derivatives on
			// OpenRouter / xAI) decode the Opus stream as silence and report
			// "no speech detected". AGC normalises quiet input up to an audible
			// level; noise suppression further stabilises it.
			const audioConstraints: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: true, autoGainControl: true };
			const constraints: MediaStreamConstraints = this.options.deviceId
				? { audio: { deviceId: { exact: this.options.deviceId }, ...audioConstraints } }
				: { audio: audioConstraints };
			const stream = await navigator.mediaDevices.getUserMedia(constraints);
			if (generation !== this.startGeneration) {
				for (const track of stream.getTracks()) {
					try { track.stop(); } catch { /* Continue releasing all microphone tracks. */ }
				}
				throw new Error('Audio recording was cancelled.');
			}
			this.stream = stream;
			const recorderOptions: MediaRecorderOptions = {};
			// ── MIME type selection ───────────────────────────────
			// Try codec-qualified types first: they pin the Opus encoder
			// and avoid Chromium's internal fallback, which on some
			// Windows builds produces a WebM container with a silent or
			// corrupt Opus track. If no qualified type is supported,
			// fall back to the user's preferred type, then the browser
			// default.
			const codecQualified = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus'];
			const preferred = this.options.mimeType;
			const chosen =
				codecQualified.find(t => typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(t))
				?? (preferred && typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(preferred) ? preferred : undefined);
			if (chosen) recorderOptions.mimeType = chosen;
			if (this.options.audioBitsPerSecond) recorderOptions.audioBitsPerSecond = this.options.audioBitsPerSecond;

			this.chunks = [];
			this.recordingError = null;
			this.peakLevel = 0;
			this.recorder = new MediaRecorder(this.stream, recorderOptions);
			this.recorder.addEventListener('dataavailable', this.handleData);
			this.recorder.addEventListener('error', this.handleRecorderError);
			// Default timeslice of 1 s ensures the recorder flushes audio data
			// periodically on all platforms. On Windows / Chromium, a recording
			// started with no timeslice can silently drop chunks when the
			// recorder's internal buffer overflows before stop() is called,
			// resulting in a blob that contains only silence.
			this.recorder.start(this.options.timesliceMs ?? 1000);
			this.startedAt = Date.now();
			this.setState('recording');
			this.startProgressMonitoring();
			console.debug(`[CC] AudioRecorder started: mimeType=${this.recorder.mimeType}, timeslice=${this.options.timesliceMs ?? 1000}ms, device=${this.options.deviceId || 'default'}`);
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
			// Use the recorder's actual MIME type (which may differ from the
			// requested type when the browser fell back to a different codec).
			// Drop the options.mimeType fallback — it can disagree with the
			// actual encoded data (e.g. 'audio/webm' requested but recorder
			// fell back to 'audio/ogg;codecs=opus'), producing a Blob whose
			// declared type doesn't match its content. That mismatched Blob
			// is decoded as silence by Whisper and its hosted derivatives.
			const type = recorder.mimeType || this.chunks[0]?.type || 'audio/webm';
			const webmBlob = new Blob(this.chunks, { type });
			// Prefer the uncompressed WAV built from raw PCM: the MediaRecorder Opus
			// path silently produces a corrupt/silent track on some Windows/Electron
			// builds. WAV has no encoder to fail, so Whisper always decodes it.
			const wavBlob = this.buildWavBlob();
			const blob = wavBlob ?? webmBlob;
			console.debug(`[CC] AudioRecorder stopped: ${this.chunks.length} webm chunks (${webmBlob.size}b), pcmSamples=${this.pcmChunks.reduce((n, c) => n + c.length, 0)}, using=${wavBlob ? 'WAV' : 'WEBM'}, blob ${blob.size} bytes, type=${blob.type}, peakLevel=${this.peakLevel.toFixed(4)}`);
			this.chunks = [];
			this.pcmChunks = [];
			this.options.onChunk?.(blob, true);
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
		if (event.data.size > 0) {
			this.chunks.push(event.data);
			this.options.onChunk?.(event.data, false);
		}
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
		console.debug(`[CC] AudioRecorder state: ${this.state} → ${state}`);
		this.state = state;
		for (const listener of this.listeners) {
			try { listener(state); } catch { /* UI callbacks cannot break recorder cleanup. */ }
		}
	}

	private startProgressMonitoring(): void {
		this.emitDuration(0);
		this.durationTimer = window.setInterval(() => this.emitDuration(Date.now() - this.startedAt), 250);
		// Always bootstrap level monitoring so peakLevel is available for the
		// silence guard — even when no UI listeners are registered yet.
		void this.bootstrapLevelMonitoring();
	}

	/**
	 * Bootstrap Web Audio analyser + rAF loop for real-time peak-level tracking.
	 * Called when recording starts with pre-registered listeners, or lazily when
	 * the first listener is added via onAudioLevel() during an active recording.
	 */
	private async bootstrapLevelMonitoring(): Promise<void> {
		if (this.analyser || this.levelFrame || this.state !== 'recording' || !this.stream) return;
		if (typeof AudioContext === 'undefined' || typeof window.requestAnimationFrame === 'undefined') return;
		try {
			this.audioContext = new AudioContext();
			// On Windows/Electron the AudioContext may start in a 'suspended'
			// state (Chromium defers audio rendering until a user gesture or
			// explicit resume). Without this call the analyser never processes
			// samples, leaving peakLevel at 0 and causing the silence guard
			// to reject every recording.
			if (this.audioContext.state === 'suspended') {
				void this.audioContext.resume().catch(() => undefined);
			}
			this.analyser = this.audioContext.createAnalyser();
			this.analyser.fftSize = 256;
			const source = this.audioContext.createMediaStreamSource(this.stream);
			source.connect(this.analyser);
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
				if (level > this.peakLevel) this.peakLevel = level;
				for (const listener of this.levelListeners) {
					try { listener(level); } catch { /* Keep metering after a consumer failure. */ }
				}
				this.levelFrame = window.requestAnimationFrame(sampleLevel);
			};
			// Start the level meter and set the re-entrancy guard before the async
			// worklet setup so a concurrent onAudioLevel() call no-ops.
			this.levelFrame = window.requestAnimationFrame(sampleLevel);
			// Tap raw PCM from the same graph for the WAV fallback via an AudioWorklet
			// (ScriptProcessorNode is deprecated). The processor runs off the main
			// thread and ships each input block here via its MessagePort; we keep the
			// transferred Float32Array as-is.
			try {
				this.pcmSampleRate = this.audioContext.sampleRate;
				this.pcmChunks = [];
				const workletSource = `class PcmCaptureProcessor extends AudioWorkletProcessor {
\tprocess(inputs) {
\t\tconst channel = inputs[0] && inputs[0][0];
\t\tif (channel) {
\t\t\tconst copy = new Float32Array(channel);
\t\t\tthis.port.postMessage(copy, [copy.buffer]);
\t\t}
\t\treturn true;
\t}
}
registerProcessor('pcm-capture-processor', PcmCaptureProcessor);`;
				const blob = new Blob([workletSource], { type: 'application/javascript' });
				const workletUrl = URL.createObjectURL(blob);
				await this.audioContext.audioWorklet.addModule(workletUrl);
				URL.revokeObjectURL(workletUrl);
				const processor = new AudioWorkletNode(this.audioContext, 'pcm-capture-processor');
				processor.port.onmessage = (event): void => {
					if (this.state !== 'recording') return;
					this.pcmChunks.push(event.data as Float32Array);
				};
				source.connect(processor);
				// Connect to destination so the graph is pulled; gain 0 keeps it silent.
				const mute = this.audioContext.createGain();
				mute.gain.value = 0;
				processor.connect(mute).connect(this.audioContext.destination);
				this.pcmNode = processor;
			} catch (error) {
				console.debug('[CC] PCM capture unavailable, falling back to MediaRecorder blob:', error);
				this.pcmNode = null;
			}
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
		if (this.pcmNode) {
			try { this.pcmNode.port.onmessage = null; this.pcmNode.disconnect(); } catch { /* node already torn down */ }
			this.pcmNode = null;
		}
		const context = this.audioContext;
		this.audioContext = null;
		if (context && context.state !== 'closed') void context.close().catch(() => undefined);
	}

	/**
	 * Encode captured raw PCM into a 16-bit mono WAV Blob. Returns null when no
	 * usable PCM was captured (so the caller falls back to the MediaRecorder blob).
	 */
	private buildWavBlob(): Blob | null {
		const total = this.pcmChunks.reduce((n, c) => n + c.length, 0);
		if (total === 0 || this.pcmSampleRate === 0) return null;
		const pcm = new Float32Array(total);
		let offset = 0;
		for (const chunk of this.pcmChunks) { pcm.set(chunk, offset); offset += chunk.length; }
		const sampleRate = this.pcmSampleRate;
		const bytesPerSample = 2;
		const dataSize = pcm.length * bytesPerSample;
		const buffer = new ArrayBuffer(44 + dataSize);
		const view = new DataView(buffer);
		const writeString = (pos: number, str: string): void => { for (let i = 0; i < str.length; i++) view.setUint8(pos + i, str.charCodeAt(i)); };
		writeString(0, 'RIFF');
		view.setUint32(4, 36 + dataSize, true);
		writeString(8, 'WAVE');
		writeString(12, 'fmt ');
		view.setUint32(16, 16, true);          // PCM chunk size
		view.setUint16(20, 1, true);           // audio format = PCM
		view.setUint16(22, 1, true);           // channels = mono
		view.setUint32(24, sampleRate, true);
		view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
		view.setUint16(32, bytesPerSample, true);              // block align
		view.setUint16(34, 16, true);          // bits per sample
		writeString(36, 'data');
		view.setUint32(40, dataSize, true);
		let pos = 44;
		for (let i = 0; i < pcm.length; i++, pos += 2) {
			const s = Math.max(-1, Math.min(1, pcm[i]!));
			view.setInt16(pos, s < 0 ? s * 0x8000 : s * 0x7fff, true);
		}
		return new Blob([buffer], { type: 'audio/wav' });
	}

	private releaseStream(): void {
		this.stopProgressMonitoring();
		for (const track of this.stream?.getTracks() ?? []) {
			try { track.stop(); } catch { /* Continue releasing remaining tracks. */ }
		}
		this.stream = null;
	}
}

/**
 * Enumerate available audio input devices (microphones).
 * Returns an empty array when enumeration is not supported or permission is denied.
 */
export async function getAudioInputDevices(): Promise<MediaDeviceInfo[]> {
	if (!navigator.mediaDevices?.enumerateDevices) return [];
	try {
		const all = await navigator.mediaDevices.enumerateDevices();
		return all.filter(d => d.kind === 'audioinput');
	} catch {
		return [];
	}
}
