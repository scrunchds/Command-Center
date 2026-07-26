import type { RequestUrlParam, RequestUrlResponse } from 'obsidian';

type ObsidianRuntime = {
	requestUrl: (options: RequestUrlParam | string) => Promise<RequestUrlResponse>;
};

/**
 * Resolve Obsidian's network API lazily so provider modules remain importable in
 * the dependency-free Node test harness. Production calls always delegate to
 * the host-provided requestUrl implementation.
 */
export function requestUrl(options: RequestUrlParam | string): Promise<RequestUrlResponse> {
	const runtimeRequire: unknown = Reflect.get(globalThis, 'require');
	if (typeof runtimeRequire !== 'function') {
		throw new Error('Obsidian requestUrl is unavailable outside the Obsidian host.');
	}
	const requireModule = runtimeRequire as (id: string) => unknown;
	const runtime: unknown = requireModule('obsidian');
	if (!runtime || typeof runtime !== 'object' || !('requestUrl' in runtime) ||
		typeof runtime.requestUrl !== 'function') {
		throw new Error('The Obsidian host does not expose requestUrl.');
	}
	return (runtime as ObsidianRuntime).requestUrl(options);
}

export type { RequestUrlParam, RequestUrlResponse } from 'obsidian';
