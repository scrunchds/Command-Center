import { ItemView, Notice, WorkspaceLeaf, setIcon } from 'obsidian';
import type CommandCenterPlugin from '../main';

export const COMMAND_CENTER_BROWSER_VIEW_TYPE = 'command-center-browser';
export const COMMAND_CENTER_BROWSER_DISPLAY_TEXT = 'Command Center Browser';

const DEFAULT_HOME = 'https://obsidian.md';

export class CommandCenterBrowserView extends ItemView {
	private readonly plugin: CommandCenterPlugin;
	private toolbarEl!: HTMLElement;
	private addressEl!: HTMLInputElement;
	private frameEl!: HTMLIFrameElement;
	private statusEl!: HTMLElement;
	private backButton!: HTMLButtonElement;
	private forwardButton!: HTMLButtonElement;
	private refreshButton!: HTMLButtonElement;
	private openButton!: HTMLButtonElement;
	private currentUrl = DEFAULT_HOME;
	private history: string[] = [DEFAULT_HOME];
	private historyIndex = 0;
	private isOpen = false;

	constructor(leaf: WorkspaceLeaf, plugin: CommandCenterPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return COMMAND_CENTER_BROWSER_VIEW_TYPE; }
	getDisplayText(): string { return COMMAND_CENTER_BROWSER_DISPLAY_TEXT; }
	getIcon(): string { return 'globe'; }

	async onOpen(): Promise<void> {
		this.isOpen = true;
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('cc-browser-view');

		const header = container.createDiv({ cls: 'cc-browser-header' });
		this.toolbarEl = header;
		this.backButton = header.createEl('button', { cls: 'cc-browser-nav', attr: { type: 'button', 'aria-label': 'Back' } });
		setIcon(this.backButton, 'arrow-left');
		this.forwardButton = header.createEl('button', { cls: 'cc-browser-nav', attr: { type: 'button', 'aria-label': 'Forward' } });
		setIcon(this.forwardButton, 'arrow-right');
		this.refreshButton = header.createEl('button', { cls: 'cc-browser-nav', attr: { type: 'button', 'aria-label': 'Reload' } });
		setIcon(this.refreshButton, 'refresh-cw');
		this.addressEl = header.createEl('input', {
			cls: 'cc-browser-address',
			attr: {
				type: 'url',
				placeholder: 'https://example.com',
				spellcheck: 'false',
				'autocapitalize': 'off',
				'autocomplete': 'off',
				'aria-label': 'Web address',
			},
		});
		this.openButton = header.createEl('button', {
			text: 'Open',
			cls: 'mod-cta',
			attr: { type: 'button', 'aria-label': 'Open web address' },
		});
		this.statusEl = header.createDiv({ cls: 'cc-browser-status', text: 'Ready' });

		const viewport = container.createDiv({ cls: 'cc-browser-viewport' });
		this.frameEl = viewport.createEl('iframe', {
			cls: 'cc-browser-frame',
			attr: {
				title: 'Command center browser',
				sandbox: 'allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-scripts allow-downloads',
				referrerpolicy: 'no-referrer',
			},
		});

		this.registerDomEvent(this.backButton, 'click', () => void this.goBack());
		this.registerDomEvent(this.forwardButton, 'click', () => void this.goForward());
		this.registerDomEvent(this.refreshButton, 'click', () => this.reload());
		this.registerDomEvent(this.openButton, 'click', () => void this.navigateFromInput());
		this.registerDomEvent(this.addressEl, 'keydown', (event: KeyboardEvent) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				void this.navigateFromInput();
			}
		});

		this.syncControls();
		void this.navigate(this.currentUrl, { replaceHistory: true, focusAddress: false });
	}

	async onClose(): Promise<void> {
		this.isOpen = false;
		this.currentUrl = this.currentUrl || DEFAULT_HOME;
		this.containerEl.children[1]?.empty();
	}

	open(url: string): void {
		void this.navigate(url, { focusAddress: true });
	}

	private async navigateFromInput(): Promise<void> {
		await this.navigate(this.addressEl.value || DEFAULT_HOME, { focusAddress: false });
	}

	private async navigate(rawUrl: string, options: { replaceHistory?: boolean; focusAddress?: boolean } = {}): Promise<void> {
		const url = this.normalizeUrl(rawUrl);
		if (!url) {
			new Notice('Enter a valid URL or search string.');
			return;
		}
		this.currentUrl = url;
		if (options.replaceHistory) {
			this.history = [url];
			this.historyIndex = 0;
		} else {
			this.history = this.history.slice(0, this.historyIndex + 1);
			this.history.push(url);
			this.historyIndex = this.history.length - 1;
		}
		if (this.addressEl) this.addressEl.value = url;
		if (this.frameEl) this.frameEl.src = url;
		if (options.focusAddress) this.addressEl?.focus();
		this.syncControls();
		this.setStatus(`Loading ${url}`);
	}

	private async goBack(): Promise<void> {
		if (this.historyIndex <= 0) return;
		this.historyIndex -= 1;
		await this.loadCurrent();
	}

	private async goForward(): Promise<void> {
		if (this.historyIndex >= this.history.length - 1) return;
		this.historyIndex += 1;
		await this.loadCurrent();
	}

	private reload(): void {
		if (!this.frameEl) return;
		this.frameEl.src = this.history[this.historyIndex] ?? this.currentUrl;
		this.setStatus(`Reloading ${this.history[this.historyIndex] ?? this.currentUrl}`);
	}

	private async loadCurrent(): Promise<void> {
		const url = this.history[this.historyIndex] ?? DEFAULT_HOME;
		this.currentUrl = url;
		if (this.addressEl) this.addressEl.value = url;
		if (this.frameEl) this.frameEl.src = url;
		this.syncControls();
		this.setStatus(`Loading ${url}`);
	}

	private syncControls(): void {
		const canGoBack = this.historyIndex > 0;
		const canGoForward = this.historyIndex < this.history.length - 1;
		if (this.backButton) this.backButton.disabled = !canGoBack;
		if (this.forwardButton) this.forwardButton.disabled = !canGoForward;
		if (this.refreshButton) this.refreshButton.disabled = !this.currentUrl;
	}

	private setStatus(text: string): void {
		if (this.statusEl) this.statusEl.setText(text);
	}

	private normalizeUrl(input: string): string {
		const trimmed = input.trim();
		if (!trimmed) return '';
		try {
			return new URL(trimmed).toString();
		} catch {
			try {
				return new URL(`https://${trimmed}`).toString();
			} catch {
				return '';
			}
		}
	}
}
