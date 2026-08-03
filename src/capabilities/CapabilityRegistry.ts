/**
 * Capability Registry — the central, unified discovery surface for
 * every instrument (tool, worker profile, MCP endpoint) the agent can
 * invoke inside Command Center.
 *
 * Design principles:
 *   1.  Single source of truth — obsidian-tools, MCP tools, worker
 *       profiles, and future custom tools all register here.
 *   2.  User-configurable — each user-configurable capability can be
 *       enabled/disabled from Settings.
 *   3.  Agent-discoverable — the registry answers filtered queries
 *       (`enabled`, `category`, `executionMode`) so the Socratic
 *       Triage consultant and ReAct orchestrator can enumerate the
 *       instruments available at inference time without knowing
 *       implementation details.
 *   4.  Alias-aware — `@command` aliases (e.g. "@vault", "@composer",
 *       "@memory") map to capabilities so users can invoke tools
 *       explicitly.
 *
 * Grounded theology: "The registry is the armory — every instrument
 * hangs in its named place, visible, accountable, and ready.  The
 * steward does not rummage for tools; they call them by name."
 */

import {
	Capability,
	CapabilityCategory,
	CapabilityMeta,
	CapabilityQuery,
	CapabilityRegistryEvent,
	CapabilityRegistryListener,
	CapabilitySettings,
	CapabilityUserPreference,
} from './CapabilityTypes';
import type { ToolDefinition } from '../types';

/* ─── Registry Implementation ───────────────────────────── */

export class CapabilityRegistry {
	private static instance: CapabilityRegistry | null = null;

	/** id → capability */
	private capabilities = new Map<string, Capability>();
	/** lower-cased alias → capability id */
	private aliases = new Map<string, string>();
	/** category → capability ids (precomputed for fast grouping) */
	private byCategory = new Map<CapabilityCategory, Set<string>>();
	/** listeners for UI updates */
	private listeners = new Set<CapabilityRegistryListener>();

	private constructor() {}

	/* ─── Singleton ─────────────────────────────────────── */

	/** Get the global registry instance. */
	static getInstance(): CapabilityRegistry {
		if (!CapabilityRegistry.instance) {
			CapabilityRegistry.instance = new CapabilityRegistry();
		}
		return CapabilityRegistry.instance;
	}

	/** Reset the singleton (primarily for tests). */
	static resetInstance(): void {
		CapabilityRegistry.instance = null;
	}

	/* ─── Registration ──────────────────────────────────── */

	/**
	 * Register a capability with the registry.
	 * Overwrites any existing capability with the same id.
	 *
	 * @param tool      The underlying ToolDefinition.
	 * @param meta      Rich capability metadata.
	 * @param enabled   Initial enablement state.  Always-enabled
	 *                  capabilities (time, system) pass `true`.
	 */
	register(tool: ToolDefinition, meta: CapabilityMeta, enabled = true): void {
		// Unregister any prior capability with the same id to keep
		// aliases, category indices, and listeners consistent.
		if (this.capabilities.has(meta.id)) {
			this.unregister(meta.id);
		}

		const capability: Capability = { meta, tool, enabled };
		this.capabilities.set(meta.id, capability);

		// Index aliases (lower-cased, @-prefix stripped).
		for (const alias of meta.aliases ?? []) {
			const normalized = alias.replace(/^@/, '').toLowerCase();
			if (normalized) this.aliases.set(normalized, meta.id);
		}

		// Index category.
		const categoryIds = this.byCategory.get(meta.category) ?? new Set<string>();
		categoryIds.add(meta.id);
		this.byCategory.set(meta.category, categoryIds);

		this.emit({ type: 'capability-registered', id: meta.id });
	}

	/**
	 * Register multiple capabilities at once.
	 */
	registerAll(capabilities: Array<{ tool: ToolDefinition; meta: CapabilityMeta; enabled?: boolean }>): void {
		for (const entry of capabilities) {
			this.register(entry.tool, entry.meta, entry.enabled ?? true);
		}
	}

	/**
	 * Unregister a capability by id.
	 * Removes its aliases and category indices.
	 */
	unregister(id: string): void {
		const capability = this.capabilities.get(id);
		if (!capability) return;

		for (const alias of capability.meta.aliases ?? []) {
			const normalized = alias.replace(/^@/, '').toLowerCase();
			this.aliases.delete(normalized);
		}

		const categoryIds = this.byCategory.get(capability.meta.category);
		categoryIds?.delete(id);
		if (categoryIds?.size === 0) {
			this.byCategory.delete(capability.meta.category);
		}

		this.capabilities.delete(id);
		this.emit({ type: 'capability-unregistered', id });
	}

	/* ─── Querying ──────────────────────────────────────── */

	/**
	 * Query the registry with optional filters.
	 * Returns a stable array sorted by category then id.
	 */
	query(query: CapabilityQuery = {}): Capability[] {
		const results: Capability[] = [];

		for (const capability of this.capabilities.values()) {
			if (query.enabledOnly === true && !capability.enabled) continue;
			if (query.categories && !query.categories.includes(capability.meta.category)) continue;
			if (query.executionModes && !query.executionModes.includes(capability.meta.executionMode)) continue;
			if (query.requiresVault !== undefined && capability.meta.requiresVault !== query.requiresVault) continue;
			if (query.ids && !query.ids.includes(capability.meta.id)) continue;
			results.push(capability);
		}

		return results.sort((a, b) =>
			a.meta.category.localeCompare(b.meta.category) ||
			a.meta.id.localeCompare(b.meta.id)
		);
	}

