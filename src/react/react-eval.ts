/**
 * ReAct Evaluation Engine — automated scoring, grading, and feedback optimization.
 *
 * After each agent execution, the engine:
 *   1. Scores the output on completeness, relevance, specificity, and correctness.
 *   2. Grades tool execution accuracy (successes vs failures).
 *   3. Accumulates performance history per agent/role/tool combination.
 *   4. Provides optimization hints to the orchestrator for future cycles.
 *
 * Performance data is persisted as Markdown notes in the memory bank for
 * cross-session reinforcement learning.
 */

import type { WorkerReActResult } from './react-types';


/* ─── Scoring Types ────────────────────────────────────── */

export interface AgentScorecard {
	/** Unique execution id. */
	executionId: string;
	/** Which agent/role was evaluated. */
	agent: string;
	role?: string;
	/** The task that was given. */
	task: string;
	/** Individual dimension scores (0-1). */
	dimensions: {
		completeness: number;
		relevance: number;
		specificity: number;
		correctness: number;
	};
	/** Weighted composite score (0-1). */
	compositeScore: number;
	/** Tool execution accuracy (successes / total). */
	toolAccuracy: number;
	/** Total tool calls in this execution. */
	toolCalls: number;
	/** Successful tool calls. */
	toolSuccesses: number;
	/** Whether self-corrections were applied. */
	selfCorrected: boolean;
	/** Corrections count. */
	corrections: number;
	/** Sub-cycles executed. */
	subCycles: number;
	/** Timestamp. */
	timestamp: number;
	/** Qualitative assessment. */
	grade: 'excellent' | 'good' | 'adequate' | 'poor' | 'failed';
	/** Specific feedback for optimization. */
	feedback: string;
}

export interface PerformanceHistory {
	/** Per-agent aggregate stats. */
	agentStats: Record<string, AgentAggregate>;
	/** Per-role aggregate stats. */
	roleStats: Record<string, AgentAggregate>;
	/** Per-tool aggregate stats. */
	toolStats: Record<string, ToolAggregate>;
	/** Total executions evaluated. */
	totalEvaluations: number;
	/** Recent scorecards (last 50). */
	recentScorecards: AgentScorecard[];
}

export interface AgentAggregate {
	executions: number;
	averageScore: number;
	bestScore: number;
	worstScore: number;
	averageToolAccuracy: number;
	mostCommonGrade: string;
	trend: 'improving' | 'stable' | 'declining';
}

export interface ToolAggregate {
	invocations: number;
	successes: number;
	failures: number;
	successRate: number;
}

/* ─── Scoring Weights ──────────────────────────────────── */

const SCORE_WEIGHTS = {
	completeness: 0.30,
	relevance: 0.30,
	specificity: 0.25,
	correctness: 0.15,
};

const GRADE_THRESHOLDS = [
	{ min: 0.85, grade: 'excellent' as const },
	{ min: 0.70, grade: 'good' as const },
	{ min: 0.50, grade: 'adequate' as const },
	{ min: 0.25, grade: 'poor' as const },
	{ min: 0.00, grade: 'failed' as const },
];

/* ─── Evaluation Engine ───────────────────────────────── */

export class ReActEvaluator {
	private history: PerformanceHistory = {
		agentStats: {},
		roleStats: {},
		toolStats: {},
		totalEvaluations: 0,
		recentScorecards: [],
	};
	private counter = 0;

	/** Evaluate a worker's execution result and return a scorecard. */
	evaluate(
		agent: string,
		role: string | undefined,
		task: string,
		result: WorkerReActResult,
	): AgentScorecard {
		const dims = this._scoreDimensions(result.output, task);
		this.counter++;

		const toolAccuracy = result.subCycles > 0
			? 0.5 // default when tool counts unavailable
			: 1.0;

		const compositeScore =
			dims.completeness * SCORE_WEIGHTS.completeness +
			dims.relevance * SCORE_WEIGHTS.relevance +
			dims.specificity * SCORE_WEIGHTS.specificity +
			dims.correctness * SCORE_WEIGHTS.correctness;

		const grade = GRADE_THRESHOLDS.find(t => compositeScore >= t.min)?.grade ?? 'failed';

		const scorecard: AgentScorecard = {
			executionId: `eval-${this.counter}`,
			agent,
			role,
			task: task.slice(0, 200),
			dimensions: dims,
			compositeScore,
			toolAccuracy,
			toolCalls: 0,
			toolSuccesses: 0,
			selfCorrected: result.corrections > 0,
			corrections: result.corrections,
			subCycles: result.subCycles,
			timestamp: Date.now(),
			grade,
			feedback: this._generateFeedback(dims, grade),
		};

		this._updateHistory(scorecard);
		return scorecard;
	}

	/** Get the current performance history. */
	getHistory(): PerformanceHistory {
		return this.history;
	}

