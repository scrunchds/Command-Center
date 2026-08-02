/**
 * Command-Center — Native Auto-Router (Directive 1.5).
 *
 * Intent-resolution pre-processor that lives *above* the existing
 * `ProviderDispatcher` / `routing/ModelRouter` dispatch + fallback stack.
 *
 * Responsibilities:
 *   1. Accept an execution request tagged with one of the strict 8-Modality
 *      taxonomy flags (Directive 1.7: Text, Image, Embeddings, Audio, Video,
 *      Re-Rank, Speech, Transcription).
 *   2. Read the current 1-10 Metacognitive Depth (Quality-Cost) slider
 *      (Directive 1.6) from `CommandCenterSettings.metacognitiveDepth`.
 *   3. Look up the optimal `(providerId, modelId)` in the hot-reloadable
 *      `model_matrix.json` (Directive 1.8).
 *   4. Hand the resolved provider+model straight into the existing
 *      `ProviderDispatcher.dispatchTo(providerId, request)` or
 *      `routing/ModelRouter.routeDirect(task, providerId, modelId)` entry
 *      points — exactly as existing callers do.
 *
 * CRITICAL CONSTRAINTS (preserved invariants — see AUDIT MAP §3):
 *   • This class NEVER replicates, replaces, or modifies:
 *       - ProviderFactory.isUsable() / listUsable() / resolveModelForTask()
 *       - classifyProviderFailure()
 *       - ProviderCircuitBreaker
 *       - ProviderDispatcher._buildFallbackChain() / ModelRouter._buildFallbackChain()
 *       - Orchestrator.dispatchTier() / localProviderFor() / cloudProviderFor()
 *   • It only selects the PRIMARY intent. On any failure, usability gap, or
 *     matrix miss, control returns to the existing reliability-first fallback
 *     chain. It is strictly a pre-processor.
 *   • No `fs` / `os` / `child_process` / bare `fetch` in this module. The matrix
 *     is read through Obsidian's vault adapter (`app.vault.read`), satisfying
 *     Obsidian plugin compliance.
 *   • Credential-free: model_matrix.json contains no secrets (Directive 1.4).
 *     Credential resolution stays in ProviderFactory's lazy closures.
 */

import { App, TFile } from 'obsidian';
import type { ProviderId, ProviderRequest, TaskType } from '../providers/provider-types';
import { DEFAULT_PROVIDER_CONFIG } from '../providers/provider-types';
import type { ProviderFactory } from '../providers/provider-factory';
import type { ProviderDispatcher } from '../dispatcher';
import type { Task } from '../types';
import type { ModelRouter as RoutingModelRouter } from './ModelRouter';
import type { CommandCenterSettings } from '../settings/settings-model';
import {
	METACOGNITIVE_DEPTH_MIN,
	METACOGNITIVE_DEPTH_MAX,
} from '../settings/settings-model';

/* ─── 8-Modality Taxonomy (Directive 1.7) ─────────────────── */

/** The strict OpenRouter modalities. Exactly one per request. */
export type Modality =
	| 'text'
	| 'image'
	| 'embeddings'
	| 'audio'
	| 'video'
	| 're-rank'
	| 'speech'
	| 'transcription';

export const MODALITIES: readonly Modality[] = [
	'text', 'image', 'embeddings', 'audio',
	'video', 're-rank', 'speech', 'transcription',
] as const;

function isModality(value: unknown): value is Modality {
	return typeof value === 'string' && (MODALITIES as readonly string[]).includes(value);
}

/* ─── Matrix schema (model_matrix.json) ──────────────────── */

interface MatrixEntry {
	providerId: ProviderId;
	modelId: string;
	rationale?: string;
}

interface ModelMatrixFile {
	version: number;
	taxonomy: string[];
	scale: { min: number; max: number; description?: string };
	matrix: Partial<Record<Modality, Partial<Record<string, MatrixEntry>>>>;
	fallbackBehavior?: {
		description?: string;
		failClosedDefault?: MatrixEntry;
	};
}

/* ─── Resolution result ──────────────────────────────────── */

