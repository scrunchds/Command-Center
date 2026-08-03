/**
 * Capability Tool Adapter — bridges Command Center's existing tool
 * surface into the unified Capability Registry.
 *
 * This adapter:
 *   1.  Wraps the 6 built-in vault tools (read_note, write_note,
 *       append_note, search_vault, list_files, get_active_note) from
 *       src/obsidian-tools.ts as registered capabilities.
 *   2.  Wraps the web search tool when available.
 *   3.  Registers built-in agent worker profiles as capabilities so
 *       the Socratic Triage consultant can dispatch to them.
 *   4.  Provides a helper to ingest MCP-discovered tools.
 *
 * Nothing here introduces new behavior — it only gives existing
 * instruments names, categories, policies, and discoverability.
 */

import { App } from 'obsidian';
import type { ToolDefinition } from '../types';
import {
	Capability,
	CapabilityMeta,
} from './CapabilityTypes';
import { getCapabilityRegistry } from './CapabilityRegistry';

/* ─── Wrapper Factory ───────────────────────────────────── */

/**
 * Wrap an existing ToolDefinition as a registered capability.
 * Preserves the underlying tool's `confirmation` gate so destructive
 * operations still pause on approval cards.
 */
export function wrapToolAsCapability(
	tool: ToolDefinition,
	meta: Omit<CapabilityMeta, 'id' | 'label'> & { id?: string; label?: string },
	enabled = true,
): Capability {
	const registry = getCapabilityRegistry();
	const fullMeta: CapabilityMeta = {
		id: meta.id ?? tool.name,
		label: meta.label ?? tool.label,
		description: meta.description ?? tool.description,
		category: meta.category,
		executionMode: meta.executionMode,
		confirmationPolicy: meta.confirmationPolicy,
		requiresVault: meta.requiresVault,
		isPlusOnly: meta.isPlusOnly,
		isBackground: meta.isBackground,
		timeoutMs: meta.timeoutMs,
		aliases: meta.aliases,
		promptInstructions: meta.promptInstructions,
	};
	registry.register(tool, fullMeta, enabled);
	return registry.get(fullMeta.id)!;
}

/* ─── Built-in Tool Registration ────────────────────────── */

/**
 * Register all built-in Command Center tools as capabilities.
 *
 * @param app         The Obsidian App instance.
 * @param tools       The tools from createObsidianTools(app).
 * @param webSearch   Optional web search tool (from createWebSearchTool).
 */
export function registerBuiltinCapabilities(
	app: App,
	tools: ToolDefinition[],
	webSearch?: ToolDefinition,
): void {
	const registry = getCapabilityRegistry();
	if (registry.size > 0) return; // idempotent — avoid double registration

	const toolMap = new Map<string, ToolDefinition>(tools.map(t => [t.name, t]));

	// ── Vault tools (from obsidian-tools.ts) ──────────────
	const readTool = toolMap.get('read_note');
	if (readTool) {
		wrapToolAsCapability(readTool, {
			id: 'vault-read-note',
			label: 'Read Note',
			description: readTool.description,
			category: 'file',
			executionMode: 'autonomous',
			confirmationPolicy: 'never',
			requiresVault: true,
			timeoutMs: 60_000,
		});
	}

	const writeTool = toolMap.get('write_note');
	if (writeTool) {
		wrapToolAsCapability(writeTool, {
			id: 'vault-write-note',
			label: 'Write Note',
			description: writeTool.description,
			category: 'file',
			executionMode: 'autonomous',
			confirmationPolicy: 'on-threshold', // bulk/destructive gates inside the tool
			requiresVault: true,
			aliases: ['@composer'],
			timeoutMs: 0, // waits for approval cards when gated
		});
	}

	const appendTool = toolMap.get('append_note');
	if (appendTool) {
		wrapToolAsCapability(appendTool, {
			id: 'vault-append-note',
			label: 'Append Note',
			description: appendTool.description,
			category: 'file',
			executionMode: 'autonomous',
			confirmationPolicy: 'on-threshold',
			requiresVault: true,
			timeoutMs: 0,
		});
	}

	const searchTool = toolMap.get('search_vault');
	if (searchTool) {
		wrapToolAsCapability(searchTool, {
			id: 'vault-search',
			label: 'Vault Search',
			description: searchTool.description,
			category: 'search',
			executionMode: 'autonomous',
			confirmationPolicy: 'never',
			requiresVault: true,
			aliases: ['@vault'],
			timeoutMs: 30_000,
		});
	}

	const listTool = toolMap.get('list_files');
	if (listTool) {
		wrapToolAsCapability(listTool, {
			id: 'vault-list-files',
			label: 'List Files',
			description: listTool.description,
			category: 'file',
			executionMode: 'autonomous',
			confirmationPolicy: 'never',
			requiresVault: true,
			timeoutMs: 30_000,
		});
	}

	const activeTool = toolMap.get('get_active_note');
	if (activeTool) {
		wrapToolAsCapability(activeTool, {
			id: 'vault-active-note',
			label: 'Get Active Note',
			description: activeTool.description,
			category: 'file',
			executionMode: 'always',
			confirmationPolicy: 'never',
			requiresVault: true,
			isBackground: true,
			timeoutMs: 10_000,
		});
	}

	// ── Web search (OpenRouter/xAI server-side tool) ──────
	if (webSearch) {
		wrapToolAsCapability(webSearch, {
			id: 'web-search',
			label: 'Web Search',
			description: webSearch.description,
			category: 'search',
			executionMode: 'explicit', // only when user requests web content
			confirmationPolicy: 'never',
			requiresVault: false,
			aliases: ['@websearch', '@web'],
			timeoutMs: 30_000,
		});
	}

	void app;
}