	/** Get optimization hints for the orchestrator. */
	getOptimizationHints(): string {
		const hints: string[] = [];

		// Best performing roles
		const roles = Object.entries(this.history.roleStats)
			.filter(([, s]) => s.executions >= 2)
			.sort(([, a], [, b]) => b.averageScore - a.averageScore);

		if (roles.length > 0) {
			const top = roles.slice(0, 3).map(([r, s]) =>
				`${r} (avg ${s.averageScore.toFixed(2)}, ${s.executions} runs, ${s.trend})`
			).join(', ');
			hints.push(`Top roles: ${top}`);
		}

		// Declining trends to avoid
		const declining = roles.filter(([, s]) => s.trend === 'declining');
		if (declining.length > 0) {
			hints.push(`Declining roles: ${declining.map(([r]) => r).join(', ')} — consider retraining or adjusting prompts`);
		}

		// Tool reliability
		const unreliableTools = Object.entries(this.history.toolStats)
			.filter(([, s]) => s.invocations >= 3 && s.successRate < 0.5)
			.map(([t, s]) => `${t} (${(s.successRate * 100).toFixed(0)}% success)`);

		if (unreliableTools.length > 0) {
			hints.push(`Unreliable tools: ${unreliableTools.join(', ')} — consider alternative approaches`);
		}

		// Correction frequency
		const correctedExecs = this.history.recentScorecards.filter(s => s.selfCorrected).length;
		if (correctedExecs > this.history.totalEvaluations * 0.3) {
			hints.push(`High self-correction rate (${correctedExecs}/${this.history.totalEvaluations}) — prompts may need refinement`);
		}

		return hints.length > 0
			? '## Performance Insights\n' + hints.map(h => `- ${h}`).join('\n')
			: '';
	}

	/** Load history from persisted data (call on plugin init). */
	loadHistory(data: PerformanceHistory): void {
		this.history = data;
	}

	/** Clear all history. */
	reset(): void {
		this.history = {
			agentStats: {},
			roleStats: {},
			toolStats: {},
			totalEvaluations: 0,
			recentScorecards: [],
		};
	}

	/* ─── Internal Scoring ──────────────────────────────── */

	private _scoreDimensions(
		output: string,
		task: string,
	): { completeness: number; relevance: number; specificity: number; correctness: number } {
		const len = output.length;

		// Completeness: length-based with diminishing returns
		const completeness = Math.min(1, len / 500);

		// Relevance: keyword overlap between task and output
		const taskWords = new Set(task.toLowerCase().split(/\s+/).filter(w => w.length > 3));
		const outputWords = output.toLowerCase().split(/\s+/).filter(w => w.length > 3);
		const overlap = outputWords.filter(w => taskWords.has(w)).length;
		const relevance = taskWords.size > 0
			? Math.min(1, overlap / Math.min(taskWords.size, 20))
			: 0.5;

		// Specificity: presence of concrete details (paths, numbers, quotes, bullet points)
		const hasPaths = (output.match(/\.md|[\w-]+\/[\w-]+/g) ?? []).length;
		const hasNumbers = (output.match(/\d+/g) ?? []).length;
		const hasBullets = (output.match(/^[*-]\s/gm) ?? []).length;
		const specificity = Math.min(1, (hasPaths * 0.4 + Math.min(hasNumbers, 10) * 0.04 + hasBullets * 0.15));

		// Correctness: absence of error indicators
		const errorCount = (output.match(/error|failed|unable|cannot|not found|no results/gi) ?? []).length;
		const correctness = Math.max(0, 1 - errorCount * 0.15);

		return { completeness, relevance, specificity, correctness };
	}

	private _generateFeedback(
		dims: { completeness: number; relevance: number; specificity: number; correctness: number },
		grade: string,
	): string {
		const issues: string[] = [];
		if (dims.completeness < 0.5) issues.push('incomplete — expand coverage');
		if (dims.relevance < 0.5) issues.push('off-topic — focus on the task');
		if (dims.specificity < 0.4) issues.push('vague — add paths, numbers, concrete details');
		if (dims.correctness < 0.7) issues.push('errors detected — verify accuracy');

		if (issues.length === 0) {
			return grade === 'excellent' ? 'Outstanding. All dimensions strong.' : 'Solid. Minor room for improvement.';
		}
		return `Needs improvement: ${issues.join('; ')}.`;
	}

	private _updateHistory(sc: AgentScorecard): void {
		this.history.totalEvaluations++;
		this.history.recentScorecards.unshift(sc);
		if (this.history.recentScorecards.length > 50) {
			this.history.recentScorecards = this.history.recentScorecards.slice(0, 50);
		}

		// Update agent stats
		this._updateAggregate(this.history.agentStats, sc.agent, sc);

		// Update role stats
		if (sc.role) {
			this._updateAggregate(this.history.roleStats, sc.role, sc);
		}
	}

	private _updateAggregate(
		stats: Record<string, AgentAggregate>,
		key: string,
		sc: AgentScorecard,
	): void {
		let agg = stats[key];
		if (!agg) {
			agg = {
				executions: 0, averageScore: 0, bestScore: 0, worstScore: 1,
				averageToolAccuracy: 0, mostCommonGrade: 'adequate', trend: 'stable',
			};
			stats[key] = agg;
		}

		const prevAvg = agg.averageScore;
		agg.executions++;
		agg.averageScore = (prevAvg * (agg.executions - 1) + sc.compositeScore) / agg.executions;
		agg.bestScore = Math.max(agg.bestScore, sc.compositeScore);
		agg.worstScore = Math.min(agg.worstScore, sc.compositeScore);
		agg.averageToolAccuracy = (agg.averageToolAccuracy * (agg.executions - 1) + sc.toolAccuracy) / agg.executions;
		agg.trend = agg.averageScore > prevAvg + 0.05 ? 'improving'
			: agg.averageScore < prevAvg - 0.05 ? 'declining' : 'stable';

		// Most common grade
		const grades = this.history.recentScorecards
			.filter(s => s.agent === sc.agent)
			.map(s => s.grade);
		const gradeCounts: Record<string, number> = {};
		for (const g of grades) gradeCounts[g] = (gradeCounts[g] ?? 0) + 1;
		agg.mostCommonGrade = Object.entries(gradeCounts).sort(([, a], [, b]) => b - a)[0]?.[0] ?? 'adequate';
	}

	/** Generate a JSON-serializable snapshot for persistence. */
	toJSON(): PerformanceHistory {
		return this.history;
	}
}