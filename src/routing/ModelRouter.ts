/**
 * ModelRouter — unified dispatch engine for the multi-provider ecosystem.
 */
import type { Task, TaskResult } from '../types';
import { TOKEN_LIMITS } from '../types';
import type {
	TaskType, ProviderId, RoutingTable,
	ProviderRequest, ProviderResponse, ProviderRequestConfig,
	ProviderFallbackConfig, MultiProviderSettings, ImageContent,
	ProviderTaskMetrics, RoutingOptimizationConfig, ProviderModel,
} from '../providers/provider-types';
import { TASK_TYPE_LABELS, TASK_TYPE_ICONS, DEFAULT_PROVIDER_CONFIG, DEFAULT_FALLBACK_CONFIG, isLocalBaseUrl } from '../providers/provider-types';
import { PROVIDER_REGISTRY } from '../providers/provider-registry';
import { ProviderFactory } from '../providers/provider-factory';
import {
	ProviderCircuitBreaker,
} from '../providers/provider-recovery';
import { DEFAULT_ROUTING } from '../routing/routing-table';
import type { ToolDefinition } from '../types';
import { preprocessPrompt, extractImageRefs } from '../providers/image-utils';
import type { AgentMemoryStore } from '../memory/memory-store';
import type { HybridRetriever } from '../rag/hybrid-retriever';
import { executeFallbackChain, defaultBackoff } from '../providers/fallback-pipeline';

export interface ClassificationResult {
	primary: TaskType; confidence: number;
	alternatives: TaskTypeScore[]; signals: string[];
}
export interface TaskTypeScore {
	taskType: TaskType; score: number; label: string; icon: string;
}
export interface RouteDecision {
	route: ResolvedRoute; classification: ClassificationResult;
	capabilitiesMatch: boolean; capabilityGaps: string[];
}
export interface ResolvedRoute {
	providerId: ProviderId; modelId: string;
	config: ProviderRequestConfig; taskType: TaskType;
}
export interface RouteResult {
	taskResult: TaskResult; decision: RouteDecision;
	attempts: RouteAttempt[]; servedBy: ProviderId | null; totalLatencyMs: number;
}
export interface RouteAttempt {
	providerId: ProviderId; modelId: string; attemptIndex: number;
	success: boolean; error?: string; errorCode?: string;
	latencyMs: number; wasFallback: boolean;
}
export interface ModelRouterConfig {
	minConfidence: number; debug: boolean;
	capabilityGating: boolean; providerTimeoutMs: number;
	/** Absolute path to the vault root, used for resolving image paths. */
	vaultPath?: string;
	/** Obsidian configuration directory name excluded from attachment searches. */
	configDir?: string;
	/** Optional persistent memory injected into routed system prompts. */
	memoryStore?: AgentMemoryStore;
	/** Optional passive vault retrieval used to enrich provider system prompts. */
	retriever?: HybridRetriever;
	/** Character budget for persistent memory + RAG context (roughly 4 chars/token). */
	contextCharLimit?: number;
}

const DRC: ModelRouterConfig = { minConfidence: 0.3, debug: false, capabilityGating: true, providerTimeoutMs: 120_000 };
const DEFAULT_OPTIMIZATION: RoutingOptimizationConfig = {
	enabled: false, objective: 'balanced', minCapabilityScore: 0.75, emaAlpha: 0.2,
};
const COST_SCORE: Record<ProviderModel['costTier'], number> = {
	free: 0, cheap: 1, moderate: 2, expensive: 3,
};

interface MutableProviderTaskMetrics extends ProviderTaskMetrics {
	initializedLatency: boolean;
	initializedTokens: boolean;
}

/* ═══════════════════════════════════════════════════════════
   ModelRouter
   ═══════════════════════════════════════════════════════════ */

export class ModelRouter {
	private factory: ProviderFactory;
	private getSettings: () => MultiProviderSettings;
	private getTools: () => ToolDefinition[];
	private config: ModelRouterConfig;
	private readonly metrics = new Map<string, MutableProviderTaskMetrics>();

	readonly decisionLog: RouteResult[] = [];
	readonly circuitBreaker = new ProviderCircuitBreaker();

	constructor(
		factory: ProviderFactory, getSettings: () => MultiProviderSettings,
		getTools: () => ToolDefinition[], config: Partial<ModelRouterConfig> = {},
	) {
		this.factory = factory; this.getSettings = getSettings;
		this.getTools = getTools; this.config = { ...DRC, ...config };
	}

