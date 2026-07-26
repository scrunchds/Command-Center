/**
 * PiAgentDaemon — spawns and communicates with a `pi --mode rpc` subprocess.
 *
 * Strict JSONL framing (LF-only delimiter, no readline) as required by
 * the RPC protocol. Supports request/response, streaming event handling,
 * tool-call interception, and first-class ReAct (Reason+Act) multi-agent
 * sessions that hold the single-task lock for the entire loop.
 *
 * Auto-detection of the pi binary path is provided via the static
 * `detectPiPath()` method, which checks common locations, npm global
 * prefix, and PATH before falling back to the default "pi".
 */

import * as crypto from 'crypto';
import { spawn, execSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import type { AgentTaskPayload, AgentTaskResponse, ToolConfirmationHandler, ToolDefinition } from './types';
import { TOKEN_LIMITS } from './types';
import type {
	ReActContext, ReActCycle, ReActThought, ReActAction,
	ReActObservation, ReActConfig, ReActMeta, WorkerReActResult,
	ValidationOutcome, ValidationEvent,
} from './react/react-types';
import { DEFAULT_REACT_CONFIG } from './react/react-types';
import {
	buildReActOrchestratorPrompt,
	buildReActFinalSynthesisPrompt,
	buildWorkerReActPrompt,
	parseReActResponse,
} from './react/react-orchestrator';
import { buildRolePrompt, filterToolsForRole, getRole, tryRegisterDynamicRole } from './react/react-roles';
import { ReActEvaluator } from './react/react-eval';
import {
	withTimeout, withRetry, withFallback, CircuitBreaker, DeadlockDetector,
	SafeStateManager, getToolTimeout, getAlternativeTools, determineRecovery,
} from './react/react-recovery';
import { ReActStepController, ReActTraceCollector, type TraceEventCallback, type ReActTraceEvent, type ReActTraceDetail, type TraceToolInvocation } from './react/react-trace';
import { FileBusyError, normalizeLockPath } from './file-lock';
import type { AgentMemoryStore } from './memory/memory-store';
import type { HybridRetriever } from './rag/hybrid-retriever';
import { injectRagContext } from './rag/rag-tool';

/* ═══════════════════════════════════════════════════════════
   Pi Binary Auto-Detection
   ═══════════════════════════════════════════════════════════ */

/**
 * Default pi binary name (looked up in PATH).
 */
export const DEFAULT_PI_BINARY = 'pi';

/** Completion signal used by the Obsidian host to synchronize note properties. */
export interface AgentExecutionState {
	targetPath: string;
	status: 'completed' | 'failed';
	evalScore?: number;
	completedAt: number;
	workerProfile: string;
}

export type AgentExecutionStateCallback = (state: AgentExecutionState) => void;

/**
 * Auto-detect the path to the pi CLI binary.
 *
 * Strategy (from fastest to slowest):
 *   1. If `candidate` is an absolute path, verify it.
 *   2. Run `where pi` (Windows) / `which pi` (macOS/Linux) — most reliable.
 *   3. Check common npm locations (%APPDATA%\npm, /usr/local/bin, etc).
 *   4. Try cached result from previous successful detection.
 *   5. Fall back to bare "pi" — let spawn handle the error.
 *
 * On Windows, we ALWAYS prefer the `.cmd` wrapper file because
 * `child_process.spawn` needs the .cmd extension to properly launch
 * via cmd.exe for npm-installed global binaries.
 *
 * Returns the validated path (with .cmd on Windows), the bare `"pi"` string,
 * or null if nothing worked. String result is always truthy.
 */
export function detectPiPath(candidate?: string): string | null {
	// Helper: on Windows, ensure we have a .cmd path
	const ensureCmd = (p: string): string => {
		if (process.platform !== 'win32') return p;
		if (p.endsWith('.cmd') || p.endsWith('.bat') || p.endsWith('.exe')) return p;
		const cmdPath = p + '.cmd';
		if (fs.existsSync(cmdPath)) return cmdPath;
		const batPath = p + '.bat';
		if (fs.existsSync(batPath)) return batPath;
		return p; // fall back to original
	};

	// ── Step 1: Verify explicit candidate path ──
	if (candidate && candidate !== DEFAULT_PI_BINARY) {
		try {
			const resolved = ensureCmd(candidate);
			if (fs.existsSync(resolved)) {
				cacheResult(resolved);
				return resolved;
			}
		} catch { /* not found */ }
	}

	// ── Step 2: Use cached result ──
	if (_detectionCache) {
		try {
			if (_detectionCache !== DEFAULT_PI_BINARY && fs.existsSync(_detectionCache)) {
				return _detectionCache;
			}
		} catch { /* cache invalid, continue */ }
	}

	// ── Step 3: `where pi` / `which pi` — reliable PATH lookup ──
	try {
		const cmd = process.platform === 'win32' ? 'where' : 'which';
		const result = execSync(`${cmd} ${DEFAULT_PI_BINARY}`, {
			encoding: 'utf-8',
			timeout: 4000,
		}).trim();
		if (result && !result.includes('not found') && !result.includes('Could not find')) {
			// On Windows, iterate results and prefer the .cmd file
			const lines = result.split('\n').map(l => l.trim()).filter(Boolean);
			for (const line of lines) {
				const resolved = ensureCmd(line);
				try {
					if (fs.existsSync(resolved)) {
						cacheResult(resolved);
						return resolved;
					}
				} catch { /* try next line */ }
			}
			// If no path resolved but 'where' confirmed it's in PATH, return "pi"
			cacheResult(DEFAULT_PI_BINARY);
			return DEFAULT_PI_BINARY;
		}
	} catch {
		// 'where'/'which' failed — fall through to common locations
	}

	// ── Step 4: Check common npm locations ──
	const commonLocations = getCommonPiLocations();
	for (const loc of commonLocations) {
		try {
			const resolved = ensureCmd(loc);
			if (fs.existsSync(resolved)) {
				cacheResult(resolved);
				return resolved;
			}
		} catch { /* try next */ }
	}

	// ── Step 5: npm root -g ──
	try {
		const npmRoot = execSync('npm root -g', { encoding: 'utf-8', timeout: 5000 }).trim();
		if (npmRoot && !npmRoot.toLowerCase().includes('err')) {
			const binDir = path.resolve(npmRoot, '..', 'bin');
			const piPath = path.join(binDir, process.platform === 'win32' ? 'pi.cmd' : 'pi');
			if (fs.existsSync(piPath)) {
				cacheResult(piPath);
				return piPath;
			}
		}
	} catch { /* npm not available */ }

	// ── Step 6: PATH directory scan (from env) ──
	const binaryName = process.platform === 'win32' ? 'pi.cmd' : 'pi';
	const pathEnv = process.env.PATH || '';
	const pathSeparator = process.platform === 'win32' ? ';' : ':';
	for (const dir of pathEnv.split(pathSeparator)) {
		const candidatePath = path.join(dir.trim(), binaryName);
		try {
			if (fs.existsSync(candidatePath)) {
				cacheResult(candidatePath);
				return candidatePath;
			}
		} catch { /* try next */ }
	}

	// ── Final fallback ──
	return DEFAULT_PI_BINARY;
}

/** Cache for the last successful detection result. */
let _detectionCache: string | null = null;

function cacheResult(result: string): void {
	_detectionCache = result;
}

/** Locate the real Node.js executable (process.execPath may be Obsidian.exe in Electron). */
function detectNodeExecutable(): string | null {
	// In plain Node/test environments, process.execPath is already correct.
	if (/node(?:\.exe)?$/i.test(process.execPath) && fs.existsSync(process.execPath)) {
		return process.execPath;
	}

	try {
		const cmd = process.platform === 'win32' ? 'where node' : 'which node';
		const result = execSync(cmd, { encoding: 'utf-8', timeout: 4000 }).trim();
		for (const line of result.split('\n').map(v => v.trim()).filter(Boolean)) {
			if (fs.existsSync(line)) return line;
		}
	} catch { /* try common locations */ }

	const candidates = process.platform === 'win32'
		? [
			process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'nodejs', 'node.exe') : '',
			process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe') : '',
		]
		: ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node'];
	for (const candidate of candidates) {
		if (candidate && fs.existsSync(candidate)) return candidate;
	}
	return null;
}

/** Clear the detection cache (e.g., after npm global install). */
export function clearPiDetectionCache(): void {
	_detectionCache = null;
}

/**
 * Get a list of common platform-specific locations where pi might be installed.
 * Prioritizes known npm global install directories.
 */
