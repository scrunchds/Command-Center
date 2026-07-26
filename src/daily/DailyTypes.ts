import type { OnboardingConfig } from '../onboarding/OnboardingTypes';

export type MetricValue = number | string | boolean | null | undefined;
export type UserMetrics = Record<string, MetricValue>;

export interface EvaluatedCapacityRule {
	metric: string;
	value?: number;
	operator: 'below' | 'above';
	threshold: number;
	matched: boolean;
	action: string;
}

export interface CapacityProposal {
	enabled: boolean;
	level: 'neutral' | 'reduced' | 'expanded';
	currentPriorityCap: number;
	recommendedPriorityCap: number;
	matchedRules: EvaluatedCapacityRule[];
	missingMetrics: string[];
	recommendations: string[];
	proposalText: string;
	choices: Array<'accept' | 'adjust' | 'keep_configured_cap'>;
	/** A proposal is advisory until this is explicitly accepted by the caller/user. */
	requiresApproval: true;
}

export type InboxActionKind = 'move' | 'summarize_and_archive' | 'extract_and_delete' | 'leave';

export interface ExtractedTask {
	text: string;
	line: number;
	raw: string;
}

export interface InboxHandlingOption {
	action: InboxActionKind;
	label: string;
	description: string;
	suggestedTargetFolderPath?: string;
	destructive: boolean;
	requiresConfirmation: boolean;
}

export interface InboxTriageProposal {
	id: string;
	filePath: string;
	fileName: string;
	summary: string;
	frontmatter: Record<string, unknown>;
	tasks: ExtractedTask[];
	options: InboxHandlingOption[];
	proposalText: string;
	createdAt: number;
}

export interface InboxTriagerOptions {
	/** Optional user-configured archive destination; no destination is assumed. */
	archiveFolderPath?: string;
	/** Optional note that receives extracted tasks before source deletion. */
	extractedTasksPath?: string;
	/** Additional user-approved routing candidates. */
	candidateTargetFolders?: string[];
}

export interface TaskItem {
	id?: string;
	text: string;
	filePath: string;
	line?: number;
	completed?: boolean;
	/** Explicit task creation/rollover timestamp, preferred when available. */
	createdAt?: number | string | Date;
	/** Last date the task was intentionally deferred or rolled over. */
	rolloverAt?: number | string | Date;
	/** Source note creation time fallback. */
	noteCreatedAt?: number | string | Date;
	metadata?: Record<string, unknown>;
}

export type FrogAction = 'swallow_today' | 'break_down' | 'defer' | 'delete';

export interface FrogCandidate {
	task: TaskItem;
	ageDays: number;
	thresholdDays: number;
	reason: string;
	prompt: string;
	options: Array<{
		action: FrogAction;
		label: string;
		destructive: boolean;
		requiresConfirmation: boolean;
	}>;
}

export interface FrogDetectionResult {
	thresholdDays: number;
	auditedCount: number;
	candidates: FrogCandidate[];
	prompt: string;
	requiresReview: boolean;
}

/** Config shape accepted by capacity evaluation, retaining onboarding compatibility. */
export type DailyOperationalConfig = OnboardingConfig & {
	health: OnboardingConfig['health'] & { capacityTrackingEnabled?: boolean };
};
