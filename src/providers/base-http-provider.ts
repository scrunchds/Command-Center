/**
 * Base HTTP Provider — shared logic for all HTTP-based LLM providers.
 *
 * Handles: fetch, streaming (SSE), tool-call interception, retry/backoff,
 * rate-limit detection, and typed error normalization.
 *
 * Subclasses implement the abstract request/response/stream format adapters
 * for their specific API shape. The base `complete()` method handles the
 * common lifecycle: build → fetch → parse → stream → tool-loop.
 */

import { requestUrl, type RequestUrlResponse } from '../obsidian-request';
import type {
	IProviderAdapter, ProviderId, ProviderMeta, ProviderModel, TaskType,
	ProviderRequest, ProviderResponse, ProviderRequestConfig,
	ProviderToolCall, ProviderToolResult, ProviderMessage,
	ProviderError, ProviderCapabilities, ImageContent,
} from './provider-types';
import {
	DEFAULT_PROVIDER_CONFIG, classifyHttpError, classifyThrowError,
	detectLocalRuntime, isLocalBaseUrl, sanitizeBaseUrl,
} from './provider-types';
import { getDefaultModelForProvider } from './provider-registry';
import { JitModelManager } from './jit-manager';

/* ─── Constructor Options ──────────────────────────────── */

export interface BaseHttpProviderOptions {
	id: ProviderId;
	meta: ProviderMeta;
	getApiKey: () => string;
	getBaseUrl: () => string;
	timeoutMs?: number;
}

/* ─── Abstract Base ────────────────────────────────────── */

export abstract class BaseHttpProvider implements IProviderAdapter {
	readonly id: ProviderId;
	readonly meta: ProviderMeta;
	protected getApiKey: () => string;
	protected getBaseUrl: () => string;
	protected timeoutMs: number;
	protected abortController: AbortController | null = null;
	private readonly jitModelManager: JitModelManager;

	constructor(opts: BaseHttpProviderOptions) {
		this.id = opts.id;
		this.meta = opts.meta;
		this.getApiKey = opts.getApiKey;
		// Sanitize at the provider boundary so malformed user input (e.g.
		// comma-separated endpoint lists pasted into a Base URL field) never
		// reaches requestUrl/fetch. Wrapping the callback centralizes
		// sanitization for every subclass call site: endpoint builders, JIT
		// payload decisions, and isLocalBaseUrl/detectLocalRuntime checks.
		this.getBaseUrl = () => sanitizeBaseUrl(opts.getBaseUrl());
		this.timeoutMs = opts.timeoutMs ?? 120_000;
		this.jitModelManager = new JitModelManager({ getApiKey: this.getApiKey });
	}

	/* ─── IProviderAdapter core ─────────────────────── */

	isAvailable(): boolean {
		return this.meta.requiresKey ? this.getApiKey().length > 0 : true;
	}

	supportsCapability(cap: keyof ProviderCapabilities): boolean {
		return !!this.meta.capabilities[cap];
	}

	async healthCheck(): Promise<string | null> {
		if (!this.isAvailable()) return 'API key not configured.';
		try {
			const resp = await this.complete({
				systemPrompt: 'You are a health check.',
				userPrompt: 'Respond with just "OK".',
				config: { maxTokens: 10, temperature: 0 },
			});
			return resp.success ? null : (resp.error ?? 'Health check failed.');
		} catch (err) {
			return (err as Error).message;
		}
	}

	async countTokens(text: string, _model?: string): Promise<number> {
		if (!this.supportsCapability('tokenCounting')) return -1;
		// Default estimate: ~4 chars/token for English text
		return Math.ceil(text.length / 4);
	}

	listModels(): ProviderModel[] {
		return this.meta.models;
	}

	getDefaultModel(taskType: TaskType): string {
		return getDefaultModelForProvider(this.id, taskType);
	}

	abort(): void {
		this.abortController?.abort();
		this.abortController = null;
	}

	/** Release resources. Subclasses can override for cleanup. */
	dispose(): void {
		this.abort();
	}

	/* ─── Core complete() pipeline ──────────────────── */

	async complete(request: ProviderRequest): Promise<ProviderResponse> {
		this.abortController = new AbortController();
		return this._completeImpl(request);
	}

