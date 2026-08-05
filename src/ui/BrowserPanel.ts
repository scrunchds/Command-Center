/**
 * BrowserPanel — a browser launcher widget for the dashboard.
 *
 * The primary action opens the system's default browser (Chrome, Edge, Firefox,
 * …) via Electron's `shell.openExternal`, because that is where links and
 * logins work reliably. An embedded webview is available as an opt-in "Preview
 * inline" toggle for close reading without leaving the dashboard, but it is no
 * longer the default: embedded webviews drop `target="_blank"` links, fail
 * logins, and break on sites that refuse framing, which made the old widget
 * feel broken.
 *
 * Principle 5 (Native Obsidian Harmony): when the core Web viewer is enabled it
 * is offered alongside the system browser, since it carries the user's history,
 * favicons, ad blocking, and search-engine choice. The same panel powers the
 * dashboard widget and the full-pane browser view.
 */

import { Notice, Platform, setIcon } from 'obsidian';
import type { App } from 'obsidian';
import { BrowserHistory, chromeUserAgent, describeUrl, normalizeBrowserUrl } from './browser-url';
import { isNativeWebViewerEnabled } from './native-webviewer';

declare const require: ((id: string) => unknown) | undefined;

/** Minimal shape of Electron's shell module we use to launch the system browser. */
interface ElectronShell {
	openExternal: (url: string) => Promise<void>;
}

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
	/**
	 * Hand the current address to Obsidian's own Web viewer. Omitted by surfaces
	 * that are already a Web viewer leaf, which would otherwise offer to open
	 * themselves.
	 */
	onOpenNative?: (url: string) => void;
}

/** Renders and maintains the browser launcher. */
export class BrowserPanel {
	private hostEl: HTMLElement | null = null;
	/** Address bar. */
	private addressEl: HTMLInputElement | null = null;
	/** Status line ("Loaded example.com" / error text). */
	private statusEl: HTMLElement | null = null;
	private backEl: HTMLButtonElement | null = null;
	private forwardEl: HTMLButtonElement | null = null;
	private focusEl: HTMLButtonElement | null = null;
	/** Container the embedded webview mounts into, only when previewing inline. */
	private viewportEl: HTMLElement | null = null;
	/** Electron <webview> on desktop; null when not previewing or unsupported. */
	private webviewEl: WebviewElement | null = null;
	/** Sandboxed iframe fallback, used only when <webview> is unavailable. */
	private frameEl: HTMLIFrameElement | null = null;
	private noticeEl: HTMLElement | null = null;
	/** Whether the inline preview webview is currently shown. */
	private previewing = false;
	private focused = false;
	private readonly history = new BrowserHistory();
	/** Lazy Electron shell handle, captured once. */
	private static shell: ElectronShell | null | undefined;

	constructor(private readonly app: App, private readonly options: BrowserPanelOptions) {}

