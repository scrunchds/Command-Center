import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import type { PythonWorkerRequest, PythonWorkerTransport as PythonWorkerTransportContract } from './ExecutionRouter';

export interface PythonWorkerTransportOptions {
	pythonPath?: string;
	workerPath?: string;
	workerSource?: string;
	timeoutMs?: number;
	failureThreshold?: number;
	circuitResetMs?: number;
	maxOutputBytes?: number;
	cwd?: string;
}

interface RpcResponse {
	jsonrpc: '2.0';
	id: string;
	result?: unknown;
	error?: { code?: number; message?: string; data?: unknown };
}

/** One isolated subprocess per request; no shell and no credentials in argv/env. */
export class PythonWorkerTransport implements PythonWorkerTransportContract {
	readonly kind = 'local-python-subprocess' as const;
	private failures = 0;
	private circuitOpenedAt = 0;
	private active = new Set<ChildProcessWithoutNullStreams>();
	private readonly pythonPath: string;
	private readonly timeoutMs: number;
	private readonly failureThreshold: number;
	private readonly circuitResetMs: number;
	private readonly maxOutputBytes: number;

	constructor(private readonly options: PythonWorkerTransportOptions) {
		if (!options.workerPath && !options.workerSource) throw new Error('A Python worker path or bundled source is required.');
		this.pythonPath = options.pythonPath?.trim() || 'python';
		this.timeoutMs = options.timeoutMs ?? 60_000;
		this.failureThreshold = options.failureThreshold ?? 3;
		this.circuitResetMs = options.circuitResetMs ?? 30_000;
		this.maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
	}

	isAvailable(): boolean {
		if (this.failures < this.failureThreshold) return true;
		if (Date.now() - this.circuitOpenedAt < this.circuitResetMs) return false;
		this.failures = 0;
		this.circuitOpenedAt = 0;
		return true;
	}

	execute(request: PythonWorkerRequest, signal?: AbortSignal): Promise<unknown> {
		if (!this.isAvailable()) return Promise.reject(new Error('Python worker is temporarily unavailable.'));
		if (signal?.aborted) return Promise.reject(new Error('Python worker execution was cancelled.'));
		return new Promise((resolve, reject) => {
			const args = this.options.workerSource ? ['-I', '-c', this.options.workerSource] : ['-I', this.options.workerPath!];
			const child = spawn(this.pythonPath, args, {
				cwd: this.options.cwd,
				shell: false,
				windowsHide: true,
				stdio: ['pipe', 'pipe', 'pipe'],
				env: { PATH: process.env.PATH ?? '', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
			});
			this.active.add(child);
			let stdout = '';
			let stderr = '';
			let bytes = 0;
			let settled = false;
			const finish = (error?: Error, value?: unknown): void => {
				if (settled) return;
				settled = true;
				window.clearTimeout(timer);
				signal?.removeEventListener('abort', abort);
				this.active.delete(child);
				if (error) { this.recordFailure(); reject(error); }
				else { this.failures = 0; resolve(value); }
			};
			const terminate = (): void => { if (!child.killed) child.kill(); };
			const abort = (): void => { terminate(); finish(new Error('Python worker execution was cancelled.')); };
			const timer = window.setTimeout(() => { terminate(); finish(new Error('Python worker timed out.')); }, this.timeoutMs);
			signal?.addEventListener('abort', abort, { once: true });
			const collect = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
				bytes += chunk.byteLength;
				if (bytes > this.maxOutputBytes) { terminate(); finish(new Error('Python worker exceeded its output limit.')); return; }
				if (target === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
			};
			child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
			child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));
			child.once('error', error => finish(new Error(`Python worker could not start: ${error.message}`)));
			child.once('close', code => {
				if (settled) return;
				const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
				if (!line) { finish(undefined, { success: false, error: code === 0 ? 'Python worker returned no response.' : 'Python worker failed.', stderr }); return; }
				try {
					const response = JSON.parse(line) as RpcResponse;
					if (response.jsonrpc !== '2.0' || response.id !== request.taskId) throw new Error('Invalid JSON-RPC response.');
					finish(undefined, response.error ? { success: false, error: response.error.message ?? 'Python worker failed.', stderr } : { success: true, result: response.result, stderr });
				} catch { finish(undefined, { success: false, error: 'Python worker returned malformed JSON.', stderr }); }
			});
			const rpc = { jsonrpc: '2.0', id: request.taskId, method: 'command_center.execute', params: request };
			child.stdin.end(`${JSON.stringify(rpc)}\n`, 'utf8');
		});
	}

	dispose(): void { for (const child of this.active) if (!child.killed) child.kill(); this.active.clear(); }

	private recordFailure(): void {
		this.failures += 1;
		if (this.failures >= this.failureThreshold) this.circuitOpenedAt = Date.now();
	}
}
