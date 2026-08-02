/**
 * Task Routing Matrix — maps cognitive sub-tasks to optimized provider/model pairs.
 *
 * The routing table answers: "For this TaskType, which provider + model is best?"
 * Routes are configurable in settings and stored in MultiProviderSettings.routing.
 */

import type {
	TaskType, ProviderId, RoutingTable,
	MultiProviderSettings, ProviderRequestConfig,
} from '../providers/provider-types';
import { DEFAULT_PROVIDER_CONFIG } from '../providers/provider-types';

/* ─── Default Routing Table ────────────────────────────── */

/**
 * Sensible defaults mapping each TaskType to an optimized provider + model.
 * Users can override these in settings.
 */
export const DEFAULT_ROUTING: RoutingTable = {
	coding: {
		taskType: 'coding',
		providerId: 'anthropic',
		modelId: 'claude-3-5-sonnet-20241022',
		config: { temperature: 0.3, maxTokens: 8192 },
	},
	vision: {
		taskType: 'vision',
		providerId: 'openai',
		modelId: 'gpt-4o',
		config: { temperature: 0.5, maxTokens: 4096 },
	},
	reading: {
		taskType: 'reading',
		providerId: 'google-gemini',
		modelId: 'gemini-1.5-pro',
		config: { temperature: 0.3, maxTokens: 8192 },
	},
	reasoning: {
		taskType: 'reasoning',
		providerId: 'anthropic',
		modelId: 'claude-3-5-sonnet-20241022',
		config: { temperature: 0.5, maxTokens: 4096 },
	},
	fast: {
		taskType: 'fast',
		providerId: 'groq',
		modelId: 'llama-3.1-8b-instant',
		config: { temperature: 0.7, maxTokens: 2048 },
	},
};

/* ─── Task Classification ──────────────────────────────── */

/** Heuristic to classify a task string into a TaskType based on keywords. */
export function classifyTask(prompt: string, workerProfile?: string): TaskType {
	const lower = prompt.toLowerCase();

	// Vision tasks — detect image/canvas embeds, Markdown attachments, and local paths.
	const imageExt = '(?:png|jpg|jpeg|gif|webp|bmp|svg|tiff|tif)';
	const hasImageRefs = new RegExp(`!\\[\\[[^\\]]+\\.(?:${imageExt}|canvas)(?:\\|[^\\]]*)?\\]\\]`, 'i').test(prompt) ||
		new RegExp(`!\\[[^\\]]*\\]\\([^)]*\\.(?:${imageExt}|canvas)(?:[?#][^)]*)?(?:\\s+["'][^"']*["'])?\\s*\\)`, 'i').test(prompt) ||
		new RegExp(`(?:^|\\s)[^\\s<>]+\\.${imageExt}(?:$|\\s)`, 'i').test(prompt);
	if (hasImageRefs ||
		/\b(image|picture|photo|screenshot|diagram|visual|ocr|what('s| is) in this)\b/.test(lower)) {
		return 'vision';
	}

	// Coding tasks
	if (workerProfile === 'editor' ||
		/\b(code|refactor|implement|function|class |api |endpoint|bug|fix|debug|compile|build|deploy|ci|cd|pipeline|test suite)\b/.test(lower)) {
		return 'coding';
	}

	// Reading/long-context tasks
	if (/\b(summarize|summarise|extract|read|analyze this|review this|scan|overview|digest|condense)\b/.test(lower) &&
		prompt.length > 500) {
		return 'reading';
	}

	// Short summarization → reading
	if (workerProfile === 'summarizer') return 'reading';

	// Reasoning tasks
	if (/\b(analyze|reason|think|plan|strategy|evaluate|compare|contrast|why|how|explain|what if|consider|decide)\b/.test(lower)) {
		return 'reasoning';
	}

	// Fast/utility: short queries, simple lookups
	if (prompt.length < 200 && !/\b(complex|detailed|comprehensive|thorough)\b/.test(lower)) {
		return 'fast';
	}

	// Default to reasoning
	return 'reasoning';
}

/* ─── Route Resolver ───────────────────────────────────── */

export interface ResolvedRoute {
	providerId: ProviderId;
	modelId: string;
	config: ProviderRequestConfig;
	taskType: TaskType;
}

/** Resolve a full route from settings, falling back to defaults for unconfigured types. */
export function resolveRoute(
	taskType: TaskType,
	settings: MultiProviderSettings,
): ResolvedRoute {
	const route = settings.routing[taskType] ?? DEFAULT_ROUTING[taskType];
	return {
		providerId: route.providerId,
		modelId: route.modelId,
		config: {
			...DEFAULT_PROVIDER_CONFIG,
			...settings.defaults,
			...route.config,
		},
		taskType,
	};
}

/** Build a merged routing table from settings + defaults. */
export function buildRoutingTable(settings: MultiProviderSettings): RoutingTable {
	const merged = { ...DEFAULT_ROUTING };
	for (const tt of Object.keys(merged) as TaskType[]) {
		if (settings.routing[tt]) {
			merged[tt] = { ...merged[tt], ...settings.routing[tt] };
		}
	}
	return merged;
}