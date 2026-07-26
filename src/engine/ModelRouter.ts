import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from '../obsidian-request';
import type { ConfigManager } from './ConfigManager';
import type { ComputeTier, StandardAgentRole } from './AgentTypes';
import type { ComputeEndpointConfig } from '../onboarding/OnboardingTypes';

export type ExecutionFallbackPolicy = 'fail_fast' | 'fallback_to_cloud' | 'ask_user';
export interface ExecutionRequest {
	prompt: string;
	workerRole: StandardAgentRole;
	preferredTier: ComputeTier;
	fallbackPolicy: ExecutionFallbackPolicy;
	systemPrompt?: string;
	onStream?: (delta: string) => void;
}
export interface EndpointAttempt {
	endpointId: string;
	provider: string;
	tier: ComputeTier;
	model: string;
	latencyMs: number;
	success: boolean;
	errorType?: ModelRouterErrorCode;
	error?: string;
}
export interface ExecutionResponse {
	output: string;
	tierUsed: ComputeTier;
	endpointId: string;
	provider: string;
	model: string;
	latencyMs: number;
	attempts: EndpointAttempt[];
}
export interface ModelRouterOptions {
	request?: (options: RequestUrlParam | string) => Promise<RequestUrlResponse>;
	resolveCredential?: (credentialRef: string | undefined, endpoint: ComputeEndpointConfig) => string | undefined;
	askUser?: (request: ExecutionRequest, error: ModelRouterError) => Promise<'fallback_to_cloud' | 'retry' | 'cancel'>;
}
export type ModelRouterErrorCode = 'timeout' | 'connection' | 'http' | 'model' | 'configuration' | 'cancelled';

/** Sanitized typed error. It deliberately carries no headers, body payload, or credential values. */
export class ModelRouterError extends Error {
	constructor(
		readonly code: ModelRouterErrorCode,
		message: string,
		readonly endpointId?: string,
		readonly status?: number,
	) { super(message); this.name = 'ModelRouterError'; }
}

/** Config-driven endpoint dispatcher with timeout, retry, and explicit tier fallback. */
export class ModelRouter {
	private readonly requestImpl: (options: RequestUrlParam | string) => Promise<RequestUrlResponse>;
	private readonly resolveCredential?: ModelRouterOptions['resolveCredential'];
	private readonly askUser?: ModelRouterOptions['askUser'];

	constructor(private readonly configs: ConfigManager, options: ModelRouterOptions = {}) {
		this.requestImpl = options.request ?? requestUrl;
		this.resolveCredential = options.resolveCredential;
		this.askUser = options.askUser;
	}

	async dispatch(request: ExecutionRequest): Promise<ExecutionResponse> {
		if (!request.prompt.trim()) throw new ModelRouterError('configuration', 'Execution prompt cannot be empty.');
		const startedAt = Date.now();
		const attempts: EndpointAttempt[] = [];
		try {
			const primary = await this.executeTier(request, request.preferredTier, attempts);
			return { ...primary, latencyMs: Date.now() - startedAt, attempts };
		} catch (error) {
			const typed = normalizeError(error);
			if (request.preferredTier === 'tier1_local' && request.fallbackPolicy === 'fallback_to_cloud') {
				const fallback = await this.executeTier(request, 'tier2_reasoning', attempts);
				return { ...fallback, latencyMs: Date.now() - startedAt, attempts };
			}
			if (request.fallbackPolicy === 'ask_user' && this.askUser) {
				const decision = await this.askUser(request, typed);
				if (decision === 'retry') return this.dispatch(request);
				if (decision === 'fallback_to_cloud') {
					const fallback = await this.executeTier(request, 'tier2_reasoning', attempts);
					return { ...fallback, latencyMs: Date.now() - startedAt, attempts };
				}
				throw new ModelRouterError('cancelled', 'Execution cancelled by user.');
			}
			throw typed;
		}
	}

	private async executeTier(request: ExecutionRequest, tier: ComputeTier, attempts: EndpointAttempt[]): Promise<Omit<ExecutionResponse, 'latencyMs' | 'attempts'>> {
		const endpoints = this.configs.getComputeEndpoints(tier);
		if (!endpoints.length) throw new ModelRouterError('configuration', `No enabled ${tier} endpoint is configured.`);
		let lastError: ModelRouterError | null = null;
		for (const endpoint of endpoints) {
			const maxAttempts = Math.max(1, Math.floor(endpoint.maxRetries ?? 0) + 1);
			for (let index = 0; index < maxAttempts; index++) {
				const startedAt = Date.now();
				try {
					const output = await this.executeCall(endpoint, request);
					attempts.push(publicAttempt(endpoint, Date.now() - startedAt, true));
					return { output, tierUsed: tier, endpointId: endpoint.id, provider: endpoint.provider, model: endpoint.model };
				} catch (error) {
					lastError = normalizeError(error, endpoint.id);
					attempts.push(publicAttempt(endpoint, Date.now() - startedAt, false, lastError));
					if (index + 1 < maxAttempts) await delay(Math.max(0, endpoint.backoffMs ?? 0) * (2 ** index));
				}
			}
		}
		throw lastError ?? new ModelRouterError('model', `All ${tier} endpoints failed.`);
	}

