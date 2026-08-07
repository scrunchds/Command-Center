/**
 * Command Center Settings — types, defaults, and re-exports.
 *
 * The dynamic settings tab lives in src/settings/PluginSettingsTab.ts.
 * This file provides the settings data model, defaults, and convenience re-export.
 */

import type { MultiProviderSettings, ProviderId } from '../providers/provider-types';
import { DEFAULT_RERANKER } from '../rag/reranker';
import type { RerankerSettings } from '../rag/reranker';
import type { CapabilityUserPreference } from '../capabilities/CapabilityTypes';
import { DEFAULT_FALLBACK_CONFIG } from '../providers/provider-types';
import { DEFAULT_ROUTING } from '../routing/routing-table';

/* ─── Settings Interface ────────────────────────────────── */

export type DashboardWidgetSize = 'compact' | 'standard' | 'expanded';

/** Alternative presentation for a widget, when it offers more than one. */
export type DashboardWidgetView = string;

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
	/**
	 * Column span out of twelve, set by dragging a panel's resize handle.
	 * Absent means "derive it from `size`", which keeps layouts saved by
	 * earlier versions working untouched.
	 */
	span?: number;
	/** Discrete panel height, set by dragging the bottom edge. */
	height?: DashboardWidgetHeight;
	/** Alternative view id for widgets that offer more than one presentation. */
	view?: DashboardWidgetView;
}

/** Named heights rather than free pixels, so themes and spacing stay coherent. */
export type DashboardWidgetHeight = 'auto' | 'short' | 'tall' | 'taller';

export const DEFAULT_DASHBOARD_LAYOUT: DashboardWidgetLayout[] = [
	{ id: 'workspace', hidden: false, collapsed: false, size: 'standard' },
	{ id: 'clock', hidden: false, collapsed: false, size: 'compact' },
	{ id: 'deck', hidden: false, collapsed: false, size: 'compact' },
	{ id: 'navigator', hidden: false, collapsed: false, size: 'standard' },
	{ id: 'intelligence', hidden: false, collapsed: false, size: 'expanded' },
	{ id: 'calendar', hidden: false, collapsed: false, size: 'standard' },
	{ id: 'schedule', hidden: false, collapsed: false, size: 'standard' },
	// Browser starts hidden: it is opt-in reading space, not everyday signal.
	{ id: 'browser', hidden: true, collapsed: false, size: 'expanded' },
	{ id: 'approvals', hidden: false, collapsed: false, size: 'expanded' },
	{ id: 'orchestrator', hidden: false, collapsed: false, size: 'expanded' },
	{ id: 'chatbox', hidden: false, collapsed: false, size: 'standard' },
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
	/** Reranker configuration for GraphRAG and hybrid retrieval re-ranking. */
	reranker: RerankerSettings;
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

	/* ─── Asset placement (user controls where files live in the vault) ─── */

	/**
	 * Vault-relative directory where approved workflows are written. Defaults
	 * to the hidden `.command-center/workflows`. Set to a visible folder
	 * (e.g. `Workflows`) to keep generated workflows in plain sight. Existing
	 * generated workflows are not moved automatically when this changes.
	 */
	workflowDirectory: string;
	/** File format for generated workflows. `md` writes human-editable
	 * frontmatter (loadWorkflowFromNote reads it); `json` writes the raw DAG. */
	workflowFormat: 'md' | 'json';
	/** Vault-relative directory where approved templates are written. */
	templateDirectory: string;
	/** Vault-relative path of the interview-derived profile JSON. */
	profilePath: string;

	/**
	 * How times are formatted across the dashboard and schedule widget.
	 * Default 'system' inherits the OS locale's hour12/24h preference; the
	 * user may force '12h' or '24h'. The Paths tab exposes this as a dropdown.
	 */
	timeFormat: 'system' | '12h' | '24h';

	/* ─── Clock widget customization ─── */
	/** Show a seconds field on the clock widget. */
	clockShowSeconds: boolean;
	/** Show the current date beneath the clock. */
	clockShowDate: boolean;
	/** Date verbosity for the clock widget. */
	clockDateFormat: 'long' | 'short' | 'numeric';
	/** Optional label shown above the clock (e.g. a timezone name or office). */
	clockLabel: string;

	/* ─── "Happening now" intelligence customization ─── */
	/** Ordered, toggleable intelligence cards (daily / capture / actions / workspaces). */
	intelligenceCards: IntelligenceCardEntry[];
	/** Configurable kanban-style lanes for the Action items card. */
	actionLanes: ActionLaneConfig[];
}

/** Identifier for one of the four built-in intelligence cards. */
export type IntelligenceCardId = 'daily' | 'capture' | 'actions' | 'workspaces';

/** One entry in the ordered, toggleable intelligence card list. */
export interface IntelligenceCardEntry {
	id: IntelligenceCardId;
	hidden: boolean;
}

