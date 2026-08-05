/**
 * MindMapPanel — a mind map of the active note's heading structure.
 *
 * Principle 2 (Zero-Cost Intelligence): the map is built entirely from
 * `metadataCache.getFileCache()`, which Obsidian has already parsed. No file
 * reads, no model calls, no tokens.
 *
 * Principle 5 (Native Obsidian Harmony): headings come from the same cache that
 * powers the core Outline view, and clicking a node uses the normal link path,
 * so it behaves like the rest of the app. This deliberately does not depend on
 * any third-party mind map plugin.
 *
 * Principle 6 (Centralized Operational Hub): structure is visible beside the
 * work rather than in a separate pane you have to go find.
 */

import { MarkdownView, Notice, TFile, setIcon } from 'obsidian';
import type { App } from 'obsidian';
import { type MindMapNode, buildMindMap, countNodes, maxDepth, toOutline } from './mindmap-model';

/** Collapse anything deeper than this by default so large notes stay readable. */
const DEFAULT_EXPAND_DEPTH = 2;

export interface MindMapPanelOptions {
	/** Opens a note at a specific line when a node is clicked. */
	onJump: (file: TFile, line: number) => void;
}

/** Renders and refreshes the heading mind map. */
export class MindMapPanel {
	private hostEl: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;
	private metaEl: HTMLElement | null = null;
	private file: TFile | null = null;
	/** Nodes the user explicitly collapsed or expanded, keyed by line. */
	private readonly overrides = new Map<number, boolean>();

	constructor(private readonly app: App, private readonly options: MindMapPanelOptions) {}

	/** Build the panel shell inside the supplied host. */
	mount(host: HTMLElement): void {
		this.hostEl = host;
		host.addClass('cc-mindmap');

		const bar = host.createDiv({ cls: 'cc-mindmap-bar' });
		this.metaEl = bar.createDiv({ cls: 'cc-mindmap-meta' });

		const copy = bar.createEl('button', {
			cls: 'cc-mindmap-action',
			attr: { type: 'button', 'aria-label': 'Copy as an outline', title: 'Copy as an outline' },
		});
		setIcon(copy, 'copy');
		copy.addEventListener('click', () => void this.copyOutline());

		this.bodyEl = host.createDiv({ cls: 'cc-mindmap-body' });
		this.refresh();
	}

	/** Release references so a closed dashboard does not retain the note. */
	dispose(): void {
		this.overrides.clear();
		this.hostEl = null;
		this.bodyEl = null;
		this.metaEl = null;
		this.file = null;
	}

	/**
	 * Rebuild from the active note.
	 *
	 * Called on mount and whenever the active leaf or metadata changes, so the
	 * map tracks whatever the user is actually looking at.
	 */
	refresh(): void {
		const body = this.bodyEl;
		if (!body) return;

		const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? null;
		// Switching notes invalidates collapse state, which is keyed by line.
		if (file?.path !== this.file?.path) this.overrides.clear();
		this.file = file;

		body.empty();

		if (!file) {
			this.setMeta('No note open');
			body.createDiv({ cls: 'cc-mindmap-empty', text: 'Open a note to see its structure.' });
			return;
		}

		const headings = this.app.metadataCache.getFileCache(file)?.headings ?? [];
		const roots = buildMindMap(headings.map(h => ({ heading: h.heading, level: h.level, line: h.position.start.line })));

		if (roots.length === 0) {
			this.setMeta(file.basename);
			body.createDiv({
				cls: 'cc-mindmap-empty',
				text: 'This note has no headings yet. Add one to map its structure.',
			});
			return;
		}

		// State the source and that it was free, per Principle 4.
		this.setMeta(`${file.basename} · ${countNodes(roots)} headings · no tokens used`);
		this.renderLevel(body, roots, 1, maxDepth(roots));
	}

	/** Render one level of the tree, recursing into expanded children. */
	private renderLevel(parent: HTMLElement, nodes: MindMapNode[], depth: number, deepest: number): void {
		const list = parent.createEl('ul', { cls: 'cc-mindmap-list' });
		if (depth === 1) list.addClass('is-root');

		for (const node of nodes) {
			const item = list.createEl('li', { cls: 'cc-mindmap-item' });
			const row = item.createDiv({ cls: 'cc-mindmap-row' });

			const hasChildren = node.children.length > 0;
			// Deep trees start folded; the user's own choice always wins.
			const expanded = this.overrides.get(node.line) ?? (depth < DEFAULT_EXPAND_DEPTH || deepest <= DEFAULT_EXPAND_DEPTH);

			if (hasChildren) {
				const twisty = row.createEl('button', {
					cls: 'cc-mindmap-twisty',
					attr: {
						type: 'button',
						'aria-expanded': String(expanded),
						'aria-label': expanded ? `Collapse ${node.text}` : `Expand ${node.text}`,
					},
				});
				setIcon(twisty, expanded ? 'chevron-down' : 'chevron-right');
				twisty.addEventListener('click', event => {
					event.stopPropagation();
					this.overrides.set(node.line, !expanded);
					this.refresh();
				});
			} else {
				// Keep labels aligned with their siblings that do have a twisty.
				row.createDiv({ cls: 'cc-mindmap-twisty-spacer' });
			}

			const label = row.createEl('button', {
				cls: `cc-mindmap-label is-level-${Math.min(node.level, 6)}`,
				text: node.text,
				attr: { type: 'button', title: `Go to "${node.text}"` },
			});
			label.addEventListener('click', () => {
				if (this.file) this.options.onJump(this.file, node.line);
			});

			if (hasChildren && expanded) this.renderLevel(item, node.children, depth + 1, deepest);
		}
	}

	/** Copy the map as an indented Markdown list. */
	private async copyOutline(): Promise<void> {
		const file = this.file;
		if (!file) {
			new Notice('Open a note first.');
			return;
		}
		const headings = this.app.metadataCache.getFileCache(file)?.headings ?? [];
		const roots = buildMindMap(headings.map(h => ({ heading: h.heading, level: h.level, line: h.position.start.line })));
		if (roots.length === 0) {
			new Notice('This note has no headings to copy.');
			return;
		}
		await navigator.clipboard.writeText(toOutline(roots));
		new Notice('Outline copied.');
	}

	private setMeta(text: string): void {
		this.metaEl?.setText(text);
	}
}
