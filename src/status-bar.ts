/**
 * Status Bar — visual indicator for daemon and task queue state.
 *
 * Shows an icon + label in Obsidian's status bar: alive (green), busy (yellow),
 * stopped (red). Updates reactively via event listeners from the task queue
 * and daemon lifecycle.
 */

type QueueStatsShape = { pending: number; running: number; completed: number; failed: number; total: number };

export type StatusBarState = 'stopped' | 'running' | 'busy' | 'error';

export class CommandCenterStatusBar {
	private statusBarEl: HTMLElement;
	private state: StatusBarState = 'stopped';
	private stats: QueueStatsShape = { pending: 0, running: 0, completed: 0, failed: 0, total: 0 };
	private label: string = 'CC';

	constructor(statusBarEl: HTMLElement, label: string = 'CC') {
		this.statusBarEl = statusBarEl;
		this.label = label;
		this.render();
	}

	/* ─── Public API ─────────────────────────────────── */

	setState(state: StatusBarState): void {
		this.state = state;
		this.render();
	}

	setStats(stats: QueueStatsShape): void {
		this.stats = stats;
		this.render();
	}

	setLabel(label: string): void {
		this.label = label;
		this.render();
	}

	/* ─── Rendering ──────────────────────────────────── */

	private render(): void {
		const { statusBarEl, state, stats, label } = this;

		// Clear and rebuild
		statusBarEl.empty();
		statusBarEl.className = 'command-center-status-bar';

		// State class for CSS styling
		statusBarEl.classList.add(state);

		// Icon + label
		const iconSpan = statusBarEl.createSpan({ cls: 'command-center-status-icon' });
		iconSpan.textContent = this.getIcon();

		const textSpan = statusBarEl.createSpan({ cls: 'command-center-status-text' });
		textSpan.textContent = `${label} ${stats.running > 0 ? `(${stats.running} active)` : ''}`;

		// Tooltip with detailed stats
		statusBarEl.setAttribute('title', this.buildTooltip());
	}

	private getIcon(): string {
		switch (this.state) {
			case 'running':
				return '▶';
			case 'busy':
				return '⚡';
			case 'error':
				return '✕';
			case 'stopped':
			default:
				return '■';
		}
	}

	private buildTooltip(): string {
		const lines: string[] = [`State: ${this.state}`];
		if (this.stats.total > 0) {
			lines.push(
				`Queue: ${this.stats.pending} pending, ${this.stats.running} running, ` +
				`${this.stats.completed} completed, ${this.stats.failed} failed`,
			);
		}
		return lines.join('\n');
	}
}