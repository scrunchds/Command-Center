/**
 * DailySchedulePanel — a zero-cost "today, by time" view.
 *
 * Principle 2 (Zero-Cost Intelligence): every row comes from the local
 * `VaultSnapshot`. Building the day costs no tokens.
 *
 * Principle 6 (Centralized Operational Hub): the schedule is one more doorway.
 * Each row links to its source note so the operator can jump straight to the
 * work. Task mutations are not performed here — click-through keeps the write
 * gate as the single mutation boundary, mirroring how custom cards deep-link.
 *
 * Time discovery is intentionally permissive and human-editable: a task carries
 * a time when its text contains an inline `⏰ HH:MM`, a Dataview-style
 * `[time:: HH:MM]`/`[start:: HH:MM]` field, or the note's frontmatter defines
 * `time`/`start`. Tasks without a time fall into an "unscheduled" group so
 * nothing due today is hidden.
 */

import { type App, TFile, setIcon } from 'obsidian';
import type { VaultSnapshot, VaultTask } from '../intelligence/VaultDataBridge';

export interface DailySchedulePanelOptions {
	/** Resolve the daily-note path for a date, or null when unconfigured. */
	dailyNotePathFor: (date: Date) => string | null;
}

/** Local ISO date (YYYY-MM-DD) without UTC drift. */
function isoDate(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const TIME_TAG = /(?:⏰|\btime\b|\bstart\b)[:\s]+(\d{1,2}:\d{2}\s*(?:[ap]\.?m\.?)?)/i;
const TIME_FIELD = /\[(?:time|start)::\s*(\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?)\s*\]/i;

/** Parse a wall-clock time from a task string. Returns normalized HH:MM (24h) or null. */
export function parseTaskTime(text: string): string | null {
	const inline = TIME_TAG.exec(text);
	const field = TIME_FIELD.exec(text);
	const raw = (field?.[1] ?? inline?.[1] ?? '').trim();
	if (!raw) return null;
	return to24h(raw);
}

/** Convert "2:30 pm" / "14:00" / "2:30p" to "14:30". Returns null when unparseable. */
function to24h(value: string): string | null {
	const match = /(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?/i.exec(value);
	if (!match) return null;
	let hour = Number(match[1]);
	const minute = Number(match[2]);
	const meridiem = (match[3] ?? '').toLowerCase();
	if (meridiem.startsWith('p') && hour < 12) hour += 12;
	if (meridiem.startsWith('a') && hour === 12) hour = 0;
	if (hour > 23 || minute > 59) return null;
	return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

interface ScheduleRow {
	task: VaultTask;
	time: string | null;
}

/** A zero-cost daily schedule derived from the vault snapshot. */
export class DailySchedulePanel {
	private hostEl: HTMLElement | null = null;
	private snapshot: VaultSnapshot | null = null;

	constructor(
		private readonly app: App,
		private readonly options: DailySchedulePanelOptions,
	) {}

	mount(host: HTMLElement): void {
		this.hostEl = host;
		host.empty();
		host.addClass('cc-schedule-panel');
		this.render();
	}

	update(snapshot: VaultSnapshot): void {
		this.snapshot = snapshot;
		this.render();
	}

	private render(): void {
		const host = this.hostEl;
		if (!host) return;
		host.empty();

		const today = isoDate(new Date());
		const tasks = this.snapshot?.tasks ?? [];
		const dueToday = tasks.filter(task => !task.done && task.due === today);
		if (dueToday.length === 0) {
			host.createDiv({
				cls: 'cc-schedule-empty cc-intel-empty',
				text: 'Nothing scheduled for today. Tasks with a due date of today appear here; add a time like "⏰ 14:00" to order them.',
			});
			return;
		}

		const rows: ScheduleRow[] = dueToday.map(task => ({ task, time: parseTaskTime(task.text) }));
		rows.sort((a, b) => {
			if (a.time && b.time) return a.time.localeCompare(b.time);
			if (a.time) return -1;
			if (b.time) return 1;
			return a.task.text.localeCompare(b.task.text);
		});

		const timed = rows.filter(row => row.time);
		const untimed = rows.filter(row => !row.time);

		if (timed.length) {
			const list = host.createEl('ul', { cls: 'cc-schedule-list' });
			for (const row of timed) this.renderRow(list, row);
		}
		if (untimed.length) {
			if (timed.length) host.createDiv({ cls: 'cc-schedule-divider', text: 'Unscheduled' });
			const list = host.createEl('ul', { cls: 'cc-schedule-list cc-schedule-untimed' });
			for (const row of untimed) this.renderRow(list, row);
		}

		host.createDiv({
			cls: 'cc-widget-caption cc-schedule-hint',
			text: 'Add a time to any task with "⏰ HH:MM" or [time:: HH:MM] to place it on the timeline.',
		});
	}

	private renderRow(list: HTMLElement, row: ScheduleRow): void {
		const item = list.createEl('li', { cls: 'cc-schedule-row' });
		if (row.time) {
			const time = item.createDiv({ cls: 'cc-schedule-time' });
			setIcon(time.createSpan({ cls: 'cc-schedule-time-icon' }), 'clock');
			time.createSpan({ text: row.time });
		}
		const body = item.createDiv({ cls: 'cc-schedule-body' });
		body.createDiv({ text: row.task.text, cls: 'cc-schedule-text' });
		body.createDiv({ text: row.task.basename, cls: 'cc-widget-caption cc-schedule-source' });
		const jump = item.createEl('button', {
			cls: 'cc-schedule-jump',
			attr: { 'aria-label': `Open ${row.task.path} at this task` },
		});
		setIcon(jump, 'arrow-up-right');
		jump.addEventListener('click', () => void this.openAt(row.task.path, row.task.line));
	}

	private async openAt(path: string, line: number): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);
		const view = leaf.view as { editor?: { setCursor: (pos: { line: number; ch: number }) => void } };
		view.editor?.setCursor({ line: Math.max(0, line - 1), ch: 0 });
	}
}
