/**
 * VaultDataBridge — deterministic, model-free vault intelligence.
 *
 * Principle 2 (Zero-Cost Intelligence): the dashboard must populate instantly
 * without spending a single API token. This bridge reads only Obsidian's
 * native `metadataCache` (frontmatter, headings, links, list items, tags) plus
 * `cachedRead` for text, exactly like Dataview does. No provider, daemon, or
 * model call ever happens here.
 *
 * Everything is derived from interview-supplied configuration when present and
 * degrades to whole-vault scanning when the plugin is unconfigured, so the
 * dashboard is useful before onboarding and never hardcodes a methodology.
 */

import { type App, type CachedMetadata, TFile, normalizePath } from 'obsidian';

/** Shape of the core Daily Notes internal plugin's options. */
interface CoreDailyNotesOptions {
	folder?: string;
	format?: string;
	template?: string;
}
import type { ConfigManager } from '../engine/ConfigManager';
import type { OnboardingConfig } from '../onboarding/OnboardingTypes';

/** One actionable task discovered in the vault. */
export interface VaultTask {
	/** Vault-relative path of the note that owns the task. */
	path: string;
	/** Native display name for the owning note. */
	basename: string;
	/** Raw task text with checkbox syntax removed. */
	text: string;
	/** 1-based line number so the UI can deep-link precisely. */
	line: number;
	/** True when the checkbox is checked or the status property reads done. */
	done: boolean;
	/** Frontmatter/inline due date when one is present, ISO-8601 date only. */
	due: string | null;
	/** True when `due` is in the past relative to the snapshot instant. */
	overdue: boolean;
}

/** One capture-inbox entry awaiting triage. */
export interface CaptureEntry {
	path: string;
	basename: string;
	/** Milliseconds since epoch from Obsidian's own file stat. */
	createdAt: number;
	/** First non-empty, non-frontmatter, non-heading line. */
	excerpt: string;
}

/** A native Obsidian `.base` view discovered in the vault. */
export interface BaseView {
	path: string;
	basename: string;
	/** Owning managed folder path when the base sits inside one. */
	workspace: string | null;
}

/** One managed folder rendered as a workspace tile. */
export interface WorkspaceSummary {
	path: string;
	purpose: string;
	scope: string | null;
	/** Markdown files directly or transitively inside the folder. */
	noteCount: number;
	/** Most recent mtime across those files, or null when empty. */
	updatedAt: number | null;
	/** True when the folder currently exists in the vault. */
	exists: boolean;
	/** True when the folder has a native `_index.md`. */
	indexed: boolean;
	/** Native `.base` views living inside this folder. */
	bases: BaseView[];
}

/** Deterministic daily-cycle facts for the current date. */
export interface DailyIntelligence {
	/** Resolved daily note path from interview configuration, when configured. */
	path: string | null;
	/** True when that path currently resolves to a file. */
	exists: boolean;
	/** Headings present in the daily note, in document order. */
	sections: string[];
	/** Frontmatter metric keys the user actually tracks, with current values. */
	metrics: Array<{ key: string; value: string }>;
	/** Interview-derived capacity rules evaluated against those metrics. */
	capacity: Array<{ metric: string; value: number | null; triggered: boolean; action: string }>;
	/** Reflection prompts from the interview style guide, when configured. */
	prompts: string[];
}

/** Complete zero-cost snapshot backing the four intelligence cards. */
export interface VaultSnapshot {
	/** Snapshot instant so the UI can show freshness without a timer. */
	generatedAt: number;
	/** Wall-clock milliseconds the scan consumed. */
	durationMs: number;
	/** True when interview configuration drove folder selection. */
	configured: boolean;
	daily: DailyIntelligence;
	captures: CaptureEntry[];
	tasks: VaultTask[];
	workspaces: WorkspaceSummary[];
	/** Every `.base` view in the vault, including those outside managed folders. */
	bases: BaseView[];
	/** Aggregate counters used by compact headline rows. */
	totals: {
		notes: number;
		openTasks: number;
		overdueTasks: number;
		captures: number;
		workspaces: number;
		bases: number;
	};
}