	/* ─── Main Entry Points ─────────────────── */

	async route(task: Task): Promise<RouteResult> {
		const t0 = Date.now();
		const classification = task.preferredTier === 'tier2_reasoning'
			? this.explicitClassification('reasoning', `${task.workerRole ?? task.workerProfile}:tier2_reasoning`)
			: task.preferredTier === 'tier1_local'
				? this.explicitClassification('fast', `${task.workerRole ?? task.workerProfile}:tier1_local`)
				: this.classify(task.prompt, task.workerProfile, task.targetPath);
		const settings = this.getSettings();
		const route = this.resolve(
			classification, settings.routing ?? DEFAULT_ROUTING, settings.optimization,
		);
		const providerReq = this._buildProviderRequest(task, route);
		await this._resolvePreprocessing(task.id);
		const { response, attempts } = await this.withJitModel(route.taskType, () =>
			this._executeWithFallback(providerReq, route, settings.fallback ?? DEFAULT_FALLBACK_CONFIG));

		const output = response.output || response.error || '';
		const taskResult: TaskResult = {
			output: output.length > TOKEN_LIMITS.MAX_RESULT_OUTPUT_CHARS
				? output.slice(0, TOKEN_LIMITS.MAX_RESULT_OUTPUT_CHARS) + '\n\n[output truncated]' : output,
			summary: response.success
				? `Completed via ${response.providerId ?? '?'} / ${response.model ?? '?'} [${route.taskType}]`
				: `Failed [${route.taskType}]: ${response.error}`,
			metadata: {
				providerId: response.providerId, model: response.model, taskType: route.taskType,
				usage: response.usage, latencyMs: response.latencyMs, attempts: attempts.length,
				classificationConfidence: classification.confidence,
			},
		};
		const result: RouteResult = {
			taskResult,
			decision: { route, classification, capabilitiesMatch: this._checkCapabilities(route.providerId, route.taskType).match, capabilityGaps: this._checkCapabilities(route.providerId, route.taskType).gaps },
			attempts, servedBy: response.success ? (response.providerId ?? null) : null,
			totalLatencyMs: Date.now() - t0,
		};
		this._logDecision(result); return result;
	}

	async routeDirect(task: Task, providerId: ProviderId, modelId?: string): Promise<RouteResult> {
		const settings = this.getSettings();
		const config = { ...DEFAULT_PROVIDER_CONFIG, ...settings.defaults };
		if (modelId) config.model = modelId;
		const classification = this.classify(task.prompt, task.workerProfile, task.targetPath);
		const route: ResolvedRoute = {
			providerId, modelId: modelId ?? PROVIDER_REGISTRY[providerId]?.models[0]?.id ?? 'unknown',
			config, taskType: classification.primary,
		};
		const providerReq = this._buildProviderRequest(task, route);
		await this._resolvePreprocessing(task.id);
		const { response, attempts } = await this._executeWithFallback(
			providerReq, route, settings.fallback ?? DEFAULT_FALLBACK_CONFIG);
		const output = response.output || response.error || '';
		const result: RouteResult = {
			taskResult: {
				output: output.length > TOKEN_LIMITS.MAX_RESULT_OUTPUT_CHARS
					? output.slice(0, TOKEN_LIMITS.MAX_RESULT_OUTPUT_CHARS) + '\n\n[output truncated]' : output,
				summary: response.success ? `Direct via ${providerId} / ${route.modelId}` : `Direct failed: ${response.error}`,
				metadata: { providerId, model: route.modelId, taskType: classification.primary, latencyMs: response.latencyMs },
			},
			decision: { route, classification, capabilitiesMatch: true, capabilityGaps: [] },
			attempts, servedBy: response.success ? (response.providerId ?? null) : null,
			totalLatencyMs: response.latencyMs,
		};
		this._logDecision(result); return result;
	}

	canServe(taskType: TaskType): boolean {
		const s = this.getSettings();
		const r = s.routing[taskType] ?? DEFAULT_ROUTING[taskType];
		return this.factory.isUsable(r.providerId);
	}

