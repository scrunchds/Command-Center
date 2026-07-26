/**
 * Pi Daemon Adapter — wraps the existing PiAgentDaemon as an IProviderAdapter.
 */
import type {
	IProviderAdapter, ProviderId, ProviderMeta, ProviderModel, TaskType,
	ProviderRequest, ProviderResponse, ProviderCapabilities,
} from './provider-types';
import { classifyThrowError } from './provider-types';
import type { PiAgentDaemon } from '../daemon';
import type { AgentTaskPayload } from '../types';
import { PROVIDER_REGISTRY, getDefaultModelForProvider } from './provider-registry';

export class PiDaemonAdapter implements IProviderAdapter {
	readonly id: ProviderId = 'pi-daemon';
	readonly meta: ProviderMeta;
	private daemon: PiAgentDaemon;

	constructor(daemon: PiAgentDaemon) {
		this.daemon = daemon;
		this.meta = { ...PROVIDER_REGISTRY['pi-daemon'] };
	}

	isAvailable(): boolean {
		return this.daemon.isRunning() && !this.daemon.startError;
	}

	supportsCapability(cap: keyof ProviderCapabilities): boolean {
		return !!this.meta.capabilities[cap];
	}

	async healthCheck(): Promise<string | null> {
		// Binary not found — not recoverable, give a helpful message
		if (this.daemon.isBinaryMissing()) {
			return 'Pi binary not found. Install pi CLI or update the path in Core Settings.';
		}
		if (!this.isAvailable()) {
			return this.daemon.startError ?? 'Daemon not running. Check Core Settings to enable or restart.';
		}
		try {
			const resp = await this.daemon.executeTask({
				taskId: `health-${Date.now()}`, workerProfile: 'retriever',
				prompt: 'Respond with just "OK".',
			});
			return resp.error ?? null;
		} catch (err) {
			return (err as Error).message;
		}
	}

	async complete(request: ProviderRequest): Promise<ProviderResponse> {
		const startedAt = Date.now();

		// Fast-fail if pi binary is missing
		if (this.daemon.isBinaryMissing()) {
			return {
				output: '', success: false,
				error: 'Pi binary not found. Install pi or update the path in Plugin Settings → Core Configuration.',
				model: 'pi-default', providerId: this.id,
				latencyMs: Date.now() - startedAt,
			};
		}

		try {
			const payload: AgentTaskPayload = {
				taskId: request.taskId ?? `prov-${Date.now()}`,
				workerProfile: 'orchestrator',
				prompt: `${request.systemPrompt}\n\n${request.userPrompt}`,
				tools: request.tools,
			};
			const response = await this.daemon.executeTask(
				payload,
				request.onStream ? (delta) => request.onStream!(delta) : undefined,
			);
			return {
				output: response.result?.output ?? response.error ?? '',
				success: !response.error,
				error: response.error,
				model: 'pi-default',
				providerId: this.id,
				latencyMs: Date.now() - startedAt,
			};
		} catch (err) {
			const typedError = classifyThrowError(err, this.id);
			return {
				output: '', success: false,
				error: typedError.message, typedError,
				model: 'pi-default', providerId: this.id,
				latencyMs: Date.now() - startedAt,
			};
		}
	}

	listModels(): ProviderModel[] { return this.meta.models; }

	getDefaultModel(taskType: TaskType): string {
		return getDefaultModelForProvider(this.id, taskType);
	}

	async countTokens(text: string): Promise<number> {
		return Math.ceil(text.length / 4);
	}

	dispose(): void {
		this.daemon.stop();
	}

	abort(): void {
		// Daemon doesn't support per-request abort
	}
}