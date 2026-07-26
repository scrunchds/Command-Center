import { App, normalizePath, TFile, TFolder } from 'obsidian';
import type { OnboardingConfig } from '../onboarding/OnboardingTypes';

export const CONFIG_DIRECTORY = '.command-center';
export const CONFIG_PATH = `${CONFIG_DIRECTORY}/config.json`;
export const STYLE_GUIDE_PATH = `${CONFIG_DIRECTORY}/style-guide.md`;

/** Validates and persists interview output without inventing operational defaults. */
export class ConfigSerializer {
	constructor(private readonly app: App) {}

	validate(value: unknown): OnboardingConfig {
		if (!isRecord(value)) throw new Error('Interview configuration must be an object.');
		const config = value as unknown as OnboardingConfig;
		const errors: string[] = [];
		if (!config.topology || !Array.isArray(config.topology.inboxFolders) || !config.topology.inboxFolders.length || !config.topology.dailyNotesFolder?.trim() || !config.topology.dailyNoteNameTemplate?.trim()) errors.push('topology');
		else {
			for (const path of config.topology.inboxFolders) this.assertSafePath(path);
			this.assertSafePath(config.topology.dailyNotesFolder);
		}
		if (!config.capacity || !Array.isArray(config.capacity.rules)) errors.push('capacity.rules');
		if (!config.triage || !['move', 'archive', 'delete', 'leave'].includes(config.triage.defaultAction) || !nonNegative(config.triage.frogRolloverThreshold)) errors.push('triage');
		else {
			if (config.triage.moveDestination) this.assertSafePath(config.triage.moveDestination);
			if (config.triage.archiveDestination) this.assertSafePath(config.triage.archiveDestination);
		}
		if (!config.compute || !Array.isArray(config.compute.endpoints)) errors.push('compute.endpoints');
		else for (const endpoint of config.compute.endpoints) {
			if (!endpoint?.id?.trim() || !['tier1_local', 'tier2_reasoning'].includes(endpoint.tier) || !endpoint.provider?.trim() || !validUrl(endpoint.baseUrl) || !endpoint.model?.trim() || !positive(endpoint.timeoutMs) || !endpoint.completionPath?.trim() || !['openai-compatible', 'anthropic', 'gemini'].includes(endpoint.protocol)) errors.push('compute.endpoints');
			if (hasSecret(endpoint)) errors.push('compute endpoint contains secret-like fields');
		}
		if (!Array.isArray(config.managedFolders) || !config.managedFolders.length) errors.push('managedFolders');
		else for (const folder of config.managedFolders) {
			if (!folder?.path?.trim() || !folder?.purpose?.trim() || !(folder.scope?.trim() || folder.contentTypes?.length)) errors.push('managedFolders.path/purpose/scope');
			else this.assertSafePath(folder.path);
		}
		if (!config.dailyNotes?.pathTemplate?.trim()) errors.push('dailyNotes.pathTemplate');
		else this.assertSafePath(config.dailyNotes.pathTemplate);
		if (!config.inbox?.path?.trim()) errors.push('inbox.path');
		else this.assertSafePath(config.inbox.path);
		if (!config.health || !Array.isArray(config.health.trackedMetrics) || !Array.isArray(config.health.capacityRules)) errors.push('health');
		else for (const rule of config.health.capacityRules) if (!rule?.metric?.trim() || !['below', 'above'].includes(rule.operator) || !finite(rule.threshold) || !rule.action?.trim()) errors.push('health.capacityRules');
		if (!config.focus || !positive(config.focus.defaultPriorityCap) || !nonNegative(config.focus.frogThresholdDays) || !positive(config.focus.maxDailyPriorities)) errors.push('focus thresholds/caps');
		if (config.focus?.quickWinsEnabled && (!positive(config.focus.quickWinCount) || !positive(config.focus.quickWinMaxMinutes))) errors.push('focus quick-win rules');
		if (!config.style?.writingStyle?.trim() || !config.style?.agentPersona?.trim()) errors.push('style');
		if (containsSecretMaterial(config)) errors.push('credential or endpoint material is not permitted in generated configuration');
		if (!config.tasks?.trackingMethod?.trim() || !config.tasks.statusProperty?.trim()) errors.push('tasks');
		for (const asset of [...(config.activeTemplates ?? []), ...(config.enabledWorkflows ?? [])]) {
			if (!asset?.id?.trim() || !asset.name?.trim() || !asset.path?.trim()) errors.push('generated assets');
			else this.assertSafePath(asset.path);
		}
		if (errors.length) throw new Error(`Interview is incomplete: ${[...new Set(errors)].join(', ')}.`);
		return { ...config, schemaVersion: 1, completedAt: new Date().toISOString() };
	}

