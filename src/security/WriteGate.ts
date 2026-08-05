/**
 * WriteGate — the single boundary between the machine and the vault.
 *
 * Principle 1 (Absolute Write-Gate Authority): no capability may unilaterally
 * mutate the vault. Every mutating tool call is routed through `authorize()`,
 * which stages the operation as a proposal and blocks until the operator clicks
 * approve in the dashboard UI.
 *
 * The only bypass is the operator's own global Auto Write setting, and even that
 * cannot override an explicitly protected path. Protected paths are supplied by
 * the user; this module hardcodes no folder names or methodology.
 */

import type { ToolConfirmationDecision, ToolConfirmationRequest, ToolDefinition } from '../types';

/** Outcome of a gate decision, retained for the transparency log. */
export interface WriteGateRecord {
	toolName: string;
	targetPaths: string[];
	decision: ToolConfirmationDecision | 'auto-approved';
	/** Why the gate resolved the way it did, shown verbatim in the UI. */
	reason: string;
	at: number;
}

export interface WriteGatePolicy {
	/** Operator's global Auto Write bypass. */
	autoWriteEnabled: () => boolean;
	/** Vault-relative folders that always require an explicit click. */
	protectedPaths: () => readonly string[];
	/** Presents the proposal in the dashboard and resolves with the click. */
	requestApproval: (request: ToolConfirmationRequest) => Promise<ToolConfirmationDecision>;
	/** Optional sink for the audit trail. */
	onRecord?: (record: WriteGateRecord) => void;
}

const MAX_HISTORY = 200;

/** Normalize for prefix comparison without importing Obsidian. */
function normalize(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

/** True when `path` is inside (or equal to) `root`. */
function isInside(path: string, root: string): boolean {
	const target = normalize(path);
	const base = normalize(root);
	if (!base) return false;
	return target === base || target.startsWith(`${base}/`);
}

/** Central authority for every vault mutation. */
export class WriteGate {
	private readonly history: WriteGateRecord[] = [];

	constructor(private readonly policy: WriteGatePolicy) {}

	/** Most recent decisions, newest last. */
	getHistory(): readonly WriteGateRecord[] {
		return this.history;
	}

	/** True when at least one supplied path sits under a protected root. */
	isProtected(paths: readonly string[]): boolean {
		const roots = this.policy.protectedPaths();
		return paths.some(path => roots.some(root => isInside(path, root)));
	}

	/**
	 * Decide whether a tool invocation may proceed.
	 *
	 * Returns `true` only when the operation is non-mutating, was explicitly
	 * approved, or was auto-approved by a policy that does not touch a protected
	 * path. Any other outcome returns `false` and the caller must not write.
	 */
	async authorize(tool: ToolDefinition, params: Record<string, unknown>): Promise<{ allowed: boolean; reason: string }> {
		// A tool without a confirmation contract declares itself non-mutating.
		if (!tool.confirmation) return { allowed: true, reason: 'Read-only capability.' };
		const request = await tool.confirmation(params);
		if (!request) return { allowed: true, reason: 'Capability reported no mutation for these parameters.' };

		const targets = request.targetPaths;
		const protectedTarget = this.isProtected(targets);
		if (this.policy.autoWriteEnabled() && !protectedTarget) {
			this.record({
				toolName: request.toolName || tool.name,
				targetPaths: targets,
				decision: 'auto-approved',
				reason: 'Auto Write is enabled and no protected path is affected.',
				at: Date.now(),
			});
			return { allowed: true, reason: 'Auto Write bypass.' };
		}

		const reason = protectedTarget
			? 'A protected path is affected, so explicit approval is always required.'
			: 'Auto Write is disabled, so every mutation requires explicit approval.';
		const decision = await this.policy.requestApproval({
			...request,
			toolName: request.toolName || tool.name,
			proposedChanges: `${request.proposedChanges || 'Vault mutation'}\n\n${reason}`,
		});
		this.record({ toolName: request.toolName || tool.name, targetPaths: targets, decision, reason, at: Date.now() });
		return decision === 'approved'
			? { allowed: true, reason: 'Operator approved the proposal.' }
			: { allowed: false, reason: `Operation was not approved (${decision}).` };
	}

	private record(record: WriteGateRecord): void {
		this.history.push(record);
		if (this.history.length > MAX_HISTORY) this.history.shift();
		this.policy.onRecord?.(record);
	}
}

/**
 * Wrap every tool so its execution physically cannot occur without passing the
 * gate. This is the enforcement point: callers receive tools that already
 * embed authorization, so a forgotten check at a call site cannot bypass it.
 */
export function gateTools(tools: readonly ToolDefinition[], gate: WriteGate): ToolDefinition[] {
	return tools.map(tool => ({
		...tool,
		execute: async (toolCallId: string, params: Record<string, unknown>) => {
			const verdict = await gate.authorize(tool, params);
			if (!verdict.allowed) throw new Error(verdict.reason);
			return tool.execute(toolCallId, params);
		},
	}));
}
