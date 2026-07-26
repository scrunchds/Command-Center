/**
 * Provider Factory — dynamically instantiates provider adapters based on configuration.
 *
 * Each provider gets its own adapter instance. The factory resolves API keys,
 * base URLs, and other config from the MultiProviderSettings at call time
 * (lazy resolution) so that settings changes take effect immediately.
 */

import type {
	IProviderAdapter, ProviderId, MultiProviderSettings,
	ProviderCredentials, TaskType, ProviderModel,
} from './provider-types';
import { sanitizeBaseUrl } from './provider-types';
import { PROVIDER_REGISTRY } from './provider-registry';
import { OpenAICompatibleProvider } from './openai-compatible';
import { LMStudioProvider } from './lm-studio';
import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './google-gemini';
import { CohereProvider } from './cohere';
import { PiDaemonAdapter } from './pi-daemon-provider';
import type { PiAgentDaemon } from '../daemon';
import { BaseHttpProvider, type BaseHttpProviderOptions } from './base-http-provider';
import { JitModelManager } from './jit-manager';

/* ─── Factory ──────────────────────────────────────────── */

export class ProviderFactory {
	private instances = new Map<ProviderId, IProviderAdapter>();
	private daemon: PiAgentDaemon;
	private getSettings: () => MultiProviderSettings;
	readonly jitModelManager: JitModelManager;

	constructor(
		daemon: PiAgentDaemon, getSettings: () => MultiProviderSettings,
		jitModelManager: JitModelManager = new JitModelManager(),
	) {
		this.daemon = daemon;
		this.getSettings = getSettings;
		this.jitModelManager = jitModelManager;
		// Pi daemon adapter is always available
		this.instances.set('pi-daemon', new PiDaemonAdapter(daemon));
	}

	/** Get (or create) a provider adapter instance. */
	get(id: ProviderId): IProviderAdapter {
		let instance = this.instances.get(id);
		if (!instance) {
			instance = this.create(id);
			this.instances.set(id, instance);
		}
		return instance;
	}

	/** Resolve the current URL lazily so settings edits apply immediately. */
	getBaseUrl(id: ProviderId): string {
		const credentials = this.getSettings().credentials[id];
		return sanitizeBaseUrl(credentials?.baseUrl || PROVIDER_REGISTRY[id].defaultBaseUrl || '');
	}

	/** List all available (configured + enabled) providers. */
	listAvailable(): IProviderAdapter[] {
		return Object.keys(PROVIDER_REGISTRY)
			.map(id => this.get(id as ProviderId))
			.filter(p => p.isAvailable());
	}

	/**
	 * A provider is usable when its adapter reports available (key configured for
	 * key-requiring providers; daemon running for pi-daemon) AND the user has opted
	 * in. Opt-in semantics:
	 *   - pi-daemon: always enabled (keyless local runtime).
	 *   - key-requiring providers: a configured API key IS the opt-in. The
	 *     `enabled` toggle is not a hard gate here because legacy installs created
	 *     credential records with `enabled: false` by default before the toggle was
	 *     wired into dispatch, and that value is indistinguishable from an
	 *     explicit opt-out. To disable a key-requiring provider, remove its key.
	 *     (loadSettings() normalizes `enabled: true` for keyed providers so the
	 *     UI toggle reflects the correct state and future opt-out works.)
	 *   - keyless local providers (LM Studio, Ollama, custom): require explicit
	 *     `enabled: true` so unconfigured localhost endpoints are never tried.
	 */
	isUsable(id: ProviderId): boolean {
		const provider = this.get(id);
		if (!provider.isAvailable()) return false;
		if (id === 'pi-daemon') return true;
		const cred = this.getSettings().credentials[id];
		const requiresKey = PROVIDER_REGISTRY[id]?.requiresKey ?? true;
		if (requiresKey) {
			// isAvailable() already verified a key is configured; the key is the opt-in.
			return true;
		}
		// Keyless local providers require explicit opt-in.
		return cred?.enabled === true;
	}

