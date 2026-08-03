/**
 * Capabilities — barrel export for the unified tool-calling surface.
 *
 * Import from this module when you need:
 *   - The CapabilityRegistry (singleton, discoverable capability store)
 *   - Capability types (meta, query, settings, events)
 *   - The adapter that wraps existing tools into capabilities
 *   - The Settings UI integration
 *
 * Usage:
 *   import { getCapabilityRegistry, registerBuiltinCapabilities } from '../capabilities';
 */

export { CapabilityRegistry, getCapabilityRegistry, DEFAULT_MAX_AUTONOMOUS_CALLS } from './CapabilityRegistry';

export type {
	Capability,
	CapabilityCategory,
	CapabilityConfirmationPolicy,
	CapabilityExecutionMode,
	CapabilityMeta,
	CapabilityQuery,
	CapabilityQueryResult,
	CapabilityRegistryEvent,
	CapabilityRegistryListener,
	CapabilitySettings,
	CapabilityUserPreference,
} from './CapabilityTypes';

export {
	DEFAULT_CAPABILITY_SETTINGS,
} from './CapabilityTypes';

export {
	registerBuiltinCapabilities,
	ingestMcpCapabilities,
	registerWorkerProfileCapabilities,
	wrapToolAsCapability,
	applyCapabilityPreferences,
	serializeCapabilityPreferences,
} from './CapabilityToolAdapter';

export { renderCapabilitySettings } from './CapabilitySettingsUI';