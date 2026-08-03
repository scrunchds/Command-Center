/**
 * @-Mention Typeahead — inline suggestion system for referencing vault
 * notes, folders, tags, capabilities, and external URLs.
 *
 * Provides:
 *   - Typeahead popover triggered by `@` in the editor
 *   - Categorized suggestions (Notes, Folders, Tags, Capabilities, URLs)
 *   - Keyboard navigation (arrow keys + Enter/Tab to select)
 *   - Mention resolution to vault paths
 *
 * Vault interaction: reads from MetadataCache and getAllTags — no writes.
 */

import { App, Editor, EditorPosition, getAllTags } from 'obsidian';

/* ─── Types ─────────────────────────────────────────────── */

export type MentionType = 'note' | 'folder' | 'tag' | 'capability' | 'url';

export interface MentionItem {
	/** The type of mention. */
	type: MentionType;
	/** The display label. */
	label: string;
	/** The value inserted into the editor (e.g., "[[note]]", "@vault"). */
	value: string;
	/** Optional description/context. */
	description?: string;
	/** Optional path for notes. */
	path?: string;
	/** Optional icon name. */
	icon?: string;
}

export interface MentionCategory {
	/** Category identifier. */
	id: string;
	/** Display label. */
	label: string;
	/** Items in this category. */
	items: MentionItem[];
}

export interface MentionQuery {
	/** The raw query text after the @ symbol. */
	raw: string;
	/** The cursor position where the @ was typed. */
	position: EditorPosition;
	/** The start position of the @ mention. */
	start: EditorPosition;
}

/* ─── Typeahead Engine ──────────────────────────────────── */

export class AtMentionEngine {
	private readonly app: App;
	private cachedNotes: MentionItem[] = [];
	private cachedFolders: MentionItem[] = [];
	private cachedTags: MentionItem[] = [];
	private cacheTime = 0;
	private readonly CACHE_TTL_MS = 30_000;

	/** Optional capability resolver — injected by the plugin. */
	private resolveCapabilities?: () => MentionItem[];

	constructor(app: App) {
		this.app = app;
	}

	/**
	 * Set the capability resolver function.
	 * Called when the user types @ near a capability name.
	 */
	setCapabilityResolver(resolver: () => MentionItem[]): void {
		this.resolveCapabilities = resolver;
	}

	/**
	 * Refresh the internal cache from vault data.
	 */
	refreshCache(): void {
		const now = Date.now();
		if (now - this.cacheTime < this.CACHE_TTL_MS) return;

		// Notes
		const markdownFiles = this.app.vault.getMarkdownFiles();
		this.cachedNotes = markdownFiles.slice(0, 500).map(f => ({
			type: 'note' as const,
			label: f.basename,
			value: `[[${f.path.replace(/\.md$/, '')}]]`,
			description: f.path,
			path: f.path,
		})).sort((a, b) => a.label.localeCompare(b.label));

		// Folders
		const folders = new Set<string>();
		for (const f of markdownFiles) {
			const folder = f.parent?.path;
			if (folder && folder !== '/') {
				folders.add(folder);
			}
		}
		this.cachedFolders = Array.from(folders).map(f => ({
			type: 'folder' as const,
			label: f.split('/').pop() ?? f,
			value: f,
			description: f,
			path: f,
		})).sort((a, b) => a.label.localeCompare(b.label));

		// Tags
		const tagMap = new Map<string, number>();
		for (const file of markdownFiles) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (cache) {
				const tags = getAllTags(cache);
				if (tags) {
					for (const tag of tags) {
						tagMap.set(tag, (tagMap.get(tag) ?? 0) + 1);
					}
				}
			}
		}
		this.cachedTags = Array.from(tagMap.entries()).map(([tag, count]) => ({
			type: 'tag' as const,
			label: tag,
			value: tag,
			description: `${tag} (${count} files)`,
		})).sort((a, b) => a.label.localeCompare(b.label));

