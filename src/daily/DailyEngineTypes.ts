import type { OnboardingConfig } from '../onboarding/OnboardingTypes';
import type {
	CapacityProposal, FrogAction, FrogDetectionResult, InboxActionKind,
	InboxTriageProposal, TaskItem,
} from './DailyTypes';

export type DailyPhase = 'morning' | 'midday' | 'evening';
export type DailyCycleStatus = 'not_started' | 'morning_open' | 'active' | 'closing' | 'closed';

export interface DailyPhasePrompt {
	phase: DailyPhase;
	tone: 'precise' | 'warm' | 'technical' | 'minimalist';
	context: string[];
	questions: string[];
	markdown: string;
}

export interface DailyNoteLocation {
	/** Vault-relative folder or a date-token template. */
	pathTemplate: string;
	/** Optional date used for deterministic execution/testing. */
	date?: Date;
}

export interface ApprovedInboxAction {
	proposalId: string;
	action: InboxActionKind;
	targetFolderPath?: string;
}

export interface ScheduleBlock {
	label: string;
	start?: string;
	end?: string;
	description?: string;
}

export interface MorningPhaseInput {
	config: OnboardingConfig;
	location: DailyNoteLocation;
	inboxFolderPath?: string;
	metrics?: Record<string, unknown>;
	vaultTasks?: TaskItem[];
	priorities?: string[];
	/** User-selected cap. When omitted the engine presents the recommendation. */
	approvedPriorityCap?: number;
	quickWins?: string[];
	schedule?: ScheduleBlock[];
	approvedInboxActions?: ApprovedInboxAction[];
}

export interface MorningInterviewProposal {
	prompt: string;
	capacity: CapacityProposal;
	inbox: InboxTriageProposal[];
	frogs: FrogDetectionResult;
	priorityCap: number;
	priorityOverflow: string[];
	quickWinsRequested: boolean;
	questions: string[];
	masterPrompt: DailyPhasePrompt;
	missingReadinessMetrics: string[];
}

export interface MorningExecutionResult extends MorningInterviewProposal {
	phase: 'morning';
	notePath: string;
	created: boolean;
	executedInboxActions: number;
	warnings: string[];
}

export interface MiddayPhaseInput {
	location: DailyNoteLocation;
	entry: string;
	source?: 'text' | 'voice' | 'task-update';
	timestamp?: Date;
}

export interface MiddayExecutionResult {
	phase: 'midday';
	notePath: string;
	appended: string;
	timestamp: string;
}

export type ReconciliationAction = 'complete' | 'rollover' | 'discard' | 'leave_open';

export interface ApprovedTaskReconciliation {
	/** Exact task text, excluding checkbox syntax. */
	taskText: string;
	action: ReconciliationAction;
}

export interface EveningPhaseInput {
	config: OnboardingConfig;
	location: DailyNoteLocation;
	finalMetrics?: Record<string, unknown>;
	reflection?: string;
	approvedReconciliations?: ApprovedTaskReconciliation[];
	tomorrowPriorityCandidates?: string[];
	timestamp?: Date;
}

export interface DailyTaskAudit {
	completed: TaskItem[];
	open: TaskItem[];
}

export interface EveningProposal {
	phase: 'evening';
	notePath: string;
	audit: DailyTaskAudit;
	reflectionQuestion: string;
	prompt: string;
	masterPrompt: DailyPhasePrompt;
}

export interface EveningExecutionResult {
	phase: 'evening';
	notePath: string;
	audit: DailyTaskAudit;
	prompt: string;
	reflectionQuestion: string;
	appliedReconciliations: number;
	unresolvedTasks: TaskItem[];
	tomorrowPriorityCandidates: string[];
	tomorrowNotePath?: string;
	warnings: string[];
}

export interface DailyCycleState {
	date: string;
	notePath: string;
	status: DailyCycleStatus;
	lastPhase?: DailyPhase;
	updatedAt: number;
}

export interface MasterDailyContext {
	styleGuide: string;
	config: OnboardingConfig;
	capacity?: CapacityProposal;
	inbox?: InboxTriageProposal[];
	frogs?: FrogDetectionResult;
}

export interface FrogDecision {
	taskId?: string;
	taskText: string;
	action: FrogAction;
}
