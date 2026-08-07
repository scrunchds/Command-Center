/**
 * CommandDeck — the vertical, Markdown-backed launcher rail.
 *
 * Principle 3 (Dynamic Extensibility): nothing here is hardcoded. The deck is a
 * direct reflection of the vault's workflow files. Every `.md`, `.canvas`, or
 * generated `.json` workflow discovered in the configured workflow directories
 * becomes a button, and the deck hot-registers changes from Obsidian's own vault
 * events, so a workflow created by the conversational builder appears without an
 * Obsidian restart.
 *
 * Principle 6 (Centralized Operational Hub): the deck is the single launch
 * surface for every automation, so the operator never has to hunt through
 * folders to run one.
 */

import { type App, type EventRef, TFile, normalizePath, setIcon } from 'obsidian';
import { GENERATED_WORKFLOW_DIRECTORY } from '../workflows/WorkflowGenerator';

/** One launchable entry discovered in the vault. */
export interface DeckEntry {
	/** Vault-relative path of the backing file. */
	path: string;
	/** Display label from frontmatter `name`, else the file basename. */
	label: string;
	/** Optional frontmatter `description`. */
	description: string;
	/** Optional frontmatter `icon`; falls back to a per-kind default. */
	icon: string;
	/** Backing file kind, which determines how the workflow is parsed. */
	kind: 'note' | 'canvas' | 'generated';
}

export interface CommandDeckOptions {
	/** Extra workflow directories beyond the generated one. */
	directories?: readonly string[];
	/** Invoked when the operator launches an entry. */
	onLaunch: (entry: DeckEntry) => void | Promise<void>;
	/** Invoked when the operator asks to build a new workflow conversationally. */
	onCreate?: () => void;
	/** When set, the deck header shows an inline collapse chevron that calls
	 * this to toggle the widget's collapsed state (kept in the layout by the
	 * owning view, not by the deck itself). */
	onToggleCollapsed?: () => void;
	/** Current collapsed state, used only to render the chevron's icon. */
	collapsed?: boolean;
}

const DEFAULT_ICONS: Record<DeckEntry['kind'], string> = {
	note: 'file-text',
	canvas: 'layout-dashboard',
	generated: 'workflow',
};

/**
 * Renders and maintains the deck. Call `mount()` once, then `dispose()` on view
 * close; vault events keep the contents live in between.
 */
export class CommandDeck {
	private hostEl: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private countEl: HTMLElement | null = null;
	private readonly refs: EventRef[] = [];
	private metadataRef: EventRef | null = null;
	private refreshTimer: number | null = null;
	private entries: DeckEntry[] = [];

	constructor(
		private readonly app: App,
		private readonly options: CommandDeckOptions,
	) {}

	/** Current discovered entries, useful for tests and diagnostics. */
	getEntries(): readonly DeckEntry[] {
		return this.entries;
	}

	/** Build the deck DOM inside `host` and start watching the vault. */
	mount(host: HTMLElement): void {
		this.hostEl = host;
		host.empty();
		host.addClass('cc-command-deck');
		const header = host.createDiv({ cls: 'cc-deck-header' });
		const group = header.createDiv({ cls: 'cc-widget-title-group' });
		if (this.options.onToggleCollapsed) {
			const chevron = group.createEl('button', {
				cls: 'cc-widget-collapse-chevron',
				attr: {
					type: 'button',
					'aria-label': this.options.collapsed ? 'Expand Command deck' : 'Collapse Command deck',
					'aria-expanded': String(!this.options.collapsed),
					title: this.options.collapsed ? 'Expand' : 'Collapse',
				},
			});
			setIcon(chevron, this.options.collapsed ? 'chevron-right' : 'chevron-down');
			chevron.addEventListener('click', () => this.options.onToggleCollapsed?.());
		}
		const textCol = group.createDiv({ cls: 'cc-widget-title-text' });
		textCol.createEl('h3', { text: 'Command deck' });
		textCol.createSpan({
			cls: 'cc-widget-caption',
			text: 'Every workflow file in your vault, as a one-click button.',
		});
		this.countEl = header.createSpan({ cls: 'cc-deck-count' });
		host.createDiv({
			cls: 'cc-widget-hint',
			text: 'Click a button to run that workflow now. New workflows appear here automatically — no restart needed.',
		});
		this.listEl = host.createDiv({ cls: 'cc-deck-list' });
		if (this.options.onCreate) {
			const create = host.createEl('button', { cls: 'cc-deck-create', text: 'New workflow', attr: { 'aria-label': 'Create a new workflow conversationally' } });
			create.addEventListener('click', () => this.options.onCreate?.());
		}
		// Hot-registration: any vault mutation inside a workflow directory
		// re-renders the deck on the next frame.
		const schedule = () => this.scheduleRefresh();
		this.refs.push(
			this.app.vault.on('create', schedule),
			this.app.vault.on('delete', schedule),
			this.app.vault.on('rename', schedule),
			this.app.vault.on('modify', schedule),
		);
		this.metadataRef = this.app.metadataCache.on('changed', schedule);
		this.refresh();
	}