		this.cacheTime = now;
	}

	/**
	 * Search for mentions matching a query.
	 */
	search(query: string, limit = 8): MentionCategory[] {
		this.refreshCache();

		const q = query.toLowerCase().trim();
		const categories: MentionCategory[] = [];

		// Notes
		const matchingNotes = this.cachedNotes
			.filter(n => n.label.toLowerCase().includes(q) || (n.path ?? '').toLowerCase().includes(q))
			.slice(0, limit);
		if (matchingNotes.length > 0) {
			categories.push({ id: 'notes', label: 'Notes', items: matchingNotes });
		}

		// Folders
		if (categories.length < 3) {
			const matchingFolders = this.cachedFolders
				.filter(f => f.label.toLowerCase().includes(q) || f.path?.toLowerCase().includes(q))
				.slice(0, Math.min(limit, 5));
			if (matchingFolders.length > 0) {
				categories.push({ id: 'folders', label: 'Folders', items: matchingFolders });
			}
		}

		// Tags
		if (categories.length < 3) {
			const matchingTags = this.cachedTags
				.filter(t => t.label.toLowerCase().includes(q))
				.slice(0, Math.min(limit, 5));
			if (matchingTags.length > 0) {
				categories.push({ id: 'tags', label: 'Tags', items: matchingTags });
			}
		}

		// Capabilities
		if (this.resolveCapabilities && categories.length < 4) {
			const capabilities = this.resolveCapabilities();
			const matchingCaps = capabilities
				.filter(c => c.label.toLowerCase().includes(q) || (c.value ?? '').toLowerCase().includes(q))
				.slice(0, Math.min(limit, 5));
			if (matchingCaps.length > 0) {
				categories.push({ id: 'capabilities', label: 'Capabilities', items: matchingCaps });
			}
		}

		// If no matches, show recent notes as fallback
		if (categories.length === 0) {
			const recentNotes = this.cachedNotes.slice(0, limit);
			if (recentNotes.length > 0) {
				categories.push({ id: 'notes', label: 'Recent Notes', items: recentNotes });
			}
		}

		return categories;
	}

	/**
	 * Parse the current editor state to find an @-mention in progress.
	 */
	parseMention(editor: Editor): MentionQuery | null {
		const cursor = editor.getCursor();
		const line = editor.getLine(cursor.line);
		const beforeCursor = line.slice(0, cursor.ch);

		// Find the last @ symbol before the cursor
		const atIndex = beforeCursor.lastIndexOf('@');
		if (atIndex === -1) return null;

		// Extract the query text after @
		const afterAt = beforeCursor.slice(atIndex + 1);

		// If there's a space in the query, the mention is complete
		if (afterAt.includes(' ')) return null;

		return {
			raw: afterAt,
			position: cursor,
			start: { line: cursor.line, ch: atIndex },
		};
	}

	/**
	 * Insert a selected mention into the editor.
	 */
	insertMention(editor: Editor, mention: MentionItem, query: MentionQuery): void {
		// Replace the @query text with the mention value
		editor.replaceRange(
			mention.value,
			query.start,
			query.position,
		);
	}

	/**
	 * Resolve a mention reference to its file path.
	 * Handles [[wikilink]] and @path formats.
	 */
	resolveMentionPath(reference: string, sourcePath: string): string | null {
		// Handle [[wikilink]]
		const wikilinkMatch = reference.match(/^\[\[(.+?)\]\]$/);
		const target = wikilinkMatch ? wikilinkMatch[1]!.split('|')[0]!.trim() : reference;

		// Try exact path
		const exact = this.app.vault.getAbstractFileByPath(target);
		if (exact) return target;

		// Try with .md extension
		const withMd = target.endsWith('.md') ? target : `${target}.md`;
		const withMdFile = this.app.vault.getAbstractFileByPath(withMd);
		if (withMdFile) return withMd;

		// Try via metadata cache
		const resolved = this.app.metadataCache.getFirstLinkpathDest(target, sourcePath);
		if (resolved) return resolved.path;

		return null;
	}
}

/* ─── UI Component ──────────────────────────────────────── */

/**
 * Typeahead popover rendered as an Obsidian suggester-like element.
 */
export class AtMentionPopover {
	private readonly container: HTMLElement;
	private items: MentionItem[] = [];
	private selectedIndex = 0;
	private onSelect: (item: MentionItem) => void;
	private onClose: () => void;
	private isVisible = false;

	constructor(parent: HTMLElement) {
		this.container = parent.createDiv({ cls: 'cc-mention-popover cc-mention-popover-hidden' });
		this.onSelect = () => {};
		this.onClose = () => {};
	}

	/**
	 * Show the popover with categorized items.
	 */
	show(categories: MentionCategory[], onSelect: (item: MentionItem) => void, onClose: () => void): void {
		this.onSelect = onSelect;
		this.onClose = onClose;
		this.items = categories.flatMap(c => c.items);
		this.selectedIndex = 0;
		this.render(categories);
		this.isVisible = true;
		this.container.removeClass('cc-mention-popover-hidden');
	}

	/**
	 * Hide the popover.
	 */
	hide(): void {
		this.isVisible = false;
		this.container.addClass('cc-mention-popover-hidden');
		this.container.empty();
	}