/* ─── MCP Tool Ingestion ────────────────────────────────── */

/**
 * Ingest MCP-discovered tools into the registry.
 * MCP tools are registered under a namespaced id to avoid collisions
 * with built-in capabilities.
 *
 * @param serverId  The MCP server id (e.g. "lmstudio-mcp").
 * @param serverLabel  Human-readable server label.
 * @param tools     The ToolDefinitions produced by MCPToolManager.
 */
export function ingestMcpCapabilities(
	serverId: string,
	serverLabel: string,
	tools: ToolDefinition[],
): void {
	const registry = getCapabilityRegistry();
	for (const tool of tools) {
		const namespacedId = `mcp:${serverId}:${tool.name}`;
		wrapToolAsCapability(tool, {
			id: namespacedId,
			label: `${serverLabel} — ${tool.label}`,
			description: tool.description,
			category: 'mcp',
			executionMode: 'autonomous',
			confirmationPolicy: tool.confirmation ? 'on-threshold' : 'never',
			requiresVault: false,
			timeoutMs: 60_000,
		});
	}
}

/* ─── Agent Worker Profiles as Capabilities ─────────────── */

/**
 * Register the ReAct worker profiles as capabilities so the Socratic
 * Triage consultant can dispatch work to a named profile without
 * reaching into the ReAct internals.
 *
 * @param profiles  The worker profiles from src/react/react-roles.
 */
export function registerWorkerProfileCapabilities(
	profiles: Array<{ name: string; label: string; description: string }>,
): void {
	const registry = getCapabilityRegistry();
	for (const profile of profiles) {
		const id = `agent:${profile.name}`;
		if (registry.get(id)) continue;
		wrapToolAsCapability(
			{
				name: id,
				label: profile.label,
				description: profile.description,
				parameters: { type: 'object', properties: {
					prompt: { type: 'string', description: 'The task prompt for this worker profile.' },
				}, required: ['prompt'] },
				execute: async () => ({
					content: [{ type: 'text', text: `Worker profile ${profile.name} is available. Dispatch a task to this profile through the ReAct orchestrator.` }],
					details: { profile: profile.name },
				}),
			},
			{
				id,
				label: profile.label,
				description: profile.description,
				category: 'agent',
				executionMode: 'autonomous',
				confirmationPolicy: 'never',
				requiresVault: false,
				isBackground: true,
			},
			true,
		);
	}
}

/* ─── Settings Sync Helpers ─────────────────────────────── */

/**
 * Apply stored capability preferences from plugin settings.
 */
export function applyCapabilityPreferences(
	preferences: Array<{ id: string; enabled: boolean }>,
): void {
	getCapabilityRegistry().applyPreferences(preferences);
}

/**
 * Serialize current registry state into storable preferences.
 */
export function serializeCapabilityPreferences(): Array<{ id: string; enabled: boolean }> {
	return getCapabilityRegistry().toSettings().preferences;
}