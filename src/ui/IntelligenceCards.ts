/**
 * IntelligenceCards — the four deterministic "Happening Now" cards.
 *
 * Principle 2 (Zero-Cost Intelligence): every value rendered here comes from
 * `VaultDataBridge`, which reads only Obsidian's metadata cache. No provider
 * call, no daemon round-trip, no token spend.
 *
 * Principle 5 (Native Obsidian Harmony): rows open notes through the native
 * workspace API and are laid out with a responsive CSS Grid using Obsidian's
 * own theme variables.
 *
 * Principle 4 (Total System Transparency): each card states its data source,
 * scan cost, and freshness, and says plainly when it is unconfigured or empty
 * instead of rendering a misleading blank.
 */

import { type App, Notice, TFile, setIcon } from 'obsidian';
import type { BaseView, CaptureEntry, VaultSnapshot, VaultTask, WorkspaceSummary } from '../intelligence/VaultDataBridge';
import type { ActionLaneConfig, ActionLaneFilter, IntelligenceCardEntry, IntelligenceCardId } from '../settings/settings-model';

const MAX_ROWS = 6;

/** Open a vault note at an optional line through native Obsidian APIs. */
async function openNote(app: App, path: string, line?: number): Promise<void> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) {
		new Notice(`${path} is no longer in the vault.`);
		return;
	}
	const leaf = app.workspace.getLeaf(false);
	await leaf.openFile(file);
	if (line && line > 1) {
		const view = leaf.view as { editor?: { setCursor: (pos: { line: number; ch: number }) => void } };
		view.editor?.setCursor({ line: line - 1, ch: 0 });
	}
}

/**
 * Render a card shell with a title, live source caption, and a one-line hint
 * telling the operator what this card is for.
 */
function card(host: HTMLElement, title: string, source: string, hint: string): HTMLElement {
	const section = host.createDiv({ cls: 'cc-intel-card' });
	const header = section.createDiv({ cls: 'cc-intel-card-header' });
	header.createEl('h4', { text: title });
	header.createSpan({ text: source, cls: 'cc-intel-card-source' });
	section.createDiv({ text: hint, cls: 'cc-intel-card-hint' });
	return section.createDiv({ cls: 'cc-intel-card-body' });
}

function empty(host: HTMLElement, message: string): void {
	host.createDiv({ text: message, cls: 'cc-intel-empty' });
}

/** One clickable row that deep-links into the vault. */
function row(
	host: HTMLElement,
	app: App,
	options: { icon: string; primary: string; secondary?: string; badge?: string; state?: string; path: string; line?: number },
): void {
	const element = host.createDiv({ cls: 'cc-intel-row', attr: { role: 'button', tabindex: '0' } });
	if (options.state) element.addClass(`is-${options.state}`);
	setIcon(element.createSpan({ cls: 'cc-intel-row-icon' }), options.icon);
	const text = element.createDiv({ cls: 'cc-intel-row-text' });
	text.createDiv({ text: options.primary, cls: 'cc-intel-row-primary' });
	if (options.secondary) text.createDiv({ text: options.secondary, cls: 'cc-intel-row-secondary' });
	if (options.badge) element.createSpan({ text: options.badge, cls: 'cc-intel-row-badge' });
	const activate = () => void openNote(app, options.path, options.line);
	element.addEventListener('click', activate);
	element.addEventListener('keydown', event => {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			activate();
		}
	});
}