	/**
	 * Move the selection up or down.
	 */
	moveSelection(direction: -1 | 1): void {
		if (!this.isVisible || this.items.length === 0) return;
		this.selectedIndex = (this.selectedIndex + direction + this.items.length) % this.items.length;
		this.highlightSelected();
	}

	/**
	 * Get the currently selected item.
	 */
	getSelected(): MentionItem | null {
		return this.items[this.selectedIndex] ?? null;
	}

	/**
	 * Confirm the current selection.
	 */
	confirm(): void {
		const selected = this.getSelected();
		if (selected) {
			this.onSelect(selected);
		}
	}

	/**
	 * Check if the popover is visible.
	 */
	get visible(): boolean {
		return this.isVisible;
	}

	/**
	 * Position the popover near the editor cursor.
	 */
	position(cursorPosition: { top: number; left: number }): void {
		this.container.style.top = `${cursorPosition.top + 24}px`;
		this.container.style.left = `${cursorPosition.left}px`;
	}

	/**
	 * Clean up the popover.
	 */
	destroy(): void {
		this.container.remove();
	}

	private render(categories: MentionCategory[]): void {
		this.container.empty();

		for (const category of categories) {
			const section = this.container.createDiv({ cls: 'cc-mention-category' });
			section.createDiv({ cls: 'cc-mention-category-label', text: category.label });

			for (const item of category.items) {
				const el = section.createDiv({ cls: 'cc-mention-item', attr: { 'data-value': item.value } });
				el.createSpan({ cls: 'cc-mention-item-label', text: item.label });
				if (item.description) {
					el.createSpan({ cls: 'cc-mention-item-desc', text: item.description });
				}
			}
		}

		this.highlightSelected();
	}

	private highlightSelected(): void {
		const items = this.container.querySelectorAll('.cc-mention-item');
		items.forEach((el, i) => {
			el.toggleClass('is-selected', i === this.selectedIndex);
		});
	}
}

/**
 * Typeahead controller that manages the lifecycle of @-mention detection
 * and popover display.
 */
export class AtMentionController {
	private readonly engine: AtMentionEngine;
	private popover: AtMentionPopover | null = null;
	private active = false;

	constructor(app: App) {
		this.engine = new AtMentionEngine(app);
	}

	/**
	 * Set the popover element for the controller.
	 */
	setPopover(popover: AtMentionPopover): void {
		this.popover = popover;
	}

	/**
	 * Get the mention engine (for configuring capability resolver).
	 */
	getEngine(): AtMentionEngine {
		return this.engine;
	}

	/**
	 * Handle a keydown event in the editor.
	 * Returns true if the event was consumed.
	 */
	handleKeydown(editor: Editor, event: KeyboardEvent): boolean {
		if (!this.popover) return false;

		if (event.key === '@') {
			// Start mention detection — let the next input event handle it
			return false;
		}

		if (this.popover.visible) {
			if (event.key === 'ArrowDown') {
				event.preventDefault();
				this.popover.moveSelection(1);
				return true;
			}
			if (event.key === 'ArrowUp') {
				event.preventDefault();
				this.popover.moveSelection(-1);
				return true;
			}
			if (event.key === 'Enter' || event.key === 'Tab') {
				event.preventDefault();
				const selected = this.popover.getSelected();
				if (selected) {
					const query = this.engine.parseMention(editor);
					if (query) {
						this.engine.insertMention(editor, selected, query);
					}
				}
				this.popover.hide();
				return true;
			}
			if (event.key === 'Escape') {
				event.preventDefault();
				this.popover.hide();
				return true;
			}
		}

		return false;
	}

	/**
	 * Handle a change in the editor content.
	 * Checks for @-mention patterns and shows/hides the popover.
	 */
	handleChange(editor: Editor): void {
		if (!this.popover) return;

		const query = this.engine.parseMention(editor);
		if (query) {
			const categories = this.engine.search(query.raw);
			if (categories.length > 0) {
				this.popover.show(categories, (item) => {
					this.engine.insertMention(editor, item, query);
					this.popover?.hide();
				}, () => {
					this.popover?.hide();
				});
				this.popover.position({ top: 0, left: 0 });
				this.active = true;
			} else {
				this.popover.hide();
				this.active = false;
			}
		} else {
			if (this.popover.visible) {
				this.popover.hide();
			}
			this.active = false;
		}
	}

	/**
	 * Clean up the controller.
	 */
	destroy(): void {
		this.popover?.destroy();
		this.popover = null;
	}
}

export { AtMentionEngine as MentionEngine };