	getRoutingTableStatus(): Array<{ taskType: TaskType; label: string; providerId: ProviderId; providerLabel: string; modelId: string; available: boolean }> {
		const s = this.getSettings();
		const routing = s.routing ?? DEFAULT_ROUTING;
		return (Object.keys(DEFAULT_ROUTING) as TaskType[]).map(tt => {
			const r = routing[tt] ?? DEFAULT_ROUTING[tt];
			return { taskType: tt, label: TASK_TYPE_LABELS[tt], providerId: r.providerId, providerLabel: PROVIDER_REGISTRY[r.providerId]?.label ?? r.providerId, modelId: r.modelId, available: this.factory.isUsable(r.providerId) };
		});
	}

	/* ─── Classification ──────────────────────── */

	private explicitClassification(primary: TaskType, signal: string): ClassificationResult {
		return {
			primary, confidence: 1, signals: [signal], alternatives: (Object.keys(DEFAULT_ROUTING) as TaskType[])
				.filter(taskType => taskType !== primary).map(taskType => ({ taskType, score: 0, label: TASK_TYPE_LABELS[taskType], icon: TASK_TYPE_ICONS[taskType] })),
		};
	}

	classify(prompt: string, workerProfile?: string, _targetPath?: string): ClassificationResult {
		const lower = prompt.toLowerCase();
		const profile = workerProfile ?? '';
		const signals: string[] = [];
		const scores: TaskTypeScore[] = [
			this._scoreCoding(lower, profile, signals),
			this._scoreVision(lower, signals),
			this._scoreReading(lower, profile, prompt.length, signals),
			this._scoreReasoning(lower, profile, signals),
			this._scoreFast(lower, prompt.length, signals),
		];
		scores.sort((a, b) => b.score - a.score);
		const top = scores[0]!;
		if (top.score < this.config.minConfidence) {
			return { primary: 'reasoning', confidence: 0, alternatives: scores, signals: ['low-confidence-fallback'] };
		}
		return { primary: top.taskType, confidence: Math.min(1, top.score), alternatives: scores, signals };
	}

	/* ─── Route Resolution ────────────────────── */

	resolve(
		classification: ClassificationResult, routing: RoutingTable,
		optimization?: Partial<RoutingOptimizationConfig>,
	): ResolvedRoute {
		let route = routing[classification.primary];
		if (!route || !this.factory.isUsable(route.providerId)) {
			for (const alt of classification.alternatives) {
				const ar = routing[alt.taskType];
				if (ar && this.factory.isUsable(ar.providerId)) { route = ar; break; }
			}
		}
		if (!route || !this.factory.isUsable(route.providerId)) {
			// No configured route is usable. Auto-reach the first enabled+available
			// provider (local-keyless preferred) so a local-only setup works without
			// manual routing of every TaskType.
			const reached = this.factory.listUsable()[0];
			if (reached) {
				const tt = classification.primary;
				route = { taskType: tt, providerId: reached.id, modelId: this.factory.resolveModelForTask(reached.id, tt), config: DEFAULT_PROVIDER_CONFIG };
			}
		}
		if (!route) route = DEFAULT_ROUTING[classification.primary] ?? DEFAULT_ROUTING['reasoning'];

		const opt = { ...DEFAULT_OPTIMIZATION, ...optimization };
		if (opt.enabled) {
			const optimized = this._selectOptimizedRoute(classification.primary, route, opt);
			if (optimized) route = optimized;
		}
		return { providerId: route.providerId, modelId: route.modelId, config: { ...DEFAULT_PROVIDER_CONFIG, ...route.config }, taskType: route.taskType };
	}

	/** Snapshot of adaptive metrics, optionally narrowed to one task type. */
	getProviderMetrics(taskType?: TaskType): ProviderTaskMetrics[] {
		return [...this.metrics.values()]
			.filter(m => !taskType || m.taskType === taskType)
			.map(({ initializedLatency: _l, initializedTokens: _t, ...m }) => ({ ...m }));
	}

