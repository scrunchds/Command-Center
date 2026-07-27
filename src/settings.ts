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
	/** Command-Center: 1-10 Metacognitive Depth (Quality-Cost) slider.
	 * Integer only. Drives NativeAutoRouter intent resolution against
	 * model_matrix.json. Lower = local/cheap, higher = cloud/premium. */
	metacognitiveDepth: number;
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
	piPath: 'pi',
	enableDaemon: true,
	memoryMaxNotes: 100,
	silentDailyStartup: false,
	multiProvider: DEFAULT_MULTI_PROVIDER,
	metacognitiveDepth: 3,
};

/** Bounds for the Metacognitive Depth slider (Directive 1.6). */
export const METACOGNITIVE_DEPTH_MIN = 1;
export const METACOGNITIVE_DEPTH_MAX = 10;

// Re-export the dynamic settings tab for convenience
export { PluginSettingsTab } from './settings/PluginSettingsTab';