function getCommonPiLocations(): string[] {
	const locations: string[] = [];
	const binaryName = process.platform === 'win32' ? 'pi.cmd' : 'pi';

	const npmPrefixes: string[] = [];

	// Windows: %APPDATA%\npm (most common for global npm on Windows)
	if (process.env.APPDATA) {
		npmPrefixes.push(path.join(process.env.APPDATA, 'npm'));
	}
	// macOS: /usr/local/lib/node_modules, /opt/homebrew/lib/node_modules
	if (process.platform === 'darwin') {
		npmPrefixes.push('/usr/local');
		npmPrefixes.push('/usr/local/lib');
		npmPrefixes.push('/opt/homebrew');
		npmPrefixes.push('/opt/homebrew/lib');
	}
	// Linux: /usr/local/lib/node_modules, /usr/lib/node_modules
	if (process.platform === 'linux') {
		npmPrefixes.push('/usr/local');
		npmPrefixes.push('/usr');
	}
	// User home directory
	if (process.env.HOME) {
		npmPrefixes.push(path.join(process.env.HOME, '.npm-global'));
	}

	// Generate locations: {prefix}/pi.cmd, {prefix}/bin/pi.cmd, {prefix}/node_modules/.bin/pi.cmd
	for (const prefix of npmPrefixes) {
		if (!prefix) continue;
		locations.push(path.join(prefix, binaryName));
		locations.push(path.join(prefix, 'bin', binaryName));
		locations.push(path.join(prefix, 'node_modules', '.bin', binaryName));
	}

	// Remove duplicates
	return [...new Set(locations)];
}

/* ─── RPC Event Interfaces ────────────────────────────── */

interface RpcContentBlock {
	type: string;
	text?: string;
}

interface RpcMessage {
	role: string;
	content?: RpcContentBlock[];
	usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
}

interface RpcAssistantMessageEvent {
	type: 'text_delta' | 'text_end';
	delta?: string;
	content?: string;
}

interface RpcToolPartialResult {
	content?: RpcContentBlock[];
}

interface RpcEvent {
	type: string;
	id?: string;
	/** Legacy bridge compatibility; Pi 0.82 events omit taskId. */
	taskId?: string;
	command?: string;
	success?: boolean;
	error?: string;
	assistantMessageEvent?: RpcAssistantMessageEvent;
	partialResult?: RpcToolPartialResult;
	messages?: RpcMessage[];
	willRetry?: boolean;
}

export type StreamCallback = (delta: string, taskId: string) => void;

/** Streaming events emitted during a ReAct session. */
export interface ReActStreamEvent {
	type: 'thought' | 'action_start' | 'action_complete' | 'observation' | 'final_answer' | 'error';
	cycleIndex: number;
	data: string;
	meta?: Record<string, unknown>;
}

export type ReActSessionCallback = (event: ReActStreamEvent) => void;

export class PiAgentDaemon {
	private piProcess: ChildProcess | null = null;
	private responseHandlers = new Map<string, (response: AgentTaskResponse) => void>();
	private toolHandlers = new Map<string, ToolDefinition>();
	private toolConfirmationHandler: ToolConfirmationHandler | null = null;
	/** Paths claimed by write-capable parallel actions in the active ReAct cycle. */
	private cycleWriteClaims = new Map<string, { worker: string; cycleIndex: number }>();
	private streamCallback: StreamCallback | null = null;
	/** Pi RPC 0.82 has one active prompt per subprocess session. */
	private activePromptTaskId: string | null = null;
	private latestAgentMessages: RpcMessage[] = [];
	/** Full prompt/tool audit data keyed by the active RPC task. */
	private rpcAudit = new Map<string, { inputPrompt: string; toolInvocations: TraceToolInvocation[] }>();
	/** Active tasks tracked for lifecycle/error cleanup. */
	private activeTasks = new Set<string>();
	/** Serialize prompts because Pi RPC 0.82 has one active run per session. */
	private rpcTaskChain: Promise<void> = Promise.resolve();
	/** Active ReAct session ID — only one session at a time. */
	private activeSessionId: string | null = null;
	private _workspacePath: string;
	private _piPath: string;
	/** Raw JSONL bytes retained between stdout chunks. */
	private stdoutBuffer: Buffer = Buffer.alloc(8192);
	private stdoutReadOffset = 0;
	private stdoutWriteOffset = 0;
	/** Stateful UTF-8 decoding prevents split multi-byte characters from being corrupted. */
	private stdoutDecoder = new StringDecoder('utf8');
	/** Buffered stderr tail for diagnostics without printing Pi output. */
	private stderrBuffer: string = '';
	private stderrDecoder = new StringDecoder('utf8');
	/** Tracks old child processes intentionally stopped during stop/restart. */
	private intentionallyStopped = new WeakSet<ChildProcess>();
	startError: string | null = null;

	/** Public trace collector — the view attaches its callback here. */
	readonly trace = new ReActTraceCollector();

	/** Add a trace subscriber without displacing dashboard/chat listeners. */
	addTraceListener(callback: TraceEventCallback): () => void {
		return this.trace.addListener(callback);
	}
	/** Cooperative debug gate; waits only at completed outer-cycle boundaries. */
	readonly stepController = new ReActStepController();

	/** Public evaluator — scores agent performance and provides optimization hints. */
	readonly evaluator = new ReActEvaluator();
	private executionStateCallback: AgentExecutionStateCallback | null = null;
	private memoryStore: AgentMemoryStore | null = null;
	private retriever: HybridRetriever | null = null;
	private contextCharLimit = 8_000;

	/** Recovery infrastructure. */
	readonly circuitBreaker = new CircuitBreaker();
	readonly deadlockDetector = new DeadlockDetector();
	readonly safeState = new SafeStateManager();

	constructor(workspacePath: string, piPath: string = 'pi') {
		this._workspacePath = workspacePath;
		this._piPath = piPath;
	}

	get workspacePath(): string { return this._workspacePath; }
	get piPath(): string { return this._piPath; }

	/** Attach the vault host's debounced frontmatter synchronization callback. */
	setExecutionStateCallback(callback: AgentExecutionStateCallback | null): void {
		this.executionStateCallback = callback;
	}

	/** Attach vault-native long-term memory for prompt injection/session learning. */
	setMemoryStore(store: AgentMemoryStore | null): void { this.memoryStore = store; }
	/** Attach passive hybrid retrieval. The limit bounds all injected memory + RAG text. */
	setRetriever(retriever: HybridRetriever | null, contextCharLimit = 8_000): void {
		this.retriever = retriever;
		this.contextCharLimit = Math.max(0, contextCharLimit);
	}

	setDebugStepMode(enabled: boolean): void { this.stepController.setEnabled(enabled); }
	isDebugStepMode(): boolean { return this.stepController.isEnabled(); }
	isDebugStepPaused(): boolean { return this.stepController.isPaused(); }
	nextDebugStep(): boolean { return this.stepController.nextStep(); }
	resumeDebugSession(): boolean { return this.stepController.resume(); }

	/**
	 * Update the pi binary path. If running, stops the current process first.
	 * Returns false if there are active tasks (preventing orphaned handlers).
	 */
	setPiPath(newPath: string): boolean {
		if (this.activeTasks.size > 0) return false;
		const wasRunning = this.isRunning();
		if (wasRunning) this.stop();
		this._piPath = newPath;
		this.startError = null;
		return true;
	}

	/* ─── Lifecycle ─────────────────────────────────── */