	async executeCall(endpoint: ComputeEndpointConfig, request: ExecutionRequest): Promise<string> {
		let timer: number | undefined;
		try {
			const credential = this.resolveCredential?.(endpoint.credentialRef, endpoint);
			const { url, headers, body } = buildBoundaryRequest(endpoint, request, credential);
			const timeout = new Promise<never>((_resolve, reject) => {
				timer = window.setTimeout(() => reject(
					new ModelRouterError('timeout', `Endpoint ${endpoint.id} timed out after ${endpoint.timeoutMs}ms.`, endpoint.id),
				), endpoint.timeoutMs);
			});
			const response = await Promise.race([
				this.requestImpl({ url, method: 'POST', headers, body: JSON.stringify(body) }),
				timeout,
			]);
			const payload = response.json as unknown;
			const output = parseOutput(endpoint.protocol, payload);
			if (!output.trim()) throw new ModelRouterError('model', `Endpoint ${endpoint.id} returned no model output.`, endpoint.id);
			request.onStream?.(output);
			return output;
		} catch (error) {
			if (error instanceof ModelRouterError) throw error;
			const status = requestErrorStatus(error);
			if (status !== undefined) throw new ModelRouterError('http', `Endpoint ${endpoint.id} returned HTTP ${status}.`, endpoint.id, status);
			throw new ModelRouterError('connection', `Could not connect to endpoint ${endpoint.id}.`, endpoint.id);
		} finally {
			if (timer !== undefined) window.clearTimeout(timer);
		}
	}
}

function buildBoundaryRequest(endpoint: ComputeEndpointConfig, request: ExecutionRequest, credential?: string): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
	const url = joinUrl(endpoint.baseUrl, endpoint.completionPath);
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (endpoint.protocol === 'anthropic') {
		if (credential) headers['x-api-key'] = credential;
		headers['anthropic-version'] = '2023-06-01';
		return { url, headers, body: { model: endpoint.model, max_tokens: 4096, system: request.systemPrompt ?? rolePrompt(request), messages: [{ role: 'user', content: request.prompt }] } };
	}
	if (endpoint.protocol === 'gemini') {
		if (credential) headers['x-goog-api-key'] = credential;
		return { url, headers, body: { model: endpoint.model, system_instruction: { parts: [{ text: request.systemPrompt ?? rolePrompt(request) }] }, contents: [{ role: 'user', parts: [{ text: request.prompt }] }] } };
	}
	if (credential) headers.Authorization = `Bearer ${credential}`;
	return { url, headers, body: { model: endpoint.model, messages: [{ role: 'system', content: request.systemPrompt ?? rolePrompt(request) }, { role: 'user', content: request.prompt }] } };
}
function parseOutput(protocol: ComputeEndpointConfig['protocol'], payload: unknown): string {
	const source = record(payload);
	if (!source) return '';
	if (protocol === 'anthropic') return array(source.content).map(item => record(item)?.text).filter((text): text is string => typeof text === 'string').join('');
	if (protocol === 'gemini') { const candidate = record(array(source.candidates)[0]); const content = record(candidate?.content); return array(content?.parts).map(item => record(item)?.text).filter((text): text is string => typeof text === 'string').join(''); }
	const choice = record(array(source.choices)[0]); const message = record(choice?.message); return typeof message?.content === 'string' ? message.content : typeof choice?.text === 'string' ? choice.text : '';
}
function publicAttempt(endpoint: ComputeEndpointConfig, latencyMs: number, success: boolean, error?: ModelRouterError): EndpointAttempt { return { endpointId: endpoint.id, provider: endpoint.provider, tier: endpoint.tier, model: endpoint.model, latencyMs, success, ...(error ? { errorType: error.code, error: error.message } : {}) }; }
function rolePrompt(request: ExecutionRequest): string { return `You are the ${request.workerRole} worker. Execute only the supplied task.`; }
function normalizeError(error: unknown, endpointId?: string): ModelRouterError { if (error instanceof ModelRouterError) return error; return new ModelRouterError('model', 'Model execution failed.', endpointId); }
function requestErrorStatus(error: unknown): number | undefined {
	if (!error || typeof error !== 'object' || !('status' in error)) return undefined;
	const status: unknown = error.status;
	return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}
function joinUrl(baseUrl: string, path: string): string { return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`; }
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function delay(ms: number): Promise<void> { return ms > 0 ? new Promise(resolve => window.setTimeout(resolve, ms)) : Promise.resolve(); }
