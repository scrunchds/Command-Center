import type { App, TFile } from 'obsidian';
import type { PiAgentDaemon } from '../daemon';
import type { ProviderDispatcher } from '../dispatcher';
import type { ProviderResponse, TaskType } from '../providers/provider-types';
import type { AgentTaskResponse } from '../types';
import type {
	WorkflowDefinition, WorkflowExecutionContext, WorkflowStep,
} from './workflow-types';
import { clampBaseBatchConcurrency, parseBaseQueue, splitBaseQueueBatches } from './base-queue';
import { updateNoteAgentState } from './frontmatter-sync';

export interface WorkflowStepExecutionResult {
	result: string;
	output: string;
	providerId?: string;
	model?: string;
	tokens: number;
	latencyMs: number;
	metadata?: Record<string, unknown>;
}

type WorkflowExecutor = Pick<ProviderDispatcher, 'dispatch'> | Pick<PiAgentDaemon, 'executeTask'>;
type WorkflowJitLifecycle = { withJitModel<T>(taskType: TaskType, work: () => Promise<T>): Promise<T> };

export interface WorkflowExecutionOptions {
	/** Receives provider/daemon deltas and engine lifecycle messages. */
	onStream?: (delta: string, step: WorkflowStep, targetFile?: TFile) => void;
	/** Optional note whose native agent properties track this execution. */
	targetFile?: TFile;
	/** Obsidian host used for native target-note property updates. */
	app?: App;
	/** @internal Serializes parallel step property writes for one target note. */
	stateUpdateChain?: Promise<void>;
	/** @internal Prevents nested lifecycle wrappers inside Base target batches. */
	jitManaged?: boolean;
}

export interface WorkflowTargetExecution {
	file: TFile;
	context?: WorkflowExecutionContext;
	error?: string;
}

export interface WorkflowBatchOptions extends Omit<WorkflowExecutionOptions, 'targetFile' | 'stateUpdateChain' | 'jitManaged'> {
	/** Number of target notes processed concurrently. Defaults to sequential execution. */
	concurrency?: number;
	/** Continue processing other target notes after one target fails. */
	continueOnError?: boolean;
	/** Maximum number of queue notes processed during this invocation. */
	limit?: number;
	/** Called after a batch and its frontmatter writes settle, before the next batch starts. */
	onBatchComplete?: (completed: WorkflowTargetExecution[], remaining: TFile[]) => void | Promise<void>;
}

/** Error raised when a workflow graph cannot be resolved. */
export class WorkflowResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WorkflowResolutionError';
	}
}

/** Resolve a workflow DAG into sequential tiers whose members may run in parallel. */
export function resolveWorkflowTiers(steps: WorkflowStep[]): WorkflowStep[][] {
	const byId = new Map<string, WorkflowStep>();
	for (const step of steps) {
		if (byId.has(step.id)) throw new WorkflowResolutionError(`Duplicate workflow step id: ${step.id}`);
		byId.set(step.id, step);
	}

	for (const step of steps) {
		for (const dependency of step.dependsOn) {
			if (!byId.has(dependency)) {
				throw new WorkflowResolutionError(`Step "${step.id}" depends on unknown step "${dependency}".`);
			}
		}
	}

	const remaining = new Map(byId);
	const resolved = new Set<string>();
	const tiers: WorkflowStep[][] = [];
	while (remaining.size > 0) {
		const tier = steps.filter(step =>
			remaining.has(step.id) && step.dependsOn.every(dependency => resolved.has(dependency))
		);
		if (tier.length === 0) {
			throw new WorkflowResolutionError(
				`Cyclic workflow dependency detected among: ${[...remaining.keys()].join(', ')}`,
			);
		}
		tiers.push(tier);
		for (const step of tier) {
			remaining.delete(step.id);
			resolved.add(step.id);
		}
	}
	return tiers;
}

