import { requestUrl } from 'obsidian';
import type { ToolDefinition } from '../types';

export interface ApiConnectorEndpoint {
	id: string;
	label: string;
	method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	path: string;
	description: string;
	parameters?: Record<string, { type: string; description?: string; required?: boolean }>;
	body?: Record<string, unknown>;
}

/** A user-approved, declarative REST connector. Secrets are referenced, never stored here. */
export interface ApiConnectorConfig {
	id: string;
	label: string;
	baseUrl: string;
	enabled: boolean;
	auth?: { type: 'bearer' | 'api-key'; credentialRef: string; header?: string };
	endpoints: ApiConnectorEndpoint[];
}

export interface ApiConnectorManagerOptions {
	connectors: ApiConnectorConfig[];
	getSecret: (ref: string) => string;
}

/**
 * Turns approved declarative API descriptions into live tools. This deliberately
 * does not execute downloaded code: only the configured HTTP method/path/schema
 * is executable, and credentials come from Obsidian Secret Storage.
 */
/** Stringify a parameter without ever producing "[object Object]". */
function scalar(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'object') return JSON.stringify(value);
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
	return '';
}

export class ApiConnectorManager {
	private readonly connectors: ApiConnectorConfig[];
	private readonly getSecret: (ref: string) => string;
	private tools = new Map<string, ToolDefinition>();

	constructor(options: ApiConnectorManagerOptions) {
		this.connectors = options.connectors.filter(c => c.enabled);
		this.getSecret = options.getSecret;
	}

	discoverTools(): ToolDefinition[] {
		this.tools.clear();
		for (const connector of this.connectors) {
			if (!isSafeBaseUrl(connector.baseUrl)) continue;
			for (const endpoint of connector.endpoints) {
				if (!isSafePath(endpoint.path)) continue;
				const tool = this.createTool(connector, endpoint);
				this.tools.set(tool.name, tool);
			}
		}
		return [...this.tools.values()];
	}

	getTools(): ToolDefinition[] { return [...this.tools.values()]; }
	dispose(): void { this.tools.clear(); }

	private createTool(connector: ApiConnectorConfig, endpoint: ApiConnectorEndpoint): ToolDefinition {
		const name = `api:${connector.id}:${endpoint.id}`;
		return {
			name,
			label: `${connector.label}: ${endpoint.label}`,
			description: endpoint.description,
			parameters: { type: 'object', properties: endpoint.parameters ?? {}, required: Object.entries(endpoint.parameters ?? {}).filter(([, v]) => v.required).map(([key]) => key) },
			confirmation: endpoint.method === 'GET' ? undefined : async () => ({ toolName: name, targetPaths: [connector.baseUrl + endpoint.path], proposedChanges: `${connector.label} will receive a ${endpoint.method} request at ${endpoint.path}.`, timeoutMs: 60_000 }),
			execute: async (_toolCallId, params) => this.call(connector, endpoint, params),
		};
	}

	private async call(connector: ApiConnectorConfig, endpoint: ApiConnectorEndpoint, params: Record<string, unknown>) {
		const query = endpoint.method === 'GET' || endpoint.method === 'DELETE' ? params : undefined;
		const path = endpoint.path.replace(/\{([^}]+)\}/g, (_, key: string) => encodeURIComponent(scalar(params[key])));
		const url = new URL(path, connector.baseUrl.endsWith('/') ? connector.baseUrl : `${connector.baseUrl}/`);
		if (query) for (const [key, value] of Object.entries(query)) if (!path.includes(`{${key}}`) && value !== undefined) url.searchParams.set(key, scalar(value));
		const headers: Record<string, string> = { Accept: 'application/json' };
		if (endpoint.method !== 'GET' && endpoint.method !== 'DELETE') headers['Content-Type'] = 'application/json';
		const secret = connector.auth?.credentialRef ? this.getSecret(connector.auth.credentialRef) : '';
		if (secret && connector.auth?.type === 'bearer') headers.Authorization = `Bearer ${secret}`;
		if (secret && connector.auth?.type === 'api-key') headers[connector.auth.header || 'X-API-Key'] = secret;
		// requestUrl is Obsidian's network primitive: it bypasses CORS and is the
		// sanctioned transport for plugin HTTP calls.
		const response = await requestUrl({
			url: url.toString(),
			method: endpoint.method,
			headers,
			body: query ? undefined : JSON.stringify({ ...(endpoint.body ?? {}), ...params }),
			throw: false,
		});
		const text = response.text;
		if (response.status < 200 || response.status >= 300) throw new Error(`${connector.label} request failed (HTTP ${response.status}): ${text.slice(0, 300)}`);
		return { content: [{ type: 'text' as const, text: text || 'Request completed successfully.' }], details: { connectorId: connector.id, endpoint: endpoint.id, status: response.status } };
	}
}

function isSafeBaseUrl(value: string): boolean {
	try { const url = new URL(value); return url.protocol === 'https:' || ['localhost', '127.0.0.1', '::1'].includes(url.hostname); } catch { return false; }
}
function isSafePath(value: string): boolean { return value.startsWith('/') && !value.includes('..') && !/[\r\n]/.test(value); }