	start(): void {
		if (this.piProcess) return;
		this.startError = null;
		this.resetStdoutBuffer();
		this.stderrBuffer = '';
		this.stdoutDecoder = new StringDecoder('utf8');
		this.stderrDecoder = new StringDecoder('utf8');

		// Pi 0.82 uses the child process cwd as the workspace; --workspace is not
		// a valid CLI option. --no-session avoids persisting plugin bridge turns.
		const rpcArgs = ['--mode', 'rpc', '--no-session', '--approve'];
		const launch = this.resolveLaunchCommand(rpcArgs);

		try {
			const child = spawn(launch.command, launch.args, {
				// Pipe stderr instead of inheriting it: Pi stays fully silent, while a
				// small tail remains available for actionable UI diagnostics.
				stdio: ['pipe', 'pipe', 'pipe'],
				env: { ...process.env },
				cwd: this._workspacePath,
				windowsHide: true,
			});
			this.piProcess = child;

			if (!child.stdout) {
				return this.setError('Failed to open stdout for Pi Harness daemon.');
			}

			child.stderr?.on('data', (chunk: Buffer | string) => {
				this.stderrBuffer += typeof chunk === 'string' ? chunk : this.stderrDecoder.write(chunk);
				// Keep only the last 8 KB so a noisy provider cannot grow memory forever.
				if (this.stderrBuffer.length > 8192) this.stderrBuffer = this.stderrBuffer.slice(-8192);
			});
			child.stderr?.on('end', () => {
				this.stderrBuffer += this.stderrDecoder.end();
				if (this.stderrBuffer.length > 8192) this.stderrBuffer = this.stderrBuffer.slice(-8192);
			});

			child.stdout.on('data', (chunk: Buffer | string) => this.consumeStdoutChunk(chunk));
			// JSONL normally ends each frame with LF. Also accept one complete final
			// frame without LF when the subprocess closes its stdout.
			child.stdout.on('end', () => this.consumeStdoutChunk(Buffer.alloc(0), true));

			child.on('exit', (code, signal) => {
				const intentional = this.intentionallyStopped.has(child);
				this.intentionallyStopped.delete(child);
				// Do not let a late exit from an old process clear a newly started one.
				if (this.piProcess === child) this.piProcess = null;
				this.resetStdoutBuffer();
				if (!intentional) {
					const detail = this.stderrBuffer.trim().slice(-1000);
					const reason = `Daemon exited unexpectedly (code ${code ?? 'none'}${signal ? `, signal ${signal}` : ''})`;
					this.startError = detail ? `${reason}: ${detail}` : `${reason}.`;
					this.cancelAllHandlers(this.startError);
				}
				this.activeTasks.clear();
				this.activePromptTaskId = null;
				this.latestAgentMessages = [];
				this.streamCallback = null;
			});

			child.on('error', (err) => {
				this.setError(`Pi binary error: ${err.message}`);
			});
		} catch (err) {
			this.setError(`Failed to start pi daemon: ${(err as Error).message}`);
		}
	}

	/**
	 * Resolve the actual executable used to launch Pi.
	 *
	 * npm global installs on Windows expose a `pi.cmd` wrapper. Directly passing
	 * that wrapper to child_process.spawn() throws EINVAL on Node 24. When the
	 * wrapper is detected, launch its underlying JavaScript CLI with the current
	 * Node executable instead. This also avoids shell quoting/injection issues.
	 */
	private resolveLaunchCommand(rpcArgs: string[]): { command: string; args: string[] } {
		// Portable JS entry points are useful for packaged CLIs and the CI RPC
		// harness. Invoke them with Node rather than relying on executable bits,
		// shebang handling, or platform-specific file associations.
		if (/\.(?:c?js|mjs)$/i.test(this._piPath)) {
			const nodeExecutable = detectNodeExecutable();
			if (nodeExecutable) return { command: nodeExecutable, args: [this._piPath, ...rpcArgs] };
		}
		if (process.platform === 'win32' && /\.cmd$/i.test(this._piPath)) {
			const cliPath = path.join(
				path.dirname(this._piPath),
				'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js',
			);
			const nodeExecutable = detectNodeExecutable();
			if (fs.existsSync(cliPath) && nodeExecutable) {
				return { command: nodeExecutable, args: [cliPath, ...rpcArgs] };
			}

			// Generic fallback for a custom npm .cmd wrapper. Invoke cmd.exe
			// explicitly without shell:true; each user-controlled value is quoted.
			const comspec = process.env.ComSpec || 'cmd.exe';
			const quote = (value: string): string => `"${value.replace(/"/g, '""')}"`;
			const commandLine = [quote(this._piPath), ...rpcArgs.map(quote)].join(' ');
			return { command: comspec, args: ['/d', '/s', '/c', commandLine] };
		}
		return { command: this._piPath, args: rpcArgs };
	}

	private setError(msg: string): void {
		this.startError = msg;
		console.error('[CC]', msg);
		if (this.piProcess) {
			const child = this.piProcess;
			this.intentionallyStopped.add(child);
			try { child.kill(); } catch { /* */ }
			this.piProcess = null;
		}
		this.resetStdoutBuffer();
	}

	/** Whether the error is specifically a missing binary (ENOENT/not found). */
	isBinaryMissing(): boolean {
		return this.startError !== null && /ENOENT|command not found|cannot find the file|not found/i.test(this.startError);
	}

	stop(): void {
		if (this.piProcess) {
			const child = this.piProcess;
			this.intentionallyStopped.add(child);
			child.kill('SIGTERM');
			this.piProcess = null;
		}
		// Cancel all pending RPC handlers so they don't hang forever
		this.cancelAllHandlers('Daemon stopped.');
		this.resetStdoutBuffer();
		this.activeTasks.clear();
		this.activePromptTaskId = null;
		this.latestAgentMessages = [];
		this.streamCallback = null;
		this.stepController.cancel();
		this.circuitBreaker.reset();
		this.deadlockDetector.reset('orchestrator');
	}

	/** Reject all pending response handlers with a consistent error. */
	private cancelAllHandlers(reason: string): void {
		for (const [id, handler] of this.responseHandlers) {
			this.responseHandlers.delete(id);
			try { handler({ taskId: id, complete: true, error: reason }); } catch { /* guard */ }
		}
	}

	isRunning(): boolean {
		return this.piProcess !== null && this.piProcess.exitCode === null;
	}

	/* ─── Tool Registration ─────────────────────────── */

	registerTools(tools: ToolDefinition[]): void {
		for (const tool of tools) this.toolHandlers.set(tool.name, tool);
	}

	/** Install a UI confirmation bridge for destructive tool invocations. */
	setToolConfirmationHandler(handler: ToolConfirmationHandler | null): void {
		this.toolConfirmationHandler = handler;
	}

	/* ─── Single-task execution (public) ────────────── */

	executeTask(payload: AgentTaskPayload, onStream?: StreamCallback): Promise<AgentTaskResponse> {
		return this._sendTask(
			{
				profile: payload.workerProfile,
				prompt: payload.prompt,
				target: payload.targetPath,
				tools: payload.tools,
			},
			payload.taskId,
			onStream,
			true, // acquire lock
		).then(response => {
			if (payload.targetPath) {
				this.notifyExecutionState({
					targetPath: payload.targetPath,
					status: response.error ? 'failed' : 'completed',
					completedAt: Date.now(),
					workerProfile: payload.workerProfile,
				});
			}
			return response;
		}, error => {
			if (payload.targetPath) {
				this.notifyExecutionState({
					targetPath: payload.targetPath,
					status: 'failed', completedAt: Date.now(), workerProfile: payload.workerProfile,
				});
			}
			throw error;
		});
	}

	/* ─── ReAct Session (public) ────────────────────── */