function relative(timestamp: number | null): string {
	if (timestamp === null) return 'never';
	const minutes = Math.round((Date.now() - timestamp) / 60_000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

/** Configuration passed into the renderer so cards/lanes honor user choices. */
export interface IntelligenceRenderConfig {
	cards: IntelligenceCardEntry[];
	lanes: ActionLaneConfig[];
}

/** Today's date as ISO YYYY-MM-DD, without UTC drift. */
function todayIso(): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Apply a lane's deterministic filter to a single task. */
function taskMatchesLane(task: VaultTask, filter: ActionLaneFilter, today: string): boolean {
	switch (filter) {
		case 'overdue': return !task.done && task.overdue;
		case 'due-today': return !task.done && !task.overdue && task.due === today;
		case 'upcoming': return !task.done && task.due !== null && task.due > today;
		case 'undated': return !task.done && task.due === null;
		case 'done': return task.done;
		case 'all': return true;
	}
}

/** Daily Intelligence — today's note, its sections, metrics, and capacity rules. */
function renderDaily(host: HTMLElement, app: App, snapshot: VaultSnapshot): void {
	const body = card(
		host,
		'Daily intelligence',
		'metadata cache',
		"Today's note at a glance, with any capacity rule that has tripped. Click to open it.",
	);
	const daily = snapshot.daily;
	if (!snapshot.configured) {
		empty(body, 'Daily structure is interview-derived. Run discovery to enable this card.');
		return;
	}
	if (!daily.path) {
		empty(body, 'No daily-note location is configured yet.');
		return;
	}
	if (!daily.exists) {
		row(body, app, { icon: 'calendar-plus', primary: "Today's note does not exist yet", secondary: daily.path, path: daily.path, state: 'pending' });
		return;
	}
	row(body, app, { icon: 'calendar-check', primary: "Open today's note", secondary: daily.path, path: daily.path, state: 'ok' });
	if (daily.metrics.length > 0) {
		const metrics = body.createDiv({ cls: 'cc-intel-metrics' });
		for (const metric of daily.metrics) {
			const chip = metrics.createDiv({ cls: 'cc-intel-metric' });
			chip.createSpan({ text: metric.key, cls: 'cc-intel-metric-key' });
			chip.createSpan({ text: metric.value, cls: 'cc-intel-metric-value' });
		}
	}
	const triggered = daily.capacity.filter(rule => rule.triggered);
	for (const rule of triggered.slice(0, MAX_ROWS)) {
		const alert = body.createDiv({ cls: 'cc-intel-alert' });
		alert.createEl('strong', { text: `${rule.metric} = ${rule.value ?? 'n/a'}` });
		alert.createSpan({ text: rule.action });
	}
	if (daily.sections.length > 0) {
		body.createDiv({ text: `Sections: ${daily.sections.slice(0, 8).join(' · ')}`, cls: 'cc-intel-footnote' });
	}
}

/** Capture — inbox entries awaiting triage. */
function renderCapture(host: HTMLElement, app: App, snapshot: VaultSnapshot, captures: CaptureEntry[]): void {
	const body = card(
		host,
		'Capture',
		`${snapshot.totals.captures} pending`,
		'Notes you dropped in but have not filed yet. Open one to process it, or ask the orchestrator to triage them.',
	);
	if (!snapshot.configured) {
		empty(body, 'Capture locations are interview-derived. Run discovery to enable this card.');
		return;
	}
	if (captures.length === 0) {
		empty(body, 'Capture surfaces are clear.');
		return;
	}
	for (const entry of captures.slice(0, MAX_ROWS)) {
		row(body, app, {
			icon: 'inbox',
			primary: entry.basename,
			secondary: entry.excerpt || entry.path,
			badge: relative(entry.createdAt),
			path: entry.path,
		});
	}
	if (captures.length > MAX_ROWS) body.createDiv({ text: `+${captures.length - MAX_ROWS} more`, cls: 'cc-intel-footnote' });
}

/**
 * Action items — checkbox tasks and property-driven work, grouped into
 * user-configurable Kanban-style lanes. Lanes are derived from dates the user
 * already wrote in the vault; no methodology or column names are imposed. A
 * "done" lane surfaces completed work only when the user adds one, so the
 * default board stays focused on open tasks.
 */
function renderActions(host: HTMLElement, app: App, snapshot: VaultSnapshot, tasks: VaultTask[], lanes: ActionLaneConfig[]): void {
	const today = todayIso();
	const body = card(
		host,
		'Action items',
		`${snapshot.totals.openTasks} open · ${snapshot.totals.overdueTasks} overdue`,
		'Open tasks from across the vault, grouped into your configured lanes. Click a row to jump to that exact line.',
	);
	const laneState = (filter: ActionLaneFilter): string | undefined => {
		if (filter === 'overdue') return 'overdue';
		if (filter === 'due-today') return 'pending';
		if (filter === 'done') return undefined;
		return undefined;
	};
	const visibleLanes = lanes.filter(lane => lane && lane.label);
	if (visibleLanes.length === 0) {
		empty(body, 'No lanes are configured for the Action items card. Add at least one in Settings → Dashboard.');
		return;
	}
	const board = body.createDiv({ cls: 'cc-intel-lanes' });
	let anyRendered = false;
	for (const lane of visibleLanes) {
		const items = tasks.filter(task => taskMatchesLane(task, lane.filter, today));
		if (items.length === 0 && lane.hideWhenEmpty) continue;
		anyRendered = true;
		const state = laneState(lane.filter);
		const column = board.createDiv({ cls: 'cc-intel-lane' });
		if (state) column.addClass(`is-${state}`);
		const header = column.createDiv({ cls: 'cc-intel-lane-header' });
		header.createSpan({ text: lane.label });
		header.createSpan({ text: String(items.length), cls: 'cc-intel-lane-count' });
		if (items.length === 0) {
			column.createDiv({ text: '—', cls: 'cc-intel-empty' });
			continue;
		}
		for (const task of items.slice(0, MAX_ROWS)) {
			const icon = task.done ? 'check-square' : task.overdue ? 'alert-triangle' : 'square';
			row(column, app, {
				icon,
				primary: task.text,
				secondary: task.basename,
				badge: task.due ?? undefined,
				state,
				path: task.path,
				line: task.line,
			});
		}
		if (items.length > MAX_ROWS) {
			column.createDiv({ text: `+${items.length - MAX_ROWS} more`, cls: 'cc-intel-footnote' });
		}
	}
	if (!anyRendered) {
		empty(body, 'No tasks match any configured lane, and all matching lanes are set to hide when empty.');
	}
}

/** Workspaces — managed folders with live note counts and index state. */
function renderWorkspaces(host: HTMLElement, app: App, snapshot: VaultSnapshot, workspaces: WorkspaceSummary[]): void {
	const body = card(
		host,
		'Workspaces',
		`${workspaces.length} managed · ${snapshot.totals.bases} bases`,
		'The folders and Bases views Command Center actively manages. Click to open a folder index or a .base view.',
	);
	const orphanBases = snapshot.bases.filter(base => !workspaces.some(workspace => workspace.bases.some(owned => owned.path === base.path)));
	if (!snapshot.configured || workspaces.length === 0) {
		if (snapshot.bases.length === 0) {
			empty(body, 'Managed folders are interview-derived. Run discovery to enable this card.');
			return;
		}
		// Even before onboarding, native Bases views are worth surfacing.
		empty(body, 'No managed folders yet. Native Bases views found in this vault:');
		for (const base of snapshot.bases.slice(0, MAX_ROWS)) renderBase(body, app, base);
		return;
	}
	for (const workspace of workspaces.slice(0, MAX_ROWS)) {
		row(body, app, {
			icon: workspace.exists ? 'folder' : 'folder-x',
			primary: workspace.path,
			secondary: workspace.purpose,
			badge: workspace.exists ? `${workspace.noteCount} · ${relative(workspace.updatedAt)}` : 'missing',
			state: workspace.exists ? (workspace.indexed ? 'ok' : undefined) : 'overdue',
			path: workspace.exists ? `${workspace.path}/_index.md` : workspace.path,
		});
		// Nested native Bases views belong to their folder, so show them inline.
		for (const base of workspace.bases.slice(0, 3)) renderBase(body, app, base, true);
	}
	if (workspaces.length > MAX_ROWS) body.createDiv({ text: `+${workspaces.length - MAX_ROWS} more`, cls: 'cc-intel-footnote' });
	for (const base of orphanBases.slice(0, 3)) renderBase(body, app, base);
}

/** One native `.base` view row, opened through Obsidian's own Bases surface. */
function renderBase(host: HTMLElement, app: App, base: BaseView, nested = false): void {
	const element = host.createDiv({ cls: 'cc-intel-row cc-intel-base', attr: { role: 'button', tabindex: '0' } });
	if (nested) element.addClass('is-nested');
	setIcon(element.createSpan({ cls: 'cc-intel-row-icon' }), 'table');
	const text = element.createDiv({ cls: 'cc-intel-row-text' });
	text.createDiv({ text: base.basename, cls: 'cc-intel-row-primary' });
	text.createDiv({ text: base.path, cls: 'cc-intel-row-secondary' });
	element.createSpan({ text: 'base', cls: 'cc-intel-row-badge' });
	const activate = () => void openNote(app, base.path);
	element.addEventListener('click', activate);
	element.addEventListener('keydown', event => {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			activate();
		}
	});
}

/**
 * Render the configured intelligence cards in the user's chosen order, skipping
 * any they have hidden. Pure function of the supplied snapshot and config so
 * it can be re-invoked on any vault change without additional cost.
 */
export function renderIntelligenceCards(
	host: HTMLElement,
	app: App,
	snapshot: VaultSnapshot,
	config: IntelligenceRenderConfig = { cards: [], lanes: [] },
): void {
	host.empty();
	const grid = host.createDiv({ cls: 'cc-intel-grid' });
	const renderers: Record<IntelligenceCardId, () => void> = {
		daily: () => renderDaily(grid, app, snapshot),
		capture: () => renderCapture(grid, app, snapshot, snapshot.captures),
		actions: () => renderActions(grid, app, snapshot, snapshot.tasks, config.lanes),
		workspaces: () => renderWorkspaces(grid, app, snapshot, snapshot.workspaces),
	};
	for (const entry of config.cards) {
		if (entry.hidden) continue;
		renderers[entry.id]?.();
	}
	host.createDiv({
		cls: 'cc-intel-provenance',
		text: `${snapshot.totals.notes} notes scanned locally in ${snapshot.durationMs}ms · no tokens used · updated ${relative(snapshot.generatedAt)}`,
	});
}
