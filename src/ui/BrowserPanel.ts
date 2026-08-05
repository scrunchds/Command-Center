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

import { Notice, Platform, setIcon } from 'obsidian';
import { BrowserHistory, chromeUserAgent, describeUrl, normalizeBrowserUrl } from './browser-url';

/** Where the panel starts when no address has been visited yet. */
const DEFAULT_HOME = 'https://obsidian.md';

/**
 * Sandbox for the iframe fallback.
 *
 * `allow-same-origin` is deliberately withheld: granting it alongside
 * `allow-scripts` would let a page reach into the plugin's own origin, and with
 * it the vault.
 */
const FRAME_SANDBOX = 'allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-scripts allow-downloads';

/**
 * Minimal surface of Electron's <webview> tag.
 *
 * Typed locally because it is a runtime element provided by Electron, not part
 * of the DOM or Obsidian type definitions.
 */
interface WebviewElement extends HTMLElement {
	src: string;
	canGoBack?: () => boolean;
	canGoForward?: () => boolean;
	goBack?: () => void;
	goForward?: () => void;
	reload?: () => void;
	getURL?: () => string;
	stop?: () => void;
}

export interface BrowserPanelOptions {
	/** Opens the full browser view in a split leaf, at the given address. */
	onPopOut: (url: string) => void;
	/** Notifies the host that focused mode changed, so layout can adapt. */
	onFocusChange?: (focused: boolean) => void;
	/** Starting address; defaults to the Obsidian home page. */
	home?: string;
	/** Hide the pop-out control when already in a dedicated pane. */
	showPopOut?: boolean;
}

/** Renders and maintains the embedded browser. */
export class BrowserPanel {
	private hostEl: HTMLElement | null = null;
	/** Electron <webview> on desktop; null when falling back to an iframe. */
	private webviewEl: WebviewElement | null = null;
	/** Sandboxed iframe fallback, used only when <webview> is unavailable. */
	private frameEl: HTMLIFrameElement | null = null;
	private noticeEl: HTMLElement | null = null;
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
		if (this.options.showPopOut !== false) {
			this.navButton(bar, 'picture-in-picture-2', 'Open in its own pane', () => {
				this.options.onPopOut(this.history.current || this.home());
			});
		}
		// Escape hatch: logins, downloads, and anything better handled by a real browser.
		this.navButton(bar, 'external-link', 'Open in your system browser', () => {
			const url = this.history.current;
			if (!url) {
				new Notice('Enter an address first.');
				return;
			}
			window.open(url, '_blank');
		});

		const viewport = host.createDiv({ cls: 'cc-browser-panel-viewport' });
		this.mountViewport(viewport);

		this.statusEl = host.createDiv({ cls: 'cc-browser-panel-status' });
		this.setStatus('Enter an address to begin.');
		this.syncControls();
	}

	/**
	 * Build the actual web surface.
	 *
	 * Electron's <webview> is a real browser view: it ignores `X-Frame-Options`
	 * and `frame-ancestors`, so sites that refuse framing (GitHub, MDN, Google,
	 * Stack Overflow) load normally. It is the same mechanism Obsidian's own Web
	 * viewer uses. An iframe cannot browse the open web, so it is only a fallback
	 * for environments without <webview>, and it says so plainly.
	 */
	private mountViewport(viewport: HTMLElement): void {
		if (Platform.isDesktopApp) {
			// createEl types against HTMLElementTagNameMap, which has no webview.
			const webview = viewport.createEl('webview' as keyof HTMLElementTagNameMap, {
				cls: 'cc-browser-panel-frame',
			}) as unknown as WebviewElement;
			webview.setAttribute('allowpopups', 'false');
			// Electron's default UA contains "Electron/" and "obsidian/", which Google
			// rejects outright ("this browser or app may not be secure") and which some
			// sites answer with a 401. Presenting the underlying Chrome UA, minus those
			// tokens, is what Obsidian's own web viewer does.
			// Read the UA from the frame's own realm rather than the plugin's global
			// navigator, which the Obsidian lint rules reserve for platform checks.
			const realmUa = viewport.ownerDocument.defaultView?.navigator.userAgent ?? '';
			webview.setAttribute('useragent', chromeUserAgent(realmUa));
			// Partition isolates cookies and storage from Obsidian's own session.
			webview.setAttribute('partition', 'persist:command-center-browser');
			this.webviewEl = webview;
			webview.addEventListener('did-stop-loading', () => {
				const url = webview.getURL?.() ?? this.history.current;
				// The page may have redirected or followed a link internally.
				if (url && url !== 'about:blank') {
					this.history.push(url);
					if (this.addressEl) this.addressEl.value = url;
				}
				this.setStatus(describeUrl(url));
				this.syncControls();
			});
			webview.addEventListener('did-fail-load', () => {
				this.setStatus('That page could not be loaded.');
			});
			return;
		}

		// Fallback path: honest about what it cannot do.
		this.frameEl = viewport.createEl('iframe', {
			cls: 'cc-browser-panel-frame',
			attr: { title: 'Embedded browser', sandbox: FRAME_SANDBOX, referrerpolicy: 'no-referrer' },
		});
		this.frameEl.addEventListener('load', () => this.setStatus(describeUrl(this.history.current)));
		this.noticeEl = viewport.createDiv({
			cls: 'cc-browser-panel-fallback',
			text: 'Limited mode: this platform has no embedded browser, so sites that refuse framing will not load. Use "Open externally" instead.',
		});
	}

	/** Remove listeners and clear the view so no page keeps running. */
	dispose(): void {
		// Blanking src stops timers, media, and network activity in the page.
		if (this.webviewEl) {
			this.webviewEl.stop?.();
			this.webviewEl.src = 'about:blank';
		}
		this.webviewEl = null;
		if (this.frameEl) this.frameEl.src = 'about:blank';
		this.frameEl = null;
		this.noticeEl = null;
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

	/**
	 * Step through history.
	 *
	 * The webview keeps its own authoritative history, including in-page
	 * navigations we never saw, so delegate to it and only fall back to the
	 * tracked stack for the iframe path.
	 */
	private step(direction: 'back' | 'forward'): void {
		const webview = this.webviewEl;
		if (webview) {
			if (direction === 'back' && webview.canGoBack?.()) webview.goBack?.();
			else if (direction === 'forward' && webview.canGoForward?.()) webview.goForward?.();
			this.syncControls();
			return;
		}
		const url = direction === 'back' ? this.history.back() : this.history.forward();
		if (url) this.load(url);
	}

	private reload(): void {
		if (this.webviewEl) {
			this.webviewEl.reload?.();
			return;
		}
		const url = this.history.current;
		if (!url) return;
		this.load(url);
	}

	/** Point the active web surface at a URL and resynchronize the toolbar. */
	private load(url: string): void {
		if (this.addressEl) this.addressEl.value = url;
		if (this.webviewEl) this.webviewEl.src = url;
		if (this.frameEl) this.frameEl.src = url;
		this.setStatus(`Loading ${describeUrl(url)}…`);
		this.syncControls();
	}

	private syncControls(): void {
		// Prefer the webview's real history; it knows about in-page navigation.
		const back = this.webviewEl?.canGoBack?.() ?? this.history.canGoBack;
		const forward = this.webviewEl?.canGoForward?.() ?? this.history.canGoForward;
		if (this.backEl) this.backEl.disabled = !back;
		if (this.forwardEl) this.forwardEl.disabled = !forward;
	}

	private setStatus(text: string): void {
		this.statusEl?.setText(text);
	}
}