	/**
	 * List all enabled+available providers in a stable preference order: keyless
	 * local runtimes first (pi-daemon, ollama, lmstudio, custom), then configured
	 * cloud providers in registry order. Used to auto-reach a usable provider when
	 * no configured route is usable (e.g. a local-only setup).
	 */
	listUsable(): IProviderAdapter[] {
		const localFirst: ProviderId[] = ['pi-daemon', 'ollama', 'lmstudio', 'custom'];
		const rest = Object.keys(PROVIDER_REGISTRY)
			.filter(id => !localFirst.includes(id as ProviderId)) as ProviderId[];
		return [...localFirst, ...rest]
			.filter(id => this.isUsable(id))
			.map(id => this.get(id));
	}

	/**
	 * Resolve the best model ID for a task on this provider. Prefers cached live
	 * models (discovered from the server) over the static registry default, because
	 * local servers such as LM Studio reject placeholder IDs like `local-model` and
	 * require a real loaded model. Falls back to the registry default when no live
	 * models are cached.
	 */
	resolveModelForTask(id: ProviderId, taskType: TaskType): string {
		const provider = this.get(id);
		const configured = provider.getDefaultModel(taskType);
		const live = this.getSettings().liveModels?.[id];
		if (!live || live.length === 0) return configured;
		// Keep the configured/default model when the server reports it as loaded.
		if (live.some(m => m.id === configured)) return configured;
		// Prefer a live model whose strengths match the task type (cheapest first).
		const costOrder: Record<string, number> = { free: 0, cheap: 1, moderate: 2, expensive: 3 };
		const byStrength = live.filter(m => Array.isArray(m.strengths) && m.strengths.includes(taskType));
		const pool = byStrength.length > 0 ? byStrength : live;
		return [...pool].sort((a, b) =>
			(costOrder[a.costTier] ?? 2) - (costOrder[b.costTier] ?? 2))[0]!.id;
	}

	/** Invalidate cached instances (e.g., after settings change). */
	invalidate(id?: ProviderId): void {
		if (id) {
			if (id !== 'pi-daemon') this.instances.delete(id);
		} else {
			const piDaemon = this.instances.get('pi-daemon');
			this.instances.clear();
			if (piDaemon) this.instances.set('pi-daemon', piDaemon);
		}
	}

	/* ─── Internal ──────────────────────────────────── */

	private create(id: ProviderId): IProviderAdapter {
		switch (id) {
			case 'pi-daemon':
				return new PiDaemonAdapter(this.daemon);
			case 'openai':
				return this.createOpenAICompatible('openai');
			case 'openrouter':
				return this.createOpenAICompatible('openrouter');
			case 'groq':
				return this.createOpenAICompatible('groq');
			case 'deepinfra':
				return this.createOpenAICompatible('deepinfra');
			case 'mistral':
				return this.createOpenAICompatible('mistral');
			case 'ollama':
				return this.createOpenAICompatible('ollama');
			case 'lmstudio':
				return new LMStudioProvider(this.httpOpts('lmstudio'));
			case 'custom':
				return this.createOpenAICompatible('custom');
			case 'anthropic':
				return new AnthropicProvider(this.httpOpts('anthropic'));
			case 'google-gemini':
				return new GeminiProvider(this.httpOpts('google-gemini'));
			case 'cohere':
				return new CohereProvider(this.httpOpts('cohere'));
		}
	}

	private createOpenAICompatible(id: ProviderId): OpenAICompatibleProvider {
		return new OpenAICompatibleProvider(this.httpOpts(id));
	}

	private httpOpts(id: ProviderId): BaseHttpProviderOptions {
		const meta = { ...PROVIDER_REGISTRY[id] };
		return {
			id, meta,
			getApiKey: () => {
				const settings = this.getSettings();
				const cred: Partial<ProviderCredentials> = settings.credentials[id] ?? {};
				return cred.apiKey ?? '';
			},
			getBaseUrl: () => this.getBaseUrl(id),
		};
	}
}