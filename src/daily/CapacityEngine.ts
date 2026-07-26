import { App, TFile } from 'obsidian';
import type { OnboardingConfig } from '../onboarding/OnboardingTypes';
import type {
	CapacityProposal, DailyOperationalConfig, EvaluatedCapacityRule, FrogCandidate,
	FrogDetectionResult, MetricValue, TaskItem, UserMetrics,
} from './DailyTypes';

const STYLE_GUIDE_PATH = '.command-center/style-guide.md';
const DAY_MS = 86_400_000;

/** Advisory capacity and delayed-task evaluator. It never mutates tasks or priorities. */
export class CapacityEngine {
	private styleGuide = '';

	constructor(private readonly app?: App) {}

	/** Load the user's generated style directives for proposal wording. */
	async ready(): Promise<void> {
		if (!this.app) return;
		const file = this.app.vault.getAbstractFileByPath(STYLE_GUIDE_PATH);
		if (file instanceof TFile) this.styleGuide = await this.app.vault.cachedRead(file);
	}

	proposeDailyCapacity(userMetrics: Record<string, unknown>, userRules: OnboardingConfig): CapacityProposal {
		const config = userRules as DailyOperationalConfig;
		const rules = config.health?.capacityRules ?? [];
		const enabled = config.health?.capacityTrackingEnabled !== false && rules.length > 0;
		const configuredCap = positiveInteger(config.focus?.maxDailyPriorities);
		if (!enabled) return {
			enabled: false, level: 'neutral', currentPriorityCap: configuredCap,
			recommendedPriorityCap: configuredCap, matchedRules: [], missingMetrics: [], recommendations: [],
			proposalText: this.style(`No active capacity rules were configured. Keep the configured priority cap of ${configuredCap}, or adjust it manually.`),
			choices: ['accept', 'adjust', 'keep_configured_cap'], requiresApproval: true,
		};

		const normalizedMetrics = normalizeMetrics(userMetrics);
		const evaluated: EvaluatedCapacityRule[] = rules.map(rule => {
			const raw = findMetric(normalizedMetrics, rule.metric);
			const value = numericMetric(raw);
			return {
				metric: rule.metric, value, operator: rule.operator, threshold: rule.threshold,
				matched: value !== undefined && (rule.operator === 'below' ? value < rule.threshold : value > rule.threshold),
				action: rule.action,
			};
		});
		const missingMetrics = evaluated.filter(rule => rule.value === undefined).map(rule => rule.metric);
		const matched = evaluated.filter(rule => rule.matched);
		const recommendations = matched.map(rule => rule.action);
		const explicitCaps = recommendations.map(parsePriorityCap).filter((value): value is number => value !== undefined);
		const recommended = explicitCaps.length ? Math.min(configuredCap, ...explicitCaps) : configuredCap;
		const level: CapacityProposal['level'] = matched.length ? 'reduced' : 'neutral';
		const evidence = matched.map(rule => `${rule.metric} ${rule.value} (${rule.operator} ${rule.threshold})`).join('; ');
		const missing = missingMetrics.length ? ` Missing metrics: ${missingMetrics.join(', ')}; no assumption was made for them.` : '';
		const recommendation = matched.length
			? `Based on ${evidence}, recommend a priority cap of ${recommended}. ${recommendations.join(' ')}`
			: `No configured capacity threshold was crossed. Keep the configured priority cap of ${configuredCap}.`;
		return {
			enabled: true, level, currentPriorityCap: configuredCap, recommendedPriorityCap: recommended,
			matchedRules: evaluated, missingMetrics, recommendations,
			proposalText: this.style(`${recommendation}${missing} Accept recommendation or adjust?`),
			choices: ['accept', 'adjust', 'keep_configured_cap'], requiresApproval: true,
		};
	}

