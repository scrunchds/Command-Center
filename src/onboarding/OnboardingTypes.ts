/** Structured preferences collected by the Command Center onboarding interview. */

export const ONBOARDING_COMPLETE_SIGNAL = 'ONBOARDING_COMPLETE_SIGNAL';
export const ONBOARDING_SCHEMA_VERSION = 1 as const;

export type WritingStyle = 'precise-tactical' | 'warm-conversational' | 'technical-analytical' | 'minimalist';
export type AgentPersona = 'sober-direct-peer' | 'drill-instructor' | 'consultative-coach';
export type InboxHandling = 'move' | 'summarize-archive' | 'extract-delete';
export type FrogPolicy = 'force-first' | 'accountability-challenge' | 'banner';
export type MetricsInputStyle = 'morning-dictation' | 'vault-scan' | 'both';
export type TaskTrackingMethod = 'markdown-checkboxes' | 'yaml-agent-status' | 'obsidian-base-properties';

export interface LifeDomain {
	name: string;
	description?: string;
}

export interface ActiveProject {
	name: string;
	timeHorizonDays: number;
	doneDefinition: string;
	domain?: string;
}

export interface CapacityRule {
	metric: string;
	operator: 'below' | 'above';
	threshold: number;
	action: string;
	/** Optional normalized scoring bounds and influence, collected by interview. */
	min?: number;
	max?: number;
	weight?: number;
	/** Set false when lower metric values indicate greater readiness. */
	higherIsBetter?: boolean;
}

export interface ManagedFolder {
	path: string;
	purpose: string;
	scope?: string;
	contentTypes?: string[];
}

export interface GeneratedAssetSelection {
	id: string;
	name: string;
	path: string;
}

export interface ComputeEndpointConfig {
	id: string;
	tier: 'tier1_local' | 'tier2_reasoning';
	provider: string;
	baseUrl: string;
	model: string;
	timeoutMs: number;
	completionPath: string;
	protocol: 'openai-compatible' | 'anthropic' | 'gemini';
	credentialRef?: string;
	enabled: boolean;
	maxRetries?: number;
	backoffMs?: number;
}

export interface OnboardingConfig {
	schemaVersion: typeof ONBOARDING_SCHEMA_VERSION;
	completedAt: string;
	/** Canonical runtime topology; every path is interview-derived. */
	topology: {
		inboxFolders: string[];
		dailyNotesFolder: string;
		dailyNoteNameTemplate: string;
	};
	capacity: {
		rules: CapacityRule[];
	};
	triage: {
		defaultAction: 'move' | 'archive' | 'delete' | 'leave';
		moveDestination?: string;
		archiveDestination?: string;
		frogRolloverThreshold: number;
	};
	/** Non-secret endpoint metadata. Credentials remain in Plugin Settings. */
	compute: {
		endpoints: ComputeEndpointConfig[];
	};
	lifeDomains: LifeDomain[];
	activeProjects: ActiveProject[];
	health: {
		trackedMetrics: string[];
		inputStyle: MetricsInputStyle;
		scanPath?: string;
		capacityRules: CapacityRule[];
	};
	dailyNotes: {
		pathTemplate: string;
	};
	inbox: {
		path: string;
		handling: InboxHandling;
		archivePath?: string;
	};
	focus: {
		defaultPriorityCap: number;
		frogThresholdDays: number;
		frogPolicy: FrogPolicy;
		quickWinsEnabled: boolean;
		quickWinCount: number;
		quickWinMaxMinutes: number;
		maxDailyPriorities: number;
	};
	style: {
		writingStyle: WritingStyle;
		agentPersona: AgentPersona;
		termsToUse: string[];
		termsToAvoid: string[];
		/** Optional interview-derived daily-note structure and conventions. */
		dailyNoteLayout?: string[];
		timestampConvention?: string;
		reflectionPrompts?: string[];
		formattingDirectives?: string[];
	};
	tasks: {
		trackingMethod: TaskTrackingMethod;
		statusProperty: string;
	};
	managedFolders: ManagedFolder[];
	/** Approved assets generated during post-interview synthesis. */
	activeTemplates?: GeneratedAssetSelection[];
	enabledWorkflows?: GeneratedAssetSelection[];
}

export interface OnboardingCompletionEnvelope {
	signal: typeof ONBOARDING_COMPLETE_SIGNAL;
	config: Partial<OnboardingConfig>;
}

export interface OnboardingTurn {
	role: 'user' | 'assistant';
	content: string;
}

