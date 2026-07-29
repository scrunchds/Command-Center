/**
 * Command Center Settings — types, defaults, and re-exports.
 *
 * The dynamic settings tab lives in src/settings/PluginSettingsTab.ts.
 * This file provides the settings data model, defaults, and convenience re-export.
 */

import type { MultiProviderSettings } from './providers/provider-types';
import type { EncryptedCredentialPayload } from './security/VaultCrypto';
import { DEFAULT_FALLBACK_CONFIG } from './providers/provider-types';
import { DEFAULT_ROUTING } from './routing';

/* ─── Settings Interface ────────────────────────────────── */

export type DashboardWidgetSize = 'compact' | 'standard' | 'expanded';
export interface DashboardWidgetLayout {
	id: string;
	hidden: boolean;
	collapsed: boolean;
	size: DashboardWidgetSize;
}

export const DEFAULT_DASHBOARD_LAYOUT: DashboardWidgetLayout[] = [
	{ id: 'workspace', hidden: false, collapsed: false, size: 'expanded' },
	{ id: 'approvals', hidden: false, collapsed: false, size: 'expanded' },
	{ id: 'orchestrator', hidden: false, collapsed: false, size: 'expanded' },
	{ id: 'queue', hidden: false, collapsed: false, size: 'standard' },
	{ id: 'react', hidden: false, collapsed: false, size: 'expanded' },
	{ id: 'bases', hidden: false, collapsed: false, size: 'standard' },
	{ id: 'daily', hidden: false, collapsed: false, size: 'standard' },
	{ id: 'system', hidden: false, collapsed: false, size: 'standard' },
	{ id: 'daemon', hidden: false, collapsed: false, size: 'compact' },
	{ id: 'live', hidden: false, collapsed: false, size: 'expanded' },
	{ id: 'history', hidden: false, collapsed: false, size: 'standard' },
];

export interface CommandCenterSettings {
	activeProfile: string;
	maxTokens: number;
	/** Character budget for passive memory + vault context injection. */
	contextCharLimit: number;
	piPath: string;
	enableDaemon: boolean;
	memoryMaxNotes: number;
	/** Skip routine morning approval prompts and show one consolidated result. */
	silentDailyStartup: boolean;
	/** Multi-provider configuration (added in v2.0). */
	multiProvider: MultiProviderSettings;
	/** Command-Center: 1-10 Metacognitive Depth (Quality-Cost) slider.
	 * Integer only. Drives NativeAutoRouter intent resolution against
	 * model_matrix.json. Lower = local/cheap, higher = cloud/premium. */
	metacognitiveDepth: number;
	/** Play restrained nonverbal cues for recording and completed responses. */
	audioCues: boolean;
	/** Automatically read completed AI responses aloud. */
	autoReadAiResponses: boolean;
	/** Per-vault dashboard widget order, visibility, collapse, and width. */
	dashboardLayout: DashboardWidgetLayout[];
	/** AES-GCM ciphertext only; plaintext credentials are memory-only. */
	encryptedCredentialVault?: EncryptedCredentialPayload;
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
	contextCharLimit: 16_000,
	piPath: 'pi',
	enableDaemon: true,
	memoryMaxNotes: 100,
	silentDailyStartup: false,
	multiProvider: DEFAULT_MULTI_PROVIDER,
	metacognitiveDepth: 3,
	audioCues: false,
	autoReadAiResponses: false,
	dashboardLayout: DEFAULT_DASHBOARD_LAYOUT.map(widget => ({ ...widget })),
};

/** Bounds for the Metacognitive Depth slider (Directive 1.6). */
export const METACOGNITIVE_DEPTH_MIN = 1;
export const METACOGNITIVE_DEPTH_MAX = 10;

// Re-export the dynamic settings tab for convenience
export { PluginSettingsTab } from './settings/PluginSettingsTab';