/** Deterministic filter that assigns tasks to a kanban lane. */
export type ActionLaneFilter = 'overdue' | 'due-today' | 'upcoming' | 'undated' | 'done' | 'all';

/** One configurable lane in the Action items intelligence card. */
export interface ActionLaneConfig {
	id: string;
	label: string;
	filter: ActionLaneFilter;
	/** Hide this lane when it has no matching tasks. */
	hideWhenEmpty: boolean;
}

/**
 * Validate a user-supplied vault-relative asset path. Rejects empty, root,
 * parent-escape, and the reserved `.command-center` root (sub-paths are fine).
 * Strips emoji/pictographs and common decorative wrappers so a model-suggested
 * value like `📁 Workflows` or `📂 "Templates"` is normalized to `Workflows` /
 * `Templates` rather than rejected. Returns the normalized path or throws.
 * Used by the Paths settings tab and by updateAssetPaths.
 */
export function validateAssetPath(value: string, { allowFile = false }: { allowFile?: boolean } = {}): string {
	// Drop emoji, pictographs, symbols, and decorative box-drawing/smart
	// quotes/wrapping characters that models sometimes prepend to paths.
	const stripped = value
		.replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200d]/gu, '')
		.replace(/[\u2500-\u257f\u2190-\u21ff\u2b00-\u2bff\u2600-\u27bf]/gu, '')
		.replace(/[\u201c\u201d\u2018\u2019\u00ab\u00bb"`]/g, '')
		.trim();
	const trimmed = stripped.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
	if (!trimmed || trimmed === '.') throw new Error('Path cannot be empty or the vault root.');
	if (trimmed.startsWith('../') || trimmed.includes('/../') || trimmed === '..') throw new Error('Path cannot escape the vault.');
	if (trimmed === '.command-center') throw new Error('Storing directly in .command-center is not allowed; use a subfolder such as .command-center/workflows.');
	// A file path has exactly one segment with an extension in the final component.
	const segments = trimmed.split('/');
	const last = segments[segments.length - 1] ?? trimmed;
	const looksLikeFile = last.includes('.');
	if (looksLikeFile && !allowFile) throw new Error(`Expected a folder path, but "${last}" looks like a file.`);
	if (!looksLikeFile && allowFile) throw new Error(`Expected a file path with an extension, but "${last}" has none.`);
	return trimmed;
}

export const DEFAULT_MULTI_PROVIDER: MultiProviderSettings = {
	credentials: {},
	routing: DEFAULT_ROUTING,
	fallback: DEFAULT_FALLBACK_CONFIG,
	defaults: {},
};

/**
 * Deep-clone a plain JSON value (no `structuredClone`), so the shared
 * `DEFAULT_*` constants can never be mutated through a live settings object.
 */
function clonePlain(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(clonePlain);
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) out[key] = clonePlain(child);
		return out;
	}
	return value;
}

/** Fully independent deep copy of the default settings (no shared references). */
export function structuredSafeDefaults(): CommandCenterSettings {
	return clonePlain(DEFAULT_SETTINGS) as CommandCenterSettings;
}

/**
 * Deep-merge a saved `multiProvider` into fresh defaults. An older `data.json`
 * may carry only `credentials` and omit `routing`/`fallback`/`defaults`; this
 * backfills every missing sub-object from a private clone so upgraders always
 * start with a complete, isolated set.
 */
export function mergeMultiProvider(
	defaults: MultiProviderSettings,
	saved: Partial<MultiProviderSettings> | undefined,
): MultiProviderSettings {
	const merged = clonePlain(defaults) as MultiProviderSettings;
	if (!saved) return merged;
	if (saved.credentials) merged.credentials = { ...saved.credentials };
	if (saved.routing) merged.routing = { ...merged.routing, ...saved.routing };
	if (saved.fallback) merged.fallback = { ...merged.fallback, ...saved.fallback };
	if (saved.defaults) merged.defaults = { ...merged.defaults, ...saved.defaults };
	return merged;
}

/** Reranker types + merge live in src/rag/reranker.ts (no Obsidian dependency). */
export type { RerankerSettings } from '../rag/reranker';
export { mergeReranker } from '../rag/reranker';

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
	reranker: { ...DEFAULT_RERANKER },
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
	workflowDirectory: '.command-center/workflows',
	workflowFormat: 'md',
	templateDirectory: '.command-center/templates',
	profilePath: '.command-center/profile.json',
	timeFormat: 'system',
	clockShowSeconds: true,
	clockShowDate: true,
	clockDateFormat: 'long',
	clockLabel: '',
	intelligenceCards: [
		{ id: 'daily', hidden: false },
		{ id: 'capture', hidden: false },
		{ id: 'actions', hidden: false },
		{ id: 'workspaces', hidden: false },
	],
	actionLanes: [
		{ id: 'overdue', label: 'Overdue', filter: 'overdue', hideWhenEmpty: true },
		{ id: 'due-today', label: 'Due today', filter: 'due-today', hideWhenEmpty: true },
		{ id: 'upcoming', label: 'Scheduled', filter: 'upcoming', hideWhenEmpty: true },
		{ id: 'undated', label: 'Undated', filter: 'undated', hideWhenEmpty: true },
	],
};