	/**
	 * Execute a full multi-agent ReAct loop within the daemon.
	 *
	 * Acquires the single-task lock once and holds it for the entire
	 * Reason→Act→Observe cycle. Each sub-task (orchestrator reasoning,
	 * worker invocation) uses the internal `_sendTask()` primitive
	 * without re-acquiring the lock.
	 *
	 * Workers collaborate implicitly through the shared ReActContext
	 * which accumulates all thoughts, actions, and observations across
	 * cycles. The orchestrator sees the full history each iteration.
	 */
	async executeReActSession(
		task: string,
		targetPath: string | undefined,
		tools: ToolDefinition[],
		config: ReActConfig = DEFAULT_REACT_CONFIG,
		onStream?: ReActSessionCallback,
	): Promise<AgentTaskResponse> {
		const sessionId = crypto.randomUUID();
		const originalTask = task;
		const context = await this.buildPassiveContext(task);
		if (context) task = `${context}\n\n## Current Request\n${task}`;
		// Include host-registered tools (notably searchVault) while preserving any
		// execution-specific tools supplied by chat/workflows.
		const toolsByName = new Map<string, ToolDefinition>();
		for (const tool of [...this.toolHandlers.values(), ...tools]) toolsByName.set(tool.name, tool);
		tools = [...toolsByName.values()];

		// Validate and acquire lock
		if (this.startError) return { taskId: sessionId, complete: true, error: `Daemon failed: ${this.startError}` };
		if (!this.piProcess?.stdin) return { taskId: sessionId, complete: true, error: 'Daemon not running.' };
		if (this.activeSessionId) return { taskId: sessionId, complete: true, error: `Session ${this.activeSessionId.slice(0, 8)} already active.` };
		if (task.length > TOKEN_LIMITS.MAX_PROMPT_CHARS) {
			return { taskId: sessionId, complete: true, error: `Prompt too large (${task.length} chars).` };
		}

		this.activeSessionId = sessionId;

		// Trace: session start
		const sessionTraceId = this._emitTrace(sessionId, null, 'orchestrator', 'session:start', -1, -1, 'ReAct Session', task, undefined, { inputPrompt: task }).id;

		// Initialize context
		const meta: ReActMeta = {
			startedAt: Date.now(), completedAt: 0, totalCycles: 0,
			daemonCalls: 0, toolCalls: 0, termination: 'error',
		};

		const ctx: ReActContext = {
			sessionId, task, targetPath, cycles: [], meta,
		};
		const evaluationStart = this.evaluator.getHistory().totalEvaluations;

		try {
			for (let i = 0; i < config.maxCycles; i++) {
				const cycleTraceId = this._emitTrace(sessionId, sessionTraceId, 'orchestrator', 'cycle:start', i, -1, `Cycle ${i + 1}`, '').id;

				const cycle = await this._executeReActCycle(ctx, i, tools, config, onStream, sessionId, cycleTraceId);
				ctx.cycles.push(cycle);
				meta.totalCycles = i + 1;
				meta.daemonCalls += 2; // one for reason, one for act

				if (cycle.thought.assessment === 'complete' && cycle.thought.confidence >= config.confidenceThreshold) {
					meta.termination = 'final_answer';
					meta.completedAt = Date.now();
					this._emitTrace(sessionId, cycleTraceId, 'orchestrator', 'cycle:end', i, -1, '✅ Complete', cycle.thought.finalAnswer ?? '');
					onStream?.({ type: 'final_answer', cycleIndex: i, data: cycle.thought.finalAnswer ?? cycle.thought.reasoning });
					this._emitTrace(sessionId, sessionTraceId, 'orchestrator', 'session:end', -1, -1, 'Session Complete', `Termination: ${meta.termination}`);
					return this._buildReActResponse(sessionId, ctx);
				}

				if (cycle.thought.assessment === 'stuck') {
					meta.termination = 'stuck';
					meta.completedAt = Date.now();
					this._emitTrace(sessionId, cycleTraceId, 'orchestrator', 'cycle:end', i, -1, '⚠️ Stuck', cycle.thought.finalAnswer ?? '');
					if (cycle.thought.finalAnswer) {
						onStream?.({ type: 'final_answer', cycleIndex: i, data: cycle.thought.finalAnswer });
					}
					this._emitTrace(sessionId, sessionTraceId, 'orchestrator', 'session:end', -1, -1, 'Session Ended (Stuck)', `Termination: stuck`);
					return this._buildReActResponse(sessionId, ctx);
				}

				this._emitTrace(sessionId, cycleTraceId, 'orchestrator', 'cycle:end', i, -1, `Cycle ${i + 1} Done`, '');
				if (i < config.maxCycles - 1 && this.stepController.isEnabled()) {
					const userAdvance = this.stepController.wait(sessionId);
					this._emitTrace(sessionId, sessionTraceId, 'orchestrator', 'session:pause', i, -1,
						'⏸ Debug pause', 'Observation complete. Waiting before the next reasoning cycle.');
					const advance = await userAdvance;
					this._emitTrace(sessionId, sessionTraceId, 'orchestrator', 'session:resume', i, -1,
						advance === 'next' ? '⏭ Next step' : '▶ Session resumed', 'Continuing to the next reasoning cycle.');
				}
			}

			// Max cycles — force final synthesis
			meta.termination = 'max_cycles';
			meta.completedAt = Date.now();
			const finalAnswer = await this._forceReActSynthesis(ctx, tools);
			onStream?.({ type: 'final_answer', cycleIndex: meta.totalCycles - 1, data: finalAnswer });
			this._emitTrace(sessionId, sessionTraceId, 'orchestrator', 'session:end', -1, -1, 'Session Complete (Max Cycles)', `Termination: max_cycles`);
			return this._buildReActResponse(sessionId, ctx);
		} catch (err) {
			meta.termination = 'error';
			meta.completedAt = Date.now();
			this._emitTrace(sessionId, sessionTraceId, 'orchestrator', 'session:end', -1, -1, 'Session Failed', (err as Error).message);
			return { taskId: sessionId, complete: true, error: (err as Error).message };
		} finally {
			if (this.memoryStore) {
				const final = ctx.cycles[ctx.cycles.length - 1]?.thought.finalAnswer
					?? ctx.cycles[ctx.cycles.length - 1]?.thought.reasoning ?? `Termination: ${meta.termination}`;
				try {
					await this.memoryStore.summarizeSession(sessionId, [
						{ role: 'user', content: originalTask },
						{ role: 'assistant', content: final },
					]);
				} catch (error) { console.warn('[CC] Unable to retain ReAct session memory:', error); }
			}
			if (targetPath) {
				const history = this.evaluator.getHistory();
				const added = Math.max(0, history.totalEvaluations - evaluationStart);
				const scores = history.recentScorecards.slice(0, added).map(score => score.compositeScore);
				const finalConfidence = ctx.cycles[ctx.cycles.length - 1]?.thought.confidence;
				this.notifyExecutionState({
					targetPath,
					status: meta.termination === 'error' ? 'failed' : 'completed',
					evalScore: scores.length
						? scores.reduce((sum, score) => sum + score, 0) / scores.length
						: meta.termination === 'error' ? 0 : finalConfidence ?? 0,
					completedAt: meta.completedAt || Date.now(),
					workerProfile: 'react-orchestrator',
				});
			}
			this.stepController.cancel();
			this.activeSessionId = null;
			this.streamCallback = null;
		}
	}

	/** Build the bounded memory + vault context block used by ReAct prompts. */
	async buildPassiveContext(query: string): Promise<string> {
		return injectRagContext(this.retriever, query, {
			existingContext: this.memoryStore?.getSystemMemoryPrompt(query) ?? '',
			limit: 5,
			charBudget: this.contextCharLimit,
			logger: { warn: (message, error) => console.warn(message.replace('Passive RAG', 'Passive ReAct retrieval'), error) },
		});
	}

	/* ─── Multi-turn ────────────────────────────────── */

	steer(message: string): Promise<void> {
		return this.sendCommand({ type: 'steer', message });
	}

	followUp(message: string): Promise<void> {
		return this.sendCommand({ type: 'follow_up', message });
	}

	abort(): Promise<void> {
		return this.sendCommand({ type: 'abort' });
	}

	prompt(message: string, taskId?: string): Promise<AgentTaskResponse> {
		return this._sendTask(
			{ profile: 'orchestrator', prompt: message, tools: [] },
			taskId || crypto.randomUUID(), undefined, true,
		);
	}

	/* ─── Internal ──────────────────────────────────── */

	/**
	 * Decode and drain Pi's UTF-8 JSONL stream.
	 *
	 * Buffer boundaries are arbitrary: one chunk may contain many frames, and a
	 * frame or UTF-8 code point may span chunks. Raw bytes remain buffered until
	 * LF is found, so only complete JSONL frames are decoded. U+2028/U+2029 are
	 * valid JSON string content and are deliberately preserved.
	 */
	private consumeStdoutChunk(chunk: Buffer | string, final = false): void {
		const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
		if (bytes.length > 0) this.appendStdoutBytes(bytes);

		let newlineOffset: number;
		while ((newlineOffset = this.stdoutBuffer.indexOf(0x0A, this.stdoutReadOffset)) !== -1
			&& newlineOffset < this.stdoutWriteOffset) {
			let lineEnd = newlineOffset;
			if (lineEnd > this.stdoutReadOffset && this.stdoutBuffer[lineEnd - 1] === 0x0D) lineEnd--;
			const line = this.stdoutDecoder.write(this.stdoutBuffer.subarray(this.stdoutReadOffset, lineEnd));
			this.stdoutReadOffset = newlineOffset + 1;
			this.decodeRpcLine(line);
		}

		if (final) {
			let lineEnd = this.stdoutWriteOffset;
			if (lineEnd > this.stdoutReadOffset && this.stdoutBuffer[lineEnd - 1] === 0x0D) lineEnd--;
			const line = this.stdoutDecoder.write(this.stdoutBuffer.subarray(this.stdoutReadOffset, lineEnd))
				+ this.stdoutDecoder.end();
			this.resetStdoutBuffer();
			this.decodeRpcLine(line);
		} else if (this.stdoutReadOffset === this.stdoutWriteOffset) {
			this.resetStdoutBuffer();
		}
	}