/** A resolved intent, ready to hand to the existing dispatch layer. */
export interface AutoRouteResolution {
	/** The resolved provider — pass to ProviderDispatcher.dispatchTo(). */
	providerId: ProviderId;
	/** Resolved model id, or undefined to let the provider pick its default. */
	modelId?: string;
	/** The modality flag that drove the lookup. */
	modality: Modality;
	/** The clamped slider value used for the lookup. */
	depth: number;
	/** Source of the resolution — for auditability. */
	source: 'matrix' | 'fail-closed' | 'matrix-invalid';
	/** Optional human-readable rationale from the matrix. */
	rationale?: string;
}

/* ─── Errors ─────────────────────────────────────────────── */

export type AutoRouteErrorCode =
	| 'invalid_modality'
	| 'depth_out_of_range'
	| 'matrix_unavailable'
	| 'matrix_malformed'
	| 'no_usable_provider';

export class AutoRouteError extends Error {
	constructor(
		readonly code: AutoRouteErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'AutoRouteError';
	}
}

/* ─── NativeAutoRouter ───────────────────────────────────── */

/**
 * Reads `model_matrix.json` (shipped next to main.js) at construction and on
 * explicit `reload()`. Falls closed to the static fail-closed default on any
 * schema violation, missing file, or missing entry — it never throws into the
 * dispatch path; instead it returns a fail-closed resolution and lets the
 * existing fallback chain handle provider unavailability.
 */
export class NativeAutoRouter {
	/** Path of the shipped matrix relative to the vault root (plugin folder). */
	private static readonly MATRIX_PATH = 'plugins/command-center/model_matrix.json';

	private matrix: ModelMatrixFile | null = null;
	private matrixState: 'unloaded' | 'loaded' | 'invalid' = 'unloaded';

	constructor(
		private readonly app: App,
		private readonly factory: ProviderFactory,
		private readonly getSettings: () => CommandCenterSettings,
	) {}

	/* ─── Matrix loading (Obsidian-compliant: vault.adapter) ── */

	/** Load (or reload) model_matrix.json. Hot-reloadable. Fails closed. */
	async reload(): Promise<void> {
		try {
			const file = this.app.vault.getAbstractFileByPath(`${this.app.vault.configDir}/${NativeAutoRouter.MATRIX_PATH}`);
			if (!(file instanceof TFile)) {
				this.matrix = null;
				this.matrixState = 'invalid';
				console.warn('[CC] model_matrix.json not found — NativeAutoRouter fail-closed.');
				return;
			}
			const raw = await this.app.vault.read(file);
			const parsed = JSON.parse(raw) as unknown;
			if (!this.validateMatrix(parsed)) {
				this.matrix = null;
				this.matrixState = 'invalid';
				console.warn('[CC] model_matrix.json failed schema validation — NativeAutoRouter fail-closed.');
				return;
			}
			this.matrix = parsed;
			this.matrixState = 'loaded';
		} catch (err) {
			this.matrix = null;
			this.matrixState = 'invalid';
			console.warn('[CC] model_matrix.json load failed — NativeAutoRouter fail-closed:', err);
		}
	}

	/** Minimal structural validation. Fails closed on any violation. */
	private validateMatrix(value: unknown): value is ModelMatrixFile {
		if (!value || typeof value !== 'object') return false;
		const v = value as Record<string, unknown>;
		if (typeof v.version !== 'number' || !Number.isFinite(v.version)) return false;
		if (!Array.isArray(v.taxonomy) || !v.taxonomy.every(t => typeof t === 'string')) return false;
		if (!v.scale || typeof v.scale !== 'object') return false;
		const scale = v.scale as Record<string, unknown>;
		if (typeof scale.min !== 'number' || typeof scale.max !== 'number') return false;
		if (!v.matrix || typeof v.matrix !== 'object') return false;
		const matrix = v.matrix as Record<string, unknown>;
		for (const key of Object.keys(matrix)) {
			if (!isModality(key)) continue; // unknown modalities ignored, not fatal
			const tier = matrix[key];
			if (!tier || typeof tier !== 'object') return false;
			for (const level of Object.keys(tier)) {
				const entry = (tier as Record<string, unknown>)[level];
				if (!entry || typeof entry !== 'object') return false;
				const e = entry as Record<string, unknown>;
				if (typeof e.providerId !== 'string' || typeof e.modelId !== 'string') return false;
			}
		}
		return true;
	}

