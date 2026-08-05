/**
 * native-webviewer — talk to Obsidian's own Web viewer instead of reimplementing it.
 *
 * Principle 5 (Native Obsidian Harmony): when the core Web viewer is enabled it
 * already provides browsing, history, favicons, ad blocking, a configurable
 * search engine, and the user's chosen "open external links" behaviour. Reusing
 * it means the browser respects the settings the user has already chosen in
 * Obsidian rather than a parallel set of our own.
 *
 * The internal-plugin registry is not in the public `obsidian` typings, so the
 * shape is declared narrowly here and every access is guarded. If Obsidian
 * changes or removes it, `isAvailable()` simply reports false and the caller
 * falls back to its own `<webview>` — the feature degrades instead of throwing.
 */

import type { App, WorkspaceLeaf } from 'obsidian';

/** View type the core Web viewer registers, confirmed against Obsidian's bundle. */
export const WEBVIEWER_VIEW_TYPE = 'webviewer';

/** Minimal shape of the internal-plugin registry we depend on. */
interface InternalPluginRegistry {
	getEnabledPluginById?: (id: string) => unknown;
}

interface AppWithInternalPlugins extends App {
	internalPlugins?: InternalPluginRegistry;
}

/**
 * Whether the core Web viewer is installed *and* enabled.
 *
 * `getEnabledPluginById` returns null when the plugin exists but is switched
 * off, which is the common case: the Web viewer ships disabled by default.
 */
export function isNativeWebViewerEnabled(app: App): boolean {
	const registry = (app as AppWithInternalPlugins).internalPlugins;
	if (!registry?.getEnabledPluginById) return false;
	try {
		return registry.getEnabledPluginById(WEBVIEWER_VIEW_TYPE) != null;
	} catch {
		// A registry shape change must not take the dashboard down with it.
		return false;
	}
}

/**
 * The view state the core Web viewer expects.
 *
 * Taken from Obsidian's own `recordHistory` call, which builds
 * `{ type: 'webviewer', state: { url } }`.
 */
export function webViewerState(url: string): { type: string; state: { url: string }; active: boolean } {
	return { type: WEBVIEWER_VIEW_TYPE, state: { url }, active: true };
}

/**
 * Point an existing leaf at a URL using the native viewer.
 *
 * Returns false when the viewer is unavailable, so the caller can fall back
 * rather than leaving the user with an empty pane.
 */
export async function openInNativeWebViewer(app: App, leaf: WorkspaceLeaf, url: string): Promise<boolean> {
	if (!isNativeWebViewerEnabled(app)) return false;
	try {
		await leaf.setViewState(webViewerState(url));
		return true;
	} catch {
		return false;
	}
}
