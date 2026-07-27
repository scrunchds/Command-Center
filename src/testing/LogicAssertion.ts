import type { DataNormalizer, ExecutionSource, NormalizedExecutionResult } from '../execution/DataNormalizer';
import type { DialecticMatch, DialecticRAG, DialecticRAGOptions } from '../memory/DialecticRAG';
import type { ShadowCloneManager, ShadowMutationResult } from './ShadowCloneManager';

export interface LogicAssertionResult {
	passed: boolean;
	checks: readonly LogicAssertionCheck[];
	matches: readonly DialecticMatch[];
	normalized: NormalizedExecutionResult;
	write?: ShadowMutationResult;
}

export interface LogicAssertionCheck {
	name: 'rag-context' | 'normalized-schema' | 'shadow-write';
	passed: boolean;
	detail: string;
}

export interface LogicAssertionInput {
	query: string;
	expectedPaths: readonly string[];
	externalOutput: unknown;
	source: ExecutionSource;
	targetPath: string;
	ragOptions?: DialecticRAGOptions;
}

/** Evaluates retrieval and normalization before permitting a simulated write. */
export class LogicAssertion {
	constructor(
		private readonly rag: DialecticRAG,
		private readonly normalizer: DataNormalizer,
		private readonly clone: ShadowCloneManager,
	) {}

	async evaluate(input: LogicAssertionInput): Promise<LogicAssertionResult> {
		const matches = await this.rag.retrieve(input.query, input.ragOptions);
		const retrievedPaths = new Set(matches.flatMap(match => [match.chunk.metadata.filePath, ...match.graphPaths]));
		const missing = input.expectedPaths.filter(path => !retrievedPaths.has(path));
		const ragCheck: LogicAssertionCheck = {
			name: 'rag-context', passed: missing.length === 0,
			detail: missing.length ? `Missing expected context: ${missing.join(', ')}` : 'Dialectic RAG returned all expected semantic or structural context.',
		};

		const normalized = this.normalizer.normalize(input.externalOutput, input.source);
		const normalizedCheck: LogicAssertionCheck = {
			name: 'normalized-schema', passed: this.isNormalized(normalized),
			detail: this.isNormalized(normalized) ? 'Output conforms to the normalized execution schema.' : 'Output failed normalized execution schema checks.',
		};
		const checks = [ragCheck, normalizedCheck];
		let write: ShadowMutationResult | undefined;
		if (ragCheck.passed && normalizedCheck.passed && normalized.success) {
			write = this.clone.intercept({ kind: this.clone.read(input.targetPath) === undefined ? 'create' : 'update', path: input.targetPath, content: normalized.content });
			checks.push({ name: 'shadow-write', passed: write.applied, detail: write.applied ? 'Normalized output was written only to the shadow clone.' : write.reason ?? 'Shadow write rejected.' });
		} else {
			checks.push({ name: 'shadow-write', passed: false, detail: 'Simulated write blocked because prerequisite assertions failed.' });
		}
		return { passed: checks.every(check => check.passed), checks, matches, normalized, ...(write ? { write } : {}) };
	}

	private isNormalized(value: NormalizedExecutionResult): boolean {
		return value.schemaVersion === 1 && typeof value.success === 'boolean' && typeof value.content === 'string' && typeof value.latencyMs === 'number' && value.latencyMs >= 0 && !/^\s*at\s+.+:\d+:\d+/m.test(value.content) && !(value.error && /\n/.test(value.error));
	}
}
