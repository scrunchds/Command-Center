import { App, normalizePath, TFile, TFolder } from 'obsidian';
import type { CapacityRule, ComputeEndpointConfig, FrogPolicy, InboxHandling, MetricsInputStyle, OnboardingConfig, TaskTrackingMethod, WritingStyle, AgentPersona } from '../onboarding/OnboardingTypes';

export const CONFIG_DIRECTORY = '.command-center';
export const CONFIG_PATH = `${CONFIG_DIRECTORY}/config.json`;
export const STYLE_GUIDE_PATH = `${CONFIG_DIRECTORY}/style-guide.md`;

/** Validates and persists interview output without inventing operational defaults. */
export class ConfigSerializer {
	constructor(private readonly app: App) {}

	validate(value: unknown): OnboardingConfig {
		if (!isRecord(value)) throw new Error('Interview configuration must be an object.');
		const config = value as Partial<OnboardingConfig>;
		const errors: string[] = [];

		if (config.schemaVersion !== 1) errors.push('schemaVersion');
		if (!isValidTimestamp(config.completedAt)) errors.push('completedAt');

		if (!config.topology || !Array.isArray(config.topology.inboxFolders) || !config.topology.inboxFolders.length || !isNonEmptyString(config.topology.dailyNotesFolder) || !isNonEmptyString(config.topology.dailyNoteNameTemplate)) {
			errors.push('topology');
		} else {
			for (const path of config.topology.inboxFolders) this.assertSafePath(path);
			this.assertSafePath(config.topology.dailyNotesFolder);
		}

		if (!config.capacity || !Array.isArray(config.capacity.rules) || !config.capacity.rules.length || config.capacity.rules.some(rule => !isCapacityRule(rule))) {
			errors.push('capacity.rules');
		}

		if (!config.triage || !['move', 'archive', 'delete', 'leave'].includes(config.triage.defaultAction) || !nonNegative(config.triage.frogRolloverThreshold)) {
			errors.push('triage');
		} else {
			if (config.triage.moveDestination) this.assertSafePath(config.triage.moveDestination);
			if (config.triage.archiveDestination) this.assertSafePath(config.triage.archiveDestination);
		}

		if (!config.compute || !Array.isArray(config.compute.endpoints) || config.compute.endpoints.some(endpoint => !isComputeEndpoint(endpoint))) {
			errors.push('compute.endpoints');
		}

		if (!Array.isArray(config.lifeDomains) || !config.lifeDomains.length || config.lifeDomains.some(domain => !isLifeDomain(domain))) {
			errors.push('lifeDomains');
		}

		if (!Array.isArray(config.activeProjects) || !config.activeProjects.length || config.activeProjects.some(project => !isActiveProject(project))) {
			errors.push('activeProjects');
		}

		if (!config.health || !Array.isArray(config.health.trackedMetrics) || config.health.trackedMetrics.some(metric => !isNonEmptyString(metric)) || !isMetricsInputStyle(config.health.inputStyle) || !Array.isArray(config.health.capacityRules) || config.health.capacityRules.some(rule => !isCapacityRule(rule))) {
			errors.push('health');
		} else if (config.health.scanPath) {
			this.assertSafePath(config.health.scanPath);
		}

		if (!config.focus || !positive(config.focus.defaultPriorityCap) || !nonNegative(config.focus.frogThresholdDays) || !isFrogPolicy(config.focus.frogPolicy) || typeof config.focus.quickWinsEnabled !== 'boolean' || !positive(config.focus.maxDailyPriorities)) {
			errors.push('focus');
		} else if (config.focus.quickWinsEnabled && (!positive(config.focus.quickWinCount) || !positive(config.focus.quickWinMaxMinutes))) {
			errors.push('focus quick-win rules');
		}

		if (!config.style || !isWritingStyle(config.style.writingStyle) || !isAgentPersona(config.style.agentPersona) || !isStringArray(config.style.termsToUse) || !isStringArray(config.style.termsToAvoid)) {
			errors.push('style');
		} else {
			if (config.style.dailyNoteLayout && !isStringArray(config.style.dailyNoteLayout)) errors.push('style.dailyNoteLayout');
			if (config.style.reflectionPrompts && !isStringArray(config.style.reflectionPrompts)) errors.push('style.reflectionPrompts');
			if (config.style.formattingDirectives && !isStringArray(config.style.formattingDirectives)) errors.push('style.formattingDirectives');
		}

		if (!config.tasks || !isTaskTrackingMethod(config.tasks.trackingMethod) || !isNonEmptyString(config.tasks.statusProperty)) {
			errors.push('tasks');
		}

		if (!config.dailyNotes?.pathTemplate || !isNonEmptyString(config.dailyNotes.pathTemplate)) errors.push('dailyNotes.pathTemplate');
		else this.assertSafePath(config.dailyNotes.pathTemplate);

		if (!config.inbox || !isNonEmptyString(config.inbox.path) || !isInboxHandling(config.inbox.handling)) errors.push('inbox');
		else {
			this.assertSafePath(config.inbox.path);
			if (config.inbox.archivePath) this.assertSafePath(config.inbox.archivePath);
		}

		if (!Array.isArray(config.managedFolders) || !config.managedFolders.length || config.managedFolders.some(folder => !isManagedFolder(folder))) {
			errors.push('managedFolders');
		} else {
			for (const folder of config.managedFolders) this.assertSafePath(folder.path);
		}

		if (!isStringArray(config.activeTemplates)) {
			if (config.activeTemplates !== undefined) errors.push('activeTemplates');
		}
		if (!isStringArray(config.enabledWorkflows)) {
			if (config.enabledWorkflows !== undefined) errors.push('enabledWorkflows');
		}

		if (config.compute?.endpoints) {
			for (const endpoint of config.compute.endpoints) {
				if (hasSecret(endpoint)) errors.push('compute endpoint contains secret-like fields');
			}
		}
		if (containsSecretMaterial(config)) errors.push('credential or endpoint material is not permitted in generated configuration');

		if (errors.length) throw new Error(`Interview is incomplete: ${[...new Set(errors)].join(', ')}.`);
		return config as OnboardingConfig;
	}