	/** Append bytes, compacting consumed data before growing the backing buffer. */
	private appendStdoutBytes(bytes: Buffer): void {
		const unreadLength = this.stdoutWriteOffset - this.stdoutReadOffset;
		const requiredLength = unreadLength + bytes.length;
		if (requiredLength > this.stdoutBuffer.length) {
			let capacity = Math.max(this.stdoutBuffer.length, 8192);
			while (capacity < requiredLength) capacity *= 2;
			const grown = Buffer.allocUnsafe(capacity);
			this.stdoutBuffer.copy(grown, 0, this.stdoutReadOffset, this.stdoutWriteOffset);
			this.stdoutBuffer = grown;
			this.stdoutReadOffset = 0;
			this.stdoutWriteOffset = unreadLength;
		} else if (this.stdoutReadOffset > 0 && this.stdoutBuffer.length - this.stdoutWriteOffset < bytes.length) {
			this.stdoutBuffer.copy(this.stdoutBuffer, 0, this.stdoutReadOffset, this.stdoutWriteOffset);
			this.stdoutReadOffset = 0;
			this.stdoutWriteOffset = unreadLength;
		}
		bytes.copy(this.stdoutBuffer, this.stdoutWriteOffset);
		this.stdoutWriteOffset += bytes.length;
	}

	private resetStdoutBuffer(): void {
		this.stdoutReadOffset = 0;
		this.stdoutWriteOffset = 0;
	}

	private decodeRpcLine(line: string): void {
		if (!line) return;
		try { this.processLine(line); }
		catch (err) { console.error('[CC] RPC parse error:', line.slice(0, 120), err); }
	}

	private processLine(line: string): void {
		let event: RpcEvent;
		try { event = JSON.parse(line) as RpcEvent; }
		catch {
			console.error('[CC] Malformed RPC line (discarded):', line.slice(0, 120));
			return;
		}

		// RPC response confirms prompt acceptance. Completion arrives later through
		// agent_end → agent_settled. Failed preflight responses resolve immediately.
		if (event.type === 'response') {
			if (!event.id) return;
			const handler = this.responseHandlers.get(event.id);
			if (!handler) return;
			if (!event.success) {
				this.responseHandlers.delete(event.id);
				this.activeTasks.delete(event.id);
				if (this.activePromptTaskId === event.id) this.activePromptTaskId = null;
				handler({ taskId: event.id, complete: true, error: event.error || 'Command failed' });
			}
			return;
		}

		// Pi events do not carry the originating prompt id. Route them to the one
		// active prompt in this subprocess session.
		if (event.type === 'message_update') {
			const msg = event.assistantMessageEvent;
			const streamTaskId = event.taskId ?? this.activePromptTaskId ?? '';
			if (msg?.type === 'text_delta' && msg.delta) {
				this.streamCallback?.(msg.delta, streamTaskId);
			}
			if (msg?.type === 'text_end' && msg.content) {
				this.streamCallback?.('\n', streamTaskId);
			}
			return;
		}

		if (event.type === 'tool_execution_update') {
			const text = event.partialResult?.content
				?.map((c) => c.text ?? '')
				.filter(Boolean)
				.join('');
			if (text) this.streamCallback?.(text, event.taskId ?? this.activePromptTaskId ?? '');
			return;
		}

		// Handle tool call requests from the agent — execute and respond
		if (event.type === 'tool_call') {
			const tc = event as RpcEvent & { name?: string; params?: Record<string, unknown> };
			if (tc.id && tc.name && this.piProcess?.stdin) {
				const audit = this.activePromptTaskId ? this.rpcAudit.get(this.activePromptTaskId) : undefined;
				const invocation: TraceToolInvocation = { name: tc.name, arguments: tc.params ?? {} };
				audit?.toolInvocations.push(invocation);
				const toolName = tc.name;
				const tool = this.toolHandlers.get(toolName);
				if (tool) {
					const executeTool = async () => {
						const request = await tool.confirmation?.(tc.params ?? {});
						if (request) {
							if (!this.toolConfirmationHandler) throw new Error(`Confirmation required for ${tc.name}, but no confirmation UI is open.`);
							const decision = await this.toolConfirmationHandler(request);
							if (decision !== 'approved') throw new Error(decision === 'timed-out'
								? `Confirmation timed out for ${tc.name}.`
								: `User rejected ${tc.name}.`);
						}
						// Tool runtime timeout begins after human review; think time must not
						// register as a tool/circuit failure.
						return withTimeout(
							() => tool.execute(tc.id!, tc.params ?? {}),
							getToolTimeout(toolName),
							`tool:${toolName}`,
						);
					};
					executeTool().then(result => {
						invocation.result = result.content;
						this.piProcess!.stdin!.write(JSON.stringify({
							type: 'tool_result',
							id: tc.id,
							result: result.content,
						}) + '\n');
					}).catch(err => {
						invocation.error = err instanceof Error ? err.message : 'Tool execution failed';
						this.piProcess!.stdin!.write(JSON.stringify({
							type: 'tool_result',
							id: tc.id,
							error: err instanceof Error ? err.message : 'Tool execution failed',
						}) + '\n');
					});
				} else {
					this.piProcess.stdin.write(JSON.stringify({
						type: 'tool_result', id: tc.id,
						error: `Unknown tool: ${tc.name}`,
					}) + '\n');
				}
			}
			return;
		}

		// agent_end contains generated messages. Keep them until agent_settled,
		// which is the true end after retries/compaction/follow-ups.
		if (event.type === 'agent_end') {
			if (event.messages) this.latestAgentMessages = event.messages;
			// Compatibility with the older taskId-bearing bridge used by tests.
			if (event.taskId) {
				const handler = this.responseHandlers.get(event.taskId);
				if (handler) {
					const messages = event.messages ?? [];
					this.responseHandlers.delete(event.taskId);
					this.activeTasks.delete(event.taskId);
					handler({
						taskId: event.taskId,
						result: {
							output: messages.filter(m => m.role === 'assistant')
								.map(m => m.content?.map(c => c.text ?? '').join('') ?? '').join('\n'),
							metadata: { messageCount: messages.length },
						},
						complete: true,
					});
				}
			}
			return;
		}

		if (event.type === 'agent_settled') {
			const taskId = event.taskId ?? this.activePromptTaskId;
			if (!taskId) return;
			const handler = this.responseHandlers.get(taskId);
			if (!handler) return;
			const messages = this.latestAgentMessages;
			const audit = this.rpcAudit.get(taskId);
			const usage = messages.map(message => message.usage).find(Boolean);
			const result: AgentTaskResponse = {
				taskId,
				result: {
					output: messages
						.filter((m) => m.role === 'assistant')
						.map((m) => m.content?.map((c) => c.text ?? '').join('') ?? '')
						.join('\n'),
					metadata: {
						messageCount: messages.length,
						traceDetail: {
							inputPrompt: audit?.inputPrompt,
							toolInvocations: audit?.toolInvocations ?? [],
							tokenUsage: usage ? {
								promptTokens: usage.input_tokens ?? usage.prompt_tokens,
								completionTokens: usage.output_tokens ?? usage.completion_tokens,
								totalTokens: usage.total_tokens,
							} : undefined,
						} satisfies ReActTraceDetail,
					},
				},
				complete: true,
			};
			this.responseHandlers.delete(taskId);
			this.activeTasks.delete(taskId);
			this.activePromptTaskId = null;
			this.latestAgentMessages = [];
			this.rpcAudit.delete(taskId);
			handler(result);
			return;
		}
	}