	/**
	 * Run a heavy ReAct or batch workload with optional local-model pre-warming.
	 * JIT is opt-in through a route/default `ttl` or `keepAlive`. Unsupported,
	 * offline, and timed-out engines execute the workload normally.
	 */
	async withJitModel<T>(taskType: TaskType, work: () => Promise<T>): Promise<T> {
		const settings = this.getSettings();
		const configured = settings.routing?.[taskType] ?? DEFAULT_ROUTING[taskType];
		const retention = configured?.config?.ttl ?? configured?.config?.keepAlive ??
			settings.defaults.ttl ?? settings.defaults.keepAlive ?? DEFAULT_PROVIDER_CONFIG.ttl ?? 300;
		const ttl = typeof retention === 'number' ? retention : this._durationSeconds(retention);
		const baseUrl = configured ? this.factory.getBaseUrl(configured.providerId) : '';
		const enabled = configured !== undefined && ttl !== undefined && Number.isFinite(ttl) &&
			ttl >= 0 && isLocalBaseUrl(baseUrl);
		if (!enabled) return work();

		const modelId = configured.modelId;
		// Optional call preserves compatibility with injected test/legacy factories.
		const bearerToken = this.factory.getApiKey?.(configured.providerId) ?? '';
		await this.factory.jitModelManager.ensureModelLoaded(baseUrl, modelId, ttl, bearerToken);
		try {
			return await work();
		} finally {
			// ReAct sessions and Base batches are explicit workload boundaries, so
			// release VRAM immediately instead of waiting for the request TTL.
			await this.factory.jitModelManager.evictModel(baseUrl, modelId, bearerToken);
		}
	}

	private _durationSeconds(value: string | undefined): number | undefined {
		if (!value) return undefined;
		const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(value);
		if (!match) return undefined;
		const amount = Number(match[1]);
		const unit = match[2]?.toLowerCase() ?? 's';
		return unit === 'ms' ? amount / 1000 : unit === 'm' ? amount * 60 : unit === 'h' ? amount * 3600 : amount;
	}

	/* ─── Fallback Execution Pipeline ─────────── */

	private async _executeWithFallback(
		request: ProviderRequest, route: ResolvedRoute, fallback: ProviderFallbackConfig,
	): Promise<{ response: ProviderResponse; attempts: RouteAttempt[] }> {
		// Optimization applies only to the initial choice. Once it fails, order
		// fallbacks by observed success probability to preserve reliability.
		const chain = this._buildFallbackChain(route.providerId, fallback, route.taskType);
		const attempts: RouteAttempt[] = [];
		const emaAlpha = this._optimizationConfig().emaAlpha;

		const { response } = await executeFallbackChain(
			request, route, chain, fallback,
			this.circuitBreaker, this.factory,
			{
				backoff: defaultBackoff,
				// Capability gate applies to fallbacks only (i > 0); the primary is the
				// configured choice and is never gated.
				shouldSkip: this.config.capabilityGating
					? (pid, taskType, i) => {
						if (i === 0) return false;
						const cap = this._checkCapabilities(pid, taskType);
						return cap.match ? false : { reason: `Capability gap: ${cap.gaps.join(', ')}` };
					}
					: undefined,
				onAttempt: (pid, modelId, i, resp, typedErr, elapsed) => {
					this._recordMetrics(pid, route.taskType, elapsed, resp?.success ?? false, resp?.usage, emaAlpha);
					attempts.push({
						providerId: pid, modelId, attemptIndex: i,
						success: resp?.success ?? false,
						error: resp?.error ?? (typedErr ? undefined : (typedErr as unknown as Error)?.message),
						errorCode: resp?.typedError?.code ?? typedErr?.code ?? (typedErr ? 'exception' : undefined),
						latencyMs: elapsed, wasFallback: i > 0,
					});
				},
			},
		);
		return { response, attempts };
	}

	private _buildFallbackChain(primary: ProviderId, fb: ProviderFallbackConfig, taskType: TaskType): ProviderId[] {
		const configured = fb.fallbacks.filter(f => f !== primary);
		configured.sort((a, b) => {
			const reliability = this._successProbability(b, taskType) - this._successProbability(a, taskType);
			return Math.abs(reliability) > 1e-9 ? reliability : fb.fallbacks.indexOf(a) - fb.fallbacks.indexOf(b);
		});
		const chain = [primary, ...configured];
		// Safety net: append every enabled+available provider so a local-only setup
		// (e.g. LM Studio alone) is always reachable even when the configured primary
		// and fallback chain are all disabled/unconfigured. Dedup preserves order.
		for (const adapter of this.factory.listUsable()) {
			if (!chain.includes(adapter.id)) chain.push(adapter.id);
		}
		return chain;
	}

	private _optimizationConfig(): RoutingOptimizationConfig {
		return { ...DEFAULT_OPTIMIZATION, ...this.getSettings().optimization };
	}

