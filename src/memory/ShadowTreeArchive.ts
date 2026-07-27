export interface ShadowTreeDelta {
	id: string;
	notePath: string;
	parentId: string | null;
	createdAt: number;
	reason: string;
	beforeHash: string;
	afterHash: string;
	operations: ShadowDeltaOperation[];
}

export interface ShadowDeltaOperation {
	kind: 'retain' | 'remove' | 'insert';
	startLine: number;
	endLine: number;
	lines: string[];
}

/**
 * In-memory logical archive for proposed Socratic Triage changes. It records
 * deltas only and has no Vault, Adapter, or filesystem mutation capability.
 */
export class ShadowTreeArchive {
	private readonly timeline = new Map<string, ShadowTreeDelta[]>();

	record(notePath: string, before: string, proposed: string, reason: string): ShadowTreeDelta {
		const normalizedPath = this.normalizePath(notePath);
		const history = this.timeline.get(normalizedPath) ?? [];
		const beforeHash = this.hash(before), afterHash = this.hash(proposed);
		const delta: ShadowTreeDelta = {
			id: `${normalizedPath}:${Date.now()}:${afterHash}`,
			notePath: normalizedPath,
			parentId: history.at(-1)?.id ?? null,
			createdAt: Date.now(),
			reason: reason.trim(),
			beforeHash,
			afterHash,
			operations: this.lineDelta(before, proposed),
		};
		history.push(delta);
		this.timeline.set(normalizedPath, history);
		return this.copy(delta);
	}

	getTimeline(notePath: string): ShadowTreeDelta[] {
		return (this.timeline.get(this.normalizePath(notePath)) ?? []).map(delta => this.copy(delta));
	}

	getLatest(notePath: string): ShadowTreeDelta | null {
		const delta = this.timeline.get(this.normalizePath(notePath))?.at(-1);
		return delta ? this.copy(delta) : null;
	}

	clear(notePath?: string): void {
		if (notePath) this.timeline.delete(this.normalizePath(notePath));
		else this.timeline.clear();
	}

	private lineDelta(before: string, after: string): ShadowDeltaOperation[] {
		const left = before.split(/\r?\n/), right = after.split(/\r?\n/);
		let prefix = 0;
		while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
		let suffix = 0;
		while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - suffix - 1] === right[right.length - suffix - 1]) suffix++;
		const operations: ShadowDeltaOperation[] = [];
		if (prefix) operations.push({ kind: 'retain', startLine: 1, endLine: prefix, lines: left.slice(0, prefix) });
		const removed = left.slice(prefix, left.length - suffix);
		if (removed.length) operations.push({ kind: 'remove', startLine: prefix + 1, endLine: prefix + removed.length, lines: removed });
		const inserted = right.slice(prefix, right.length - suffix);
		if (inserted.length) operations.push({ kind: 'insert', startLine: prefix + 1, endLine: prefix + inserted.length, lines: inserted });
		if (suffix) operations.push({ kind: 'retain', startLine: left.length - suffix + 1, endLine: left.length, lines: left.slice(left.length - suffix) });
		return operations;
	}

	private normalizePath(path: string): string {
		const normalized = path.trim().replace(/\\/g, '/').replace(/^\/+/, '');
		if (!normalized || normalized.includes('..') || !normalized.toLocaleLowerCase().endsWith('.md')) throw new Error('Shadow archive requires a safe Markdown vault path.');
		return normalized;
	}
	private hash(value: string): string {
		let hash = 2166136261;
		for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
		return (hash >>> 0).toString(16).padStart(8, '0');
	}
	private copy(delta: ShadowTreeDelta): ShadowTreeDelta {
		return { ...delta, operations: delta.operations.map(operation => ({ ...operation, lines: [...operation.lines] })) };
	}
}