function resolvePath(root: unknown, path: string[]): unknown {
	let current = root;
	for (const segment of path) {
		if (current === null || typeof current !== 'object') return undefined;
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

function templateValue(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value === null) return 'null';
	if (typeof value === 'object') return JSON.stringify(value);
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value.toString();
	return '';
}

/** Substitute workflow values such as {{inputs.topic}} and {{steps.research.result}}. */
export function interpolateTemplate(template: string, context: WorkflowExecutionContext): string {
	const scope = { inputs: context.inputs, steps: context.stepResults };
	return template.replace(/\{\{\s*([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\s*\}\}/g, (match, rawPath: string) => {
		const value = resolvePath(scope, rawPath.split('.'));
		return value === undefined ? match : templateValue(value);
	});
}

type ConditionTokenType = 'identifier' | 'string' | 'number' | 'operator' | 'punctuation' | 'eof';
interface ConditionToken { type: ConditionTokenType; value: string }

function tokenizeCondition(source: string): ConditionToken[] {
	const tokens: ConditionToken[] = [];
	let index = 0;
	while (index < source.length) {
		const character = source[index]!;
		if (/\s/.test(character)) { index++; continue; }
		const operator = ['===', '!==', '==', '!=', '>=', '<=', '&&', '||'].find(value => source.startsWith(value, index));
		if (operator) { tokens.push({ type: 'operator', value: operator }); index += operator.length; continue; }
		if ('!><'.includes(character)) { tokens.push({ type: 'operator', value: character }); index++; continue; }
		if ('().,'.includes(character)) { tokens.push({ type: 'punctuation', value: character }); index++; continue; }
		if (character === '"' || character === "'") {
			const quote = character;
			let value = '';
			let closed = false;
			index++;
			while (index < source.length) {
				const next = source[index++];
				if (next === quote) { closed = true; break; }
				if (next === '\\') {
					if (index >= source.length) break;
					const escaped = source[index++]!;
					value += escaped === 'n' ? '\n' : escaped === 'r' ? '\r' : escaped === 't' ? '\t' : escaped;
				} else value += next;
			}
			if (!closed) throw new WorkflowResolutionError('Unterminated string in workflow condition.');
			tokens.push({ type: 'string', value });
			continue;
		}
		const number = source.slice(index).match(/^-?(?:\d+(?:\.\d*)?|\.\d+)/)?.[0];
		if (number) { tokens.push({ type: 'number', value: number }); index += number.length; continue; }
		const identifier = source.slice(index).match(/^[A-Za-z_$][A-Za-z0-9_$-]*/)?.[0];
		if (identifier) { tokens.push({ type: 'identifier', value: identifier }); index += identifier.length; continue; }
		throw new WorkflowResolutionError(`Unexpected character "${character}" in workflow condition.`);
	}
	tokens.push({ type: 'eof', value: '' });
	return tokens;
}

function conditionTruthy(value: unknown): boolean {
	return value !== undefined && value !== null && value !== false && value !== 0 && value !== '';
}

function conditionEquals(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if ((left === null || left === undefined) && (right === null || right === undefined)) return true;
	if ((typeof left === 'number' && typeof right === 'string') || (typeof left === 'string' && typeof right === 'number')) {
		const leftNumber = Number(left);
		const rightNumber = Number(right);
		return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber === rightNumber;
	}
	return false;
}

class WorkflowConditionParser {
	private position = 0;
	constructor(private readonly tokens: ConditionToken[], private readonly context: WorkflowExecutionContext) {}

	parse(): boolean {
		const result = conditionTruthy(this.parseOr());
		if (this.peek().type !== 'eof') throw new WorkflowResolutionError(`Unexpected token "${this.peek().value}" in workflow condition.`);
		return result;
	}

	private peek(): ConditionToken { return this.tokens[this.position] ?? { type: 'eof', value: '' }; }
	private take(): ConditionToken { return this.tokens[this.position++] ?? { type: 'eof', value: '' }; }
	private match(value: string): boolean {
		if (this.peek().value !== value) return false;
		this.position++;
		return true;
	}
	private expect(value: string): void {
		if (!this.match(value)) throw new WorkflowResolutionError(`Expected "${value}" in workflow condition.`);
	}

	private parseOr(): unknown {
		let value = this.parseAnd();
		while (this.match('||')) {
			const right = this.parseAnd();
			value = conditionTruthy(value) || conditionTruthy(right);
		}
		return value;
	}
	private parseAnd(): unknown {
		let value = this.parseComparison();
		while (this.match('&&')) {
			const right = this.parseComparison();
			value = conditionTruthy(value) && conditionTruthy(right);
		}
		return value;
	}
	private parseComparison(): unknown {
		const left = this.parseUnary();
		const operator = this.peek().value;
		if (!['==', '===', '!=', '!==', '>', '<', '>=', '<='].includes(operator)) return left;
		this.take();
		const right = this.parseUnary();
		switch (operator) {
			case '==': case '===': return conditionEquals(left, right);
			case '!=': case '!==': return !conditionEquals(left, right);
			case '>': return (left as number) > (right as number);
			case '<': return (left as number) < (right as number);
			case '>=': return (left as number) >= (right as number);
			case '<=': return (left as number) <= (right as number);
			default: return false;
		}
	}
	private parseUnary(): unknown {
		if (this.match('!')) return !conditionTruthy(this.parseUnary());
		return this.parsePrimary();
	}
	private parsePrimary(): unknown {
		if (this.match('(')) {
			const value = this.parseOr();
			this.expect(')');
			return value;
		}
		const token = this.take();
		if (token.type === 'string') return token.value;
		if (token.type === 'number') return Number(token.value);
		if (token.type !== 'identifier') throw new WorkflowResolutionError(`Expected a value in workflow condition, received "${token.value}".`);
		if (token.value === 'true') return true;
		if (token.value === 'false') return false;
		if (token.value === 'null') return null;
		if (token.value === 'undefined') return undefined;
		if (token.value !== 'inputs' && token.value !== 'steps') {
			throw new WorkflowResolutionError(`Workflow conditions may only reference inputs or steps, not "${token.value}".`);
		}
		const path = [token.value];
		while (this.match('.')) {
			const segment = this.take();
			if (segment.type !== 'identifier') throw new WorkflowResolutionError('Expected a property name in workflow condition.');
			if (segment.value === 'contains' && this.match('(')) {
				const needle = this.parseOr();
				this.expect(')');
				const value = resolvePath({ inputs: this.context.inputs, steps: this.context.stepResults }, path);
				return typeof value === 'string'
					? value.includes(String(needle))
					: Array.isArray(value) && value.includes(needle);
			}
			path.push(segment.value);
		}
		return resolvePath({ inputs: this.context.inputs, steps: this.context.stepResults }, path);
	}
}

/** Evaluate a side-effect-free workflow condition against inputs and completed step results. */
export function evaluateWorkflowCondition(condition: string | undefined, context: WorkflowExecutionContext): boolean {
	if (!condition || condition.trim() === '') return true;
	return new WorkflowConditionParser(tokenizeCondition(condition), context).parse();
}

function numberMetadata(metadata: Record<string, unknown> | undefined, key: string): number {
	const value = metadata?.[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Executes workflow tiers through either the multi-provider dispatcher or Pi daemon. */
export class WorkflowEngine {
	constructor(
		private readonly executor: WorkflowExecutor,
		private readonly jitLifecycle?: WorkflowJitLifecycle,
		private readonly getStyleGuide?: () => string,
	) {}

	async execute(
		definition: WorkflowDefinition,
		providedInputs: Record<string, unknown> = {},
		options: WorkflowExecutionOptions = {},
	): Promise<WorkflowExecutionContext> {
		if (this.jitLifecycle && !options.jitManaged) {
			return this.withJitForDefinition(definition, () =>
				this.execute(definition, providedInputs, { ...options, jitManaged: true }));
		}
		const inputs: Record<string, unknown> = {};
		for (const [name, schema] of Object.entries(definition.inputs)) {
			if (schema.default !== undefined) inputs[name] = schema.default;
		}
		Object.assign(inputs, providedInputs);
		// Per-target values are engine-owned so one shared input object cannot route a
		// batch execution to the wrong note.
		if (options.targetFile) {
			inputs.target = {
				path: options.targetFile.path,
				name: options.targetFile.name,
				basename: options.targetFile.basename,
			};
			inputs.targetPath = options.targetFile.path;
		}
		for (const [name, schema] of Object.entries(definition.inputs)) {
			if (schema.required && inputs[name] === undefined) throw new Error(`Missing required workflow input: ${name}`);
		}

		const context: WorkflowExecutionContext = {
			inputs,
			stepResults: {},
			stepStatuses: Object.fromEntries(definition.steps.map(step => [step.id, 'pending'])),
			totalTokens: 0,
			totalLatencyMs: 0,
		};

		try {
			for (const tier of resolveWorkflowTiers(definition.steps)) {
				await Promise.all(tier.map(step => this.executeStep(definition, step, context, options)));
			}
			if (options.targetFile) this.queueTargetState(options, 'completed');
			await options.stateUpdateChain;
			return context;
		} catch (error) {
			if (options.targetFile) {
				this.queueTargetState(options, 'failed');
				await options.stateUpdateChain;
			}
			throw error;
		}
	}

	/** Resolve a `.base` file or consume a pre-resolved queue, then execute per target in bounded batches. */
	async executeOnTargets(
		definition: WorkflowDefinition,
		providedInputs: Record<string, unknown>,
		targets: TFile | TFile[],
		app: App,
		options: WorkflowBatchOptions = {},
	): Promise<WorkflowTargetExecution[]> {
		if (this.jitLifecycle) {
			return this.withJitForDefinition(definition, () =>
				this.executeTargetsManaged(definition, providedInputs, targets, app, options));
		}
		return this.executeTargetsManaged(definition, providedInputs, targets, app, options);
	}

	private async executeTargetsManaged(
		definition: WorkflowDefinition,
		providedInputs: Record<string, unknown>,
		targets: TFile | TFile[],
		app: App,
		options: WorkflowBatchOptions,
	): Promise<WorkflowTargetExecution[]> {
		const sourceBase = !Array.isArray(targets) && targets.extension === 'base' ? targets : undefined;
		const initialFiles = Array.isArray(targets)
			? targets
			: sourceBase ? await parseBaseQueue(sourceBase, app) : [targets];
		const normalizePath = (file: TFile) => file.path.replace(/\\/g, '/').toLowerCase();
		const deduplicate = (files: TFile[]) => {
			const byPath = new Map<string, TFile>();
			for (const file of files) if (file.extension === 'md') byPath.set(normalizePath(file), file);
			return [...byPath.values()];
		};
		let available = deduplicate(initialFiles);
		const concurrency = clampBaseBatchConcurrency(options.concurrency);
		const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit!)) : Number.POSITIVE_INFINITY;
		const processed = new Set<string>();
		const results: WorkflowTargetExecution[] = [];
		while (results.length < limit) {
			const batch = splitBaseQueueBatches(
				available.filter(file => !processed.has(normalizePath(file))),
				concurrency,
				limit - results.length,
			)[0] ?? [];
			if (batch.length === 0) break;
			for (const file of batch) processed.add(normalizePath(file));
			let fatalError: unknown;
			const batchResults = await Promise.all(batch.map(async file => {
				try {
					const context = await this.execute(definition, providedInputs, {
						targetFile: file,
						app,
						onStream: options.onStream,
						jitManaged: true,
					});
					return { file, context } satisfies WorkflowTargetExecution;
				} catch (error) {
					if (!options.continueOnError) fatalError ??= error;
					return { file, error: (error as Error).message } satisfies WorkflowTargetExecution;
				}
			}));
			results.push(...batchResults);
			// execute() has settled every processFrontMatter write. Let the native view
			// refresh, then re-query a Base before selecting the next queue tier.
			await options.onBatchComplete?.(batchResults, available.filter(file => !processed.has(normalizePath(file))));
			if (fatalError !== undefined) {
				throw fatalError instanceof Error ? fatalError : new Error('Workflow target execution failed.');
			}
			if (sourceBase) available = deduplicate(await parseBaseQueue(sourceBase, app));
		}
		return results;
	}

	/** Hold every distinct routed model used by this workflow until its full run/batch settles. */
	private withJitForDefinition<T>(definition: WorkflowDefinition, work: () => Promise<T>): Promise<T> {
		const taskTypes = [...new Set(definition.steps.map(step => step.taskType))];
		const run = (index: number): Promise<T> => {
			if (!this.jitLifecycle || index >= taskTypes.length) return work();
			return this.jitLifecycle.withJitModel(taskTypes[index]!, () => run(index + 1));
		};
		return run(0);
	}

	private queueTargetState(
		options: WorkflowExecutionOptions,
		status: 'running' | 'completed' | 'failed',
		evalScore?: number,
	): void {
		if (!options.targetFile) return;
		const previous = options.stateUpdateChain ?? Promise.resolve();
		const file = options.targetFile;
		options.stateUpdateChain = previous.catch(() => undefined).then(() => updateNoteAgentState(file, this.appForState(options), {
			status,
			...(evalScore === undefined ? {} : { evalScore }),
			lastRun: new Date().toISOString(),
		}));
	}

	private appForState(options: WorkflowExecutionOptions): App {
		const app = options.app;
		if (!app) throw new WorkflowResolutionError('Workflow target state updates require an Obsidian App.');
		return app;
	}

	private async executeStep(
		definition: WorkflowDefinition,
		step: WorkflowStep,
		context: WorkflowExecutionContext,
		options: WorkflowExecutionOptions,
	): Promise<void> {
		if (!evaluateWorkflowCondition(step.condition, context)) {
			context.stepStatuses[step.id] = 'skipped';
			options.onStream?.(`↷ ${step.name} skipped (condition was false)\n`, step, options.targetFile);
			return;
		}
		context.stepStatuses[step.id] = 'running';
		const prompt = interpolateTemplate(step.promptTemplate, context);
		const startedAt = Date.now();
		let streamed = false;
		const onDelta = options.onStream
			? (delta: string) => { streamed = true; options.onStream!(delta, step, options.targetFile); }
			: undefined;
		options.onStream?.(`\n▶ ${step.name}\n`, step, options.targetFile);
		try {
			const result = 'dispatch' in this.executor
				? await this.dispatchProvider(definition, step, prompt, onDelta, options.targetFile)
				: await this.dispatchDaemon(definition, step, prompt, onDelta, options.targetFile);
			const measuredLatency = Date.now() - startedAt;
			const executionResult: WorkflowStepExecutionResult = {
				...result,
				latencyMs: result.latencyMs || measuredLatency,
			};
			context.stepResults[step.id] = executionResult;
			if (step.outputKey) context.stepResults[step.outputKey] = executionResult;
			context.totalTokens += executionResult.tokens;
			context.totalLatencyMs += executionResult.latencyMs;
			context.stepStatuses[step.id] = 'completed';
			if (options.targetFile) {
				const finished = Object.values(context.stepStatuses).every(status => status === 'completed' || status === 'skipped');
				this.queueTargetState(options, finished ? 'completed' : 'running');
			}
			if (!streamed && executionResult.output) options.onStream?.(`${executionResult.output}\n`, step, options.targetFile);
			options.onStream?.(`✓ ${step.name} complete\n`, step, options.targetFile);
		} catch (error) {
			context.stepStatuses[step.id] = 'failed';
			if (options.targetFile) this.queueTargetState(options, 'failed');
			options.onStream?.(`✕ ${step.name}: ${(error as Error).message}\n`, step, options.targetFile);
			throw error;
		}
	}

	private async dispatchProvider(
		definition: WorkflowDefinition,
		step: WorkflowStep,
		prompt: string,
		onStream?: (delta: string) => void,
		targetFile?: TFile,
	): Promise<WorkflowStepExecutionResult> {
		const styleGuide = this.getStyleGuide?.() ?? '';
		const response: ProviderResponse = await (this.executor as Pick<ProviderDispatcher, 'dispatch'>).dispatch({
			systemPrompt: `Workflow: ${definition.name}\nStep: ${step.name}\nWorker profile: ${step.workerProfile}${step.role ? `\nRole: ${step.role}` : ''}\n\nFollow this runtime style guide:\n<style-guide>\n${styleGuide}\n</style-guide>`,
			userPrompt: prompt,
			taskId: `${definition.id}:${targetFile?.path ?? 'single'}:${step.id}`,
			onStream,
		}, step.taskType);
		if (!response.success) throw new Error(response.error ?? `Workflow step ${step.id} failed.`);
		return {
			result: response.output,
			output: response.output,
			providerId: response.providerId,
			model: response.model,
			tokens: response.usage?.totalTokens ?? 0,
			latencyMs: response.latencyMs,
			metadata: response.usage ? { usage: response.usage } : undefined,
		};
	}

	private async dispatchDaemon(
		definition: WorkflowDefinition,
		step: WorkflowStep,
		prompt: string,
		onStream?: (delta: string) => void,
		targetFile?: TFile,
	): Promise<WorkflowStepExecutionResult> {
		const response: AgentTaskResponse = await (this.executor as Pick<PiAgentDaemon, 'executeTask'>).executeTask({
			taskId: `${definition.id}:${targetFile?.path ?? 'single'}:${step.id}`,
			workerProfile: step.workerProfile,
			targetPath: targetFile?.path,
			prompt: step.role ? `Role: ${step.role}\n\n${prompt}` : prompt,
		}, onStream ? delta => onStream(delta) : undefined);
		if (response.error) throw new Error(response.error);
		const result = response.result ?? {};
		const metadata = result.metadata;
		const output = result.output ?? result.summary ?? '';
		return {
			result: output,
			output,
			tokens: numberMetadata(metadata, 'totalTokens') || numberMetadata(metadata, 'tokens'),
			latencyMs: numberMetadata(metadata, 'latencyMs'),
			metadata,
		};
	}
}
