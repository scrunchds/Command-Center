import { ItemView, WorkspaceLeaf } from 'obsidian';
import type CommandCenterPlugin from '../main';
import { BrowserPanel } from './BrowserPanel';

export const COMMAND_CENTER_BROWSER_VIEW_TYPE = 'command-center-browser';
export const COMMAND_CENTER_BROWSER_DISPLAY_TEXT = 'Command Center browser';

const DEFAULT_HOME = 'https://obsidian.md';

/**
 * Full-pane browser.
 *
 * This is a thin shell around {@link BrowserPanel}: the pane and the dashboard
 * widget were previously separate implementations, which is how the pane ended
 * up rendering nothing while the widget worked. Sharing one panel means a fix
 * or a hardening applies to both surfaces at once.
 */
export class CommandCenterBrowserView extends ItemView {
	private readonly plugin: CommandCenterPlugin;
	private panel: BrowserPanel | null = null;
	/** Address requested before the panel existed, replayed once mounted. */
	private pendingUrl: string | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: CommandCenterPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return COMMAND_CENTER_BROWSER_VIEW_TYPE; }
	getDisplayText(): string { return COMMAND_CENTER_BROWSER_DISPLAY_TEXT; }
	getIcon(): string { return 'globe'; }

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('cc-browser-view');

		const host = container.createDiv({ cls: 'cc-browser-view-host' });
		this.panel = new BrowserPanel(this.app, {
			// Already a dedicated pane, so there is nothing to pop out to.
			onPopOut: () => undefined,
			showPopOut: false,
			home: DEFAULT_HOME,
		});
		this.panel.mount(host);

		// Load whatever was requested, or the home page for a bare open.
		this.panel.navigate(this.pendingUrl ?? DEFAULT_HOME);
		this.pendingUrl = null;
	}

	async onClose(): Promise<void> {
		// Dispose stops the page so no timers, media, or network survive the close.
		this.panel?.dispose();
		this.panel = null;
		this.containerEl.children[1]?.empty();
	}

	/** Navigate the pane, from the dashboard pop-out or a command. */
	open(url: string): void {
		if (!this.panel) {
			// onOpen has not run yet; remember the target and load it there.
			this.pendingUrl = url;
			return;
		}
		this.panel.navigate(url);
	}
}