	/**
	 * Single unified completion implementation.
	 * Gemini overrides getEndpoint() to return the full URL with key embedded,
	 * so the base pipeline works for it too.
	 */
	protected async _completeImpl(request: ProviderRequest): Promise<ProviderResponse> {
		const startedAt = Date.now();

		const cfg = { ...DEFAULT_PROVIDER_CONFIG, ...request.config };
		const model = cfg.model ?? this.getDefaultModel('reasoning');

		// This shared boundary covers Quick/conversation dispatch, workflow steps,
		// router tasks, and any other HTTP completion entry point. Pre-warming is
		// best-effort; inference remains authoritative if a local lifecycle API is
		// unavailable. TTL/keep-alive in the request handles eventual eviction.
		const baseUrl = this.getBaseUrl();
		if (isLocalBaseUrl(baseUrl) && this.shouldPrewarmModel()) {
			const retention = cfg.ttl ?? (typeof cfg.keepAlive === 'number' ? cfg.keepAlive : 300);
			await this.jitModelManager.ensureModelLoaded(baseUrl, model, retention);
		}

		const messages = this.buildMessages(request.systemPrompt, request.userPrompt, request.history);
		const body = this.applyJitPayloadFields(
			this.buildRequestBody(messages, model, cfg, request.tools, request.images), cfg,
		);
		const headers = this.buildHeaders(this.getApiKey());

		// Streaming path
		if (request.onStream) {
			return this._streamComplete(body, headers, model, startedAt, request);
		}

		// Non-streaming path
		try {
			const response = await this._request(body, headers, model);
			const data = response.json as Record<string, unknown>;
			return this.parseResponse(data, model, startedAt);
		} catch (err) {
			return this._errorResponse(err, model, startedAt);
		}
	}

	/* ─── Streaming pipeline ────────────────────────── */

