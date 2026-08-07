/**
 * ClockPanel — a live, zero-cost, customizable clock and date widget.
 *
 * Principle 2 (Zero-Cost Intelligence): rendering reads the system clock and
 * the user's locale; it makes no model calls and spends no tokens.
 *
 * The clock is user-customizable: time format (system/12h/24h), a seconds
 * field, an optional date line with selectable verbosity, and an optional
 * label (e.g. a timezone or office name). It updates once per second without
 * holding a busy loop, and the interval is cleared on dispose so view close
 * never leaves a ticking timer behind.
 */

import { type App } from 'obsidian';
import type { TimeFormatPreference } from '../util/time-format';
import { formatTime } from '../util/time-format';

export interface ClockPanelOptions {
	getTimeFormat: () => TimeFormatPreference;
	getShowSeconds: () => boolean;
	getShowDate: () => boolean;
	getDateFormat: () => 'long' | 'short' | 'numeric';
	getLabel: () => string;
	/** Active view id; defaults to 'digital'. 'minimal' hides the date and label. */
	getView?: () => string;
}

/** A live wall clock + optional date and label, mounted into a dashboard section. */
export class ClockPanel {
	private hostEl: HTMLElement | null = null;
	private labelEl: HTMLElement | null = null;
	private timeEl: HTMLElement | null = null;
	private dateEl: HTMLElement | null = null;
	private timer: number | null = null;

	constructor(
		private readonly app: App,
		private readonly options: ClockPanelOptions,
	) {}

	mount(host: HTMLElement): void {
		this.hostEl = host;
		host.empty();
		host.addClass('cc-clock-panel');
		// Label is created once and toggled on each tick so a setting change
		// takes effect on the next second without a full re-mount.
		this.labelEl = host.createDiv({ cls: 'cc-clock-label' });
		this.timeEl = host.createDiv({ cls: 'cc-clock-time' });
		this.dateEl = host.createDiv({ cls: 'cc-clock-date' });
		this.tick();
		this.timer = window.setInterval(() => this.tick(), 1000);
	}

	private tick(): void {
		if (!this.timeEl || !this.dateEl || !this.labelEl || !this.hostEl) return;
		const now = new Date();

		const minimal = (this.options.getView?.() ?? 'digital') === 'minimal';
		this.hostEl.toggleClass('cc-clock-minimal', minimal);

		this.timeEl.setText(formatTime(now, this.options.getTimeFormat(), this.options.getShowSeconds()));

		const showDate = !minimal && this.options.getShowDate();
		this.dateEl.toggleClass('is-hidden', !showDate);
		if (showDate) {
			const fmt = this.options.getDateFormat();
			try {
				if (fmt === 'long') {
					this.dateEl.setText(now.toLocaleDateString(undefined, {
						weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
					}));
				} else if (fmt === 'short') {
					this.dateEl.setText(now.toLocaleDateString(undefined, {
						weekday: 'short', month: 'short', day: 'numeric',
					}));
				} else {
					this.dateEl.setText(now.toLocaleDateString(undefined, {
						year: 'numeric', month: '2-digit', day: '2-digit',
					}));
				}
			} catch {
				this.dateEl.setText(now.toDateString());
			}
		}

		const label = !minimal && this.options.getLabel().trim();
		this.labelEl.toggleClass('is-hidden', !label);
		if (label) this.labelEl.setText(label);
	}

	dispose(): void {
		if (this.timer !== null) {
			window.clearInterval(this.timer);
			this.timer = null;
		}
		this.hostEl = null;
		this.labelEl = null;
		this.timeEl = null;
		this.dateEl = null;
	}

	/** Repaint immediately. Used by the host when the view changes so a new
	 * mode appears without waiting for the next one-second tick. */
	refresh(): void {
		this.tick();
	}
}