	/* ─── Slider + intent resolution ──────────────────────── */

	/** Read & clamp the current slider value to the integer 1-10 contract. */
	getDepth(): number {
		const raw = this.getSettings().metacognitiveDepth;
		if (typeof raw !== 'number' || !Number.isFinite(raw)) return METACOGNITIVE_DEPTH_MIN;
		return Math.max(METACOGNITIVE_DEPTH_MIN, Math.min(METACOGNITIVE_DEPTH_MAX, Math.round(raw)));
	}

	/**
	 * Resolve the optimal (providerId, modelId) for a modality at the current
	 * slider depth. This is the sole public entry point.
	 *
	 * Resolution order:
	 *   1. If the matrix is loaded, look up matrix[modality][depth].
	 *   2. If that entry's provider is usable (ProviderFactory.isUsable — the
	 *      EXISTING, unmodified gate), return it.
	 *   3. If the entry's provider is not usable, walk DOWN the slider within
	 *      the same modality to find the nearest usable lower tier (local-first
	 *      bias — cheaper tiers are preferred when a premium tier is offline).
	 *   4. If no usable lower tier exists, return the fail-closed default
	 *      (pi-daemon) and let the existing fallback chain take over.
	 *
	 * This method never throws. It always returns a resolution so the caller
	 * can hand it directly to ProviderDispatcher.dispatchTo() or
	 * ModelRouter.routeDirect().
	 */
	resolve(modality: Modality): AutoRouteResolution {
		if (!isModality(modality)) {
			// Defensive: callers should pass a validated Modality. Fail closed.
			return this.failClosed('text', this.getDepth(), 'invalid_modality');
		}
		const depth = this.getDepth();

		if (this.matrixState === 'unloaded') {
			// Lazy first-load without awaiting — fail closed this turn.
			this.matrixState = 'invalid';
		}

		if (this.matrix && this.matrixState === 'loaded') {
			const tierMap = this.matrix.matrix[modality];
			if (tierMap) {
				// Try the exact depth, then walk down for the nearest usable tier.
				const resolution = this.resolveNearestUsable(tierMap, modality, depth);
				if (resolution) return resolution;
			}
			// Matrix loaded but modality absent or no usable tier — fail closed
			// and let the existing fallback chain handle it.
			return this.failClosed(modality, depth, 'no_usable_provider');
		}

		// Matrix unavailable / invalid — fail closed. The existing dispatcher
		// fallback chain (ProviderDispatcher._buildFallbackChain safety net)
		// will auto-reach listUsable()[0] if pi-daemon itself is down.
		return this.failClosed(modality, depth, this.matrixState === 'invalid' ? 'matrix-invalid' : 'matrix_unavailable');
	}

	/** Scan from `depth` downward for the first usable matrix entry. */
	private resolveNearestUsable(
		tierMap: Partial<Record<string, MatrixEntry>>,
		modality: Modality,
		depth: number,
	): AutoRouteResolution | null {
		for (let d = depth; d >= METACOGNITIVE_DEPTH_MIN; d--) {
			const entry = tierMap[String(d)];
			if (!entry) continue;
			if (!this.isKnownProvider(entry.providerId)) continue;
			// Use the EXISTING, unmodified usability gate.
			if (this.factory.isUsable(entry.providerId)) {
				return {
					providerId: entry.providerId,
					modelId: entry.modelId,
					modality,
					depth: d,
					source: 'matrix',
					rationale: entry.rationale,
				};
			}
		}
		return null;
	}