/** Render a frontmatter value as text without ever producing "[object Object]". */
function scalarText(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (value instanceof Date) return value.toISOString();
	return JSON.stringify(value) ?? '';
}

/**
 * Expand a daily-note name template for a specific date. Shared by the daily
 * card and the calendar so both resolve identically. Only date tokens are
 * substituted; every path segment comes from interview configuration.
 */
export function resolveDailyNotePath(config: OnboardingConfig, date: Date): string {
	const pad = (value: number) => String(value).padStart(2, '0');
	const tokens: Record<string, string> = {
		YYYY: String(date.getFullYear()),
		MM: pad(date.getMonth() + 1),
		DD: pad(date.getDate()),
		HH: pad(date.getHours()),
		mm: pad(date.getMinutes()),
	};
	const name = config.topology.dailyNoteNameTemplate.replace(/YYYY|MM|DD|HH|mm/g, token => tokens[token] ?? token);
	const withExtension = name.endsWith('.md') ? name : `${name}.md`;
	const folder = config.topology.dailyNotesFolder.replace(/^\/+|\/+$/g, '');
	return normalizePath(folder ? `${folder}/${withExtension}` : withExtension);
}

const MAX_CAPTURES = 25;
const MAX_TASKS = 200;
const EXCERPT_LENGTH = 160;
const DUE_KEYS = ['due', 'due-date', 'duedate', 'deadline', 'scheduled'];
const CHECKBOX = /^\s*[-*+]\s*\[( |x|X)]\s*/;
const INLINE_DUE = /\[(?:due|deadline|scheduled)::\s*([^\]]+)]|📅\s*(\d{4}-\d{2}-\d{2})/i;

/** Read-only, cache-first vault intelligence provider. */
export class VaultDataBridge {
	private cache: VaultSnapshot | null = null;
	private inFlight: Promise<VaultSnapshot> | null = null;

	constructor(
		private readonly app: App,
		private readonly configs: ConfigManager,
	) {}

	/** Last computed snapshot, or null before the first scan. */
	peek(): VaultSnapshot | null {
		return this.cache;
	}

	/** Invalidate the cache so the next `snapshot()` recomputes. */
	invalidate(): void {
		this.cache = null;
	}

	/**
	 * Build (or reuse) a snapshot. Concurrent callers share one scan so a burst
	 * of vault events cannot multiply the work.
	 */
	async snapshot(force = false): Promise<VaultSnapshot> {
		if (!force && this.cache) return this.cache;
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.build()
			.then(snapshot => {
				this.cache = snapshot;
				return snapshot;
			})
			.finally(() => {
				this.inFlight = null;
			});
		return this.inFlight;
	}

	private async build(): Promise<VaultSnapshot> {
		const started = performance.now();
		const config = this.configs.isInitialized() ? this.configs.requireConfig() : null;
		const files = this.app.vault.getMarkdownFiles();
		const captureRoots = this.normalizeRoots(config?.topology.inboxFolders ?? []);
		const daily = await this.readDaily(config);
		const captures: CaptureEntry[] = [];
		const tasks: VaultTask[] = [];
		const statusProperty = config?.tasks.statusProperty ?? 'status';
		const today = new Date().toISOString().slice(0, 10);

		for (const file of files) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (captureRoots.length > 0 && this.isInside(file.path, captureRoots) && captures.length < MAX_CAPTURES) {
				captures.push({
					path: file.path,
					basename: file.basename,
					createdAt: file.stat.ctime,
					excerpt: await this.excerpt(file),
				});
			}
			if (tasks.length < MAX_TASKS) await this.collectTasks(file, cache, statusProperty, today, tasks);
		}