	private _metricsKey(pid: ProviderId, tt: TaskType): string { return `${pid}:${tt}`; }

	private _successProbability(pid: ProviderId, tt: TaskType): number {
		return this.metrics.get(this._metricsKey(pid, tt))?.successProbability ?? 0.9;
	}

	private _recordMetrics(
		pid: ProviderId, tt: TaskType, latencyMs: number, success: boolean,
		usage: ProviderResponse['usage'], alpha: number,
	): void {
		const key = this._metricsKey(pid, tt);
		const m = this.metrics.get(key) ?? {
			providerId: pid, taskType: tt, samples: 0, successes: 0,
			averageLatencyMs: 0, averagePromptTokens: 0, averageCompletionTokens: 0,
			averageTotalTokens: 0, successProbability: 0.9,
			initializedLatency: false, initializedTokens: false,
		};
		const a = Math.max(0.01, Math.min(1, alpha));
		m.samples++; if (success) m.successes++;
		if (latencyMs >= 0) {
			m.averageLatencyMs = m.initializedLatency ? a * latencyMs + (1 - a) * m.averageLatencyMs : latencyMs;
			m.initializedLatency = true;
		}
		if (usage) {
			m.averagePromptTokens = m.initializedTokens ? a * usage.promptTokens + (1 - a) * m.averagePromptTokens : usage.promptTokens;
			m.averageCompletionTokens = m.initializedTokens ? a * usage.completionTokens + (1 - a) * m.averageCompletionTokens : usage.completionTokens;
			m.averageTotalTokens = m.initializedTokens ? a * usage.totalTokens + (1 - a) * m.averageTotalTokens : usage.totalTokens;
			m.initializedTokens = true;
		}
		m.successProbability = a * (success ? 1 : 0) + (1 - a) * m.successProbability;
		this.metrics.set(key, m);
	}

	private _selectOptimizedRoute(
		tt: TaskType, configured: RoutingTable[TaskType], opt: RoutingOptimizationConfig,
	): RoutingTable[TaskType] | null {
		const candidates: Array<{ providerId: ProviderId; model: ProviderModel; score: number }> = [];
		for (const [rawPid, meta] of Object.entries(PROVIDER_REGISTRY)) {
			const pid = rawPid as ProviderId;
			if (!this.factory.isUsable(pid)) continue;
			for (const model of meta.models) {
				const score = this._capabilityScore(pid, model, tt);
				if (score >= opt.minCapabilityScore) candidates.push({ providerId: pid, model, score });
			}
		}
		if (candidates.length < 2) return null;
		const configuredCandidate = candidates.find(c => c.providerId === configured.providerId && c.model.id === configured.modelId);
		candidates.sort((a, b) => this._optimizationScore(a, tt, opt.objective) - this._optimizationScore(b, tt, opt.objective));
		const best = candidates[0]!;
		// With no observations, retain an equally-priced configured route rather
		// than making an arbitrary latency choice.
		if (opt.objective === 'latency' && !this.metrics.get(this._metricsKey(best.providerId, tt))?.initializedLatency && configuredCandidate) return configured;
		return { taskType: tt, providerId: best.providerId, modelId: best.model.id, config: configured.config };
	}

	private _optimizationScore(
		candidate: { providerId: ProviderId; model: ProviderModel }, tt: TaskType,
		objective: RoutingOptimizationConfig['objective'],
	): number {
		const m = this.metrics.get(this._metricsKey(candidate.providerId, tt));
		const latency = m?.initializedLatency ? m.averageLatencyMs : 60_000;
		const tokenFactor = m?.initializedTokens ? Math.min(2, m.averageTotalTokens / 4096) : 1;
		const cost = COST_SCORE[candidate.model.costTier] * tokenFactor;
		if (objective === 'latency') return latency;
		if (objective === 'cost') return cost;
		return cost * 10_000 + latency;
	}

	private _capabilityScore(pid: ProviderId, model: ProviderModel, tt: TaskType): number {
		const caps = PROVIDER_REGISTRY[pid]?.capabilities;
		if (!caps) return 0;
		if (tt === 'vision' && (!caps.vision || !model.supportsVision)) return 0;
		if (tt === 'coding' && (!caps.toolCalling || !model.supportsTools)) return 0;
		if (tt === 'reading' && model.contextWindow < 32_000) return 0;
		return model.strengths.includes(tt) ? 1 : 0.6;
	}

