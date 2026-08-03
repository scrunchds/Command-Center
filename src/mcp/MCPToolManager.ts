/**
 * MCP Tool Manager — integrates MCP-discovered tools into the Command Center
 * tool system as ToolDefinitions that can be used by the LLM.
 *
 * The manager:
 *   1. Connects to registered MCP servers
 *   2. Discovers available tools via tools/list
 *   3. Wraps each MCP tool as a ToolDefinition
 *   4. Handles tool call execution via tools/call
 *   5. Integrates with the existing tool pipeline through registerTools()
 */

import type { ToolDefinition } from '../types';
import { MCPClient } from './MCPClient';

export interface MCPServerConfig {
	/** Unique identifier for this MCP server. */
	id: string;
	/** Human-readable label for the MCP server. */
	label: string;
	/** MCP server URL (e.g. http://localhost:8080/mcp). */
	serverUrl: string;
	/** Optional bearer token for authenticated MCP servers. */
	apiKey?: string;
	/** Whether this MCP server is enabled. */
	enabled: boolean;
}

export interface MCPToolManagerOptions {
	/** MCP server configurations. */
	servers: MCPServerConfig[];
	/** Optional abort signal. */
	signal?: AbortSignal;
	/** Timeout for MCP requests in ms. */
	timeoutMs?: number;
}

export class MCPToolManager {
	private readonly servers: MCPServerConfig[];
	private readonly signal?: AbortSignal;
	private readonly timeoutMs: number;
	private clients = new Map<string, MCPClient>();
	private tools = new Map<string, ToolDefinition>();

	constructor(options: MCPToolManagerOptions) {
		this.servers = options.servers.filter(s => s.enabled);
		this.signal = options.signal;
		this.timeoutMs = options.timeoutMs ?? 30_000;
	}

	/**
	 * Discover tools from all enabled MCP servers.
	 * Returns an array of ToolDefinitions that can be registered with
	 * the Command Center tool system.
	 */
	async discoverTools(): Promise<ToolDefinition[]> {
		const allTools: ToolDefinition[] = [];
		this.tools.clear();

		for (const server of this.servers) {
			try {
				const client = new MCPClient({
					serverUrl: server.serverUrl,
					timeoutMs: this.timeoutMs,
					apiKey: server.apiKey,
					signal: this.signal,
				});
				this.clients.set(server.id, client);

				const mcpTools = await client.listTools();
				for (const mcpTool of mcpTools) {
					const toolDef = this.mcpToolToToolDefinition(server.id, server.label, mcpTool);
					allTools.push(toolDef);
					this.tools.set(`${server.id}:${mcpTool.name}`, toolDef);
				}
			} catch (error) {
				console.warn(`[CC] MCP tool discovery failed for ${server.label} (${server.serverUrl}):`, (error as Error).message);
			}
		}

		return allTools;
	}

	/**
	 * Get all discovered tools as ToolDefinitions.
	 */
	getTools(): ToolDefinition[] {
		return [...this.tools.values()];
	}

	/**
	 * Execute an MCP tool call.
	 * Returns the tool result content.
	 */
	async executeTool(serverId: string, toolName: string, params: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }> {
		const client = this.clients.get(serverId);
		if (!client) {
			return {
				content: [{ type: 'text', text: `MCP server "${serverId}" is not connected.` }],
				details: { error: 'server_not_connected' },
			};
		}

		try {
			const result = await client.callTool(toolName, params);
			const text = result.content
				.map(c => c.text ?? c.data ?? JSON.stringify(c))
				.filter(Boolean)
				.join('\n');
			return {
				content: [{ type: 'text', text: text || 'MCP tool returned no content.' }],
				details: { serverId, toolName, params, isError: result.isError },
			};
		} catch (error) {
			return {
				content: [{ type: 'text', text: `MCP tool "${toolName}" failed: ${(error as Error).message}` }],
				details: { serverId, toolName, params, error: (error as Error).message },
			};
		}
	}

	/**
	 * Convert an MCP tool definition to a Command Center ToolDefinition.
	 */
	private mcpToolToToolDefinition(serverId: string, serverLabel: string, mcpTool: import('./MCPClient').MCPToolDefinition): ToolDefinition {
		const properties = (mcpTool.inputSchema?.properties ?? {}) as Record<string, { type: string; description?: string }>;
		const required = mcpTool.inputSchema?.required ?? [];

		const toolProperties: Record<string, { type: string; description?: string }> = {};
		for (const [key, value] of Object.entries(properties)) {
			toolProperties[key] = {
				type: (value as { type?: string }).type ?? 'string',
				description: (value as { description?: string }).description ?? '',
			};
		}

		const toolName = `${serverId}:${mcpTool.name}`;
		return {
			name: toolName,
			label: `${serverLabel}: ${mcpTool.name}`,
			description: mcpTool.description ?? `MCP tool from ${serverLabel}`,
			parameters: {
				type: 'object',
				properties: toolProperties,
				required,
			},
			execute: async (toolCallId: string, params: Record<string, unknown>) => {
				return this.executeTool(serverId, mcpTool.name, params);
			},
		};
	}

	/**
	 * Clean up all MCP client connections.
	 */
	dispose(): void {
		this.clients.clear();
		this.tools.clear();
	}
}