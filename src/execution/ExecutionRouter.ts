import type { ProviderDispatcher } from '../dispatcher';
import type { AutoRouteResolution } from '../routing/NativeAutoRouter';
import type { ProviderId, ProviderRequest } from '../providers/provider-types';
import { DataNormalizer, type NormalizedExecutionResult } from './DataNormalizer';

export interface PythonWorkerRequest {
	schemaVersion: 1;
	taskId: string;
	providerId: ProviderId;
	modelId?: string;
	systemPrompt: string;
	userPrompt: string;
	metadata?: Record<string, string | number | boolean>;
}

export interface PythonWorkerTransport {
	readonly kind: 'local-python-subprocess';
	isAvailable(): boolean;
	execute(request: PythonWorkerRequest, signal?: AbortSignal): Promise<unknown>;
}

export interface ExecutionRouteRequest {
	resolution: Pick<AutoRouteResolution, 'providerId' | 'modelId'>;
	request: ProviderRequest;
	backend?: 'node' | 'python';
	metadata?: Record<string, string | number | boolean>;
	signal?: AbortSignal;
}

/** Bridges Phase 1 routing to current Node adapters and future local workers. */
export class ExecutionRouter {
	constructor(
		private readonly dispatcher: ProviderDispatcher,
		private readonly normalizer: DataNormalizer = new DataNormalizer(),
		private readonly pythonWorker?: PythonWorkerTransport,
	) {}

	async execute(input: ExecutionRouteRequest): Promise<NormalizedExecutionResult> {
		if (input.signal?.aborted) return this.normalizer.normalize({ success: false, error: 'Execution cancelled.' }, 'provider-dispatcher');
		if (input.backend === 'python' && this.pythonWorker?.isAvailable()) {
			try {
				const raw = await this.pythonWorker.execute(this.pythonRequest(input), input.signal);
				return this.normalizer.normalize(raw, 'python-worker');
			} catch (error) {
				return this.normalizer.normalize({ success: false, error: this.safeError(error) }, 'python-worker');
			}
		}

		const request: ProviderRequest = {
			...input.request,
			config: { ...input.request.config, ...(input.resolution.modelId ? { model: input.resolution.modelId } : {}) },
		};
		try {
			// pi-daemon remains delegated through ProviderDispatcher/ProviderFactory,
			// preserving the existing PiDaemonAdapter subprocess lifecycle.
			const response = await this.dispatcher.dispatchTo(input.resolution.providerId, request);
			return this.normalizer.normalizeProvider(response);
		} catch (error) {
			return this.normalizer.normalize({ success: false, error: this.safeError(error), providerId: input.resolution.providerId }, input.resolution.providerId === 'pi-daemon' ? 'pi-daemon' : 'provider-dispatcher');
		}
	}

	private pythonRequest(input: ExecutionRouteRequest): PythonWorkerRequest {
		return {
			schemaVersion: 1,
			taskId: input.request.taskId ?? `python-${Date.now()}`,
			providerId: input.resolution.providerId,
			...(input.resolution.modelId ? { modelId: input.resolution.modelId } : {}),
			systemPrompt: input.request.systemPrompt,
			userPrompt: input.request.userPrompt,
			...(input.metadata ? { metadata: { ...input.metadata } } : {}),
		};
	}

	private safeError(error: unknown): string {
		return error instanceof Error ? error.message.split(/\r?\n/, 1)[0] ?? 'Execution failed.' : 'Execution failed.';
	}
}