	private _logDecision(r: RouteResult): void {
		this.decisionLog.unshift(r);
		if (this.decisionLog.length > 100) this.decisionLog.length = 100;
	}

	/* ─── Classification Scorers ──────────────── */

	private _s(lower: string, terms: string[], inc: number, signals: string[]): number {
		let s = 0; for (const t of terms) if (lower.includes(t)) { s += inc; signals.push(t); } return s;
	}

	private _scoreCoding(lower: string, profile: string, signals: string[]): TaskTypeScore {
		let score = this._s(lower, ['code','refactor','implement','function','class ','api ','endpoint','bug','fix','debug','compile','build','deploy','ci','cd','pipeline','test suite','patch','merge','typescript','javascript','python','rust'], 0.12, signals);
		if (profile === 'editor') { score += 0.3; signals.push('editor-profile'); }
		return { taskType: 'coding', score: Math.min(1, score), label: TASK_TYPE_LABELS.coding, icon: TASK_TYPE_ICONS.coding };
	}

	private _scoreVision(lower: string, signals: string[]): TaskTypeScore {
		// Also detect image references in the raw prompt (Obsidian ![[...]], Markdown ![alt](...))
		const hasImageRefs = extractImageRefs(lower).length > 0;
		let score = this._s(lower, ['image','picture','photo','screenshot','diagram','visual','ocr','what is in this','describe this','what do you see','detect','recognize','identify','caption','alt text'], 0.2, signals);
		if (hasImageRefs) {
			score += 0.5;
			signals.push('image-reference-detected');
		}
		return { taskType: 'vision', score: Math.min(1, score), label: TASK_TYPE_LABELS.vision, icon: TASK_TYPE_ICONS.vision };
	}

	private _scoreReading(lower: string, profile: string, len: number, signals: string[]): TaskTypeScore {
		let score = this._s(lower, ['summarize','summarise','extract','condense','digest','overview','tl;dr','tldr','gist','synopsis','read and','scan this','skim'], 0.15, signals);
		if (len > 1000) { score += 0.2; signals.push('long-prompt'); } else if (len > 500) { score += 0.1; }
		if (profile === 'summarizer') { score += 0.3; signals.push('summarizer-profile'); }
		return { taskType: 'reading', score: Math.min(1, score), label: TASK_TYPE_LABELS.reading, icon: TASK_TYPE_ICONS.reading };
	}

	private _scoreReasoning(lower: string, profile: string, signals: string[]): TaskTypeScore {
		let score = this._s(lower, ['analyze','reason','think through','plan','strategy','evaluate','compare','contrast','why','how does','explain','what if','consider','decide','assess','weigh','trade-off','implication'], 0.1, signals);
		if (profile.startsWith('react')) { score += 0.5; signals.push('react-profile'); }
		return { taskType: 'reasoning', score: Math.min(1, score), label: TASK_TYPE_LABELS.reasoning, icon: TASK_TYPE_ICONS.reasoning };
	}

	private _scoreFast(lower: string, len: number, signals: string[]): TaskTypeScore {
		let score = this._s(lower, ['quick',' fast','simple','just','what is','who is','when ','where ','lookup','find ','get ','show ','tell ','list ','define'], 0.15, signals);
		if (len < 200) { score += 0.3; signals.push('short-prompt'); } else if (len < 500) { score += 0.1; }
		return { taskType: 'fast', score: Math.min(1, score), label: TASK_TYPE_LABELS.fast, icon: TASK_TYPE_ICONS.fast };
	}

	/* ─── Capability Gating ──────────────────── */

	private _checkCapabilities(pid: ProviderId, tt: TaskType): { match: boolean; gaps: string[] } {
		const meta = PROVIDER_REGISTRY[pid];
		if (!meta) return { match: true, gaps: [] };
		const c = meta.capabilities; const gaps: string[] = [];
		if (tt === 'vision' && !c.vision) gaps.push('vision support');
		if (tt === 'coding' && !c.toolCalling) gaps.push('tool calling');
		if (tt === 'reading' && c.maxContextWindow < 32000) gaps.push('small context window');
		return { match: gaps.length === 0, gaps };
	}

	/* ─── Provider Request Builder ───────────── */

