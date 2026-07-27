/**
 * LM Studio provider.
 *
 * LM Studio exposes the OpenAI-compatible inference API below `/v1`, while
 * model discovery has existed at several endpoints across LM Studio releases.
 * Query all supported catalog endpoints so both loaded and downloaded models
 * are available in Command Center.
 */

import { requestUrl } from '../obsidian-request';
import type { ProviderModel, ProviderRequest, ProviderResponse } from './provider-types';
import { OpenAICompatibleProvider } from './openai-compatible';

export class LMStudioProvider extends OpenAICompatibleProvider {
	private serverRoot(): string {
		return this.getBaseUrl()
			.trim()
			.replace(/\/+$/, '')
			.replace(/\/(?:api\/v[01]|v1)$/i, '');
	}

	protected getEndpoint(): string {
		return `${this.serverRoot()}/v1/chat/completions`;
	}

	/** Resolve the exact model currently exposed by LM Studio for inference. */
	async getActiveModelId(baseUrl: string = this.serverRoot()): Promise<string> {
		const root = baseUrl.trim().replace(/\/+$/, '').replace(/\/(?:api\/v[01]|v1)$/i, '');
		try {
			const response = await requestUrl({
				url: `${root}/v1/models`,
				method: 'GET',
				headers: this.buildListHeaders(this.getApiKey()),
			});
			const payload = response.json as { data?: Array<{ id?: unknown }> };
			const id = payload.data?.[0]?.id;
			if (typeof id === 'string' && id.trim()) return id.trim();
		} catch {
			// Normalize transport and response failures into an actionable message.
		}
		throw new Error('No model currently loaded in LM Studio. Please load a model into memory.');
	}

	/** Replace matrix placeholders with the model LM Studio reports as active. */
	protected override async _completeImpl(request: ProviderRequest): Promise<ProviderResponse> {
		const activeModelId = await this.getActiveModelId();
		return super._completeImpl({
			...request,
			config: { ...request.config, model: activeModelId },
		});
	}

	/**
	 * Discover models through the stable OpenAI endpoint and LM Studio's native
	 * catalogs. `/api/v0/models` is used by older releases; newer releases may
	 * expose `/api/v1/models`. Successful results are merged by model key.
	 */
	async fetchLiveModels(): Promise<ProviderModel[]> {
		const root = this.serverRoot();
		if (!root) throw new Error('LM Studio base URL is empty.');

		const endpoints = [
			// LM Studio 0.4.0+ native API (preferred; includes downloaded models).
			`${root}/api/v1/models`,
			// OpenAI compatibility API and pre-0.4 native compatibility fallback.
			`${root}/v1/models`,
			`${root}/api/v0/models`,
		];
		const results = await Promise.all(endpoints.map(url => this.fetchCatalog(url)));
		const successful = results.filter(result => result.ok);
		if (successful.length === 0) {
			const detail = results.map(result => result.error).filter(Boolean).join('; ');
			throw new Error(`Could not query LM Studio model API at ${root}. ${detail}`.trim());
		}

		const models = new Map<string, ProviderModel>();
		for (const result of successful) {
			for (const model of result.models) {
				const existing = models.get(model.id);
				models.set(model.id, existing ? { ...model, ...existing } : model);
			}
		}
		return [...models.values()].sort((a, b) => a.label.localeCompare(b.label));
	}

	/** Test discovery first so the health check never sends the placeholder `local-model`. */
	async healthCheck(): Promise<string | null> {
		try {
			const models = await this.fetchLiveModels();
			if (models.length === 0) {
				return 'LM Studio is reachable, but it reported no LLM models. Download or load a model in LM Studio.';
			}
			const response: ProviderResponse = await this.complete({
				systemPrompt: 'You are a health check.',
				userPrompt: 'Respond with just "OK".',
				config: { model: models[0]!.id, maxTokens: 10, temperature: 0 },
			});
			return response.success ? null : (response.error ?? 'LM Studio health check failed.');
		} catch (err) {
			return err instanceof Error ? err.message : String(err);
		}
	}

	private async fetchCatalog(url: string): Promise<{
		ok: boolean;
		models: ProviderModel[];
		error?: string;
	}> {
		try {
			const response = await requestUrl({
				url,
				headers: this.buildListHeaders(this.getApiKey()),
			});
			const payload = response.json as Record<string, unknown>;
			return { ok: true, models: this.parseLMStudioCatalog(payload) };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { ok: false, models: [], error: `${url}: ${message}` };
		}
	}

	private parseLMStudioCatalog(payload: Record<string, unknown>): ProviderModel[] {
		const entries = (Array.isArray(payload.data) ? payload.data
			: Array.isArray(payload.models) ? payload.models
			: []) as Array<Record<string, unknown>>;

		return entries.flatMap(entry => {
			const rawType = typeof entry.type === 'string'
				? entry.type
				: typeof entry.object === 'string' ? entry.object : '';
			if (rawType.toLowerCase().includes('embed')) return [];

			// Native v1 calls this `key`; OpenAI compatibility calls it `id`.
			// Prefer the native key because it is accepted by inference endpoints.
			const idValue = entry.key ?? entry.id ?? entry.model;
			if (typeof idValue !== 'string' || !idValue.trim()) return [];
			const id = idValue.trim();
			const inferred = this.rawModelToProviderModel(id);
			const context = Number(entry.max_context_length ?? entry.context_length ?? entry.context_window);
			const displayName = entry.display_name ?? entry.name;
			const capabilities = entry.capabilities && typeof entry.capabilities === 'object'
				? entry.capabilities as Record<string, unknown>
				: {};
			return [{
				...inferred,
				label: typeof displayName === 'string' && displayName.trim() ? displayName.trim() : inferred.label,
				contextWindow: Number.isFinite(context) && context > 0 ? context : inferred.contextWindow,
				supportsVision: capabilities.vision === true || capabilities.image_input === true || inferred.supportsVision,
				supportsTools: capabilities.trained_for_tool_use !== false && inferred.supportsTools,
				costTier: 'free' as const,
			}];
		});
	}
}