	/** Detach vault listeners and cancel pending work. */
	dispose(): void {
		for (const ref of this.refs) {
			this.app.vault.offref(ref);
		}
		this.refs.length = 0;
		if (this.metadataRef) {
			this.app.metadataCache.offref(this.metadataRef);
			this.metadataRef = null;
		}
		if (this.refreshTimer !== null) {
			window.clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.hostEl = null;
		this.listEl = null;
		this.countEl = null;
	}

	/** Coalesce bursts of vault events into a single re-render. */
	private scheduleRefresh(): void {
		if (this.refreshTimer !== null) return;
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			this.refresh();
		}, 150);
	}

	/** Re-scan the workflow directories and repaint. */
	refresh(): void {
		this.entries = this.discover();
		this.render();
	}

	private roots(): string[] {
		const configured = [GENERATED_WORKFLOW_DIRECTORY, ...(this.options.directories ?? [])];
		return [...new Set(configured.map(path => normalizePath(path).replace(/^\/+|\/+$/g, '')))].filter(Boolean);
	}

	/**
	 * Discover launchable files. Markdown and canvas files are user-authored
	 * workflows; generated JSON files come from the approved workflow generator.
	 */
	private discover(): DeckEntry[] {
		const roots = this.roots();
		if (roots.length === 0) return [];
		const owned = (path: string) => roots.some(root => path === root || path.startsWith(`${root}/`));
		const entries: DeckEntry[] = [];
		for (const file of this.app.vault.getFiles()) {
			if (!owned(file.path)) continue;
			const kind = this.kindOf(file);
			if (!kind) continue;
			entries.push(this.describe(file, kind));
		}
		return entries.sort((a, b) => a.label.localeCompare(b.label));
	}

	private kindOf(file: TFile): DeckEntry['kind'] | null {
		if (file.extension === 'md') return 'note';
		if (file.extension === 'canvas') return 'canvas';
		if (file.extension === 'json') return 'generated';
		return null;
	}

	/** Read presentation metadata from native frontmatter when available. */
	private describe(file: TFile, kind: DeckEntry['kind']): DeckEntry {
		const frontmatter = (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
		const text = (value: unknown): string => (typeof value === 'string' && value.trim() ? value.trim() : '');
		return {
			path: file.path,
			label: text(frontmatter.name) || text(frontmatter.title) || file.basename,
			description: text(frontmatter.description),
			icon: text(frontmatter.icon) || DEFAULT_ICONS[kind],
			kind,
		};
	}

	private render(): void {
		const list = this.listEl;
		if (!list || !this.hostEl) return;
		list.empty();
		if (this.countEl) this.countEl.setText(`${this.entries.length} registered`);
		if (this.entries.length === 0) {
			list.createDiv({
				cls: 'cc-deck-empty',
				text: `No workflows found in ${this.roots().join(', ') || 'any configured directory'}. Create one conversationally and it registers here immediately.`,
			});
			return;
		}
		for (const entry of this.entries) {
			const button = list.createEl('button', {
				cls: 'cc-deck-button',
				attr: { title: entry.description || entry.path, 'data-kind': entry.kind },
			});
			setIcon(button.createSpan({ cls: 'cc-deck-icon' }), entry.icon);
			const text = button.createDiv({ cls: 'cc-deck-text' });
			text.createDiv({ text: entry.label, cls: 'cc-deck-label' });
			if (entry.description) text.createDiv({ text: entry.description, cls: 'cc-deck-desc' });
			button.addEventListener('click', () => void this.options.onLaunch(entry));
		}
	}
}