	/** Build the toolbar and launcher inside the supplied host. */
	mount(host: HTMLElement): void {
		this.hostEl = host;
		host.addClass('cc-browser-panel');
		host.addClass('cc-browser-launcher');

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
				this.openFromAddress();
			}
		});
		// Selecting on focus makes replacing the address a single action.
		this.addressEl.addEventListener('focus', () => this.addressEl?.select());

		// Primary action: open in the system browser.
		const openBtn = bar.createEl('button', {
			cls: 'cc-browser-panel-open mod-cta',
			attr: { type: 'button', 'aria-label': 'Open in your browser', title: 'Open in your browser' },
		});
		openBtn.createSpan({ text: 'Open' });
		openBtn.addEventListener('click', () => this.openFromAddress());

		// Toggle an inline preview inside the widget for close reading.
		this.focusEl = this.navButton(bar, 'maximize-2', 'Preview inline', () => this.togglePreview());

		if (this.options.showPopOut !== false) {
			this.navButton(bar, 'picture-in-picture-2', 'Open in its own pane', () => {
				this.options.onPopOut(this.history.current || this.home());
			});
		}
		// Hand off to Obsidian's own Web viewer, which brings its history,
		// favicons, ad blocking, and search-engine choice. Only offered when it is
		// enabled, so the button never appears and then fails.
		if (this.options.onOpenNative && isNativeWebViewerEnabled(this.app)) {
			this.navButton(bar, 'globe-2', "Open in Obsidian's Web viewer", () => {
				const url = this.history.current;
				if (!url) {
					new Notice('Enter an address first.');
					return;
				}
				this.options.onOpenNative?.(url);
			});
		}

		this.statusEl = host.createDiv({ cls: 'cc-browser-panel-status' });
		this.setStatus('Enter an address to open it in your browser.');
		this.syncControls();
	}

	/** Remove listeners and clear the view so no page keeps running. */
	dispose(): void {
		this.unmountViewport();
		this.addressEl = null;
		this.statusEl = null;
		this.backEl = null;
		this.forwardEl = null;
		this.focusEl = null;
		this.viewportEl = null;
		this.hostEl = null;
	}

	/**
	 * Resolve the address bar's text and open it.
	 *
	 * The default destination is the system browser. When the inline preview is
	 * active the address instead loads into the embedded webview so the user can
	 * keep reading in place.
	 */
	navigate(raw: string): void {
		const url = normalizeBrowserUrl(raw);
		if (!url) {
			new Notice('That does not look like a web address or a search.');
			return;
		}
		this.history.push(url);
		if (this.addressEl) this.addressEl.value = url;
		if (this.previewing) {
			this.loadIntoViewport(url);
		} else {
			void this.openInSystemBrowser(url);
		}
		this.syncControls();
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

	/** Show or hide the embedded preview webview. */
	togglePreview(force?: boolean): void {
		this.previewing = force ?? !this.previewing;
		this.hostEl?.toggleClass('is-previewing', this.previewing);
		if (this.focusEl) {
			this.focusEl.empty();
			setIcon(this.focusEl, this.previewing ? 'eye-off' : 'maximize-2');
			this.focusEl.setAttribute(
				'aria-label',
				this.previewing ? 'Stop inline preview' : 'Preview inline',
			);
			this.focusEl.setAttribute('aria-pressed', String(this.previewing));
		}
		if (this.previewing) {
			this.ensureViewport();
			const url = this.history.current;
			if (url) this.loadIntoViewport(url);
			else this.setStatus('Enter an address to preview it here.');
		} else {
			this.unmountViewport();
			this.setStatus('Enter an address to open it in your browser.');
		}
		this.syncControls();
	}

	/* ─── internals ──────────────────────────────────────── */

	private home(): string {
		return this.options.home?.trim() || DEFAULT_HOME;
	}

	private openFromAddress(): void {
		this.navigate(this.addressEl?.value ?? '');
	}

	/**
	 * Open a URL in the system's default browser via Electron's shell.
	 *
	 * `window.open` in Electron opens another Obsidian window, not the user's
	 * browser, so it is never used for external links. On mobile there is no
	 * Electron shell; we fall back to `window.open`, which the system handles.
	 */
	private async openInSystemBrowser(url: string): Promise<void> {
		this.setStatus(`Opening ${describeUrl(url)} in your browser…`);
		try {
			if (Platform.isDesktopApp) {
				const shell = BrowserPanel.electronShell();
				if (shell) {
					await shell.openExternal(url);
					this.setStatus(`Opened ${describeUrl(url)}.`);
					return;
				}
			}
			// Mobile or no Electron: let the platform handle it.
			window.open(url, '_blank');
			this.setStatus(`Opened ${describeUrl(url)}.`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.setStatus(`Could not open the browser: ${message}`);
			new Notice(`Could not open the browser: ${message}`);
		}
	}

	/** Lazily require Electron's shell module once, then cache it. */
	private static electronShell(): ElectronShell | null {
		if (BrowserPanel.shell !== undefined) return BrowserPanel.shell;
		if (typeof require !== 'function') {
			BrowserPanel.shell = null;
			return BrowserPanel.shell;
		}
		try {
			const electron = require('electron') as { shell?: ElectronShell; remote?: { shell?: ElectronShell } } | undefined;
			const shell = electron?.shell ?? electron?.remote?.shell;
			BrowserPanel.shell = shell && typeof shell.openExternal === 'function' ? shell : null;
		} catch {
			BrowserPanel.shell = null;
		}
		return BrowserPanel.shell;
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

	/** Create the viewport container if it does not yet exist. */
	private ensureViewport(): void {
		if (this.viewportEl || !this.hostEl) return;
		this.viewportEl = this.hostEl.createDiv({ cls: 'cc-browser-panel-viewport' });
	}

	/** Tear down the embedded webview and its container. */
	private unmountViewport(): void {
		if (this.webviewEl) {
			this.webviewEl.stop?.();
			this.webviewEl.src = 'about:blank';
			this.webviewEl = null;
		}
		if (this.frameEl) {
			this.frameEl.src = 'about:blank';
			this.frameEl = null;
		}
		this.noticeEl = null;
		this.viewportEl?.remove();
		this.viewportEl = null;
	}

	/** Build the actual web surface on first use, then load `url` into it. */
	private loadIntoViewport(url: string): void {
		this.ensureViewport();
		const viewport = this.viewportEl;
		if (!viewport) return;
		// Build the webview/iframe the first time we preview.
		if (!this.webviewEl && !this.frameEl) this.mountViewportSurface(viewport);
		if (this.addressEl) this.addressEl.value = url;
		if (this.webviewEl) this.webviewEl.src = url;
		if (this.frameEl) this.frameEl.src = url;
		this.setStatus(`Loading ${describeUrl(url)}…`);
		this.syncControls();
	}

	/**
	 * Build the actual web surface for inline preview.
	 *
	 * Electron's <webview> is a real browser view: it ignores `X-Frame-Options`
	 * and `frame-ancestors`, so sites that refuse framing (GitHub, MDN, Google,
	 * Stack Overflow) load normally. It is the same mechanism Obsidian's own Web
	 * viewer uses. An iframe cannot browse the open web, so it is only a fallback
	 * for environments without <webview>, and it says so plainly.
	 */
	private mountViewportSurface(viewport: HTMLElement): void {
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
			const realmUa = viewport.ownerDocument.defaultView?.navigator.userAgent ?? '';
			webview.setAttribute('useragent', chromeUserAgent(realmUa));
			// Partition isolates cookies and storage from Obsidian's own session.
			webview.setAttribute('partition', 'persist:command-center-browser');
			this.webviewEl = webview;
			webview.addEventListener('did-stop-loading', () => {
				const url = webview.getURL?.() ?? this.history.current;
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
			// Redirect target="_blank" / window.open links into this webview instead
			// of dropping them (allowpopups is false).
			webview.addEventListener('new-window', (event: Event & { url?: string }) => {
				const url = event.url;
				if (url && /^https?:/i.test(url)) {
					event.preventDefault?.();
					this.navigate(url);
				}
			});
			// Keep the address bar synced for in-page navigations (SPAs, anchors).
			webview.addEventListener('did-navigate-in-page', (event: Event & { url?: string }) => {
				const url = event.url;
				if (url && url !== 'about:blank') {
					this.history.push(url);
					if (this.addressEl) this.addressEl.value = url;
					this.setStatus(describeUrl(url));
				}
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
			text: 'Limited mode: this platform has no embedded browser, so sites that refuse framing will not load. Use "Open" instead.',
		});
	}

	/**
	 * Step through history. Only meaningful while previewing inline; when not
	 * previewing, there is no page to step within.
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
		if (url) this.loadIntoViewport(url);
	}

	private reload(): void {
		if (this.webviewEl) {
			this.webviewEl.reload?.();
			return;
		}
		const url = this.history.current;
		if (!url) return;
		this.loadIntoViewport(url);
	}

	private syncControls(): void {
		// Back/forward are only useful when an inline preview is active.
		const interactive = this.previewing;
		const back = this.webviewEl?.canGoBack?.() ?? this.history.canGoBack;
		const forward = this.webviewEl?.canGoForward?.() ?? this.history.canGoForward;
		if (this.backEl) this.backEl.disabled = !interactive || !back;
		if (this.forwardEl) this.forwardEl.disabled = !interactive || !forward;
	}

	private setStatus(text: string): void {
		this.statusEl?.setText(text);
	}
}
