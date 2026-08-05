/**
 * CustomCards — user-defined dashboard cards backed by ordinary vault notes.
 *
 * Principle 3 (Dynamic Extensibility / Markdown-Backed): a card is just a note
 * with `cc-card: true` in its frontmatter. There is no card registry, no JSON
 * schema, and no settings form to fill in. Create the note and the card appears;
 * delete the note and it disappears. Cards hot-register on vault events, so no
 * Obsidian restart is ever required.
 *
 * Principle 2 (Zero-Cost Intelligence): rendering is pure Obsidian — Markdown
 * rendering plus the metadata cache. No provider call and no token spend, so
 * cards stay free no matter how many you create.
 *
 * Principle 1 (Absolute Write-Gate Authority): task rows inside a card are
 * interactive, but every toggle is routed through `TaskWriter` and therefore
 * through the write gate. A click is a proposal, never an unattended write.
 *
 * Recognized frontmatter keys:
 *   cc-card:        true — required; marks the note as a dashboard card
 *   cc-card-title:  display name (falls back to name/title, then filename)
 *   cc-card-hint:   one-line description of what the card is for
 *   cc-card-icon:   Obsidian icon id
 *   cc-card-order:  number used to sort cards relative to one another
 */

import { type App, type Component, type EventRef, MarkdownRenderer, Notice, TFile, setIcon } from 'obsidian';
import type { TaskWriter } from '../intelligence/TaskWriter';
import { type CardSegment, CUSTOM_CARD_FLAG, CUSTOM_WIDGET_PREFIX, parseCardBody } from './card-syntax';

export { CUSTOM_CARD_FLAG, CUSTOM_WIDGET_PREFIX, parseCardBody, stripFrontmatter } from './card-syntax';

/** Refresh coalescing window, matched to the Command Deck for consistency. */
const REFRESH_DEBOUNCE_MS = 150;

/** A discovered custom card definition. */
export interface CustomCard {
	/** Vault path of the backing note. */
	path: string;
	/** Widget id used by the dashboard layout system. */
	widgetId: string;
	title: string;
	hint: string;
	icon: string;
	order: number;
}

export interface CustomCardsOptions {
	/** Write-gated task mutation layer. */
	tasks: TaskWriter;
	/** Component owning rendered Markdown, for correct child lifecycle. */
	component: Component;
	/** Called after a successful mutation so dependent surfaces can refresh. */
	onMutate: () => void;
	/**
	 * Called after every repaint so the dashboard can re-place the sections.
	 *
	 * @param rosterChanged True when cards were added or removed, as opposed to a
	 *   card's contents changing. Only a roster change needs the layout editor
	 *   rebuilt, which would otherwise fight with in-progress editing.
	 */
	onCardsChanged: (rosterChanged: boolean) => void;
}

