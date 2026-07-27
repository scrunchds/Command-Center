import type { ProviderId, ProviderResponse, ProviderToolCall, ProviderUsage } from '../providers/provider-types';

export type ExecutionSource = 'provider-dispatcher' | 'pi-daemon' | 'python-worker';

export interface NormalizedExecutionResult {
	schemaVersion: 1;
	success: boolean;
	content: string;
	error?: string;
	providerId?: ProviderId;
	modelId?: string;
	usage?: ProviderUsage;
	toolCalls?: ProviderToolCall[];
	latencyMs: number;
	source: ExecutionSource;
}

const STACK_LINE = /^\s*(?:at\s+.+(?:\(.+?:\d+:\d+\)|:\d+:\d+)|File\s+".+",\s+line\s+\d+|Traceback \(most recent call last\):)/i;
const stripControlCharacters = (value: string): string => [...value].filter(character => {
	const code = character.charCodeAt(0);
	return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
}).join('');

/** Mandatory trust boundary between external processes and Markdown consumers. */
export class DataNormalizer {
	normalizeMany(payloads: readonly unknown[], source: ExecutionSource): NormalizedExecutionResult[] {
		return payloads.map(payload => this.normalize(payload, source));
	}

	merge(payloads: readonly unknown[], source: ExecutionSource): NormalizedExecutionResult {
		const results = this.normalizeMany(payloads, source);
		const failure = results.find(result => !result.success);
		return {
			schemaVersion: 1,
			success: !failure,
			content: results.filter(result => result.success && result.content).map(result => result.content).join('\n\n---\n\n'),
			...(failure ? { error: failure.error ?? 'One or more agent workers failed safely.' } : {}),
			latencyMs: results.reduce((total, result) => total + result.latencyMs, 0),
			source,
		};
	}

	normalize(payload: unknown, source: ExecutionSource): NormalizedExecutionResult {
		const value = this.toRecord(payload);
		const nested = this.toOptionalRecord(value.result);
		const success = value.success === true && nested?.success !== false;
		const content = this.cleanText(this.string(value.content) ?? this.string(value.output) ?? this.string(value.result) ?? this.string(nested?.content) ?? this.string(nested?.output));
		const error = this.cleanError(this.string(value.error) ?? this.string(nested?.error) ?? (success ? undefined : this.string(value.stderr)));
		return {
			schemaVersion: 1,
			success: success && !error,
			content,
			...(error ? { error } : {}),
			...(this.providerId(value.providerId) ? { providerId: this.providerId(value.providerId) } : {}),
			...(this.string(value.modelId) ?? this.string(value.model) ? { modelId: this.cleanInline(this.string(value.modelId) ?? this.string(value.model) ?? '') } : {}),
			...(this.usage(value.usage) ? { usage: this.usage(value.usage) } : {}),
			...(this.toolCalls(value.toolCalls) ? { toolCalls: this.toolCalls(value.toolCalls) } : {}),
			latencyMs: this.nonNegativeNumber(value.latencyMs),
			source,
		};
	}

	normalizeProvider(response: ProviderResponse): NormalizedExecutionResult {
		return this.normalize(response, response.providerId === 'pi-daemon' ? 'pi-daemon' : 'provider-dispatcher');
	}

	private toRecord(payload: unknown): Record<string, unknown> {
		if (typeof payload === 'string') {
			try { return this.toRecord(JSON.parse(payload)); }
			catch { return { success: false, error: 'Worker returned malformed JSON.' }; }
		}
		return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : { success: false, error: 'Worker returned an invalid payload.' };
	}
	private toOptionalRecord(value: unknown): Record<string, unknown> | undefined {
		return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	}
	private string(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
	private cleanText(value = ''): string {
		return stripControlCharacters(value).split(/\r?\n/).filter(line => !STACK_LINE.test(line)).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1_000_000);
	}
	private cleanError(value?: string): string | undefined {
		if (!value) return undefined;
		const firstSafeLine = stripControlCharacters(value).split(/\r?\n/).find(line => line.trim() && !STACK_LINE.test(line));
		return firstSafeLine ? this.cleanInline(firstSafeLine).slice(0, 500) : 'External execution failed.';
	}
	private cleanInline(value: string): string { return stripControlCharacters(value).replace(/[\r\n]+/g, ' ').trim().slice(0, 500); }
	private nonNegativeNumber(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0; }
	private providerId(value: unknown): ProviderId | undefined {
		const ids: ProviderId[] = ['pi-daemon', 'openai', 'anthropic', 'google-gemini', 'openrouter', 'ollama', 'groq', 'deepinfra', 'mistral', 'cohere', 'lmstudio', 'custom'];
		return typeof value === 'string' && ids.includes(value as ProviderId) ? value as ProviderId : undefined;
	}
	private usage(value: unknown): ProviderUsage | undefined {
		const usage = this.toRecord(value);
		if (![usage.promptTokens, usage.completionTokens, usage.totalTokens].every(item => typeof item === 'number' && Number.isFinite(item))) return undefined;
		return { promptTokens: this.nonNegativeNumber(usage.promptTokens), completionTokens: this.nonNegativeNumber(usage.completionTokens), totalTokens: this.nonNegativeNumber(usage.totalTokens) };
	}
	private toolCalls(value: unknown): ProviderToolCall[] | undefined {
		if (!Array.isArray(value)) return undefined;
		const calls = value.filter((item): item is ProviderToolCall => item !== null && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string' && typeof (item as Record<string, unknown>).name === 'string' && typeof (item as Record<string, unknown>).arguments === 'object');
		return calls.length ? calls.map(call => ({ ...call, arguments: { ...call.arguments } })) : undefined;
	}
}
