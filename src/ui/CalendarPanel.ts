/**
 * CalendarPanel — the month grid that turns dates into a doorway.
 *
 * Principle 2 (Zero-Cost Intelligence): every dot, count, and badge comes from
 * the local `VaultSnapshot`. Rendering a month costs no tokens.
 *
 * Principle 6 (Centralized Operational Hub): a day cell is a navigation target.
 * Clicking a date reveals that day's note, its tasks, and anything due, and lets
 * the operator add or complete work without leaving the dashboard.
 *
 * Principle 1: task mutations are proposals. Every write goes through
 * `TaskWriter`, which routes to the write gate.
 */

import { type App, Notice, TFile, setIcon } from 'obsidian';
import type { VaultSnapshot, VaultTask } from '../intelligence/VaultDataBridge';
import type { TaskWriter } from '../intelligence/TaskWriter';

export interface CalendarPanelOptions {
	/** Resolve the daily-note path for a date, or null when unconfigured. */
	dailyNotePathFor: (date: Date) => string | null;
	/** Mutation surface; all writes pass the write gate. */
	tasks: TaskWriter;
	/** Ask the host to recompute the snapshot after a successful write. */
	onChanged: () => void | Promise<void>;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Local ISO date (YYYY-MM-DD) without UTC drift. */
function isoDate(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Monday-first weekday index. */
function weekdayIndex(date: Date): number {
	return (date.getDay() + 6) % 7;
}

/** Month/year label in the user's own locale. */
function monthLabel(date: Date): string {
	return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/**
 * A month calendar plus a detail pane for the selected day. Mount once, then
 * call `update()` whenever a new snapshot is available.
 */
export class CalendarPanel {
	private hostEl: HTMLElement | null = null;
	private gridEl: HTMLElement | null = null;
	private detailEl: HTMLElement | null = null;
	private titleEl: HTMLElement | null = null;
	private snapshot: VaultSnapshot | null = null;
	private cursor = new Date();
	private selected = isoDate(new Date());

	constructor(
		private readonly app: App,
		private readonly options: CalendarPanelOptions,
	) {}

	/** Build the static shell. Data arrives via `update()`. */
	mount(host: HTMLElement): void {
		this.hostEl = host;
		host.empty();
		host.addClass('cc-calendar');

		const header = host.createDiv({ cls: 'cc-calendar-header' });
		const prev = header.createEl('button', { attr: { 'aria-label': 'Previous month' } });
		setIcon(prev, 'chevron-left');
		prev.addEventListener('click', () => this.shiftMonth(-1));
		this.titleEl = header.createDiv({ cls: 'cc-calendar-title' });
		const next = header.createEl('button', { attr: { 'aria-label': 'Next month' } });
		setIcon(next, 'chevron-right');
		next.addEventListener('click', () => this.shiftMonth(1));
		const today = header.createEl('button', { text: 'Today' });
		today.addEventListener('click', () => {
			this.cursor = new Date();
			this.selected = isoDate(new Date());
			this.render();
		});

		const weekdays = host.createDiv({ cls: 'cc-calendar-weekdays' });
		for (const day of WEEKDAYS) weekdays.createDiv({ text: day });
		this.gridEl = host.createDiv({ cls: 'cc-calendar-grid' });
		this.detailEl = host.createDiv({ cls: 'cc-calendar-detail' });
	}

	/** Supply a fresh snapshot and repaint. */
	update(snapshot: VaultSnapshot): void {
		this.snapshot = snapshot;
		this.render();
	}

	dispose(): void {
		this.hostEl = null;
		this.gridEl = null;
		this.detailEl = null;
		this.titleEl = null;
	}

	private shiftMonth(delta: number): void {
		this.cursor = new Date(this.cursor.getFullYear(), this.cursor.getMonth() + delta, 1);
		this.render();
	}

	/** Group every dated task by ISO day for O(1) cell lookups. */
	private tasksByDay(): Map<string, VaultTask[]> {
		const map = new Map<string, VaultTask[]>();
		for (const task of this.snapshot?.tasks ?? []) {
			if (!task.due) continue;
			const bucket = map.get(task.due) ?? [];
			bucket.push(task);
			map.set(task.due, bucket);
		}
		return map;
	}

	private render(): void {
		if (!this.gridEl || !this.titleEl) return;
		this.titleEl.setText(monthLabel(this.cursor));
		this.gridEl.empty();

		const byDay = this.tasksByDay();
		const year = this.cursor.getFullYear();
		const month = this.cursor.getMonth();
		const first = new Date(year, month, 1);
		const daysInMonth = new Date(year, month + 1, 0).getDate();
		const todayIso = isoDate(new Date());

		// Leading blanks so the 1st lands on its true weekday.
		for (let i = 0; i < weekdayIndex(first); i++) this.gridEl.createDiv({ cls: 'cc-calendar-cell is-empty' });

		for (let day = 1; day <= daysInMonth; day++) {
			const date = new Date(year, month, day);
			const iso = isoDate(date);
			const dayTasks = byDay.get(iso) ?? [];
			const open = dayTasks.filter(task => !task.done);
			const notePath = this.options.dailyNotePathFor(date);
			const hasNote = notePath !== null && this.app.vault.getAbstractFileByPath(notePath) instanceof TFile;

			const cell = this.gridEl.createDiv({ cls: 'cc-calendar-cell', attr: { role: 'button', tabindex: '0' } });
			cell.toggleClass('is-today', iso === todayIso);
			cell.toggleClass('is-selected', iso === this.selected);
			cell.toggleClass('has-note', hasNote);
			cell.toggleClass('is-overdue', open.some(task => task.overdue));
			cell.setAttribute(
				'aria-label',
				`${iso}${hasNote ? ', has a note' : ''}${open.length ? `, ${open.length} open task${open.length === 1 ? '' : 's'}` : ''}`,
			);
			cell.createDiv({ text: String(day), cls: 'cc-calendar-day' });
			const marks = cell.createDiv({ cls: 'cc-calendar-marks' });
			if (hasNote) marks.createSpan({ cls: 'cc-calendar-dot is-note', attr: { title: 'Daily note exists' } });
			if (open.length > 0) marks.createSpan({ text: String(open.length), cls: 'cc-calendar-count' });

			const select = () => {
				this.selected = iso;
				this.render();
			};
			cell.addEventListener('click', select);
			cell.addEventListener('keydown', event => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					select();
				}
			});
		}
		this.renderDetail(byDay.get(this.selected) ?? []);
	}

	/** The selected day's note link, its dated tasks, and a quick-add row. */
	private renderDetail(dayTasks: VaultTask[]): void {
		const host = this.detailEl;
		if (!host) return;
		host.empty();
		const date = new Date(`${this.selected}T00:00:00`);
		const heading = host.createDiv({ cls: 'cc-calendar-detail-header' });
		heading.createEl('strong', { text: date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) });

		const notePath = this.options.dailyNotePathFor(date);
		if (notePath) {
			const exists = this.app.vault.getAbstractFileByPath(notePath) instanceof TFile;
			const open = heading.createEl('button', { text: exists ? 'Open note' : 'Create note' });
			open.addEventListener('click', () => void this.openOrCreateDailyNote(notePath));
		} else {
			heading.createSpan({ cls: 'cc-widget-caption', text: 'Configure daily notes to open a note for this date.' });
		}

		const list = host.createDiv({ cls: 'cc-calendar-tasks' });
		if (dayTasks.length === 0) {
			list.createDiv({ text: 'Nothing scheduled for this day.', cls: 'cc-intel-empty' });
		}
		for (const task of dayTasks) {
			const rowEl = list.createDiv({ cls: 'cc-calendar-task' });
			rowEl.toggleClass('is-done', task.done);
			const box = rowEl.createEl('input', { type: 'checkbox' });
			box.checked = task.done;
			box.setAttribute('aria-label', `Mark "${task.text}" ${task.done ? 'incomplete' : 'complete'}`);
			box.addEventListener('change', () => {
				box.disabled = true;
				void this.run(() => this.options.tasks.toggleTask(task.path, task.line, box.checked), () => {
					box.checked = task.done;
					box.disabled = false;
				});
			});
			const text = rowEl.createDiv({ cls: 'cc-calendar-task-text' });
			text.createDiv({ text: task.text });
			text.createDiv({ text: task.basename, cls: 'cc-intel-row-secondary' });
			const jump = rowEl.createEl('button', { attr: { 'aria-label': 'Open this task in its note' } });
			setIcon(jump, 'arrow-up-right');
			jump.addEventListener('click', () => void this.openAt(task.path, task.line));
			const remove = rowEl.createEl('button', { attr: { 'aria-label': 'Delete this task' } });
			setIcon(remove, 'trash-2');
			remove.addEventListener('click', () => {
				remove.disabled = true;
				void this.run(() => this.options.tasks.deleteTask(task.path, task.line), () => {
					remove.disabled = false;
				});
			});
		}

		// Quick add: capture straight into the selected day.
		const add = host.createDiv({ cls: 'cc-calendar-add' });
		const input = add.createEl('input', {
			type: 'text',
			attr: { placeholder: 'Add a task for this day…', 'aria-label': 'New task text' },
		});
		const submit = add.createEl('button', { text: 'Add', cls: 'mod-cta' });
		const commit = () => {
			const value = input.value.trim();
			if (!value) return;
			if (!notePath) {
				new Notice('Configure a daily-note location before adding dated tasks, or add the task from a note.');
				return;
			}
			submit.disabled = true;
			void this.run(
				() => this.options.tasks.createTask({ path: notePath }, { text: value, due: this.selected }),
				() => {
					submit.disabled = false;
				},
				() => {
					input.value = '';
				},
			);
		};
		submit.addEventListener('click', commit);
		input.addEventListener('keydown', event => {
			if (event.key === 'Enter') {
				event.preventDefault();
				commit();
			}
		});
		host.createDiv({
			cls: 'cc-widget-hint',
			text: 'Click a date to see its note and scheduled work. Tasks you add here are written to that day’s note after you approve the change.',
		});
	}

