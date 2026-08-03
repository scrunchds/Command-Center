/**
 * MCP Client — connects to Model Context Protocol servers over HTTP/SSE.
 *
 * MCP (Model Context Protocol) is an open protocol that enables LLMs to
 * discover and use external tools and data sources. This client implements
 * the JSON-RPC 2.0 transport for communicating with MCP servers.
 *
 * Key methods:
 *   - listTools()    → discovers available tools from the MCP server
 *   - callTool()     → invokes a tool and returns the result
 *   - listResources()→ discovers available resources
 *   - readResource() → reads a specific resource
 *
 * @see https://modelcontextprotocol.io/
 */

import { requestUrl } from '../obsidian-request';

/* ─── JSON-RPC types ──────────────────────────────────── */

interface JsonRpcRequest {
	jsonrpc: '2.0';
	id: string | number;
	method: string;
	params?: Record<string, unknown>;
}

interface JsonRpcResponse {
	jsonrpc: '2.0';
	id: string | number;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

/* ─── MCP types ───────────────────────────────────────── */

export interface MCPToolDefinition {
	name: string;
	description?: string;
	inputSchema?: {
		type: 'object';
		properties?: Record<string, unknown>;
		required?: string[];
	};
}

export interface MCPResourceDefinition {
	uri: string;
	name: string;
	description?: string;
	mimeType?: string;
}

export interface MCPToolResult {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	isError?: boolean;
}

export interface MCPResourceContent {
	uri: string;
	mimeType?: string;
	text?: string;
	blob?: string;
}

export interface MCPClientOptions {
	/** MCP server URL (e.g. http://localhost:8080/mcp or http://localhost:1234/api/v1/mcp) */
	serverUrl: string;
	/** Optional timeout for MCP requests. Default: 30s */
	timeoutMs?: number;
	/** Optional bearer token for authenticated MCP servers. */
	apiKey?: string;
	/** Optional abort signal for cancellation. */
	signal?: AbortSignal;
}

/* ─── Client ───────────────────────────────────────────── */

export class MCPClient {
	private readonly serverUrl: string;
	private readonly timeoutMs: number;
	private readonly apiKey: string;
	private readonly signal?: AbortSignal;
	private requestId = 0;

	constructor(options: MCPClientOptions) {
		this.serverUrl = options.serverUrl.replace(/\/+$/, '');
		this.timeoutMs = options.timeoutMs ?? 30_000;
		this.apiKey = options.apiKey ?? '';
		this.signal = options.signal;
	}

	/**
	 * List available tools from the MCP server.
	 * Returns an array of tool definitions that can be integrated into
	 * the Command Center tool system.
	 */
	async listTools(): Promise<MCPToolDefinition[]> {
		const result = await this.request('tools/list');
		if (!result || typeof result !== 'object') return [];
		const tools = (result as Record<string, unknown>).tools as MCPToolDefinition[] | undefined;
		return Array.isArray(tools) ? tools : [];
	}

	/**
	 * Call a tool on the MCP server with the given arguments.
	 * Returns the tool execution result.
	 */
	async callTool(name: string, arguments_: Record<string, unknown>): Promise<MCPToolResult> {
		const result = await this.request('tools/call', { name, arguments: arguments_ });
		if (!result || typeof result !== 'object') {
			return { content: [{ type: 'text', text: 'MCP tool returned no result.' }], isError: true };
		}
		const content = (result as Record<string, unknown>).content as Array<{ type: string; text?: string; data?: string; mimeType?: string }> | undefined;
		return {
			content: Array.isArray(content) ? content : [{ type: 'text', text: JSON.stringify(result) }],
			isError: (result as Record<string, unknown>).isError as boolean | undefined,
		};
	}

	/**
	 * List available resources from the MCP server.
	 */
	async listResources(): Promise<MCPResourceDefinition[]> {
		const result = await this.request('resources/list');
		if (!result || typeof result !== 'object') return [];
		const resources = (result as Record<string, unknown>).resources as MCPResourceDefinition[] | undefined;
		return Array.isArray(resources) ? resources : [];
	}

	/**
	 * Read a specific resource by URI.
	 */
	async readResource(uri: string): Promise<MCPResourceContent[]> {
		const result = await this.request('resources/read', { uri });
		if (!result || typeof result !== 'object') return [];
		const contents = (result as Record<string, unknown>).contents as MCPResourceContent[] | undefined;
		return Array.isArray(contents) ? contents : [];
	}

	/**
	 * Send a JSON-RPC request to the MCP server.
	 */
	private async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
		const id = ++this.requestId;
		const body: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

		try {
			const headers: Record<string, string> = { 'Content-Type': 'application/json' };
			if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

			const response = await requestUrl({
				url: this.serverUrl,
				method: 'POST',
				headers,
				body: JSON.stringify(body),
			});

			const data = response.json as JsonRpcResponse;
			if (data.error) {
				throw new Error(`MCP error: ${data.error.message} (code ${data.error.code})`);
			}
			return data.result;
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				throw new Error(`MCP request timed out: ${method}`);
			}
			throw error;
		}
	}
}