		captures.sort((a, b) => b.createdAt - a.createdAt);
		tasks.sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.due ?? '9999').localeCompare(b.due ?? '9999'));
		// Principle 5: native Bases views are first-class here rather than
		// reimplemented — Command Center surfaces what Obsidian already defines.
		const bases = this.readBases();
		const workspaces = this.readWorkspaces(config, files, bases);
		const openTasks = tasks.filter(task => !task.done);

		return {
			generatedAt: Date.now(),
			durationMs: Math.round(performance.now() - started),
			configured: Boolean(config),
			daily,
			captures,
			tasks,
			workspaces,
			bases,
			totals: {
				notes: files.length,
				openTasks: openTasks.length,
				overdueTasks: openTasks.filter(task => task.overdue).length,
				captures: captures.length,
				workspaces: workspaces.length,
				bases: bases.length,
			},
		};
	}

	/* ─── Daily Intelligence ─────────────────────────────── */

	private async readDaily(config: OnboardingConfig | null): Promise<DailyIntelligence> {
		const empty: DailyIntelligence = { path: null, exists: false, sections: [], metrics: [], capacity: [], prompts: [] };
		if (!config) return empty;
		const path = this.resolveDailyPath(config);
		const file = this.app.vault.getAbstractFileByPath(path);
		const prompts = config.style.reflectionPrompts ?? [];
		if (!(file instanceof TFile)) return { ...empty, path, prompts };
		const cache = this.app.metadataCache.getFileCache(file);
		const frontmatter = (cache?.frontmatter ?? {}) as Record<string, unknown>;
		const trackedMetrics = config.capacity.rules.map(rule => rule.metric);
		const metrics = trackedMetrics
			.filter(metric => frontmatter[metric] !== undefined)
			.map(metric => ({ key: metric, value: scalarText(frontmatter[metric]) }));
		const capacity = config.capacity.rules.map(rule => {
			const raw = Number(frontmatter[rule.metric]);
			const value = Number.isFinite(raw) ? raw : null;
			const triggered =
				value !== null && (rule.operator === 'below' ? value < rule.threshold : value > rule.threshold);
			return { metric: rule.metric, value, triggered, action: rule.action };
		});
		return {
			path,
			exists: true,
			sections: (cache?.headings ?? []).map(heading => heading.heading),
			metrics,
			capacity,
			prompts,
		};
	}

	/**
	 * Expand the interview-derived daily-note name template for today. Only
	 * date tokens are substituted; every path segment comes from configuration.
	 */
	private resolveDailyPath(config: OnboardingConfig): string {
		return resolveDailyNotePath(config, new Date());
	}

	/**
	 * Public daily-note path resolution for any date. The calendar uses this so
	 * clicking a day opens (or offers to create) the correct note.
	 *
	 * When onboarding has been completed the interview-derived template wins.
	 * Otherwise we fall back to Obsidian's core Daily Notes plugin settings so
	 * the calendar still detects notes before the user has run the interview.
	 */
	dailyNotePathFor(date: Date): string | null {
		if (this.configs.isInitialized()) return resolveDailyNotePath(this.configs.requireConfig(), date);
		return this.coreDailyNotePath(date);
	}

	/** Resolve a daily-note path from the core Daily Notes internal plugin. */
	private coreDailyNotePath(date: Date): string | null {
		const registry = (this.app as App & { internalPlugins?: { getPluginById?: (id: string) => { instance?: { options?: CoreDailyNotesOptions } } | null } }).internalPlugins;
		const options = registry?.getPluginById?.('daily-notes')?.instance?.options;
		if (!options) return null;
		const folder = (options.folder ?? '').replace(/^\/+|\/+$/g, '');
		const format = options.format ?? 'YYYY-MM-DD';
		// moment is always present on the Obsidian window object.
		const momentFn = (window as unknown as { moment?: (d: Date) => { format: (f: string) => string } }).moment;
		if (!momentFn) return null;
		const name = momentFn(date).format(format);
		const file = name.endsWith('.md') ? name : `${name}.md`;
		return normalizePath(folder ? `${folder}/${file}` : file);
	}

	/* ─── Action Items ───────────────────────────────────── */

	private async collectTasks(
		file: TFile,
		cache: CachedMetadata | null,
		statusProperty: string,
		today: string,
		out: VaultTask[],
	): Promise<void> {
		const frontmatter = (cache?.frontmatter ?? {}) as Record<string, unknown>;
		const frontmatterDue = this.readDue(frontmatter);
		const checkboxItems = (cache?.listItems ?? []).filter(item => item.task !== undefined);
		// One cached read per note, and only when the metadata cache already proved
		// checkbox tasks exist. Obsidian serves this from memory in the common case.
		const lines = checkboxItems.length > 0 ? (await this.app.vault.cachedRead(file)).split(/\r?\n/) : [];
		// Native checkbox list items first — this is the Dataview-compatible surface.
		for (const item of checkboxItems) {
			if (out.length >= MAX_TASKS) return;
			const line = item.position.start.line;
			const text = (lines[line] ?? '').replace(CHECKBOX, '').trim();
			if (!text) continue;
			const due = this.readInlineDue(text) ?? frontmatterDue;
			const done = item.task !== ' ';
			out.push({
				path: file.path,
				basename: file.basename,
				text: text.slice(0, EXCERPT_LENGTH),
				line: line + 1,
				done,
				due,
				overdue: Boolean(due && !done && due < today),
			});
		}
		// Property-driven tasks: a note itself is the unit of work.
		const status = frontmatter[statusProperty];
		if (typeof status === 'string' && status.trim()) {
			if (out.length >= MAX_TASKS) return;
			const done = /^(done|complete|completed|closed)$/i.test(status.trim());
			out.push({
				path: file.path,
				basename: file.basename,
				text: `${file.basename} · ${statusProperty}: ${status.trim()}`,
				line: 1,
				done,
				due: frontmatterDue,
				overdue: Boolean(frontmatterDue && !done && frontmatterDue < today),
			});
		}
	}

	private readDue(frontmatter: Record<string, unknown>): string | null {
		for (const key of DUE_KEYS) {
			const value = frontmatter[key];
			const parsed = scalarText(value).trim().slice(0, 10);
			if (/^\d{4}-\d{2}-\d{2}$/.test(parsed)) return parsed;
		}
		return null;
	}

	private readInlineDue(text: string): string | null {
		const match = INLINE_DUE.exec(text);
		const value = (match?.[1] ?? match?.[2] ?? '').trim().slice(0, 10);
		return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
	}

	/* ─── Capture ────────────────────────────────────────── */

	private async excerpt(file: TFile): Promise<string> {
		const content = await this.app.vault.cachedRead(file);
		const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
		for (const line of body.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			return trimmed.slice(0, EXCERPT_LENGTH);
		}
		return '';
	}

	/* ─── Workspaces ─────────────────────────────────────── */

	/** Discover every native `.base` view Obsidian knows about. */
	private readBases(): BaseView[] {
		return this.app.vault
			.getFiles()
			.filter(file => file.extension === 'base')
			.map(file => ({ path: file.path, basename: file.basename, workspace: null }))
			.sort((a, b) => a.basename.localeCompare(b.basename));
	}

	private readWorkspaces(config: OnboardingConfig | null, files: TFile[], bases: BaseView[]): WorkspaceSummary[] {
		const folders = config?.managedFolders ?? [];
		if (folders.length === 0) return [];
		return folders.map(folder => {
			const root = normalizePath(folder.path).replace(/\/+$/, '');
			const prefix = `${root}/`;
			const owned = files.filter(file => file.path === root || file.path.startsWith(prefix));
			const updatedAt = owned.reduce<number | null>(
				(latest, file) => (latest === null || file.stat.mtime > latest ? file.stat.mtime : latest),
				null,
			);
			return {
				path: root,
				purpose: folder.purpose,
				scope: folder.scope ?? null,
				noteCount: owned.length,
				updatedAt,
				exists: this.app.vault.getAbstractFileByPath(root) !== null,
				indexed: this.app.vault.getAbstractFileByPath(normalizePath(`${root}/_index.md`)) instanceof TFile,
				bases: bases
					.filter(base => base.path === root || base.path.startsWith(prefix))
					.map(base => ({ ...base, workspace: root })),
			};
		});
	}

	/* ─── Helpers ────────────────────────────────────────── */

	private normalizeRoots(paths: readonly string[]): string[] {
		return paths
			.map(path => normalizePath(path).replace(/^\/+|\/+$/g, ''))
			.filter(path => path.length > 0);
	}

	private isInside(path: string, roots: readonly string[]): boolean {
		return roots.some(root => path === root || path.startsWith(`${root}/`));
	}
}
