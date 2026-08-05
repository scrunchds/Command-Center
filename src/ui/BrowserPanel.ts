/**
 * BrowserPanel — an embedded web browser widget for the dashboard.
 *
 * Principle 6 (Centralized Operational Hub): documentation, API references, and
 * research live beside your notes and workflows instead of in a separate app, so
 * looking something up never means leaving the operational surface.
 *
 * Principle 5 (Native Obsidian Harmony): the same panel powers the dashboard
 * widget and the full-pane browser view, and popping out uses Obsidian's own
 * workspace leaves rather than a bespoke window.
 *
 * The panel has three presentations:
 *   inline    — sits in the dashboard grid at widget height
 *   focused   — expands to fill the dashboard for close reading
 *   popped out — opens the full browser view in a split leaf
 */

import { Notice, setIcon } from 'obsidian';
import { BrowserHistory, describeUrl, normalizeBrowserUrl } from './browser-url';

/** Where the panel starts when no address has been visited yet. */
const DEFAULT_HOME = 'https://obsidian.md';

/**
 * Sandbox for embedded pages.
 *
 * `allow-same-origin` is deliberately withheld: granting it alongside
 * `allow-scripts` would let a page reach into the plugin's own origin, and with
 * it the vault. Forms, scripts, and popups are permitted so real documentation
 * sites remain usable.
 */
const FRAME_SANDBOX = 'allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-scripts allow-downloads';

export interface BrowserPanelOptions {
	/** Opens the full browser view in a split leaf, at the given address. */
	onPopOut: (url: string) => void;
	/** Notifies the host that focused mode changed, so layout can adapt. */
	onFocusChange?: (focused: boolean) => void;
	/** Starting address; defaults to the Obsidian home page. */
	home?: string;
}

/** Renders and maintains the embedded browser. */
export class BrowserPanel {
	private hostEl: HTMLElement | null = null;
	private frameEl: HTMLIFrameElement | null = null;
	private addressEl: HTMLInputElement | null = null;
	private statusEl: HTMLElement | null = null;
	private backEl: HTMLButtonElement | null = null;
	private forwardEl: HTMLButtonElement | null = null;
	private focusEl: HTMLButtonElement | null = null;
	private readonly history = new BrowserHistory();
	private focused = false;

	constructor(private readonly options: BrowserPanelOptions) {}

	/** Build the toolbar and viewport inside the supplied host. */
	mount(host: HTMLElement): void {
		this.hostEl = host;
		host.addClass('cc-browser-panel');

		const bar = host.createDiv({ cls: 'cc-browser-panel-bar' });
		this.backEl = this.navButton(bar, 'arrow-left', 'Back', () => this.step('back'));
		this.forwardEl = this.navButton(bar, 'arrow-right', 'Forward', () => this.step('forward'));
		this.navButton(bar, 'refresh-cw', 'Reload', () => this.reload());

		this.addressEl = bar.createEl('input', {
			cls: 'cc-browser-panel-address',
			attr: {
				type: 'text',
				placeholder: 'Search or enter a web address',
				spellcheck: 'false',
				autocapitalize: 'off',
				autocomplete: 'off',
				'aria-label': 'Search or enter a web address',
			},
		});
		this.addressEl.addEventListener('keydown', event => {
			if (event.key === 'Enter') {
				event.preventDefault();
				this.navigate(this.addressEl?.value ?? '');
			}
		});
		// Selecting on focus makes replacing the address a single action.
		this.addressEl.addEventListener('focus', () => this.addressEl?.select());

		this.focusEl = this.navButton(bar, 'maximize-2', 'Expand to fill the dashboard', () => this.toggleFocus());
		this.navButton(bar, 'picture-in-picture-2', 'Open in its own pane', () => {
			this.options.onPopOut(this.history.current || this.home());
		});

		const viewport = host.createDiv({ cls: 'cc-browser-panel-viewport' });
		this.frameEl = viewport.createEl('iframe', {
			cls: 'cc-browser-panel-frame',
			attr: { title: 'Embedded browser', sandbox: FRAME_SANDBOX, referrerpolicy: 'no-referrer' },
		});
		// Some sites refuse framing; say so rather than showing a blank rectangle.
		this.frameEl.addEventListener('load', () => this.setStatus(describeUrl(this.history.current)));

		this.statusEl = host.createDiv({ cls: 'cc-browser-panel-status' });
		this.setStatus('Enter an address to begin.');
		this.syncControls();
	}

	/** Remove listeners and clear the frame so no page keeps running. */
	dispose(): void {
		// Blanking src stops timers, media, and network activity in the page.
		if (this.frameEl) this.frameEl.src = 'about:blank';
		this.frameEl = null;
		this.addressEl = null;
		this.statusEl = null;
		this.backEl = null;
		this.forwardEl = null;
		this.focusEl = null;
		this.hostEl = null;
	}

	/** Load an address, from the address box or from another surface. */
	navigate(raw: string): void {
		const url = normalizeBrowserUrl(raw);
		if (!url) {
			new Notice('That does not look like a web address or a search.');
			return;
		}
		this.history.push(url);
		this.load(url);
	}

	/** The address currently loaded, for handoff when popping out. */
	currentUrl(): string {
		return this.history.current;
	}

	/** Whether the panel is expanded to fill the dashboard. */
	isFocused(): boolean {
		return this.focused;
	}

	/** Expand to fill the dashboard, or return to inline height. */
	toggleFocus(force?: boolean): void {
		this.focused = force ?? !this.focused;
		this.hostEl?.toggleClass('is-focused', this.focused);
		if (this.focusEl) {
			this.focusEl.empty();
			setIcon(this.focusEl, this.focused ? 'minimize-2' : 'maximize-2');
			this.focusEl.setAttribute(
				'aria-label',
				this.focused ? 'Collapse back into the dashboard' : 'Expand to fill the dashboard',
			);
			this.focusEl.setAttribute('aria-pressed', String(this.focused));
		}
		this.options.onFocusChange?.(this.focused);
	}

	private home(): string {
		return this.options.home?.trim() || DEFAULT_HOME;
	}

	private navButton(bar: HTMLElement, icon: string, label: string, onClick: () => void): HTMLButtonElement {
		const button = bar.createEl('button', {
			cls: 'cc-browser-panel-nav',
			attr: { type: 'button', 'aria-label': label, title: label },
		});
		setIcon(button, icon);
		button.addEventListener('click', onClick);
		return button;
	}

	private step(direction: 'back' | 'forward'): void {
		const url = direction === 'back' ? this.history.back() : this.history.forward();
		if (url) this.load(url);
	}

	private reload(): void {
		const url = this.history.current;
		if (!url) return;
		this.load(url);
	}

	/** Point the frame at a URL and resynchronize the toolbar. */
	private load(url: string): void {
		if (this.addressEl) this.addressEl.value = url;
		if (this.frameEl) this.frameEl.src = url;
		this.setStatus(`Loading ${describeUrl(url)}…`);
		this.syncControls();
	}

	private syncControls(): void {
		if (this.backEl) this.backEl.disabled = !this.history.canGoBack;
		if (this.forwardEl) this.forwardEl.disabled = !this.history.canGoForward;
	}

	private setStatus(text: string): void {
		this.statusEl?.setText(text);
	}
}