	/**
	 * Build a ProviderRequest with full image preprocessing.
	 *
	 * The pipeline:
	 *   1. Scans the prompt for Obsidian ![[links]], Markdown images, and bare image paths
	 *   2. Resolves vault-relative paths against the vault root
	 *   3. Reads and base64-encodes each image
	 *   4. Strips image references from the prompt, replacing with descriptive markers
	 *   5. Attaches the processed ImageContent[] to the request
	 *
	 * If any image fails to load, the error is logged and the user prompt retains
	 * a descriptive placeholder so the provider can still respond usefully.
	 */
	private _buildProviderRequest(task: Task, route: ResolvedRoute): ProviderRequest {
		const tools = this.getTools();

		// Determine vault path for image resolution.
		// Use configured vaultPath, fall back to the task's targetPath directory or cwd.
		const vaultPath = this.config.vaultPath ?? process.cwd();

		// Preprocess images synchronously — kick off the async work and await below
		// We store the raw prompt in case async preprocessing fails
		let userPrompt = task.prompt;
		let images: ImageContent[] | undefined;

		// Try async preprocessing; if it fails (e.g. no Obsidian vault in tests),
		// fall through with the original prompt and no images.
		const preprocessingPromise = preprocessPrompt(task.prompt, vaultPath, undefined, {
			configDir: this.config.configDir,
		})
			.then(result => {
				userPrompt = result.cleanedPrompt;
				if (result.images.length > 0) {
					images = result.images;
				}
			})
			.catch(err => {
				console.warn('[ModelRouter] Image preprocessing error:', err);
				// Non-fatal — proceed with original prompt
			});

		// We need to return synchronously but use the async result.
		// Store the promise on the task so we can await it before dispatch.
		// The actual dispatch in route() will await this via a task-level hook.
		// For clean architecture, we store it as a private field and await at call site.
		(this._pendingPreprocessing).set(task.id, preprocessingPromise);

		const memoryPrompt = this.config.memoryStore?.getSystemMemoryPrompt(task.prompt) ?? '';
		const contextLimit = Math.max(2_000, this.config.contextCharLimit ?? 16_000);
		const systemPrefix = `You are a ${task.workerProfile} agent in an Obsidian vault.`;
		const contextPromise = this.config.retriever?.search(task.prompt, 5)
			.then(matches => {
				const vault = matches.length ? `## Relevant Vault Context\n${this.config.retriever?.formatContext(matches) ?? ''}` : '';
				const combined = [memoryPrompt, vault].filter(Boolean).join('\n\n').slice(0, contextLimit);
				providerRequest.systemPrompt = `${systemPrefix}${combined ? `\n\n<context>\n${combined}\n</context>` : ''}`;
			})
			.catch(error => { console.warn('[ModelRouter] Passive RAG retrieval failed:', error); });
		const providerRequest: ProviderRequest = {
			systemPrompt: `${systemPrefix}${memoryPrompt ? `\n\n<context>\n${memoryPrompt.slice(0, contextLimit)}\n</context>` : ''}`,
			userPrompt,
			tools,
			taskId: task.id,
			config: { ...route.config },
			images,
			onStream: task.onStream ? (d: string) => task.onStream!(d) : undefined,
			onToolCall: async (name, params) => {
				const tool = tools.find(t => t.name === name);
				if (!tool) return { toolCallId: name, content: '', error: `Unknown tool: ${name}` };
				try {
					const r = await tool.execute(name, params);
					return { toolCallId: name, content: r.content?.map(c => c.text ?? '').join('') ?? '' };
				} catch (err) {
					return { toolCallId: name, content: '', error: (err as Error).message };
				}
			},
		};
		if (contextPromise) {
			const existing = this._pendingPreprocessing.get(task.id);
			this._pendingPreprocessing.set(task.id, Promise.all([existing, contextPromise]).then(() => undefined));
		}
		return providerRequest;
	}

	/**
	 * Wait for any pending image preprocessing to complete.
	 * Called before dispatching the actual provider request.
	 * This ensures that by the time the provider builds its request body,
	 * the `images` field is fully populated.
	 */
	private _pendingPreprocessing = new Map<string, Promise<void>>();

	private async _resolvePreprocessing(taskId: string): Promise<void> {
		const pending = this._pendingPreprocessing.get(taskId);
		if (pending) {
			await pending;
			this._pendingPreprocessing.delete(taskId);
		}
	}
}