	async serialize(value: unknown): Promise<OnboardingConfig> {
		const validated = this.validate(value);
		const config: OnboardingConfig = { ...validated, schemaVersion: 1, completedAt: new Date().toISOString() };
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
function isValidTimestamp(value: unknown): value is string { return typeof value === 'string' && !Number.isNaN(Date.parse(value)); }
function validUrl(value: unknown): boolean { if (typeof value !== 'string') return false; try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:'; } catch { return false; } }
function hasSecret(value: unknown): boolean { return isRecord(value) && Object.keys(value).some(key => /api.?key|password|token|secret|authorization/i.test(key) && key !== 'credentialRef'); }
function containsSecretMaterial(value: unknown, key = ''): boolean {
	if (/api.?key|password|passphrase|access.?token|secret|authorization/i.test(key) && key !== 'credentialRef') return true;
	if (typeof value === 'string') return /\b(?:sk|xox[baprs]|gh[pousr])[-_][A-Za-z0-9_-]{10,}\b|\b[A-Za-z0-9_-]{28,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/i.test(value);
	if (Array.isArray(value)) return value.some(item => containsSecretMaterial(item));
	return isRecord(value) && Object.entries(value).some(([childKey, child]) => containsSecretMaterial(child, childKey));
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim().length > 0); }
function isNonEmptyString(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function isMetricsInputStyle(value: unknown): value is MetricsInputStyle { return value === 'morning-dictation' || value === 'vault-scan' || value === 'both'; }
function isFrogPolicy(value: unknown): value is FrogPolicy { return value === 'force-first' || value === 'accountability-challenge' || value === 'banner'; }
function isWritingStyle(value: unknown): value is WritingStyle { return value === 'precise-tactical' || value === 'warm-conversational' || value === 'technical-analytical' || value === 'minimalist'; }
function isAgentPersona(value: unknown): value is AgentPersona { return value === 'sober-direct-peer' || value === 'drill-instructor' || value === 'consultative-coach'; }
function isTaskTrackingMethod(value: unknown): value is TaskTrackingMethod { return value === 'markdown-checkboxes' || value === 'yaml-agent-status' || value === 'obsidian-base-properties'; }
function isInboxHandling(value: unknown): value is InboxHandling { return value === 'move' || value === 'summarize-archive' || value === 'extract-delete'; }
function isManagedFolder(value: unknown): value is { path: string; purpose: string; scope?: string; contentTypes?: string[] } {
	return isRecord(value) && isNonEmptyString(value.path) && isNonEmptyString(value.purpose) && (isNonEmptyString(value.scope) || isStringArray(value.contentTypes)) && (!value.contentTypes || isStringArray(value.contentTypes));
}
function isLifeDomain(value: unknown): boolean { return isRecord(value) && isNonEmptyString(value.name) && (value.description === undefined || isNonEmptyString(value.description)); }
function isActiveProject(value: unknown): boolean { return isRecord(value) && isNonEmptyString(value.name) && positive(value.timeHorizonDays) && isNonEmptyString(value.doneDefinition) && (value.domain === undefined || isNonEmptyString(value.domain)); }
function isCapacityRule(value: unknown): value is CapacityRule {
	return isRecord(value)
		&& isNonEmptyString(value.metric)
		&& (value.operator === 'below' || value.operator === 'above')
		&& finite(value.threshold)
		&& isNonEmptyString(value.action)
		&& (value.min === undefined || finite(value.min))
		&& (value.max === undefined || finite(value.max))
		&& (value.weight === undefined || finite(value.weight))
		&& (value.higherIsBetter === undefined || typeof value.higherIsBetter === 'boolean');
}
function isComputeEndpoint(value: unknown): value is ComputeEndpointConfig {
	return isRecord(value)
		&& isNonEmptyString(value.id)
		&& (value.tier === 'tier1_local' || value.tier === 'tier2_reasoning')
		&& isNonEmptyString(value.provider)
		&& validUrl(value.baseUrl)
		&& isNonEmptyString(value.model)
		&& positive(value.timeoutMs)
		&& isNonEmptyString(value.completionPath)
		&& (value.protocol === 'openai-compatible' || value.protocol === 'anthropic' || value.protocol === 'gemini')
		&& typeof value.enabled === 'boolean'
		&& (value.maxRetries === undefined || nonNegative(value.maxRetries))
		&& (value.backoffMs === undefined || nonNegative(value.backoffMs))
		&& (value.credentialRef === undefined || isNonEmptyString(value.credentialRef));
}
function list(values: string[] | undefined): string { return values?.length ? values.map(value => `- ${value}`).join('\n') : '- No interview-defined terms.'; }
