import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';

declare const require: ((id: string) => unknown) | undefined;

type ObsidianRuntime = {
	requestUrl: (options: RequestUrlParam | string) => Promise<RequestUrlResponse>;
};

/**
 * Resolve Obsidian's host API through the plugin module's scoped `require`.
 * This keeps provider modules importable in the Node test harness while avoiding
 * Electron renderer `globalThis.require`, which cannot resolve Obsidian modules.
 */
export function requestUrl(options: RequestUrlParam | string): Promise<RequestUrlResponse> {
	if (typeof require !== 'function') {
		throw new Error('Obsidian requestUrl is unavailable outside the Obsidian host.');
	}
	const runtime = require('obsidian');
	if (!runtime || typeof runtime !== 'object' || !('requestUrl' in runtime) ||
		typeof runtime.requestUrl !== 'function') {
		throw new Error('The Obsidian host does not expose requestUrl.');
	}
	return (runtime as ObsidianRuntime).requestUrl(options);
}

export type { RequestUrlParam, RequestUrlResponse } from 'obsidian';
