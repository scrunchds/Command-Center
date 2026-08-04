import type { ProviderDispatcher } from '../dispatcher';
import type { AutoRouteResolution, Modality, NativeAutoRouter } from '../routing/NativeAutoRouter';
import type { ProviderId, ProviderRequest } from '../providers/provider-types';
import { DataNormalizer, type NormalizedExecutionResult } from './DataNormalizer';
import type { MemoryCredentialVault } from '../security/VaultCrypto';

export interface PythonWorkerRequest {
	schemaVersion: 1;
	taskId: string;
	taskType: Modality;
	providerId: ProviderId;
	modelId?: string;
	/** Ephemeral credential sent only over subprocess stdin; never argv, env, logs, or disk. */
	credential?: string;
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
	resolution?: Pick<AutoRouteResolution, 'providerId' | 'modelId'>;
	request: ProviderRequest;
	backend?: 'node' | 'python';
	taskType?: Modality;
	metadata?: Record<string, string | number | boolean>;
	signal?: AbortSignal;
}

/**
 * Execution-modality worker profiles. A strict superset of `WorkerProfileName`
 * (types.ts): the base four plus the two ReAct-capable profiles that have no
 * static `workers/` prompt entry but DO declare an execution modality.
 * `PROFILE_MODALITY` maps each to the single OpenRouter modality its requests
 * cross. The `pi-daemon` sentinel is intentionally excluded — it routes via
 * `router.routeDirect('pi-daemon', …)`, not the execution boundary.
 */
export type AgentWorkerProfile = 'orchestrator' | 'summarizer' | 'editor' | 'retriever' | 'react-orchestrator' | 'react-analyst';

const PROFILE_MODALITY: Readonly<Record<AgentWorkerProfile, Modality>> = {
	orchestrator: 'text', summarizer: 'text', editor: 'text', retriever: 'embeddings',
	'react-orchestrator': 'text', 'react-analyst': 'text',
};

/** Bridges Phase 1 routing to current Node adapters and future local workers. */
export class ExecutionRouter {
	constructor(
		private readonly dispatcher: ProviderDispatcher,
		private readonly normalizer: DataNormalizer = new DataNormalizer(),
		private readonly pythonWorker?: PythonWorkerTransport,
		private readonly autoRouter?: NativeAutoRouter,
		private readonly credentialVault?: MemoryCredentialVault,
	) {}

	async executeAgent(profile: AgentWorkerProfile, request: ProviderRequest, options: Omit<ExecutionRouteRequest, 'resolution' | 'request' | 'taskType'> = {}): Promise<NormalizedExecutionResult> {
		const taskType = PROFILE_MODALITY[profile];
		const resolution = this.autoRouter?.resolve(taskType);
		if (!resolution) return this.normalizer.normalize({ success: false, error: 'Automatic model routing is unavailable.' }, options.backend === 'python' ? 'python-worker' : 'provider-dispatcher');
		return this.execute({ ...options, request, resolution, taskType, metadata: { ...options.metadata, workerProfile: profile } });
	}

	async execute(input: ExecutionRouteRequest): Promise<NormalizedExecutionResult> {
		if (input.signal?.aborted) return this.normalizer.normalize({ success: false, error: 'Execution cancelled.' }, 'provider-dispatcher');
		if (input.backend === 'python') {
			if (!this.pythonWorker?.isAvailable()) return this.normalizer.normalize({ success: false, error: 'Python execution is temporarily unavailable.' }, 'python-worker');
			try {
				// This is the sole Python trust boundary: transport output never escapes raw.
				return this.normalizer.normalize(await this.pythonWorker.execute(this.pythonRequest(input), input.signal), 'python-worker');
			} catch (error) {
				return this.normalizer.normalize({ success: false, error: this.safeError(error) }, 'python-worker');
			}
		}

		const resolution = input.resolution ?? this.autoRouter?.resolve(input.taskType ?? 'text');
		if (!resolution) return this.normalizer.normalize({ success: false, error: 'Automatic model routing is unavailable.' }, 'provider-dispatcher');
		const request: ProviderRequest = {
			...input.request,
			config: { ...input.request.config, ...(resolution.modelId ? { model: resolution.modelId } : {}) },
		};
		try {
			// pi-daemon remains delegated through ProviderDispatcher/ProviderFactory,
			// preserving the existing PiDaemonAdapter subprocess lifecycle.
			const response = await this.dispatcher.dispatchTo(resolution.providerId, request);
			return this.normalizer.normalizeProvider(response);
		} catch (error) {
			return this.normalizer.normalize({ success: false, error: this.safeError(error), providerId: resolution.providerId }, resolution.providerId === 'pi-daemon' ? 'pi-daemon' : 'provider-dispatcher');
		}
	}

	private pythonRequest(input: ExecutionRouteRequest): PythonWorkerRequest {
		const resolution = input.resolution ?? this.autoRouter?.resolve(input.taskType ?? 'text');
		if (!resolution) throw new Error('Automatic model routing is unavailable.');
		const credential = this.credentialVault?.get(resolution.providerId);
		return {
			schemaVersion: 1,
			taskId: input.request.taskId ?? `python-${Date.now()}`,
			taskType: input.taskType ?? 'text',
			providerId: resolution.providerId,
			...(resolution.modelId ? { modelId: resolution.modelId } : {}),
			...(credential ? { credential } : {}),
			systemPrompt: input.request.systemPrompt,
			userPrompt: input.request.userPrompt,
			...(input.metadata ? { metadata: { ...input.metadata } } : {}),
		};
	}

	private safeError(error: unknown): string {
		return error instanceof Error ? error.message.split(/\r?\n/, 1)[0] ?? 'Execution failed.' : 'Execution failed.';
	}
}
