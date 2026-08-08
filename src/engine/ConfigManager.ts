import { App, TFile } from 'obsidian';
import type { ComputeEndpointConfig, OnboardingConfig } from '../onboarding/OnboardingTypes';
import { ConfigSerializer, CONFIG_PATH, STYLE_GUIDE_PATH } from './ConfigSerializer';

/** Sole runtime gateway to interview-derived operational configuration. */
export class ConfigManager {
	private config: OnboardingConfig | null = null;
	private styleGuide: string | null = null;
	private readonly serializer: ConfigSerializer;

	constructor(private readonly app: App) { this.serializer = new ConfigSerializer(app); }

	async load(): Promise<OnboardingConfig | null> {
		const file = this.app.vault.getAbstractFileByPath(CONFIG_PATH);
		if (!(file instanceof TFile)) { this.clearRuntime(); return null; }
		try {
			this.config = this.serializer.validate(JSON.parse(await this.app.vault.read(file)) as unknown);
			this.styleGuide = await this.readStyleGuide();
			if (!this.styleGuide) throw new Error('Style guide is missing.');
			return this.config;
		} catch (error) {
			this.clearRuntime();
			console.warn('[CC] Interview configuration is invalid:', error);
			return null;
		}
	}

	isInitialized(): boolean { return this.config !== null && Boolean(this.styleGuide); }
	validate(value: unknown): OnboardingConfig { return this.serializer.validate(value); }
	requireConfig(): OnboardingConfig { if (!this.config) throw new Error('Command Center is uninitialized. Complete the conversational interview first.'); return this.config; }
	requireStyleGuide(): string { if (!this.styleGuide) throw new Error('Command Center style guide is unavailable. Complete the conversational interview first.'); return this.styleGuide; }

	/**
	 * Non-throwing style-guide accessor for features that stay usable before
	 * onboarding completes (chat, workflows, task execution). Returns an empty
	 * style guide when the interview has not been run, so prompt builders get
	 * a safe default instead of an 'uninitialized' error. Use `requireStyleGuide()`
	 * only for features that genuinely cannot operate without a style guide.
	 */
	getStyleGuide(): string { return this.styleGuide ?? ''; }
	getComputeEndpoints(tier?: ComputeEndpointConfig['tier']): ComputeEndpointConfig[] {
		const endpoints = this.requireConfig().compute.endpoints.filter(endpoint => endpoint.enabled);
		return endpoints.filter(endpoint => !tier || endpoint.tier === tier).map(endpoint => ({ ...endpoint }));
	}

	async save(value: unknown): Promise<OnboardingConfig> {
		this.config = await this.serializer.serialize(value);
		this.styleGuide = await this.readStyleGuide();
		return this.config;
	}

	clearRuntime(): void { this.config = null; this.styleGuide = null; }

	async reset(): Promise<void> {
		this.clearRuntime();
		for (const path of [CONFIG_PATH, STYLE_GUIDE_PATH]) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) await this.app.fileManager.trashFile(file);
		}
	}

	/** Drop cached state while preserving files; used before rebuilding runtime services. */
	invalidate(): void { this.clearRuntime(); }

	private async readStyleGuide(): Promise<string | null> {
		const file = this.app.vault.getAbstractFileByPath(STYLE_GUIDE_PATH);
		return file instanceof TFile ? this.app.vault.cachedRead(file) : null;
	}
}
