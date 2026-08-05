/**
 * VaultNavigator — the dashboard's doorway into the vault.
 *
 * Principle 6 (Centralized Operational Hub): find and open anything without
 * leaving the dashboard. Recent notes are one click away, and a single filter
 * box searches note titles, folders, tags, and `.base` views together.
 *
 * Principle 2 (Zero-Cost Intelligence): matching is local string work over
 * Obsidian's file list and metadata cache. No embeddings, no model calls.
 *
 * Principle 5 (Native Obsidian Harmony): results open through the workspace API
 * and can be revealed in the native file explorer.
 */

import { type App, type TAbstractFile, TFile, TFolder, Notice, setIcon } from 'obsidian';

const MAX_RESULTS = 40;
const MAX_RECENT = 8;

type ResultKind = 'note' | 'folder' | 'base' | 'canvas' | 'tag';

interface NavResult {
	kind: ResultKind;
	/** Display label. */
	label: string;
	/** Secondary line, usually the containing folder. */
	detail: string;
	/** Vault path, or the tag text for tag results. */
	path: string;
	/** Lower score sorts first. */
	score: number;
}

const ICONS: Record<ResultKind, string> = {
	note: 'file-text',
	folder: 'folder',
	base: 'table',
	canvas: 'layout-dashboard',
	tag: 'hash',
};

/**
 * Score a candidate against a lowercase query. Prefix matches rank above word
 * matches, which rank above loose substring matches. Returns null when no match.
 */