/** Read a trimmed string from unknown frontmatter safely. */
function text(value: unknown): string {
	return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/** Read a finite number from unknown frontmatter, defaulting when absent. */
function num(value: unknown, fallback: number): number {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	const parsed = typeof value === 'string' ? Number(value) : NaN;
	return Number.isFinite(parsed) ? parsed : fallback;
}



/**
 * Discovers, renders, and maintains custom dashboard cards.
 *
 * Call `mount()` once with the widget host, then `dispose()` on view close.
 */
export class CustomCards {
	private hostEl: HTMLElement | null = null;
	/**
	 * Sections this instance created.
	 *
	 * Tracked by reference rather than cleared with `host.empty()`, because the
	 * dashboard layout engine reparents widgets to order them. Once a section has
	 * been moved out of our mount point, only the reference can still remove it.
	 */
	private sections: HTMLElement[] = [];
	private cards: CustomCard[] = [];
	private vaultRefs: EventRef[] = [];
	private metadataRef: EventRef | null = null;
	private refreshTimer: number | null = null;
	/** Signature of the last rendered card set, used to detect real changes. */
	private signature = '';

	constructor(
		private readonly app: App,
		private readonly options: CustomCardsOptions,
	) {}

	/** Attach to the widget host and begin tracking vault changes. */
	mount(host: HTMLElement): void {
		this.hostEl = host;
		const schedule = () => this.scheduleRefresh();
		// Registered per event literal: a loop breaks Obsidian's overload typing.
		this.vaultRefs = [
			this.app.vault.on('create', schedule),
			this.app.vault.on('delete', schedule),
			this.app.vault.on('rename', schedule),
			this.app.vault.on('modify', schedule),
		];
		this.metadataRef = this.app.metadataCache.on('changed', schedule);
		void this.refresh();
	}

	/** Detach every listener and timer. Safe to call more than once. */
	dispose(): void {
		for (const ref of this.vaultRefs) this.app.vault.offref(ref);
		this.vaultRefs = [];
		if (this.metadataRef) {
			this.app.metadataCache.offref(this.metadataRef);
			this.metadataRef = null;
		}
		if (this.refreshTimer !== null) {
			window.clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.clearSections();
		this.hostEl = null;
	}

	/** Detach every section we created, wherever the layout engine moved it. */
	private clearSections(): void {
		for (const section of this.sections) section.remove();
		this.sections = [];
	}

	/** Widget ids currently backed by a real card, for layout validation. */
	widgetIds(): string[] {
		return this.cards.map(card => card.widgetId);
	}

	/** Human label for a custom widget id, used by the layout editor. */
	labelFor(widgetId: string): string | null {
		return this.cards.find(card => card.widgetId === widgetId)?.title ?? null;
	}

	private scheduleRefresh(): void {
		if (this.refreshTimer !== null) return;
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			void this.refresh();
		}, REFRESH_DEBOUNCE_MS);
	}

	/** Rediscover cards and repaint. Cheap enough to call on any vault event. */
	async refresh(): Promise<void> {
		if (!this.hostEl) return;
		this.cards = this.discover();
		const signature = this.cards.map(card => `${card.widgetId}:${card.title}`).join('|');
		const changed = signature !== this.signature;
		this.signature = signature;
		await this.render();
		// Always announce: freshly created sections must be re-placed by the layout
		// engine, even when the roster itself is unchanged.
		this.options.onCardsChanged(changed);
	}

	/**
	 * Find every note flagged as a card.
	 *
	 * Any note anywhere may be a card: imposing a folder would contradict the
	 * agnostic design and force a structure onto the vault.
	 */
	private discover(): CustomCard[] {
		const found: CustomCard[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (!frontmatter || frontmatter[CUSTOM_CARD_FLAG] !== true) continue;
			const record = frontmatter as Record<string, unknown>;
			found.push({
				path: file.path,
				widgetId: `${CUSTOM_WIDGET_PREFIX}${file.path}`,
				title: text(record['cc-card-title']) || text(record.name) || text(record.title) || file.basename,
				hint: text(record['cc-card-hint']),
				icon: text(record['cc-card-icon']) || 'layout-dashboard',
				order: num(record['cc-card-order'], 0),
			});
		}
		// Explicit order first, then alphabetical, so ties stay stable.
		return found.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
	}

	/** Rebuild every card section inside the widget host. */
	private async render(): Promise<void> {
		const host = this.hostEl;
		if (!host) return;
		this.clearSections();
		for (const card of this.cards) {
			const file = this.app.vault.getAbstractFileByPath(card.path);
			if (!(file instanceof TFile)) continue;
			const section = host.createEl('section', { cls: 'command-center-section cc-custom-card' });
			section.dataset.widgetId = card.widgetId;
			this.sections.push(section);
			this.renderHeader(section, card, file);
			const body = section.createDiv({ cls: 'cc-custom-card-body' });
			try {
				await this.renderBody(body, card, file);
			} catch (error) {
				// Principle 4: a broken card explains itself rather than blanking.
				body.empty();
				body.createDiv({
					cls: 'cc-intel-error',
					text: `Could not render ${card.path}: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}
	}

	/** Title row with the card's icon, hint, and a jump to its source note. */
	private renderHeader(section: HTMLElement, card: CustomCard, file: TFile): void {
		const header = section.createDiv({ cls: 'command-center-section-header' });
		const group = header.createDiv({ cls: 'cc-widget-title-group' });
		const heading = group.createEl('h3');
		setIcon(heading.createSpan({ cls: 'cc-custom-card-icon' }), card.icon);
		heading.createSpan({ text: card.title });
		group.createSpan({
			text: card.hint || 'A custom card defined by a note in your vault.',
			cls: 'cc-widget-caption',
		});
		const actions = header.createDiv({ cls: 'cc-widget-header-actions' });
		const edit = actions.createEl('button', {
			text: 'Edit card',
			attr: { 'aria-label': `Open ${card.path} to edit this card` },
		});
		edit.addEventListener('click', () => {
			void this.app.workspace.getLeaf(false).openFile(file);
		});
	}

	/** Render prose runs natively and task lines as write-gated rows. */
	private async renderBody(body: HTMLElement, card: CustomCard, file: TFile): Promise<void> {
		const segments = parseCardBody(await this.app.vault.cachedRead(file));
		if (segments.length === 0) {
			body.createDiv({
				cls: 'cc-intel-empty',
				text: 'This card is empty. Add Markdown, an embedded base, or checkbox tasks to the note.',
			});
			return;
		}
		let tasks: HTMLElement | null = null;
		for (const segment of segments) {
			if (segment.kind === 'markdown') {
				tasks = null;
				const block = body.createDiv({ cls: 'cc-custom-card-markdown' });
				// Native rendering keeps base embeds, Dataview, and callouts working.
				await MarkdownRenderer.render(this.app, segment.text, block, card.path, this.options.component);
				continue;
			}
			tasks ??= body.createDiv({ cls: 'cc-custom-card-tasks' });
			this.renderTask(tasks, card, segment);
		}
	}

	/** One interactive task row. Every mutation passes through the write gate. */
	private renderTask(host: HTMLElement, card: CustomCard, segment: CardSegment): void {
		const row = host.createDiv({ cls: 'cc-custom-task' });
		row.toggleClass('is-done', segment.done);
		const box = row.createEl('input', { type: 'checkbox' });
		box.checked = segment.done;
		box.setAttribute('aria-label', `Mark "${segment.label}" ${segment.done ? 'incomplete' : 'complete'}`);
		box.addEventListener('change', () => {
			box.disabled = true;
			const desired = box.checked;
			void (async () => {
				try {
					const written = await this.options.tasks.toggleTask(card.path, segment.line, desired);
					if (!written) {
						// Declined at the gate: restore the checkbox, claim nothing.
						box.checked = segment.done;
						new Notice('Not approved. Nothing was changed.');
						return;
					}
					this.options.onMutate();
				} catch (error) {
					box.checked = segment.done;
					new Notice(error instanceof Error ? error.message : String(error));
				} finally {
					box.disabled = false;
				}
			})();
		});
		row.createDiv({ text: segment.label, cls: 'cc-custom-task-text' });
		const jump = row.createEl('button', { attr: { 'aria-label': `Open ${card.path} at this task` } });
		setIcon(jump, 'arrow-up-right');
		jump.addEventListener('click', () => void this.openAt(card.path, segment.line));
	}

	/** Open the backing note with the cursor on the task's line. */
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
}
