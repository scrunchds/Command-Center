/**
 * Command Center Settings — types, defaults, and re-exports.
 *
 * The dynamic settings tab lives in src/settings/PluginSettingsTab.ts.
 * This file provides the settings data model, defaults, and convenience re-export.
 */

import type { MultiProviderSettings, ProviderId } from '../providers/provider-types';
import type { CapabilityUserPreference } from '../capabilities/CapabilityTypes';
import { DEFAULT_FALLBACK_CONFIG } from '../providers/provider-types';
import { DEFAULT_ROUTING } from '../routing/routing-table';

/* ─── Settings Interface ────────────────────────────────── */

export type DashboardWidgetSize = 'compact' | 'standard' | 'expanded';

/**
 * UI complexity mode — progressively discloses settings and features.
 * - simple:  minimal configuration, auto-detection, basic toggles only
 * - normal:  full feature toggles, provider routing, standard settings
 * - advanced: debug options, MCP, custom endpoints, performance tuning
 */
export type UiMode = 'simple' | 'normal' | 'advanced';
export interface DashboardWidgetLayout {
	id: string;
	hidden: boolean;
	collapsed: boolean;
	size: DashboardWidgetSize;
}

export const DEFAULT_DASHBOARD_LAYOUT: DashboardWidgetLayout[] = [
	{ id: 'workspace', hidden: false, collapsed: false, size: 'expanded' },
	{ id: 'deck', hidden: false, collapsed: false, size: 'compact' },
	{ id: 'navigator', hidden: false, collapsed: false, size: 'standard' },
	{ id: 'intelligence', hidden: false, collapsed: false, size: 'expanded' },
	{ id: 'calendar', hidden: false, collapsed: false, size: 'standard' },
	// Browser starts hidden: it is opt-in reading space, not everyday signal.
	{ id: 'browser', hidden: true, collapsed: false, size: 'expanded' },
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
	/** Master toggle for spoken output and Read aloud controls. */
	textToSpeechEnabled: boolean;
	/** Selected browser/system TTS voice name; empty string uses the default voice. */
	textToSpeechVoice: string;
	/**
	 * TTS source: 'browser' uses the built-in speechSynthesis (default, preserves
	 * prior behavior); 'auto' or a ProviderId routes spoken output through a
	 * provider's /audio/speech (or xAI /v1/tts) endpoint for higher-quality voices.
	 */
	textToSpeechProviderId: 'browser' | 'auto' | ProviderId;
	/** Global TTS model slug fallback (per-provider overrides preferred). */
	textToSpeechModel: string;
	/** Per-provider TTS model overrides (STT/TTS slugs are not portable across providers). */
	textToSpeechModels: Partial<Record<ProviderId, string>>;
	/** Voice id for provider TTS (e.g. 'alloy', 'nova'); ignored for browser TTS. */
	textToSpeechApiVoice: string;
	/** Speaking rate for TTS output. */
	textToSpeechRate: number;
	/** Master toggle for speech-to-text capture and transcription fallback. */
	speechToTextEnabled: boolean;
	/** Preferred audio input device ID (from enumerateDevices); empty uses the system default. */
	audioInputDeviceId: string;
	/** Preferred provider for speech-to-text; "auto" preserves fallback ordering. */
	speechToTextProviderId: 'auto' | ProviderId;
	/** Preferred transcription model; empty string lets the provider choose automatically. */
	speechToTextModel: string;
	/**
	 * Per-provider transcription model overrides. Each key is a ProviderId; the
	 * value is the model slug that provider's STT endpoint accepts. Empty/missing
	 * entries fall back to `speechToTextModel`, then the provider's built-in default.
	 *
	 * STT model IDs are NOT portable across providers (e.g. `openai/gpt-4o-mini-transcribe`
	 * is an OpenRouter routing slug, `grok-stt` is xAI, `whisper-1` is OpenAI), so a
	 * single global model can't be broadcast to every provider in the fallback chain.
	 */
	speechToTextModels: Partial<Record<ProviderId, string>>;
	/** Where voice transcription output goes by default. */
	voiceOutputTarget: 'chat' | 'note' | 'canvas' | 'note+audio' | 'canvas+audio' | 'all';
	/** Chunk duration (ms) for live transcription; smaller = faster interim results, larger = cheaper. */
	liveTranscriptionChunkMs: number;
	/** Automatically read completed AI responses aloud. */
	autoReadAiResponses: boolean;
	/** Enable web search tool for models that support it (OpenRouter, xAI, etc.). */
	webSearchEnabled: boolean;
	/** Enable vault-grounded RAG (hybrid retrieval). Disable for strict privacy. */
	ragEnabled: boolean;
	/** Enable persistent agent memory across sessions. */
	memoryEnabled: boolean;
	/** Enable the ReAct multi-agent engine for complex tasks. */
	reactAgentEnabled: boolean;
	/** Enable native Markdown/Canvas workflow execution. */
	workflowsEnabled: boolean;
	/** Enable daily operations engine (morning check-in, evening review). */
	dailyOperationsEnabled: boolean;
	/** Enable MCP (Model Context Protocol) tool discovery. */
	mcpEnabled: boolean;
	/** Enable chat history persistence across sessions. */
	chatHistoryEnabled: boolean;
	/** UI complexity mode. */
	uiMode: UiMode;
	/** MCP server configurations for dynamic tool discovery. */
	mcpServers: import('../mcp/MCPToolManager').MCPServerConfig[];
	/** Declarative, user-approved REST connectors; credentials remain in Secret Storage. */
	apiConnectors: import('../connectors/ApiConnectorManager').ApiConnectorConfig[];
	/**
	 * Global write-gate bypass. When false (default) every capability that
	 * mutates the vault is staged as a proposal and requires an explicit UI
	 * approval click. When true the operator has deliberately delegated write
	 * authority and mutations execute without a per-action click.
	 */
	autoWriteEnabled: boolean;
	/**
	 * Vault-relative folders under absolute write protection. Mutations inside
	 * these paths always require an explicit approval click, even when
	 * `autoWriteEnabled` is true. Paths are user-supplied; nothing is assumed.
	 */
	protectedWritePaths: string[];
	/** Per-vault dashboard widget order, visibility, collapse, and width. */
	dashboardLayout: DashboardWidgetLayout[];
	/** Capability system master toggle. */
	capabilitySystemEnabled: boolean;
	/** Per-capability user preferences. */
	capabilityPreferences: CapabilityUserPreference[];
	/** Max autonomous tool calls per ReAct cycle. */
	capabilityMaxAutonomousCalls: number;
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
	textToSpeechEnabled: true,
	textToSpeechVoice: '',
	textToSpeechProviderId: 'browser',
	textToSpeechModel: '',
	textToSpeechModels: {},
	textToSpeechApiVoice: '',
	textToSpeechRate: 1,
	speechToTextEnabled: true,
	audioInputDeviceId: '',
	speechToTextProviderId: 'auto',
	speechToTextModel: '',
	speechToTextModels: {},
	voiceOutputTarget: 'chat',
	liveTranscriptionChunkMs: 3000,
	autoReadAiResponses: false,
	webSearchEnabled: false,
	ragEnabled: true,
	memoryEnabled: true,
	reactAgentEnabled: true,
	workflowsEnabled: true,
	dailyOperationsEnabled: true,
	mcpEnabled: true,
	chatHistoryEnabled: true,
	uiMode: 'normal',
	mcpServers: [],
	apiConnectors: [],
	autoWriteEnabled: false,
	protectedWritePaths: [],
	dashboardLayout: DEFAULT_DASHBOARD_LAYOUT.map(widget => ({ ...widget })),
	capabilitySystemEnabled: true,
	capabilityPreferences: [],
	capabilityMaxAutonomousCalls: 8,
};

/** Bounds for the Metacognitive Depth slider (Directive 1.6). */
export const METACOGNITIVE_DEPTH_MIN = 1;
export const METACOGNITIVE_DEPTH_MAX = 10;

// Re-export the dynamic settings tab for convenience
export { PluginSettingsTab } from './PluginSettingsTab';