function score(name: string, query: string): number | null {
	const lower = name.toLowerCase();
	if (lower === query) return 0;
	if (lower.startsWith(query)) return 1;
	// Word-boundary match, e.g. "proj" matching "Active Projects".
	if (new RegExp(`\\b${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(lower)) return 2;
	if (lower.includes(query)) return 3;
	return null;
}

/** Quick-find and recents rail for the whole vault. */
export class VaultNavigator {
	private hostEl: HTMLElement | null = null;
	private inputEl: HTMLInputElement | null = null;
	private resultsEl: HTMLElement | null = null;
	private query = '';

	constructor(private readonly app: App) {}

	/** Build the shell and render the default recents view. */
	mount(host: HTMLElement): void {
		this.hostEl = host;
		host.empty();
		host.addClass('cc-navigator');

		const search = host.createDiv({ cls: 'cc-navigator-search' });
		const icon = search.createSpan({ cls: 'cc-navigator-search-icon' });
		setIcon(icon, 'search');
		this.inputEl = search.createEl('input', {
			type: 'text',
			attr: { placeholder: 'Find a note, folder, tag, or base…', 'aria-label': 'Search the vault' },
		});
		this.inputEl.addEventListener('input', () => {
			this.query = this.inputEl?.value.trim() ?? '';
			this.renderResults();
		});
		// Enter opens the first result, so the keyboard alone is enough.
		this.inputEl.addEventListener('keydown', event => {
			if (event.key !== 'Enter') return;
			event.preventDefault();
			const first = this.resultsEl?.querySelector<HTMLElement>('.cc-navigator-row');
			first?.click();
		});
		const clear = search.createEl('button', { attr: { 'aria-label': 'Clear search' } });
		setIcon(clear, 'x');
		clear.addEventListener('click', () => {
			if (this.inputEl) this.inputEl.value = '';
			this.query = '';
			this.renderResults();
			this.inputEl?.focus();
		});

		this.resultsEl = host.createDiv({ cls: 'cc-navigator-results' });
		this.renderResults();
	}

	/** Re-render after vault changes so recents stay accurate. */
	refresh(): void {
		if (this.hostEl) this.renderResults();
	}

	dispose(): void {
		this.hostEl = null;
		this.inputEl = null;
		this.resultsEl = null;
	}

	private renderResults(): void {
		const host = this.resultsEl;
		if (!host) return;
		host.empty();
		if (!this.query) {
			this.renderRecents(host);
			return;
		}
		const results = this.search(this.query.toLowerCase());
		if (results.length === 0) {
			host.createDiv({ text: `Nothing in the vault matches “${this.query}”.`, cls: 'cc-intel-empty' });
			return;
		}
		host.createDiv({ text: `${results.length} match${results.length === 1 ? '' : 'es'}`, cls: 'cc-navigator-group' });
		for (const result of results) this.renderRow(host, result);
	}

	/** Most recently modified notes, the highest-value default view. */
	private renderRecents(host: HTMLElement): void {
		const recent = [...this.app.vault.getMarkdownFiles()]
			.sort((a, b) => b.stat.mtime - a.stat.mtime)
			.slice(0, MAX_RECENT);
		if (recent.length === 0) {
			host.createDiv({ text: 'This vault has no notes yet.', cls: 'cc-intel-empty' });
			return;
		}
		host.createDiv({ text: 'Recently edited', cls: 'cc-navigator-group' });
		for (const file of recent) {
			this.renderRow(host, {
				kind: 'note',
				label: file.basename,
				detail: file.parent?.path && file.parent.path !== '/' ? file.parent.path : 'vault root',
				path: file.path,
				score: 0,
			});
		}
	}

	/** Match notes, folders, canvases, bases, and tags in one pass. */
	private search(query: string): NavResult[] {
		const results: NavResult[] = [];
		for (const file of this.app.vault.getFiles()) {
			const kind: ResultKind = file.extension === 'base' ? 'base' : file.extension === 'canvas' ? 'canvas' : 'note';
			if (kind === 'note' && file.extension !== 'md') continue;
			const rank = score(file.basename, query) ?? (score(file.path, query) === null ? null : 4);
			if (rank === null) continue;
			results.push({
				kind,
				label: file.basename,
				detail: file.parent?.path && file.parent.path !== '/' ? file.parent.path : 'vault root',
				path: file.path,
				score: rank,
			});
		}
		const seenFolders = new Set<string>();
		for (const file of this.app.vault.getFiles()) {
			const parent = file.parent;
			if (!parent || parent.path === '/' || seenFolders.has(parent.path)) continue;
			seenFolders.add(parent.path);
			const rank = score(parent.name, query);
			if (rank === null) continue;
			results.push({ kind: 'folder', label: parent.name, detail: parent.path, path: parent.path, score: rank });
		}
		for (const tag of this.collectTags()) {
			const rank = score(tag, query);
			if (rank === null) continue;
			results.push({ kind: 'tag', label: `#${tag}`, detail: 'search this tag', path: tag, score: rank });
		}
		return results.sort((a, b) => a.score - b.score || a.label.localeCompare(b.label)).slice(0, MAX_RESULTS);
	}

	/** Every tag Obsidian's metadata cache knows about. */
	private collectTags(): string[] {
		const tags = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			for (const tag of cache?.tags ?? []) tags.add(tag.tag.replace(/^#/, ''));
			const frontmatterTags: unknown = cache?.frontmatter?.tags;
			if (Array.isArray(frontmatterTags)) {
				for (const tag of frontmatterTags) if (typeof tag === 'string') tags.add(tag.replace(/^#/, ''));
			} else if (typeof frontmatterTags === 'string') {
				for (const tag of frontmatterTags.split(/[,\s]+/)) if (tag) tags.add(tag.replace(/^#/, ''));
			}
		}
		return [...tags];
	}

	private renderRow(host: HTMLElement, result: NavResult): void {
		const row = host.createDiv({ cls: 'cc-navigator-row', attr: { role: 'button', tabindex: '0' } });
		setIcon(row.createSpan({ cls: 'cc-navigator-icon' }), ICONS[result.kind]);
		const text = row.createDiv({ cls: 'cc-navigator-text' });
		text.createDiv({ text: result.label, cls: 'cc-navigator-label' });
		text.createDiv({ text: result.detail, cls: 'cc-navigator-detail' });
		row.createSpan({ text: result.kind, cls: 'cc-navigator-kind' });
		const activate = () => void this.open(result);
		row.addEventListener('click', activate);
		row.addEventListener('keydown', event => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				activate();
			}
		});
	}

	/** Open a result using the most native affordance for its kind. */
	private async open(result: NavResult): Promise<void> {
		if (result.kind === 'tag') {
			// Hand tag navigation to Obsidian's own search.
			const search = (this.app as unknown as {
				internalPlugins?: { getPluginById: (id: string) => { instance?: { openGlobalSearch?: (q: string) => void } } | null };
			}).internalPlugins?.getPluginById('global-search');
			const open = search?.instance?.openGlobalSearch;
			if (open) open(`tag:#${result.path}`);
			else new Notice(`Search for tag #${result.path} to see its notes.`);
			return;
		}
		const entry: TAbstractFile | null = this.app.vault.getAbstractFileByPath(result.path);
		if (entry instanceof TFile) {
			await this.app.workspace.getLeaf(false).openFile(entry);
			return;
		}
		if (entry instanceof TFolder) {
			// Reveal folders in the native file explorer rather than reinventing a tree.
			const explorer = this.app.workspace.getLeavesOfType('file-explorer')[0];
			if (explorer) {
				void this.app.workspace.revealLeaf(explorer);
				const view = explorer.view as unknown as { revealInFolder?: (file: TAbstractFile) => void };
				view.revealInFolder?.(entry);
				return;
			}
			new Notice(`${result.path} is a folder. Open the file explorer to browse it.`);
			return;
		}
		new Notice(`${result.path} is no longer in the vault.`);
	}
}
