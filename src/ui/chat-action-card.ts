import type { ToolConfirmationDecision, ToolConfirmationRequest } from '../types';

export type ChatActionCardState = 'pending' | ToolConfirmationDecision;

export interface ChatActionCardOptions extends ToolConfirmationRequest {
	timeoutMs: number;
}

/**
 * Inline confirmation UI for destructive agent tools. Its promise settles once
 * on approval, rejection, timeout, or disposal, allowing tool execution to
 * pause without blocking the UI thread.
 */
export class ChatActionCard {
	readonly element: HTMLElement;
	private state: ChatActionCardState = 'pending';
	private timer: number | null = null;
	private settlePromise: Promise<ToolConfirmationDecision>;
	private settleDecision!: (decision: ToolConfirmationDecision) => void;
	private approveButton: HTMLButtonElement;
	private rejectButton: HTMLButtonElement;
	private statusEl: HTMLElement;
	private deadline: number;

	constructor(parent: HTMLElement, private readonly options: ChatActionCardOptions) {
		this.deadline = Date.now() + Math.max(0, options.timeoutMs);
		this.settlePromise = new Promise(resolve => { this.settleDecision = resolve; });
		this.element = parent.createDiv({
			cls: 'cc-chat-action-card',
			attr: { role: 'group', 'aria-label': `Confirm ${options.toolName}` },
		});
		const header = this.element.createDiv({ cls: 'cc-chat-action-header' });
		header.createSpan({ text: '⚠', cls: 'cc-chat-action-icon', attr: { 'aria-hidden': 'true' } });
		header.createSpan({ text: 'Action requires confirmation', cls: 'cc-chat-action-title' });
		this.statusEl = header.createSpan({ cls: 'cc-chat-action-status', text: 'Pending' });
		this.element.createDiv({ cls: 'cc-chat-action-tool', text: `Tool: ${options.toolName}` });
		const targets = this.element.createDiv({ cls: 'cc-chat-action-targets' });
		targets.createEl('strong', { text: 'Targets' });
		const targetList = targets.createEl('ul');
		for (const path of options.targetPaths) targetList.createEl('li', { text: path });
		const changes = this.element.createDiv({ cls: 'cc-chat-action-changes' });
		const diff = changes.createEl('details', { cls: 'cc-chat-action-diff' });
		diff.open = options.proposedChanges.split(/\r?\n/).length <= 24;
		diff.createEl('summary', { text: 'Proposed changes · diff preview' });
		const preview = diff.createEl('pre', { attr: { 'aria-label': 'Proposed change diff' } });
		for (const line of (options.proposedChanges || '(No diff provided)').split(/\r?\n/)) {
			preview.createSpan({
				cls: line.startsWith('+') && !line.startsWith('+++')
					? 'cc-diff-add'
					: line.startsWith('-') && !line.startsWith('---') ? 'cc-diff-remove' : line.startsWith('@@') ? 'cc-diff-hunk' : 'cc-diff-context',
				text: `${line}\n`,
			});
		}
		const actions = this.element.createDiv({ cls: 'cc-chat-action-buttons' });
		this.approveButton = actions.createEl('button', { cls: 'mod-cta', text: 'Approve & Apply' });
		this.rejectButton = actions.createEl('button', { text: 'Reject' });
		this.approveButton.addEventListener('click', this.onApprove);
		this.rejectButton.addEventListener('click', this.onReject);
		if (options.timeoutMs <= 0) this.finish('timed-out');
		else this.timer = this.element.ownerDocument?.defaultView?.setTimeout(
			() => this.finish('timed-out'), options.timeoutMs,
		) ?? window.setTimeout(() => this.finish('timed-out'), options.timeoutMs);
	}

	wait(): Promise<ToolConfirmationDecision> { return this.settlePromise; }
	getState(): ChatActionCardState { return this.state; }
	getRemainingMs(): number { return this.state === 'pending' ? Math.max(0, this.deadline - Date.now()) : 0; }

	approve(): void { this.finish('approved'); }
	reject(): void { this.finish('rejected'); }

	/** Closing the chat is equivalent to rejecting an unreviewed mutation. */
	dispose(): void {
		if (this.state === 'pending') this.finish('rejected');
		this.approveButton.removeEventListener('click', this.onApprove);
		this.rejectButton.removeEventListener('click', this.onReject);
	}

	private readonly onApprove = () => this.approve();
	private readonly onReject = () => this.reject();

	private finish(decision: ToolConfirmationDecision): void {
		if (this.state !== 'pending') return;
		this.state = decision;
		if (this.timer !== null) {
			(this.element.ownerDocument?.defaultView ?? window).clearTimeout(this.timer);
		}
		this.timer = null;
		this.approveButton.disabled = true;
		this.rejectButton.disabled = true;
		this.element.addClass(`is-${decision}`);
		this.statusEl.setText(decision === 'approved' ? 'Approved' : decision === 'rejected' ? 'Rejected' : 'Timed out');
		this.settleDecision(decision);
	}
}