	async serialize(value: unknown): Promise<OnboardingConfig> {
		const config = this.validate(value);
		await this.ensureDirectory();
		await this.upsert(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
		await this.upsert(STYLE_GUIDE_PATH, this.renderStyleGuide(config));
		return config;
	}

	private renderStyleGuide(config: OnboardingConfig): string {
		return `<!-- COMMAND CENTER GENERATED FILE: INTERVIEW IS THE SOURCE OF TRUTH. -->\n# Command Center Style Guide\n\n_Generated ${config.completedAt}_\n\n## Writing Style\n\n${config.style.writingStyle}\n\n## Formatting Directives\n\n${list(config.style.formattingDirectives)}\n\n## Daily Note Layout\n\n${list(config.style.dailyNoteLayout)}\n\n## Timestamped Log Convention\n\n${config.style.timestampConvention?.trim() || 'No interview-defined timestamp convention.'}\n\n## Reflection Prompts\n\n${list(config.style.reflectionPrompts)}\n\n## Agent Persona\n\n${config.style.agentPersona}\n\n## Vocabulary to Use\n\n${list(config.style.termsToUse)}\n\n## Vocabulary to Avoid\n\n${list(config.style.termsToAvoid)}\n`;
	}

	private assertSafePath(value: string): void {
		const path = normalizePath(value.trim().replace(/^\/+|\/+$/g, ''));
		if (!path || path === '.' || path.startsWith('../') || path.includes('/../') || path === CONFIG_DIRECTORY) throw new Error(`Unsafe configured path: ${value}`);
	}
	private async ensureDirectory(): Promise<void> {
		const entry = this.app.vault.getAbstractFileByPath(CONFIG_DIRECTORY);
		if (entry instanceof TFolder) return;
		if (entry) throw new Error(`${CONFIG_DIRECTORY} is not a folder.`);
		await this.app.vault.createFolder(CONFIG_DIRECTORY);
	}
	private async upsert(path: string, content: string): Promise<void> {
		const entry = this.app.vault.getAbstractFileByPath(path);
		if (entry instanceof TFile) await this.app.vault.modify(entry, content);
		else if (entry) throw new Error(`${path} is not a file.`);
		else await this.app.vault.create(path, content);
	}
}

function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function nonNegative(value: unknown): boolean { return finite(value) && value >= 0; }
function positive(value: unknown): boolean { return finite(value) && value > 0; }
function validUrl(value: unknown): boolean { if (typeof value !== 'string') return false; try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:'; } catch { return false; } }
function hasSecret(value: unknown): boolean { return isRecord(value) && Object.keys(value).some(key => /api.?key|password|token|secret|authorization/i.test(key) && key !== 'credentialRef'); }
function containsSecretMaterial(value: unknown, key = ''): boolean {
	if (/api.?key|password|passphrase|access.?token|secret|authorization/i.test(key) && key !== 'credentialRef') return true;
	if (typeof value === 'string') return /\b(?:sk|xox[baprs]|gh[pousr])[-_][A-Za-z0-9_-]{10,}\b|\b[A-Za-z0-9_-]{28,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/i.test(value);
	if (Array.isArray(value)) return value.some(item => containsSecretMaterial(item));
	return isRecord(value) && Object.entries(value).some(([childKey, child]) => containsSecretMaterial(child, childKey));
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function list(values: string[] | undefined): string { return values?.length ? values.map(value => `- ${value}`).join('\n') : '- No interview-defined terms.'; }