	/**
	 * Run a gated mutation, reporting the real outcome. Never claims success
	 * unless the write actually happened (Principle 4).
	 */
	private async run(action: () => Promise<boolean>, cleanup: () => void, onSuccess?: () => void): Promise<void> {
		try {
			const written = await action();
			if (!written) {
				new Notice('Change was not approved. Nothing was written.');
				cleanup();
				return;
			}
			onSuccess?.();
			await this.options.onChanged();
		} catch (error) {
			new Notice(`Task update failed: ${error instanceof Error ? error.message : String(error)}`, 10_000);
			cleanup();
		}
	}

	private async openAt(path: string, line: number): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice(`${path} is no longer in the vault.`);
			return;
		}
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);
		const view = leaf.view as { editor?: { setCursor: (pos: { line: number; ch: number }) => void } };
		view.editor?.setCursor({ line: Math.max(0, line - 1), ch: 0 });
	}

	/** Open the day's note, creating an empty one on request. */
	private async openOrCreateDailyNote(path: string): Promise<void> {
		try {
			let file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) {
				const written = await this.options.tasks.createTask({ path }, { text: 'Plan the day' });
				if (!written) {
					new Notice('Note creation was not approved.');
					return;
				}
				file = this.app.vault.getAbstractFileByPath(path);
				await this.options.onChanged();
			}
			if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
		} catch (error) {
			new Notice(`Could not open ${path}: ${error instanceof Error ? error.message : String(error)}`, 10_000);
		}
	}
}