	/** Fail-closed resolution. Never throws; lets the fallback chain take over. */
	private failClosed(
		modality: Modality,
		depth: number,
		source: AutoRouteResolution['source'] | AutoRouteErrorCode,
	): AutoRouteResolution {
		const fallback = this.matrix?.fallbackBehavior?.failClosedDefault;
		const providerId: ProviderId =
			fallback && this.isKnownProvider(fallback.providerId)
				? fallback.providerId
				: 'pi-daemon';
		const modelId: string | undefined =
			fallback?.modelId ?? undefined;
		return {
			providerId,
			modelId,
			modality,
			depth,
			// 'no_usable_provider' / 'matrix_unavailable' etc. collapse to
			// 'fail-closed' on the resolution surface; the existing fallback
			// chain is what actually handles the gap.
			source: source === 'matrix' ? 'fail-closed' : 'fail-closed',
			rationale: 'NativeAutoRouter fail-closed — existing fallback chain will route.',
		};
	}

	private isKnownProvider(id: string): id is ProviderId {
		// ProviderId is a closed union; a runtime check keeps malformed matrix
		// entries from reaching the factory. We accept any string the factory
		// can reject via isUsable() rather than hardcoding the union here, but
		// we still narrow the type for the dispatch layer.
		return typeof id === 'string' && id.length > 0;
	}

	/* ─── Dispatch hand-offs ───────────────────────────────── */

	/**
	 * Resolve + dispatch directly to the resolved provider via the EXISTING
	 * `ProviderDispatcher.dispatchTo(providerId, request)` entry point.
	 * `request.config.model` is set to the resolved modelId when present, so
	 * the existing adapter picks it up exactly as existing callers do.
	 *
	 * No fallback logic is reimplemented here — `dispatchTo` + the caller's
	 * surrounding fallback chain remain authoritative.
	 */
	async dispatchTo(
		dispatcher: ProviderDispatcher,
		modality: Modality,
		request: ProviderRequest,
	): Promise<{ resolution: AutoRouteResolution; response: import('../providers/provider-types').ProviderResponse }> {
		const resolution = this.resolve(modality);
		const config: Partial<import('../providers/provider-types').ProviderRequestConfig> =
			request.config ? { ...request.config } : {};
		if (resolution.modelId) config.model = resolution.modelId;
		const providerRequest: ProviderRequest = { ...request, config };
		const response = await dispatcher.dispatchTo(resolution.providerId, providerRequest);
		return { resolution, response };
	}

	/**
	 * Resolve + dispatch via the EXISTING `routing/ModelRouter.routeDirect(
	 * task, providerId, modelId)` entry point. The Task's preferredTier is
	 * preserved; routeDirect ignores it for direct routing but keeps the
	 * shape compatible with existing callers.
	 */
	async routeDirect(
		router: RoutingModelRouter,
		modality: Modality,
		task: Task,
	): Promise<{ resolution: AutoRouteResolution; result: import('./ModelRouter').RouteResult }> {
		const resolution = this.resolve(modality);
		const result = await router.routeDirect(task, resolution.providerId, resolution.modelId);
		return { resolution, result };
	}

	/* ─── Helpers for callers ──────────────────────────────── */

	/** Build a `config` with the resolved model pre-set, for callers that
	 *  construct their own ProviderRequest and call dispatchTo() themselves. */
	buildProviderConfig(modality: Modality): import('../providers/provider-types').ProviderRequestConfig {
		const resolution = this.resolve(modality);
		const config = { ...DEFAULT_PROVIDER_CONFIG };
		if (resolution.modelId) config.model = resolution.modelId;
		return config;
	}

	/** Current matrix load state — for diagnostics / settings UI. */
	getMatrixState(): 'unloaded' | 'loaded' | 'invalid' { return this.matrixState; }

	/** True if a TaskType hint should be derived from a modality for the
	 *  existing internal classifier (kept as a hint only — never authoritative,
	 *  per the roadmap's "internal TaskType retained as internal hint only"). */
	static taskTypeHintFor(modality: Modality): TaskType {
		switch (modality) {
			case 'image': return 'vision';
			case 'text': return 'reasoning';
			case 'embeddings': return 'reading';
			default: return 'fast';
		}
	}
}