	private sendCommand(command: Record<string, unknown>): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!this.piProcess?.stdin) return reject(new Error('Daemon not running.'));
			this.piProcess.stdin.write(JSON.stringify(command) + '\n', (err) => err ? reject(err) : resolve());
		});
	}

	/* ═══════════════════════════════════════════════════
	   PRIVATE — Core send/receive primitive
	   ═══════════════════════════════════════════════════ */

	/**
	 * Send a Pi 0.82 RPC prompt and wait for agent_settled.
	 * Prompts are serialized because one RPC subprocess has one active run.
	 */
	private _sendTask(
		params: { profile: string; prompt: string; target?: string; tools?: ToolDefinition[] },
		taskId: string,
		onStream?: StreamCallback,
		_lock: boolean = false,
	): Promise<AgentTaskResponse> {
		const run = (): Promise<AgentTaskResponse> => new Promise((resolve, reject) => {
			if (this.startError) return reject(new Error(`Daemon failed: ${this.startError}`));
			if (!this.piProcess?.stdin) return reject(new Error('Daemon not running.'));
			if (params.prompt.length > TOKEN_LIMITS.MAX_PROMPT_CHARS) {
				return reject(new Error(`Prompt too large (${params.prompt.length} chars).`));
			}

			this.activeTasks.add(taskId);
			this.activePromptTaskId = taskId;
			this.rpcAudit.set(taskId, { inputPrompt: params.prompt, toolInvocations: [] });
			this.latestAgentMessages = [];
			const prevStream = this.streamCallback;
			this.streamCallback = onStream ?? null;

			this.responseHandlers.set(taskId, (response) => {
				this.activeTasks.delete(taskId);
				if (this.activePromptTaskId === taskId) this.activePromptTaskId = null;
				this.streamCallback = prevStream;
				response.error ? reject(new Error(response.error)) : resolve(response);
			});

			const context = [
				params.profile ? `Agent profile: ${params.profile}` : '',
				params.target ? `Target note: ${params.target}` : '',
			].filter(Boolean).join('\n');
			const message = context ? `${context}\n\n${params.prompt}` : params.prompt;
			const frame = JSON.stringify({ id: taskId, type: 'prompt', message }) + '\n';

			this.piProcess.stdin.write(frame, (err) => {
				if (err) {
					this.responseHandlers.delete(taskId);
					this.activeTasks.delete(taskId);
					if (this.activePromptTaskId === taskId) this.activePromptTaskId = null;
					this.streamCallback = prevStream;
					reject(err);
				}
			});
		});

		const queued = this.rpcTaskChain.then(run, run);
		this.rpcTaskChain = queued.then(() => undefined, () => undefined);
		return queued;
	}

	/* ═══════════════════════════════════════════════════
	   PRIVATE — ReAct cycle helpers
	   ═══════════════════════════════════════════════════ */

	private async _executeReActCycle(
		ctx: ReActContext, index: number, tools: ToolDefinition[],
		config: ReActConfig, onStream: ReActSessionCallback | undefined,
		sessionId: string, cycleTraceId: string,
	): Promise<ReActCycle> {
		const startedAt = Date.now();

		// 1. REASON — orchestrator thinks (its own mini ReAct loop)
		const thinkTraceId = this._emitTrace(sessionId, cycleTraceId, 'orchestrator', 'agent:think:start', index, -1, '🧠 Orchestrator Reasoning', '').id;
		const thought = await this._reason(ctx, index, tools, config, onStream);
		this._emitTrace(sessionId, thinkTraceId, 'orchestrator', 'agent:think:end', index, -1,
			thought.assessment === 'complete' ? '✅ Final Answer' : '📤 Action Decided',
			thought.finalAnswer ?? `${thought.assessment} (confidence: ${thought.confidence.toFixed(2)})`, undefined,
			thought.traceDetail);

		if (thought.assessment === 'complete' || thought.assessment === 'stuck') {
			return { index, thought, action: null, observation: null, startedAt, completedAt: Date.now() };
		}

		// 2. Parse actions (supports parallel dispatch)
		const actions = this._parseActions(thought);
		if (actions.length === 0) {
			return {
				index, action: null, observation: null, startedAt, completedAt: Date.now(),
				thought: { ...thought, assessment: 'stuck', finalAnswer: 'Failed to determine next action from response.' },
			};
		}

		// 3. DISPATCH — workers run concurrently. Claim explicit write targets first so
		// same-cycle editors cannot race even if their RPC/tool timing differs.
		this.cycleWriteClaims.clear();
		const workerPromises = actions.map(action => {
			ctx.meta.daemonCalls++;
			const dynAction = action as ReActAction & { customRole?: Partial<import('./react/react-roles').AgentRole> };
			let dynamicRoleName: string | null = null;
			if (dynAction.customRole?.name) {
				dynamicRoleName = tryRegisterDynamicRole(dynAction);
				if (dynamicRoleName) {
					action.role = dynamicRoleName;
					const role = getRole(dynamicRoleName)!;
					this._emitTrace(sessionId, cycleTraceId, dynamicRoleName, 'agent:role:create', index, -1,
						`✨ Custom role: ${role.label}`, role.persona.slice(0, 220), {
							dynamicRole: true, roleName: role.name, baseProfile: role.baseProfile,
							allowedTools: role.toolPermissions?.allowed ?? role.recommendedTools,
							validationRules: role.validationRules ?? [],
						});
				}
			}
			onStream?.({ type: 'action_start', cycleIndex: index, data: `${action.worker}: ${action.prompt.slice(0, 80)}` });
			const workerTraceId = this._emitTrace(sessionId, cycleTraceId, action.worker, 'agent:act:start', index, -1,
				`${action.role ? `🎭 ${action.role}` : '🔧'} → ${action.worker}`, action.prompt.slice(0, 200), {
					roleName: action.role, dynamicRole: Boolean(dynamicRoleName),
				}, { inputPrompt: action.prompt }).id;
			const busy = this._claimCycleWriteTarget(action, index);
			if (busy) {
				const result = this._fileBusyResult(busy);
				this._emitTrace(sessionId, workerTraceId, action.worker, 'agent:observe', index, -1,
					'🔒 File busy', result.output);
				return Promise.resolve(result);
			}
			return this._dispatchWorker(action, tools, onStream, index).then(result => {
				ctx.meta.toolCalls += result.toolCalls;
				this._emitTrace(sessionId, workerTraceId, action.worker, 'agent:observe', index, -1,
					`📋 ${result.subCycles} sub-cycles, ${result.corrections} corrections`, result.output.slice(0, 300), undefined,
					result.traceDetail);
				return result;
			});
		});

		const workerResults = await Promise.all(workerPromises);
		this.cycleWriteClaims.clear();

		// Merge parallel observations
		const mergedOutput = workerResults.map((r, i) =>
			`### Worker ${i + 1} (${actions[i]!.worker})\n${r.output.slice(0, 2000)}`
		).join('\n\n');
		const allInsights = workerResults.flatMap(r => r.keyInsights);
		const allSuccess = workerResults.every(r => r.success);

		const observation: ReActObservation = {
			output: mergedOutput,
			success: allSuccess,
			error: workerResults.find(r => r.error)?.error,
			keyInsights: allInsights,
			surprised: false,
		};

		onStream?.({ type: 'observation', cycleIndex: index, data: `Merged ${workerResults.length} worker(s)`, meta: { success: allSuccess } });

		return { index, thought, action: actions[0] ?? null, observation, startedAt, completedAt: Date.now() };
	}

	private async _reason(
		ctx: ReActContext, index: number, tools: ToolDefinition[],
		config: ReActConfig, onStream?: ReActSessionCallback,
	): Promise<ReActThought> {
		const basePrompt = buildReActOrchestratorPrompt(ctx, index, config.maxContextChars);
		const hints = this.evaluator.getOptimizationHints();
		const prompt = hints ? `${hints}\n\n${basePrompt}` : basePrompt;

		try {
			const streamWrapper: StreamCallback | undefined = onStream
				? (delta) => onStream({ type: 'thought', cycleIndex: index, data: delta })
				: undefined;

			const result = await this._runAgentReActLoop({
				profile: 'orchestrator',
				task: prompt,
				tools,
				maxSubCycles: 2,
				onStream: streamWrapper,
			});

			const parsed = parseReActResponse(result.output);
			return {
				reasoning: parsed.thought.reasoning,
				assessment: parsed.thought.assessment,
				confidence: parsed.thought.confidence,
				finalAnswer: parsed.finalAnswer,
				actions: parsed.actions ?? (parsed.action ? [parsed.action] : undefined),
				traceDetail: { ...result.traceDetail, inputPrompt: result.traceDetail?.inputPrompt ?? prompt, modelResponse: result.output },
			};
		} catch (err) {
			return { reasoning: `Orchestrator failed: ${(err as Error).message}`, assessment: 'stuck', confidence: 0 };
		}
	}

	/* ── Worker dispatch (mini ReAct loop) ────────────── */

	private async _dispatchWorker(
		action: ReActAction, tools: ToolDefinition[],
		onStream: ReActSessionCallback | undefined, cycleIndex: number,
	): Promise<WorkerReActResult> {
		const streamWrapper: StreamCallback | undefined = onStream
			? (delta) => onStream({ type: 'action_complete', cycleIndex, data: delta })
			: undefined;

		// Use role-specific prompt if a role is assigned, otherwise default worker prompt
		const prompt = action.role
			? buildRolePrompt(action)
			: buildWorkerReActPrompt(action.worker, action.prompt, action.targetPath, action.expectedOutput);

		// Filter tools to role-relevant subset
		const filteredTools = filterToolsForRole(action.role, tools);

		const result = await withRetry(
			async () => {
				// Check circuit breaker before execution
				if (this.circuitBreaker.isOpen(action.worker)) {
					throw new Error(`Circuit breaker open for ${action.worker} — too many recent failures`);
				}
				const r = await this._runAgentReActLoop({
					profile: action.worker,
					task: prompt,
					targetPath: action.targetPath,
					tools: filteredTools,
					maxSubCycles: 3,
					onStream: streamWrapper,
				});
				this.circuitBreaker.recordSuccess(action.worker);
				// Reset deadlock detector for this agent on success
				this.deadlockDetector.reset(action.worker);
				return r;
			},
			{ maxRetries: 1, baseDelayMs: 500 },
			action.worker,
		).catch((err) => {
			this.circuitBreaker.recordFailure(action.worker);
			const recovery = determineRecovery(err instanceof Error ? err : new Error(String(err)), 1, 1, action.worker);
			const fallbackResult: WorkerReActResult = {
				output: `[Recovery: ${recovery.strategy}] ${recovery.reason}`,
				subCycles: 0, toolCalls: 0, success: false,
				error: (err instanceof Error ? err : new Error(String(err))).message,
				keyInsights: [], corrections: 0, validationLog: [],
			};
			return fallbackResult;
		});

		// Evaluate performance and attach the scorecard to this specific trace step.
		const scorecard = this.evaluator.evaluate(
			action.worker,
			action.role,
			action.prompt,
			result,
		);
		result.traceDetail = { ...result.traceDetail, evaluation: scorecard as unknown as Record<string, unknown> };
		if (action.targetPath) {
			this.notifyExecutionState({
				targetPath: action.targetPath,
				status: result.success ? 'completed' : 'failed',
				evalScore: scorecard.compositeScore,
				completedAt: Date.now(),
				workerProfile: action.worker,
			});
		}

		return result;
	}

	private notifyExecutionState(state: AgentExecutionState): void {
		try { this.executionStateCallback?.(state); }
		catch (error) { console.error('[CC] Execution state callback failed:', error); }
	}

	private _claimCycleWriteTarget(action: ReActAction, cycleIndex: number): FileBusyError | null {
		if (action.worker !== 'editor' || !action.targetPath) return null;
		const key = normalizeLockPath(action.targetPath);
		if (!key) return null;
		const existing = this.cycleWriteClaims.get(key);
		if (existing) return new FileBusyError(action.targetPath);
		this.cycleWriteClaims.set(key, { worker: action.worker, cycleIndex });
		return null;
	}

	private _fileBusyResult(error: FileBusyError): WorkerReActResult {
		return {
			output: `${error.message} The conflicting action was not run; the orchestrator may queue it in the next cycle.`,
			subCycles: 0, toolCalls: 0, success: false, error: error.message,
			keyInsights: [], corrections: 0,
			validationLog: [{ checkpoint: 'post-observation', subCycle: 0, severity: 'warning', issue: error.message, at: Date.now() }],
		};
	}

	private _parseActions(thought: ReActThought): ReActAction[] {
		if (thought.actions?.length) return thought.actions;
		const reasoning = thought.reasoning;
		// Try to parse a JSON array of actions first
		const arrayMatch = reasoning.match(/\[[\s\S]*"worker"[\s\S]*"prompt"[\s\S]*\]/);
		if (arrayMatch) {
			try {
				const parsed = JSON.parse(arrayMatch[0]) as ReActAction[];
				if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]!.worker) return parsed;
			} catch { /* fall through */ }
		}
		// Fall back to single action
		const single = this._parseAction(thought);
		return single ? [single] : [];
	}

	private _parseAction(thought: ReActThought): ReActAction | null {
		const jsonMatch = thought.reasoning.match(/\{[\s\S]*"worker"[\s\S]*"prompt"[\s\S]*\}/);
		if (jsonMatch) {
			try {
				const parsed = JSON.parse(jsonMatch[0]) as ReActAction;
				if (parsed.worker && parsed.prompt) return parsed;
			} catch { /* fall through */ }
		}
		return null;
	}

	private _extractInsights(output: string): string[] {
		const bulletMatch = output.match(/^[*-]\s+(.+)$/gm);
		if (bulletMatch) return bulletMatch.map(b => b.replace(/^[*-]\s+/, '').slice(0, 200)).slice(0, 5);
		const sentences = output.match(/[^.!?]+[.!?]+/g) ?? [];
		return sentences.slice(0, 3).map(s => s.trim().slice(0, 200));
	}

	private _buildReActResponse(sessionId: string, ctx: ReActContext): AgentTaskResponse {
		const finalThought = ctx.cycles[ctx.cycles.length - 1]?.thought;
		const output = finalThought?.finalAnswer
			?? ctx.cycles.map(c =>
				`## Cycle ${c.index + 1}\n**Thought:** ${c.thought.reasoning.slice(0, 500)}\n` +
				(c.observation ? `**Result:** ${c.observation.output.slice(0, 800)}` : '')
			).join('\n\n');

		return {
			taskId: sessionId, complete: true,
			result: {
				output: output.slice(0, TOKEN_LIMITS.MAX_RESULT_OUTPUT_CHARS),
				summary: `ReAct session: ${ctx.meta.totalCycles} cycles, ${ctx.meta.termination}.`,
				metadata: {
					reactSessionId: sessionId, cycles: ctx.meta.totalCycles,
					daemonCalls: ctx.meta.daemonCalls, toolCalls: ctx.meta.toolCalls,
					termination: ctx.meta.termination,
				},
			},
		};
	}

	/* ═══════════════════════════════════════════════════
	   PRIVATE — Generalized agent ReAct loop
	   ═══════════════════════════════════════════════════ */

	/**
	 * Run a self-correcting ReAct loop for ANY agent.
	 *
	 * Validation checkpoints at three stages:
	 *   1. POST-OBSERVATION — validate each response for errors, emptiness, loops
	 *   2. PRE-RETURN — validate the final answer before handing back
	 *   3. IMPLICIT — empty output or tool failures trigger automatic retry
	 *
	 * On validation failure, the agent receives a correction prompt and retries
	 * with an adjusted approach. Circular/redundant outputs are detected and
	 * force a different trajectory.
	 */
	private async _runAgentReActLoop(params: {
		profile: string; task: string; targetPath?: string;
		tools: ToolDefinition[]; maxSubCycles: number; onStream?: StreamCallback;
	}): Promise<WorkerReActResult> {
		let accumulatedPrompt = params.task;
		let lastOutput = '';
		let totalCorrections = 0;
		const validationLog: ValidationEvent[] = [];

		for (let subCycle = 0; subCycle < params.maxSubCycles; subCycle++) {
			const taskId = crypto.randomUUID();

			try {
				const response = await this._sendTask(
					{ profile: params.profile, prompt: accumulatedPrompt, target: params.targetPath, tools: params.tools },
					taskId, params.onStream, false,
				);

				const output = response.result?.output ?? '';
				lastOutput = output;
				const responseDetail = this._responseTraceDetail(response, accumulatedPrompt);

				// Deadlock detection — repeated identical output
				if (this.deadlockDetector.isDeadlocked(params.profile, output)) {
					this.deadlockDetector.record(params.profile, output);
					// Force re-route by appending a strong correction
					accumulatedPrompt = `${params.task}\n\n## ⚠️ DEADLOCK DETECTED\nYou are repeating yourself. Take a completely different approach. Use different tools, different search terms, or reconsider the problem.`;
					continue;
				}
				this.deadlockDetector.record(params.profile, output);

				// ═══ CHECKPOINT 1: Post-observation validation ═══
				const validation = this._validateOutput(output, lastOutput, subCycle, params.maxSubCycles);
				if (validation.issues.length > 0) {
					validationLog.push({
						checkpoint: validation.action === 'abort' ? 'pre-return' : 'post-observation',
						subCycle, severity: validation.passed ? 'info' : 'warning',
						issue: validation.issues.join('; '),
						correction: validation.correctionPrompt?.slice(0, 200),
						at: Date.now(),
					});
				}

				// Fatal or abort — return immediately
				if (validation.action === 'abort') {
					return { output, subCycles: subCycle + 1, toolCalls: 0, success: false, error: validation.issues[0], keyInsights: [], corrections: totalCorrections, validationLog };
				}

				// Accept — agent is done
				if (validation.action === 'accept') {
					const parsed = parseReActResponse(output);
					const finalOutput = parsed.finalAnswer ?? output;

					// ═══ CHECKPOINT 2: Pre-return final validation ═══
					const finalCheck = this._validateFinalAnswer(finalOutput);
					if (!finalCheck.passed && subCycle < params.maxSubCycles - 1) {
						validationLog.push({
							checkpoint: 'pre-return', subCycle, severity: 'warning',
							issue: finalCheck.issues.join('; '),
							correction: finalCheck.correctionPrompt?.slice(0, 200),
							at: Date.now(),
						});
						totalCorrections++;
						accumulatedPrompt = `${params.task}\n\n## Previous Attempt\n${output.slice(0, 1500)}\n\n## Correction Needed\n${finalCheck.correctionPrompt}`;
						continue;
					}

					return { output: finalOutput, subCycles: subCycle + 1, toolCalls: responseDetail.toolInvocations?.length ?? 0, success: true, keyInsights: this._extractInsights(finalOutput), corrections: totalCorrections, validationLog, traceDetail: { ...responseDetail, modelResponse: output } };
				}

				// Retry or retry-different — build correction prompt
				totalCorrections++;
				if (validation.correctionPrompt) {
					accumulatedPrompt = `${params.task}\n\n## Previous Attempt\n${output.slice(0, 1500)}\n\n## Correction Needed\n${validation.correctionPrompt}`;
				} else if (validation.action === 'retry-different') {
					accumulatedPrompt = `${params.task}\n\n## Previous Attempt (insufficient)\n${output.slice(0, 1500)}\n\nYour last response was insufficient. Try a completely different approach. Use different search terms, read different notes, or reconsider the problem from another angle.`;
				} else {
					accumulatedPrompt = `${params.task}\n\n## Previous Attempt\n${output.slice(0, 1500)}\n\nYour response was incomplete. Please continue and provide more detail.`;
				}
			} catch (err) {
				validationLog.push({ checkpoint: 'post-observation', subCycle, severity: 'error', issue: (err as Error).message, at: Date.now() });
				if (subCycle === 0) return { output: '', subCycles: 0, toolCalls: 0, success: false, error: (err as Error).message, keyInsights: [], corrections: totalCorrections, validationLog };
				if (subCycle < params.maxSubCycles - 1) {
					accumulatedPrompt = `${params.task}\n\n## Error\nThe previous attempt failed with: ${(err as Error).message}\n\nPlease retry with a different approach.`;
					continue;
				}
				return { output: lastOutput, subCycles: subCycle + 1, toolCalls: 0, success: false, error: (err as Error).message, keyInsights: this._extractInsights(lastOutput), corrections: totalCorrections, validationLog };
			}
		}

		return { output: lastOutput, subCycles: params.maxSubCycles, toolCalls: 0, success: true, keyInsights: this._extractInsights(lastOutput), corrections: totalCorrections, validationLog };
	}

	/* ═══════════════════════════════════════════════════
	   PRIVATE — Self-correction validators
	   ═══════════════════════════════════════════════════ */

	/** Validate intermediate agent output. Detects emptiness, errors, circular output, and missing structure. */
	private _validateOutput(
		output: string, previousOutput: string,
		subCycle: number, maxCycles: number,
	): ValidationOutcome {
		const issues: string[] = [];

		// 1. Empty or whitespace-only output
		if (!output || output.trim().length < 10) {
			return { passed: false, issues: ['Empty or near-empty response'], correctionPrompt: 'Your response was empty. Please produce a substantive answer with your findings, reasoning, and any tool results.', action: 'retry' };
		}

		// 2. Explicit error indicators in the output
		const errorIndicators = [/error/i, /failed/i, /unable to/i, /cannot/i, /not found/i, /no results/i, /denied/i, /timeout/i];
		const matchedErrors = errorIndicators.filter(r => r.test(output));
		if (matchedErrors.length >= 3) {
			issues.push(`Output contains ${matchedErrors.length} error indicators`);
		}

		// 3. Circular output — nearly identical to previous
		if (previousOutput && subCycle > 0) {
			const similarity = this._textSimilarity(output, previousOutput);
			if (similarity > 0.85) {
				issues.push('Output is nearly identical to previous attempt (circular reasoning)');
				return { passed: false, issues, correctionPrompt: 'Your response is nearly identical to your previous attempt. You appear to be stuck in a loop. Try a completely different approach — different search terms, a different perspective, or break the problem into smaller sub-problems.', action: 'retry-different' };
			}
		}

		// 4. Tool references but no actual data
		const mentionsTools = /search_vault|read_note|list_files|get_active_note|write_note/.test(output);
		const hasData = output.length > 200 && /[0-9]+/.test(output) && /[a-zA-Z]{20,}/.test(output);
		if (mentionsTools && !hasData && subCycle < maxCycles - 1) {
			issues.push('Output mentions tools but contains no substantive data');
			if (issues.length === 1) {
				return { passed: false, issues, correctionPrompt: 'You mentioned tools but did not include their results. Please actually invoke the tools (search_vault, read_note, etc.) and include the returned data in your response.', action: 'retry' };
			}
		}

		// 5. Parse as ReAct response — check for completion
		const parsed = parseReActResponse(output);
		if (parsed.thought.assessment === 'stuck') {
			issues.push('Agent reported itself as stuck');
			if (subCycle < maxCycles - 1) {
				return { passed: false, issues, correctionPrompt: 'You indicated you are stuck. Try a different strategy: use different tools, search with broader terms, or ask a clarifying question. If truly blocked, provide your best partial answer.', action: 'retry-different' };
			}
		}

		if (issues.length === 0) {
			return { passed: true, issues: [], action: 'accept' };
		}

		return { passed: false, issues, action: subCycle < maxCycles - 1 ? 'retry' : 'accept' };
	}

	/** Final-answer validation — checks completeness, sources, and substance before returning to orchestrator. */
	private _validateFinalAnswer(output: string): ValidationOutcome {
		const issues: string[] = [];

		// 1. Too short for a meaningful answer
		if (output.length < 50) {
			issues.push('Final answer is too short (< 50 chars)');
		}

		// 2. No file paths or references when the task likely needed them
		const hasReferences = /\.md|\/[\w-]+\/|path[:\s]|note[:\s]|file[:\s]/i.test(output);
		const mentionsVault = /vault|note|file|document/i.test(output);
		if (mentionsVault && !hasReferences && output.length < 500) {
			issues.push('Answer mentions vault content but provides no specific paths or references');
		}

		// 3. Low-confidence language
		const hedgeCount = (output.match(/maybe|perhaps|might be|could be|possibly|I think|probably|not sure|unclear/gi) ?? []).length;
		if (hedgeCount > 3 && output.length < 500) {
			issues.push(`Answer uses hedging language ${hedgeCount} times — suggests low confidence`);
		}

		if (issues.length === 0) {
			return { passed: true, issues: [], action: 'accept' };
		}

		return {
			passed: false, issues,
			correctionPrompt: `Your answer has these issues: ${issues.join('; ')}. Please provide a more complete, specific answer with concrete references, file paths, and higher confidence. Eliminate hedging language.`,
			action: 'retry',
		};
	}

	/** Simple Jaccard-like text similarity for detecting circular output. */
	private _textSimilarity(a: string, b: string): number {
		const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
		const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
		if (wordsA.size === 0 || wordsB.size === 0) return 0;
		let intersection = 0;
		for (const w of wordsA) { if (wordsB.has(w)) intersection++; }
		return intersection / Math.max(wordsA.size, wordsB.size);
	}

	private async _forceReActSynthesis(ctx: ReActContext, tools: ToolDefinition[]): Promise<string> {
		try {
			const prompt = buildReActFinalSynthesisPrompt(ctx);
			const response = await this._sendTask(
				{ profile: 'summarizer', prompt, tools },
				crypto.randomUUID(), undefined, false,
			);
			return response.result?.output ?? 'Unable to synthesize final answer.';
		} catch {
			return ctx.cycles.filter(c => c.observation?.output).map(c => c.observation!.output).join('\n\n').slice(0, 5000) || 'No results.';
		}
	}

	/* ── Trace helper ────────────────────────────────── */

	private _responseTraceDetail(response: AgentTaskResponse, fallbackPrompt: string): ReActTraceDetail {
		const metadata = response.result?.metadata;
		const detail = metadata?.traceDetail as ReActTraceDetail | undefined;
		return {
			...detail,
			inputPrompt: detail?.inputPrompt ?? fallbackPrompt,
			modelResponse: response.result?.output ?? '',
		};
	}

	private _emitTrace(
		sessionId: string, parentId: string | null, agent: string,
		type: ReActTraceEvent['type'], cycleIndex: number, subCycle: number,
		label: string, content: string, meta?: Record<string, unknown>, detail?: ReActTraceDetail,
	): ReActTraceEvent {
		return this.trace.emit(sessionId, parentId, agent, type, cycleIndex, subCycle, label, content, meta, detail);
	}
}