	detectDelayedItems(vaultTaskNodes: TaskItem[], rolloverThresholdDays: number): FrogDetectionResult {
		const threshold = Math.max(0, Math.floor(Number.isFinite(rolloverThresholdDays) ? rolloverThresholdDays : 0));
		const now = Date.now();
		const incomplete = vaultTaskNodes.filter(task => !task.completed);
		const candidates: FrogCandidate[] = [];
		for (const task of incomplete) {
			const origin = firstValidDate(task.rolloverAt, task.createdAt, task.noteCreatedAt, task.metadata?.createdAt, task.metadata?.date);
			if (origin === undefined) continue; // Neutral: unknown age is never treated as overdue.
			const ageDays = Math.max(0, Math.floor((startOfLocalDay(now) - startOfLocalDay(origin)) / DAY_MS));
			if (ageDays < threshold) continue;
			const source = `${task.filePath}${task.line ? `:${task.line}` : ''}`;
			candidates.push({
				task, ageDays, thresholdDays: threshold,
				reason: `Incomplete for ${ageDays} day${ageDays === 1 ? '' : 's'}; configured threshold is ${threshold}.`,
				prompt: this.style(`“${task.text}” (${source}) crossed the rollover threshold. Choose an action; nothing changes until approved.`),
				options: [
					{ action: 'swallow_today', label: 'Swallow Frog today', destructive: false, requiresConfirmation: true },
					{ action: 'break_down', label: 'Break down task', destructive: false, requiresConfirmation: true },
					{ action: 'defer', label: 'Defer', destructive: false, requiresConfirmation: true },
					{ action: 'delete', label: 'Delete', destructive: true, requiresConfirmation: true },
				],
			});
		}
		candidates.sort((a, b) => b.ageDays - a.ageDays || a.task.text.localeCompare(b.task.text));
		return {
			thresholdDays: threshold, auditedCount: incomplete.length, candidates,
			prompt: this.style(candidates.length
				? `${candidates.length} delayed item${candidates.length === 1 ? '' : 's'} crossed the configured ${threshold}-day threshold. Review: Swallow Frog today, Break down, Defer, or Delete.`
				: `No incomplete task with a known date crossed the configured ${threshold}-day threshold.`),
			requiresReview: candidates.length > 0,
		};
	}

	private style(text: string): string {
		if (/minimalist/i.test(this.styleGuide)) return text.replace(/\bBased on\b/i, 'From').replace(/; no assumption was made for them/g, '');
		if (/warm/i.test(this.styleGuide)) return `Review: ${text}`;
		if (/technical|analytical/i.test(this.styleGuide)) return `Capacity analysis — ${text}`;
		return text;
	}
}

function normalizeMetrics(metrics: Record<string, unknown>): UserMetrics {
	return Object.fromEntries(Object.entries(metrics).map(([key, value]) => [normalizeKey(key), isMetricValue(value) ? value : undefined]));
}
function normalizeKey(value: string): string { return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
function findMetric(metrics: UserMetrics, name: string): MetricValue { const key = normalizeKey(name); if (key in metrics) return metrics[key]; const entry = Object.entries(metrics).find(([candidate]) => candidate.includes(key) || key.includes(candidate)); return entry?.[1]; }
function isMetricValue(value: unknown): value is MetricValue { return value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value); }
function numericMetric(value: MetricValue): number | undefined { if (typeof value === 'number') return Number.isFinite(value) ? value : undefined; if (typeof value === 'boolean') return value ? 1 : 0; if (typeof value !== 'string') return undefined; const match = /-?\d+(?:\.\d+)?/.exec(value); return match ? Number(match[0]) : undefined; }
function positiveInteger(value: unknown): number { const number = Number(value); if (!Number.isFinite(number) || number <= 0) throw new Error('Daily priority cap is missing from interview configuration.'); return Math.floor(number); }
function parsePriorityCap(action: string): number | undefined { const patterns = [/(?:cap|limit|max(?:imum)?)\D{0,25}(\d+)/i, /(\d+)\s+(?:priorit|non-negotiable)/i]; for (const pattern of patterns) { const match = pattern.exec(action); if (match?.[1]) return Math.max(1, Number(match[1])); } return undefined; }
function firstValidDate(...values: unknown[]): number | undefined { for (const value of values) { if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime(); if (typeof value === 'number' && Number.isFinite(value)) return value; if (typeof value === 'string' && value.trim()) { const parsed = Date.parse(value); if (Number.isFinite(parsed)) return parsed; } } return undefined; }
function startOfLocalDay(timestamp: number): number { const date = new Date(timestamp); return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(); }
