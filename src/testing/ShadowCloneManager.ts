import type { TopographyMap } from '../ingestion/TopographySweep';

export interface DryRunExecutionContext {
	readonly isDryRun: true;
	readonly target: 'shadow-clone';
}

export type ShadowWriteCommand =
	| { kind: 'create'; path: string; content: string }
	| { kind: 'update'; path: string; content: string }
	| { kind: 'delete'; path: string }
	| { kind: 'move'; path: string; destination: string };

export interface ShadowMutationResult {
	applied: boolean;
	command: ShadowWriteCommand;
	reason?: string;
}

export interface ShadowCloneSnapshot {
	readonly cloneId: string;
	readonly createdAt: number;
	readonly folders: readonly string[];
	readonly files: ReadonlyMap<string, string>;
	readonly mutations: readonly ShadowMutationResult[];
}

const DRY_RUN_CONTEXT: DryRunExecutionContext = Object.freeze({ isDryRun: true, target: 'shadow-clone' });

/**
 * Ephemeral vault-shaped test double built only from TopographySweep data.
 * Deliberately accepts no App or Vault instance, so its command path cannot
 * reach app.vault.create(), app.vault.modify(), or any filesystem adapter.
 */
export class ShadowCloneManager {
	private readonly files = new Map<string, string>();
	private readonly folders = new Set<string>();
	private readonly mutations: ShadowMutationResult[] = [];
	private cloneId = '';
	private createdAt = 0;
	private active = false;

	instantiate(topography: TopographyMap): ShadowCloneSnapshot {
		this.files.clear(); this.folders.clear(); this.mutations.length = 0;
		for (const path of topography.folders.keys()) this.folders.add(this.safePath(path, true));
		for (const node of topography.nodes.values()) {
			const path = this.safePath(node.path);
			this.files.set(path, ''); // Structure only: live Markdown is never copied or read.
			if (node.folder) this.folders.add(this.safePath(node.folder, true));
		}
		this.createdAt = Date.now();
		this.cloneId = `shadow-${topography.generatedAt}-${this.createdAt}`;
		this.active = true;
		return this.snapshot();
	}

	/** Sole mutation entry point; every Orchestrator write must terminate here. */
	intercept(command: ShadowWriteCommand, context: DryRunExecutionContext = DRY_RUN_CONTEXT): ShadowMutationResult {
		this.assertIsolation(context);
		if (!this.active) throw new Error('Shadow clone is not active.');
		const normalized = this.normalizeCommand(command);
		let reason: string | undefined;
		if (normalized.kind === 'create' && this.files.has(normalized.path)) reason = 'Shadow file already exists.';
		else if ((normalized.kind === 'update' || normalized.kind === 'delete' || normalized.kind === 'move') && !this.files.has(normalized.path)) reason = 'Shadow file does not exist.';
		else if (normalized.kind === 'move' && this.files.has(normalized.destination)) reason = 'Shadow destination already exists.';
		if (!reason) this.applyInMemory(normalized);
		const result: ShadowMutationResult = { applied: !reason, command: normalized, ...(reason ? { reason } : {}) };
		this.mutations.push(result);
		return this.copyResult(result);
	}

	read(path: string): string | undefined { return this.files.get(this.safePath(path)); }
	snapshot(): ShadowCloneSnapshot {
		return { cloneId: this.cloneId, createdAt: this.createdAt, folders: [...this.folders].sort(), files: new Map(this.files), mutations: this.mutations.map(result => this.copyResult(result)) };
	}
	dispose(): void { this.files.clear(); this.folders.clear(); this.mutations.length = 0; this.active = false; this.cloneId = ''; this.createdAt = 0; }

	private assertIsolation(context: DryRunExecutionContext): void {
		// Hardcoded fail-closed gate: no caller can select a live vault target.
		if (context.isDryRun !== true || context.target !== 'shadow-clone') throw new Error('Isolation violation: dry-run writes may target only the in-memory shadow clone.');
	}
	private applyInMemory(command: ShadowWriteCommand): void {
		if (command.kind === 'create' || command.kind === 'update') this.files.set(command.path, command.content);
		else if (command.kind === 'delete') this.files.delete(command.path);
		else { const content = this.files.get(command.path) ?? ''; this.files.delete(command.path); this.files.set(command.destination, content); }
	}
	private normalizeCommand(command: ShadowWriteCommand): ShadowWriteCommand {
		if (command.kind === 'move') return { ...command, path: this.safePath(command.path), destination: this.safePath(command.destination) };
		return { ...command, path: this.safePath(command.path) };
	}
	private safePath(path: string, folder = false): string {
		const normalized = path.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
		if (normalized.includes('..') || (!folder && !normalized.toLowerCase().endsWith('.md'))) throw new Error('Shadow clone path must be a safe vault-relative Markdown path.');
		return normalized;
	}
	private copyResult(result: ShadowMutationResult): ShadowMutationResult { return { ...result, command: { ...result.command } }; }
}