/** Bounds for the Metacognitive Depth slider (Directive 1.6). */
export const METACOGNITIVE_DEPTH_MIN = 1;
export const METACOGNITIVE_DEPTH_MAX = 10;

/** Default intelligence card order/visibility, used to reconcile saved data. */
export const DEFAULT_INTELLIGENCE_CARDS: IntelligenceCardEntry[] = [
	{ id: 'daily', hidden: false },
	{ id: 'capture', hidden: false },
	{ id: 'actions', hidden: false },
	{ id: 'workspaces', hidden: false },
];

/** Default kanban lanes for the Action items card. */
export const DEFAULT_ACTION_LANES: ActionLaneConfig[] = [
	{ id: 'overdue', label: 'Overdue', filter: 'overdue', hideWhenEmpty: true },
	{ id: 'due-today', label: 'Due today', filter: 'due-today', hideWhenEmpty: true },
	{ id: 'upcoming', label: 'Scheduled', filter: 'upcoming', hideWhenEmpty: true },
	{ id: 'undated', label: 'Undated', filter: 'undated', hideWhenEmpty: true },
];

/** Known intelligence card ids in their canonical order. */
const INTELLIGENCE_CARD_ORDER: IntelligenceCardId[] = ['daily', 'capture', 'actions', 'workspaces'];

/** Valid action-lane filter values, used to drop malformed saved data. */
const ACTION_LANE_FILTERS: ActionLaneFilter[] = ['overdue', 'due-today', 'upcoming', 'undated', 'done', 'all'];

/**
 * Reconcile a saved intelligence-card list against the cards that ship.
 * Preserves the user's order and visibility choices; appends any newly shipped
 * card at its default position and drops unknown ids. Returns the default
 * list when `saved` is missing or malformed so a fresh vault always renders.
 */
export function resolveIntelligenceCards(saved: unknown): IntelligenceCardEntry[] {
	if (!Array.isArray(saved)) return DEFAULT_INTELLIGENCE_CARDS.map(entry => ({ ...entry }));
	const known = new Set<IntelligenceCardId>(INTELLIGENCE_CARD_ORDER);
	const seen = new Set<string>();
	const merged: IntelligenceCardEntry[] = [];
	for (const raw of saved) {
		if (!raw || typeof raw !== 'object') continue;
		const entry = raw as { id?: unknown; hidden?: unknown };
		if (typeof entry.id !== 'string' || !known.has(entry.id as IntelligenceCardId) || seen.has(entry.id)) continue;
		seen.add(entry.id);
		merged.push({ id: entry.id as IntelligenceCardId, hidden: Boolean(entry.hidden) });
	}
	for (const fallback of DEFAULT_INTELLIGENCE_CARDS) {
		if (seen.has(fallback.id)) continue;
		seen.add(fallback.id);
		merged.push({ ...fallback });
	}
	return merged;
}

/**
 * Reconcile saved action-lane config. Drops lanes with bad filter values or
 * empty labels, dedupes ids, and falls back to the default lanes when nothing
 * usable remains, so the Action items card is never blank by accident.
 */
export function resolveActionLanes(saved: unknown): ActionLaneConfig[] {
	if (!Array.isArray(saved)) return DEFAULT_ACTION_LANES.map(lane => ({ ...lane }));
	const seen = new Set<string>();
	const merged: ActionLaneConfig[] = [];
	for (const raw of saved) {
		if (!raw || typeof raw !== 'object') continue;
		const lane = raw as { id?: unknown; label?: unknown; filter?: unknown; hideWhenEmpty?: unknown };
		const label = typeof lane.label === 'string' ? lane.label.trim() : '';
		if (!label) continue;
		const filter = ACTION_LANE_FILTERS.includes(lane.filter as ActionLaneFilter) ? (lane.filter as ActionLaneFilter) : 'all';
		let id = typeof lane.id === 'string' && lane.id ? lane.id : `${filter}-${merged.length}`;
		while (seen.has(id)) id = `${id}-${merged.length}`;
		seen.add(id);
		merged.push({ id, label, filter, hideWhenEmpty: lane.hideWhenEmpty !== false });
	}
	return merged.length > 0 ? merged : DEFAULT_ACTION_LANES.map(lane => ({ ...lane }));
}

// Re-export the dynamic settings tab for convenience
export { PluginSettingsTab } from './PluginSettingsTab';