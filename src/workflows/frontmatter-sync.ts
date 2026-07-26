import type { App, TFile } from 'obsidian';
import { getSharedFileLockManager } from '../file-lock';

/** Agent properties written to a Markdown note after task or workflow execution. */
export interface NoteAgentState {
	status: string;
	evalScore?: number;
	lastRun?: string;
}

/** Atomically update agent properties while preserving every unrelated frontmatter field. */
export async function updateNoteAgentState(
	file: TFile,
	app: App,
	state: NoteAgentState,
): Promise<void> {
	await getSharedFileLockManager(app).withLock(file.path, async () => {
		await app.fileManager.processFrontMatter(file, (rawFrontmatter: unknown) => {
			if (!isMutableRecord(rawFrontmatter)) throw new Error(`Invalid frontmatter in ${file.path}`);
			rawFrontmatter.agent_status = state.status;
			if (state.evalScore !== undefined && Number.isFinite(state.evalScore)) {
				rawFrontmatter.agent_eval_score = Math.round(state.evalScore * 10_000) / 10_000;
			}
			if (state.lastRun !== undefined) rawFrontmatter.agent_last_run = state.lastRun;
		});
	});
}

function isMutableRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

interface PendingNoteState {
	file: TFile;
	state: NoteAgentState;
}

/**
 * Coalesces rapid state changes by note path into one native frontmatter mutation.
 * Calling flush() is safe during plugin unload and drains all currently queued work.
 */
export class DebouncedFrontmatterSync {
	private readonly pending = new Map<string, PendingNoteState>();
	private timer: number | null = null;
	private flushing: Promise<void> | null = null;

	constructor(
		private readonly app: App,
		private readonly delayMs = 750,
	) {}

	queue(file: TFile, state: NoteAgentState): void {
		const key = file.path.replace(/\\/g, '/').toLowerCase();
		const previous = this.pending.get(key);
		this.pending.set(key, {
			file,
			state: {
				...previous?.state,
				...state,
				evalScore: state.evalScore ?? previous?.state.evalScore,
				lastRun: laterIsoTimestamp(previous?.state.lastRun, state.lastRun),
			},
		});
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.flush();
		}, this.delayMs);
	}

	async flush(): Promise<void> {
		if (this.timer !== null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.flushing) await this.flushing;
		if (this.pending.size === 0) return;
		const updates = [...this.pending.values()];
		this.pending.clear();
		this.flushing = Promise.all(updates.map(({ file, state }) =>
			updateNoteAgentState(file, this.app, state).catch(error => {
				console.error(`[CC] Failed to synchronize agent properties for ${file.path}:`, error);
			}),
		)).then(() => undefined);
		try {
			await this.flushing;
		} finally {
			this.flushing = null;
		}
		// Updates queued while writes were in flight must not be stranded.
		if (this.pending.size > 0) await this.flush();
	}
}

function laterIsoTimestamp(previous: string | undefined, next: string | undefined): string | undefined {
	if (!previous) return next;
	if (!next) return previous;
	const previousTime = Date.parse(previous);
	const nextTime = Date.parse(next);
	if (!Number.isFinite(previousTime)) return next;
	if (!Number.isFinite(nextTime)) return previous;
	return nextTime >= previousTime ? next : previous;
}
