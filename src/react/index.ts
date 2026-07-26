/**
 * ReAct (Reasoning + Acting) module — barrel export.
 *
 * Types define the shared context structure for multi-agent ReAct sessions.
 * Every agent (orchestrator and workers) can reason, act, observe, and refine.
 * The execution loop lives in `PiAgentDaemon`.
 */

export { DEFAULT_REACT_CONFIG } from './react-types';
export type {
	ReActContext,
	ReActCycle,
	ReActThought,
	ReActAction,
	ReActObservation,
	ReActConfig,
	ReActMeta,
	ReActTermination,
	ReActResponse,
	AgentReActConfig,
	WorkerReActResult,
	ValidationEvent,
	ValidationOutcome,
	ValidationSeverity,
} from './react-types';
export {
	ReActTraceCollector,
} from './react-trace';
export {
	ReActMemoryBank,
} from './react-memory';
export {
	getRole,
	listRoles,
	findRolesByCapability,
	buildRoleCatalog,
	buildRolePrompt,
	filterToolsForRole,
	registerDynamicRole,
	unregisterDynamicRole,
	listDynamicRoles,
	buildDynamicRoleCreationPrompt,
	tryRegisterDynamicRole,
} from './react-roles';
export type {
	AgentRole,
} from './react-roles';
export {
	ReActEvaluator,
} from './react-eval';
export type {
	AgentScorecard,
	PerformanceHistory,
	AgentAggregate,
	ToolAggregate,
} from './react-eval';
export {
	CircuitBreaker,
	DeadlockDetector,
	SafeStateManager,
	withTimeout,
	withRetry,
	withFallback,
	getToolTimeout,
	getAlternativeTools,
	determineRecovery,
	TimedOutError,
} from './react-recovery';
export type {
	RecoveryDecision,
	RecoveryStrategy,
	StateSnapshot,
	RetryConfig,
	RecoveryContext,
} from './react-recovery';
export { DEFAULT_AGENT_REACT_CONFIG } from './react-types';
export {
	REACT_ORCHESTRATOR_SYSTEM_PROMPT,
	WORKER_REACT_SYSTEM_PROMPTS,
	buildReActOrchestratorPrompt,
	buildReActFinalSynthesisPrompt,
	buildWorkerReActPrompt,
	parseReActResponse,
} from './react-orchestrator';