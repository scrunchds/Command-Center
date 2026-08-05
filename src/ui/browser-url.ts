/**
 * browser-url — pure URL handling for the browser surfaces, free of Obsidian imports.
 *
 * Shared by the embedded dashboard widget and the full-pane browser view so both
 * treat addresses, history, and search fallbacks identically.
 */

/** Schemes we are willing to load. Anything else is a potential escape hatch. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Normalize typed input into a loadable URL.
 *
 * Bare hosts gain `https://`, and anything that is not a plausible host is
 * treated as a search query rather than silently failing. Non-web schemes such
 * as `file:`, `javascript:`, and `data:` are rejected outright: they would read
 * local disk or execute script inside the plugin's origin.
 *
 * @param input       Raw text from the address box.
 * @param searchUrl   Search endpoint used for non-URL input; `%s` is replaced.
 * @returns A loadable absolute URL, or an empty string when nothing is usable.
 */
export function normalizeBrowserUrl(input: string, searchUrl = 'https://duckduckgo.com/?q=%s'): string {
	const trimmed = input.trim();
	if (!trimmed) return '';

	const asUrl = (candidate: string): string => {
		try {
			const url = new URL(candidate);
			return ALLOWED_PROTOCOLS.has(url.protocol) ? url.toString() : '';
		} catch {
			return '';
		}
	};

	// `host:port` is not a scheme, even though it matches the scheme grammar.
	// Checked first so `localhost:3000` is a host rather than a `localhost:` URL.
	const hostPort = /^[a-z0-9.-]+:\d{1,5}(?:[/?#]|$)/i.test(trimmed);

	// Explicit scheme: honour it, but only if it is a web scheme.
	if (!hostPort && /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return asUrl(trimmed);

	// A single token containing a dot (or localhost) is a host, not a search.
	const looksLikeHost = !/\s/.test(trimmed)
		&& (hostPort || /^localhost(?:[/?#]|$)/i.test(trimmed) || /^[^\s/]+\.[^\s/]{2,}/.test(trimmed));
	if (looksLikeHost) {
		const resolved = asUrl(`https://${trimmed}`);
		if (resolved) return resolved;
	}
	return asUrl(searchUrl.replace('%s', encodeURIComponent(trimmed)));
}

/** A back/forward stack with the same semantics as a browser's. */
export class BrowserHistory {
	private entries: string[] = [];
	private index = -1;

	/** Current address, or an empty string before the first visit. */
	get current(): string {
		return this.entries[this.index] ?? '';
	}

	get canGoBack(): boolean {
		return this.index > 0;
	}

	get canGoForward(): boolean {
		return this.index < this.entries.length - 1;
	}

	/**
	 * Record a visit. Forward entries are discarded, matching browser behaviour,
	 * and re-visiting the current address is collapsed rather than duplicated.
	 */
	push(url: string): void {
		if (!url || url === this.current) return;
		this.entries = this.entries.slice(0, this.index + 1);
		this.entries.push(url);
		this.index = this.entries.length - 1;
	}

	/** Replace the whole stack, used when resetting to a home page. */
	reset(url: string): void {
		this.entries = url ? [url] : [];
		this.index = this.entries.length - 1;
	}

	/** Step back one entry, returning the new address if it moved. */
	back(): string {
		if (!this.canGoBack) return '';
		this.index -= 1;
		return this.current;
	}

	/** Step forward one entry, returning the new address if it moved. */
	forward(): string {
		if (!this.canGoForward) return '';
		this.index += 1;
		return this.current;
	}
}

/**
 * Shorten a URL for a compact status line.
 *
 * The host is what matters when the widget is narrow, so keep it and trim the
 * path rather than truncating the middle of the address.
 */
export function describeUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const path = parsed.pathname === '/' ? '' : parsed.pathname;
		const short = path.length > 24 ? `${path.slice(0, 24)}…` : path;
		return `${parsed.host}${short}`;
	} catch {
		return url;
	}
}

/**
 * Build a plain Chrome user agent from the runtime's own UA.
 *
 * Derived from the runtime UA rather than hardcoded, so the Chrome version stays
 * truthful as Obsidian updates Electron; only the identifying Electron and
 * Obsidian tokens are removed.
 */
export function chromeUserAgent(ua: string): string {
	const stripped = ua
		.replace(/\s*Electron\/[^\s]+/gi, '')
		.replace(/\s*obsidian\/[^\s]+/gi, '')
		.replace(/\s{2,}/g, ' ')
		.trim();
	// Fall back to a known-good UA if the runtime string was unexpectedly empty.
	return stripped || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
}
