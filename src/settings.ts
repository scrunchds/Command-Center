/**
 * Command Center Settings — types, defaults, and re-exports.
 *
 * The dynamic settings tab lives in src/settings/PluginSettingsTab.ts.
 * This file provides the settings data model, defaults, and convenience re-export.
 */

import type { MultiProviderSettings } from './providers/provider-types';
import { DEFAULT_FALLBACK_CONFIG } from './providers/provider-types';
import { DEFAULT_ROUTING } from './routing';

/* ─── Settings Interface ────────────────────────────────── */

export interface CommandCenterSettings {
	activeProfile: string;
	maxTokens: number;
	piPath: string;
	enableDaemon: boolean;
	memoryMaxNotes: number;
	/** Skip routine morning approval prompts and show one consolidated result. */
	silentDailyStartup: boolean;
	/** Multi-provider configuration (added in v2.0). */
	multiProvider: MultiProviderSettings;
}

export const DEFAULT_MULTI_PROVIDER: MultiProviderSettings = {
	credentials: {},
	routing: DEFAULT_ROUTING,
	fallback: DEFAULT_FALLBACK_CONFIG,
	defaults: {},
};

export const DEFAULT_SETTINGS: CommandCenterSettings = {
	activeProfile: 'default-orchestrator',
	maxTokens: 4096,
	piPath: 'pi',
	enableDaemon: true,
	memoryMaxNotes: 100,
	silentDailyStartup: false,
	multiProvider: DEFAULT_MULTI_PROVIDER,
};

// Re-export the dynamic settings tab for convenience
export { PluginSettingsTab } from './settings/PluginSettingsTab';