	/**
	 * Get all capabilities that are currently enabled and safe to
	 * serialize into the model's tool schema.  This is the primary
	 * method used by the ReAct orchestrator and the Socratic Triage
	 * consultant when building an inference request.
	 *
	 * @param vaultAvailable  Whether the vault APIs are available.
	 *                        When false, vault-requiring capabilities
	 *                        are excluded.  When true, all enabled
	 *                        capabilities (vault and non-vault) are
	 *                        included.
	 */
	getEnabledCapabilities(vaultAvailable = true): Capability[] {
		return this.query({
			enabledOnly: true,
			requiresVault: vaultAvailable ? undefined : false,
		});
	}

	/**
	 * Get the ToolDefinitions of all enabled capabilities.
	 * This is what gets handed to the model's tool-calling layer.
	 */
	getEnabledToolDefinitions(vaultAvailable = true): ToolDefinition[] {
		return this.getEnabledCapabilities(vaultAvailable).map(cap => cap.tool);
	}

	/**
	 * Get a capability by id.
	 */
	get(id: string): Capability | undefined {
		return this.capabilities.get(id);
	}

	/**
	 * Get a capability by @-command alias (case-insensitive).
	 * E.g. resolveAlias("@vault") → the vault-search capability.
	 */
	resolveAlias(alias: string): Capability | undefined {
		const normalized = alias.toLowerCase().replace(/^@/, '');
		const id = this.aliases.get(normalized);
		return id ? this.capabilities.get(id) : undefined;
	}

	/**
	 * Get all capabilities grouped by category.
	 * Useful for the Settings UI's collapsible sections.
	 */
	getByCategory(): Map<CapabilityCategory, Capability[]> {
		const grouped = new Map<CapabilityCategory, Capability[]>();
		for (const [category, ids] of this.byCategory) {
			const capabilities = [...ids]
				.map(id => this.capabilities.get(id))
				.filter((cap): cap is Capability => cap !== undefined)
				.sort((a, b) => a.meta.id.localeCompare(b.meta.id));
			grouped.set(category, capabilities);
		}
		return grouped;
	}

	/* ─── Enablement ────────────────────────────────────── */

	/**
	 * Set whether a capability is enabled.
	 * Returns true if the state changed.
	 */
	setEnabled(id: string, enabled: boolean): boolean {
		const capability = this.capabilities.get(id);
		if (!capability || capability.enabled === enabled) return false;
		capability.enabled = enabled;
		this.emit({ type: enabled ? 'capability-enabled' : 'capability-disabled', id });
		return true;
	}

	/**
	 * Toggle a capability's enabled state.
	 * Returns the new state.
	 */
	toggle(id: string): boolean | null {
		const capability = this.capabilities.get(id);
		if (!capability) return null;
		const next = !capability.enabled;
		this.setEnabled(id, next);
		return next;
	}

	/* ─── Settings Synchronization ──────────────────────── */

	/**
	 * Apply user preferences from plugin settings.
	 * Only applies to user-configurable capabilities; always-enabled
	 * capabilities (executionMode === 'always') are never disabled.
	 *
	 * @param preferences  The stored per-capability preferences.
	 */
	applyPreferences(preferences: CapabilityUserPreference[]): void {
		const preferenceMap = new Map(preferences.map(p => [p.id, p.enabled]));
		for (const capability of this.capabilities.values()) {
			// Always-enabled capabilities cannot be disabled by the user.
			if (capability.meta.executionMode === 'always') continue;
			const pref = preferenceMap.get(capability.meta.id);
			if (pref !== undefined) {
				capability.enabled = pref;
			}
		}
	}

	/**
	 * Serialize the current user-configurable state into a
	 * CapabilitySettings object suitable for persistence.
	 */
	toSettings(): CapabilitySettings {
		const preferences: CapabilityUserPreference[] = [];
		for (const capability of this.capabilities.values()) {
			if (capability.meta.executionMode === 'always') continue;
			preferences.push({ id: capability.meta.id, enabled: capability.enabled });
		}
		return {
			preferences,
			capabilitySystemEnabled: true,
			maxAutonomousCalls: DEFAULT_MAX_AUTONOMOUS_CALLS,
		};
	}

	/* ─── Lifecycle ─────────────────────────────────────── */

	/**
	 * Clear all capabilities (used on plugin unload or full reset).
	 */
	clear(): void {
		this.capabilities.clear();
		this.aliases.clear();
		this.byCategory.clear();
		this.emit({ type: 'registry-cleared' });
	}

	/* ─── Events ────────────────────────────────────────── */

	/**
	 * Subscribe to registry events.
	 * Returns an unsubscribe function.
	 */
	subscribe(listener: CapabilityRegistryListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(event: CapabilityRegistryEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (error) {
				console.error('[CC] CapabilityRegistry listener error:', error);
			}
		}
	}

	/* ─── Introspection ─────────────────────────────────── */

	/** Total number of registered capabilities. */
	get size(): number {
		return this.capabilities.size;
	}

	/** All registered capability ids. */
	get ids(): string[] {
		return [...this.capabilities.keys()];
	}

	/**
	 * Build a compact human-readable inventory of enabled capabilities
	 * for system-prompt injection and the dashboard Health widget.
	 */
	describeEnabled(): string {
		const enabled = this.getEnabledCapabilities();
		if (enabled.length === 0) return 'No capabilities enabled.';
		const lines = enabled.map(cap => {
			const aliases = cap.meta.aliases?.length ? ` (${cap.meta.aliases.join(', ')})` : '';
			return `- ${cap.meta.id}: ${cap.meta.description}${aliases}`;
		});
		return lines.join('\n');
	}
}

/* ─── Module-Level Default ──────────────────────────────── */

/** Default maximum autonomous tool calls per agent cycle. */
export const DEFAULT_MAX_AUTONOMOUS_CALLS = 8;

/** Convenience accessor. */
export function getCapabilityRegistry(): CapabilityRegistry {
	return CapabilityRegistry.getInstance();
}