/**
 * Provider Factory — dynamically instantiates provider adapters based on configuration.
 *
 * Each provider gets its own adapter instance. The factory resolves API keys,
 * base URLs, and other config from the MultiProviderSettings at call time
 * (lazy resolution) so that settings changes take effect immediately.
 */

import type {
	IProviderAdapter, ProviderId, MultiProviderSettings,
	ProviderCredentials,
} from './provider-types';
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
		return credentials?.baseUrl || PROVIDER_REGISTRY[id].defaultBaseUrl || '';
	}

	/** List all available (configured + enabled) providers. */
	listAvailable(): IProviderAdapter[] {
		return Object.keys(PROVIDER_REGISTRY)
			.map(id => this.get(id as ProviderId))
			.filter(p => p.isAvailable());
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