	private async _streamComplete(
		body: unknown, headers: Record<string, string>,
		model: string, startedAt: number, request: ProviderRequest,
	): Promise<ProviderResponse> {
		try {
			const streamBody = { ...(body as Record<string, unknown>), stream: true };
			const response = await this._fetchStreaming(streamBody, headers, model);

			const reader = response.body?.getReader();
			if (!reader) {
				// Fallback to non-streaming
				const data = await response.json() as Record<string, unknown>;
				return this.parseResponse(data, model, startedAt);
			}

			const decoder = new TextDecoder();
			let buffer = '';
			let fullOutput = '';
			const toolCalls: ProviderToolCall[] = [];
			let usage = undefined;

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';
				for (const line of lines) {
					const event = this.parseStreamEvent(line, fullOutput, toolCalls);
					if (event === null) continue;
					if (event.type === 'delta' && event.text) {
						fullOutput += event.text;
						request.onStream?.(event.text);
					}
					if (event.type === 'tool_call') {
						toolCalls.push(event.toolCall!);
					}
					if (event.type === 'usage') {
						usage = event.usage;
					}
				}
			}

			// Drain final buffer
			for (const line of buffer.split('\n')) {
				const event = this.parseStreamEvent(line, fullOutput, toolCalls);
				if (event?.type === 'delta' && event.text) fullOutput += event.text;
			}

			// Tool-call loop
			if (toolCalls.length > 0 && request.onToolCall) {
				const toolResults = await this._executeToolCalls(toolCalls, request);
				const finalResponse = await this._sendToolResults(
					this.buildMessages(request.systemPrompt, request.userPrompt, request.history),
					model, toolResults, request,
				);
				fullOutput = finalResponse.output;
				usage = finalResponse.usage;
			}

			return {
				output: fullOutput, success: true, model, providerId: this.id,
				usage, toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
				latencyMs: Date.now() - startedAt,
			};
		} catch (err) {
			return this._errorResponse(err, model, startedAt);
		}
	}

	/* ─── Tool execution ────────────────────────────── */

	private async _executeToolCalls(
		toolCalls: ProviderToolCall[], request: ProviderRequest,
	): Promise<ProviderToolResult[]> {
		return Promise.all(toolCalls.map(async tc => {
			try {
				return await request.onToolCall!(tc.name, tc.arguments);
			} catch (err) {
				return { toolCallId: tc.id, content: '', error: (err as Error).message };
			}
		}));
	}

	private async _sendToolResults(
		messages: ProviderMessage[], model: string,
		toolResults: ProviderToolResult[], request: ProviderRequest,
	): Promise<ProviderResponse> {
		const toolMsgs: ProviderMessage[] = toolResults.map(tr => ({
			role: 'tool' as const, content: tr.error ?? tr.content, toolCallId: tr.toolCallId,
		}));
		const allMessages = [...messages, ...toolMsgs];
		const config = { ...DEFAULT_PROVIDER_CONFIG, ...request.config };
		const body = this.applyJitPayloadFields(
			this.buildRequestBody(allMessages, model, config, undefined, request.images), config,
		);
		const headers = this.buildHeaders(this.getApiKey());

		try {
			const response = await this._request(body, headers, model);
			const data = response.json as Record<string, unknown>;
			return this.parseResponse(data, model, Date.now());
		} catch (err) {
			return this._errorResponse(err, model, Date.now());
		}
	}

	/**
	 * Final payload boundary shared by every HTTP entry point and tool-result
	 * continuation. Cloud requests are scrubbed even when stale JIT keys came
	 * from `config.extra`; local runtimes receive only their native lifecycle
	 * field (LM Studio `ttl`, Ollama `keep_alive`). Unknown local OpenAI-style
	 * servers receive both for compatibility.
	 */
	protected applyJitPayloadFields(body: unknown, config: ProviderRequestConfig): unknown {
		if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
		const payload = body as Record<string, unknown>;
		delete payload.ttl;
		delete payload.keep_alive;
		delete payload.keepAlive;
		if (!isLocalBaseUrl(this.getBaseUrl())) return payload;

		const runtime = detectLocalRuntime(this.getBaseUrl(), this.id);
		if (runtime === 'ollama') payload.keep_alive = config.keepAlive ?? '5m';
		else payload.ttl = config.ttl ?? 300;
		return payload;
	}

	/** Subclasses may skip optional lifecycle prewarming when discovery already proves a model is loaded. */
	protected shouldPrewarmModel(): boolean { return true; }

	/* ─── HTTP requests and streaming transport ───────── */

	private async _request(
		body: unknown, headers: Record<string, string>, model: string,
	): Promise<RequestUrlResponse> {
		try {
			return await requestUrl({
				url: this.resolveEndpoint(model),
				method: 'POST', headers,
				body: JSON.stringify(body),
			});
		} catch (err) {
			if (err && typeof err === 'object' && 'status' in err) {
				const status: unknown = err.status;
				if (typeof status === 'number') {
					const detail = 'text' in err && typeof err.text === 'string'
						? err.text
						: err instanceof Error ? err.message : '';
					throw classifyHttpError(status, detail, this.id);
				}
			}
			throw classifyThrowError(err, this.id);
		}
	}

	private async _fetchStreaming(body: unknown, headers: Record<string, string>, model: string): Promise<Response> {
		const timeoutId = window.setTimeout(() => this.abortController!.abort(), this.timeoutMs);
		try {
			const url = this.resolveEndpoint(model);
			// The Obsidian requestUrl API does not support ReadableStreams/SSE responses.
			// Obsidian's requestUrl returns RequestUrlResponse (status, headers, text, json, arrayBuffer)
			// with no access to the underlying ReadableStream body. Token-by-token SSE streaming
			// is therefore impossible with requestUrl. Standard fetch is the documented exception
			// per https://docs.obsidian.md/Plugins/Guides/Network+requests for streaming use cases.
			// All non-streaming requests in this file use requestUrl instead.
			const response = await window.fetch(url, {
				method: 'POST', headers,
				body: JSON.stringify(body),
				signal: this.abortController!.signal,
			});
			window.clearTimeout(timeoutId);

			if (!response.ok) {
				const errText = await response.text().catch(() => '');
				throw classifyHttpError(response.status, errText, this.id);
			}
			return response;
		} catch (err) {
			window.clearTimeout(timeoutId);
			if (err instanceof Error && err.name === 'ProviderError') throw err;
			throw classifyThrowError(err, this.id);
		}
	}

	/** Convert any error to a consistent ProviderResponse. */
	private _errorResponse(err: unknown, model: string, startedAt: number): ProviderResponse {
		const typedErr = err instanceof Error && err.name === 'ProviderError'
			? err as ProviderError
			: classifyThrowError(err, this.id);
		return {
			output: '', success: false,
			error: typedErr.message,
			typedError: typedErr,
			model, providerId: this.id,
			latencyMs: Date.now() - startedAt,
		};
	}

		/* ─── Live Model Fetching ───────────────────── */

	/**
	 * Fetch live models from the provider's API.
	 * Default implementation hits GET {getModelListEndpoint()} and parses
	 * the standard OpenAI-compatible response shape {data: [{id, object}]}.
	 * Subclasses override when the API shape differs (Anthropic, Gemini, Ollama, Cohere).
	 */
	async fetchLiveModels(): Promise<ProviderModel[]> {
		const apiKey = this.getApiKey();
		if (this.meta.requiresKey && !apiKey) return [];

		try {
			const url = this.getModelListEndpoint();
			const headers = this.buildListHeaders(apiKey);
			const response = await requestUrl({ url, headers });
			const data = response.json as Record<string, unknown>;
			return this.parseModelListResponse(data);
		} catch {
			return [];
		}
	}

	/**
	 * Endpoint URL for listing models.
	 * Override for providers with non-standard listing paths (e.g. Ollama, Gemini).
	 */
	protected getModelListEndpoint(): string {
		const base = this.getBaseUrl().replace(/\/+$/, '');
		return `${base}/models`;
	}

	/**
	 * Headers for model listing requests.
	 * Default uses Bearer token from getApiKey(). Override if different auth is needed.
	 */
	protected buildListHeaders(apiKey: string): Record<string, string> {
		const h: Record<string, string> = { 'Content-Type': 'application/json' };
		if (apiKey) {
			h['Authorization'] = `Bearer ${apiKey}`;
		}
		return h;
	}

	/**
	 * Parse a standard OpenAI-compatible model list response.
	 * Response shape: { data: [{ id, object, created, owned_by }] }
	 */
	protected parseModelListResponse(data: Record<string, unknown>): ProviderModel[] {
		const rawModels = data.data as Array<Record<string, unknown>> | undefined;
		if (!rawModels || !Array.isArray(rawModels)) return [];

		return rawModels
			.filter(m => m.id && typeof m.id === 'string')
			.map(m => this.rawModelToProviderModel(m.id as string));
	}

	/**
	 * Convert a raw model ID from the API into a ProviderModel with best-effort
	 * defaults. Merges with any matching entry from the static registry.
	 */
	protected rawModelToProviderModel(id: string): ProviderModel {
		// Check static registry for known metadata
		const registered = this.meta.models.find(m => m.id === id);
		if (registered) return { ...registered };

		// Infer from model ID heuristics
		const label = id
			.replace(/^.*\//, '')          // strip org prefix (e.g. openai/gpt-4o → gpt-4o)
			.replace(/[-_]/g, ' ')          // hyphens/underscores → spaces
			.replace(/\b(\w)/g, c => c.toUpperCase()); // Title Case

		return {
			id,
			label,
			contextWindow: 128_000,
			maxOutput: 4096,
			supportsVision: /vision|gpt-4o|gemini|claude-3/i.test(id),
			supportsTools: !/instruct/i.test(id),
			supportsCaching: /claude|anthropic/i.test(id),
			costTier: /mini|flash|haiku|fast/i.test(id) ? 'cheap' : /opus|ultra|expensive|o1/i.test(id) ? 'expensive' : 'moderate',
			strengths: ['reasoning', 'fast'] as TaskType[],
		};
	}

	/* ─── Abstract — subclasses MUST implement ─────── */

	protected abstract buildRequestBody(
		messages: ProviderMessage[], model: string,
		config: ProviderRequestConfig, tools?: unknown[],
		images?: ImageContent[],
	): unknown;

	protected abstract buildHeaders(apiKey: string): Record<string, string>;

	/**
	 * Default endpoint for most providers. Subclasses that need
	 * model/key in the URL (e.g. Gemini) should override resolveEndpoint().
	 */
	protected getEndpoint(): string {
		return `${this.getBaseUrl().replace(/\/+$/, '')}/chat/completions`;
	}

	/**
	 * Resolve the full endpoint URL given a model.
	 * Override for providers where model or API key go in the URL.
	 */
	protected resolveEndpoint(_model: string): string {
		return this.getEndpoint();
	}

	protected abstract parseResponse(
		data: Record<string, unknown>, model: string, startedAt: number,
	): ProviderResponse;

	protected abstract parseStreamEvent(
		line: string, currentOutput: string, toolCalls: ProviderToolCall[],
	): { type: 'delta'; text?: string }
		 | { type: 'tool_call'; toolCall?: ProviderToolCall }
		 | { type: 'usage'; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }
		 | null;

	/* ─── Shared helpers ────────────────────────────── */

	protected buildMessages(
		systemPrompt: string, userPrompt: string,
		history?: ProviderMessage[],
	): ProviderMessage[] {
		const msgs: ProviderMessage[] = [];
		if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
		if (history) msgs.push(...history);
		msgs.push({ role: 'user', content: userPrompt });
		return msgs;
	}
}