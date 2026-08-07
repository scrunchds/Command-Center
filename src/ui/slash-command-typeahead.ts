import type { App } from 'obsidian';

/**
 * Slash-command typeahead for the chat composer. When the textarea value
 * starts with `/`, a popover of matching Obsidian commands appears; arrow keys
 * navigate, Enter executes the selected command (and clears the input so no
 * message is sent), Escape closes the popover. This makes the chat panel a
 * command surface like an agentic assistant's `/command` bar.
 *
 * `app.commands` is an internal Obsidian API; it is accessed defensively so a
 * future API change degrades to "no matches" rather than crashing.
 */
interface ObsidianCommand { id: string; name: string }

export class SlashCommandTypeahead {
	private popover: HTMLElement | null = null;
	private items: ObsidianCommand[] = [];
	private selected = 0;
	private open = false;

	constructor(
		private readonly app: App,
		private readonly textarea: HTMLTextAreaElement,
		private readonly onExecuted?: (command: ObsidianCommand) => void,
	) {
		textarea.addEventListener('input', () => this.refresh());
		textarea.addEventListener('keydown', e => this.onKey(e));
		textarea.addEventListener('blur', () => window.setTimeout(() => this.close(), 120));
	}

	private commands(): ObsidianCommand[] {
		const manager = (this.app as unknown as { commands?: { listCommands?: () => ObsidianCommand[] } }).commands;
		return manager?.listCommands?.() ?? [];
	}

	private refresh(): void {
		const value = this.textarea.value;
		if (!value.startsWith('/') || value.includes('\n')) { this.close(); return; }
		const query = value.slice(1).toLowerCase();
		const all = this.commands();
		const matches = query
			? all.filter(cmd => cmd.id.toLowerCase().includes(query) || cmd.name.toLowerCase().includes(query))
			: all;
		this.items = matches.slice(0, 12);
		this.selected = 0;
		if (this.items.length === 0) { this.close(); return; }
		this.render();
	}

	private render(): void {
		if (!this.popover) {
			this.popover = this.textarea.ownerDocument.body.createDiv({ cls: 'cc-slash-popover' });
		}
		this.popover.empty();
		this.items.forEach((cmd, index) => {
			const row = this.popover!.createDiv({
				cls: `cc-slash-row${index === this.selected ? ' is-selected' : ''}`,
				attr: { role: 'option', 'aria-selected': String(index === this.selected) },
			});
			row.createSpan({ cls: 'cc-slash-name', text: cmd.name });
			row.createSpan({ cls: 'cc-slash-id', text: cmd.id });
			row.addEventListener('mousedown', e => { e.preventDefault(); this.execute(index); });
		});
		this.position();
		this.open = true;
	}

	private position(): void {
		if (!this.popover) return;
		const rect = this.textarea.getBoundingClientRect();
		this.popover.setCssProps({
			left: `${rect.left}px`,
			top: `${rect.bottom + 4}px`,
			minWidth: `${Math.max(220, rect.width)}px`,
		});
	}

	private onKey(event: KeyboardEvent): void {
		if (!this.open || this.items.length === 0) return;
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			event.stopImmediatePropagation();
			this.selected = (this.selected + 1) % this.items.length;
			this.highlight();
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			event.stopImmediatePropagation();
			this.selected = (this.selected - 1 + this.items.length) % this.items.length;
			this.highlight();
		} else if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			event.stopImmediatePropagation();
			this.execute(this.selected);
		} else if (event.key === 'Escape') {
			event.preventDefault();
			event.stopImmediatePropagation();
			this.close();
		}
	}

	private highlight(): void {
		this.popover?.querySelectorAll('.cc-slash-row').forEach((row, index) => {
			row.toggleClass('is-selected', index === this.selected);
		});
	}

	private execute(index: number): void {
		const command = this.items[index];
		this.close();
		if (!command) return;
		this.textarea.value = '';
		this.textarea.dispatchEvent(new Event('input'));
		const manager = (this.app as unknown as { commands?: { executeCommandById?: (id: string) => boolean } }).commands;
		manager?.executeCommandById?.(command.id);
		this.onExecuted?.(command);
	}

	close(): void {
		this.popover?.remove();
		this.popover = null;
		this.open = false;
		this.items = [];
	}
}
