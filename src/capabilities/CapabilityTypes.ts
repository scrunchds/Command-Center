/**
 * Capability Types — the shared vocabulary for the Command Center
 * Capability Registry.
 *
 * A Capability is a named, bounded, user-configurable instrument that
 * an agent (orchestrator, worker, or the Socratic Triage consultant)
 * can invoke.  Capabilities wrap the existing tool surface
 * (obsidian-tools, MCP tools, worker profiles) into a single
 * discoverable namespace.
 *
 * Grounded theology: "A steward does not act without understanding
 * their tools.  Each capability is a named instrument with a known
 * purpose, and the agent must discern which instrument serves each
 * task before it acts."
 */

import type { ToolDefinition } from '../types';

/* ─── Capability Identity ───────────────────────────────── */

/**
 * Capability categories — used for UI grouping and agent filtering.
 */
export type CapabilityCategory =
	| 'search'       // vault search, web search, tag listing
	| 'file'         // read, write, edit, append, list, tree
	| 'media'        // image, audio, YouTube, transcription
	| 'time'         // clock, timezone, date-range
	| 'memory'       // persistent fact/preference storage
	| 'system'       // daemon, indexing, topology, health
	| 'mcp'          // externally discovered MCP tools
	| 'custom'       // user-defined external tool endpoints
	| 'agent';       // worker profiles (researcher, analyst, etc.)

/**
 * Execution mode — how the capability is invoked at runtime.
 * - 'autonomous': the model can decide to call this tool on its own
 * - 'explicit':   the model only calls this when the user explicitly
 *                 requests it (e.g., @command or direct mention)
 * - 'always':     always included in every inference context
 */
export type CapabilityExecutionMode = 'autonomous' | 'explicit' | 'always';

/**
 * Confirmation policy for destructive capabilities.
 */
export type CapabilityConfirmationPolicy =
	| 'never'          // no confirmation needed
	| 'on-threshold'   // confirm only when crossing size/count thresholds
	| 'always';        // always require explicit user approval

/* ─── Capability Metadata ───────────────────────────────── */

/**
 * Complete metadata for a registered capability.
 */
export interface CapabilityMeta {
	/** Unique identifier, e.g. "vault-search", "write-file". */
	id: string;
	/** Human-readable label for Settings UI. */
	label: string;
	/** Short description of what this capability does. */
	description: string;
	/** UI grouping category. */
	category: CapabilityCategory;
	/** How the model is allowed to invoke this capability. */
	executionMode: CapabilityExecutionMode;
	/** Confirmation policy for destructive operations. */
	confirmationPolicy: CapabilityConfirmationPolicy;
	/** Whether this capability requires vault access. */
	requiresVault: boolean;
	/** Whether this capability requires an advanced license feature. */
	isPlusOnly?: boolean;
	/** Whether this capability runs in the background (no UI feedback). */
	isBackground?: boolean;
	/** Optional timeout in milliseconds. 0 = no timeout. */
	timeoutMs?: number;
	/**
	 * Optional @-command aliases, e.g.
	 * ["@vault", "@websearch", "@composer", "@memory"].
	 */
	aliases?: string[];
	/**
	 * Optional custom instructions injected into the system prompt
	 * when this capability is enabled.
	 */
	promptInstructions?: string;
}

/* ─── Capability Wrapper ────────────────────────────────── */

/**
 * A Capability wraps a ToolDefinition with rich metadata,
 * execution policy, and user-configurable enablement.
 */
export interface Capability {
	/** Unique identity + metadata. */
	meta: CapabilityMeta;
	/**
	 * The underlying ToolDefinition that performs the work.
	 * This is what gets serialized into the model's tool-calling
	 * schema.
	 */
	tool: ToolDefinition;
	/**
	 * Whether the user has currently enabled this capability.
	 * Always-enabled capabilities (time tools, system tools) are
	 * always true regardless of user preference.
	 */
	enabled: boolean;
}

/* ─── Registry Query Types ──────────────────────────────── */

/**
 * Filter for querying the capability registry.
 */
export interface CapabilityQuery {
	/** Only return capabilities matching these categories. */
	categories?: CapabilityCategory[];
	/** Only return capabilities matching these execution modes. */
	executionModes?: CapabilityExecutionMode[];
	/** Only return capabilities with vault access requirement. */
	requiresVault?: boolean;
	/** Only return capabilities matching these IDs. */
	ids?: string[];
	/** If true, only return capabilities that are currently enabled. */
	enabledOnly?: boolean;
}

/**
 * Result of a registry query — a flat array of matching capabilities.
 */
export type CapabilityQueryResult = Capability[];

/* ─── Settings Integration ──────────────────────────────── */

/**
 * Per-capability user preference stored in plugin settings.
 * Only capabilities that are user-configurable appear here;
 * always-enabled and always-disabled capabilities are excluded.
 */
export interface CapabilityUserPreference {
	/** Matches CapabilityMeta.id. */
	id: string;
	/** Whether the user has enabled this capability. */
	enabled: boolean;
}

/**
 * The capability section of CommandCenterSettings.
 */
export interface CapabilitySettings {
	/** Per-capability user preferences. */
	preferences: CapabilityUserPreference[];
	/** Master toggle for the capability system. */
	capabilitySystemEnabled: boolean;
	/**
	 * Maximum number of autonomous tool calls per ReAct cycle.
	 */
	maxAutonomousCalls: number;
}

/* ─── Defaults ──────────────────────────────────────────── */

export const DEFAULT_CAPABILITY_SETTINGS: CapabilitySettings = {
	preferences: [],
	capabilitySystemEnabled: true,
	maxAutonomousCalls: 8,
};

/* ─── Event Types ───────────────────────────────────────── */

/**
 * Events emitted by the CapabilityRegistry for UI updates.
 */
export type CapabilityRegistryEvent =
	| { type: 'capability-registered'; id: string }
	| { type: 'capability-unregistered'; id: string }
	| { type: 'capability-enabled'; id: string }
	| { type: 'capability-disabled'; id: string }
	| { type: 'registry-cleared' };

/**
 * Listener for registry events.
 */
export type CapabilityRegistryListener = (event: CapabilityRegistryEvent) => void;