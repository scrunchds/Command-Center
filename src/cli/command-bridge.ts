import type { TFile } from 'obsidian';
import type CommandCenterPlugin from '../main';
import { getSharedFileLockManager } from '../file-lock';
import { loadWorkflowFromCanvas, loadWorkflowFromNote } from '../workflows/native-workflow-parser';

export type CommandCenterExternalAction = 'morning' | 'workflow' | 'indexes';

export interface CommandExecutionLog {
	ok: boolean;
	action: CommandCenterExternalAction;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	result?: unknown;
	error?: string;
}

const MAX_ARGUMENT_CHARS = 64_000;
type ExternalParams = Record<string, string>;
type NativeCliFlag = { value?: string; description: string; required?: boolean };
type NativeCliRegistration = (
	command: string,
	description: string,
	flags: Record<string, NativeCliFlag> | null,
	handler: (params: ExternalParams) => string | Promise<string>,
) => void;

/**
 * Headless-safe command boundary shared by Obsidian CLI and obsidian:// calls.
 * It never opens a view or reads credentials from command arguments. Runtime
 * services remain guarded by ConfigManager and their normal vault file locks.
 */
export class CommandCenterCommandBridge {
	private readonly operationLocks;

	constructor(private readonly plugin: CommandCenterPlugin) {
		this.operationLocks = getSharedFileLockManager(plugin.app);
	}

	register(): void {
		this.plugin.registerObsidianProtocolHandler('command-center', params => {
			const operation = params.operation ?? params.command;
			void this.handle({ ...params, ...(operation ? { action: operation } : {}) })
				.catch(() => undefined);
		});

		// Native CLI support was introduced after the plugin's minimum Obsidian
		// version. Keep URI automation available when the host lacks this method.
		const nativeCli = Reflect.get(this.plugin, 'registerCliHandler') as NativeCliRegistration | undefined;
		if (typeof nativeCli !== 'function') return;
		const register = nativeCli.bind(this.plugin);

		register('command-center:morning', 'Create or refresh today’s Command Center daily note.', {
			metrics: { value: '<json>', description: 'Capacity metric values as a JSON object.' },
			date: { value: '<YYYY-MM-DD>', description: 'Optional local date override.' },
		}, params => this.handleCli('morning', params));
		register('command-center:workflow', 'Run a vault workflow without opening Command Center views.', {
			path: { value: '<vault-path>', description: 'Markdown or Canvas workflow path.', required: true },
			inputs: { value: '<json>', description: 'Workflow inputs as a JSON object.' },
			target: { value: '<vault-path>', description: 'Optional Markdown target or Base queue.' },
			concurrency: { value: '<1-10>', description: 'Base queue concurrency.' },
			limit: { value: '<count>', description: 'Optional Base queue target limit.' },
		}, params => this.handleCli('workflow', params));
		register('command-center:indexes', 'Refresh all interview-managed stationary indexes.', null,
			params => this.handleCli('indexes', params));
	}

	async handle(params: ExternalParams): Promise<CommandExecutionLog> {
		const action = params.action;
		if (action !== 'morning' && action !== 'workflow' && action !== 'indexes') {
			throw new Error('action must be morning, workflow, or indexes.');
		}
		return this.execute(action, params);
	}

	async execute(action: CommandCenterExternalAction, params: ExternalParams = {}): Promise<CommandExecutionLog> {
		const started = Date.now();
		const startedAt = new Date(started).toISOString();
		try {
			this.rejectCredentialArguments(params);
			this.plugin.requireInitialized();
			const result = await this.operationLocks.withLock(`.command-center/cli/${action}`, async () => {
				if (action === 'morning') return this.runMorning(params);
				if (action === 'workflow') return this.runWorkflow(params);
				return this.refreshIndexes();
			});
			const finished = Date.now();
			return { ok: true, action, startedAt, finishedAt: new Date(finished).toISOString(), durationMs: finished - started, result };
		} catch (error) {
			const finished = Date.now();
			return {
				ok: false, action, startedAt, finishedAt: new Date(finished).toISOString(), durationMs: finished - started,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private async handleCli(action: CommandCenterExternalAction, params: ExternalParams): Promise<string> {
		const log = await this.execute(action, params);
		const output = JSON.stringify(log);
		if (!log.ok) throw new Error(output); // Obsidian CLI maps rejection to a non-zero exit.
		return output;
	}

	private async runMorning(params: ExternalParams): Promise<unknown> {
		await this.plugin.dailyEngine.ready();
		const metrics = parseObject(params.metrics, 'metrics');
		const date = parseLocalDate(params.date);
		// Headless runs never approve inbox mutations. Return proposals for a later
		// interactive review while safely assembling the configured Daily Note.
		const proposals = await this.plugin.dailyEngine.generateInboxProposals();
		const assembled = await this.plugin.dailyEngine.assembleDailyNote(metrics, date);
		return {
			dailyNote: assembled.path,
			created: assembled.created,
			capacity: assembled.capacity,
			pendingInboxProposals: proposals.length,
		};
	}

	private async runWorkflow(params: ExternalParams): Promise<unknown> {
		const path = requiredPath(params.path, 'path');
		const workflowFile = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!isVaultFile(workflowFile) || (workflowFile.extension !== 'md' && workflowFile.extension !== 'canvas')) {
			throw new Error(`Workflow file not found or unsupported: ${path}`);
		}
		const workflow = workflowFile.extension === 'canvas'
			? await loadWorkflowFromCanvas(workflowFile, this.plugin.app)
			: loadWorkflowFromNote(workflowFile, this.plugin.app);
		if (!workflow.steps.length) throw new Error(`Workflow has no executable steps: ${path}`);
		const inputs = parseObject(params.inputs, 'inputs');
		const targetPath = optionalValue(params.target);
		if (!targetPath) {
			const context = await this.plugin.workflowEngine.execute(workflow, inputs, { app: this.plugin.app });
			return { workflow: workflow.id, statuses: context.stepStatuses, totalTokens: context.totalTokens, totalLatencyMs: context.totalLatencyMs };
		}
		const target = this.plugin.app.vault.getAbstractFileByPath(requiredPath(targetPath, 'target'));
		if (!isVaultFile(target) || (target.extension !== 'md' && target.extension !== 'base')) {
			throw new Error(`Workflow target must be a Markdown note or Base queue: ${targetPath}`);
		}
		const results = await this.plugin.workflowEngine.executeOnTargets(workflow, inputs, target, this.plugin.app, {
			concurrency: integerOption(params.concurrency, 1, 10, 1),
			limit: integerOption(params.limit, 0, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
			continueOnError: true,
		});
		return {
			workflow: workflow.id,
			targets: results.map(item => ({ path: item.file.path, ok: Boolean(item.context), error: item.error })),
			completed: results.filter(item => item.context).length,
			failed: results.filter(item => item.error).length,
		};
	}

	private async refreshIndexes(): Promise<unknown> {
		const config = this.plugin.requireInitialized();
		await this.plugin.folderIndexer.verifyIndexAnchors();
		const results = [];
		for (const folder of config.managedFolders) results.push(await this.plugin.folderIndexer.update(folder.path));
		return { refreshed: results.length, indexes: results.map(result => ({ path: result.indexPath, operation: result.operation, files: result.fileCount })) };
	}

	private rejectCredentialArguments(params: ExternalParams): void {
		for (const [key, value] of Object.entries(params)) {
			if (key.length + value.length > MAX_ARGUMENT_CHARS) throw new Error(`Command argument ${key} is too large.`);
			if (/(?:api[-_]?key|token|password|secret|credential)/i.test(key)) {
				throw new Error('Credentials are not accepted through CLI or URI arguments; configure providers in Obsidian settings.');
			}
		}
	}

}

function isVaultFile(value: unknown): value is TFile {
	if (!value || typeof value !== 'object') return false;
	const file = value as Partial<TFile>;
	return typeof file.path === 'string' && typeof file.extension === 'string' && file.stat !== undefined;
}

function optionalValue(value: string | undefined): string | undefined {
	return typeof value === 'string' && value !== 'true' && value.trim() ? value.trim() : undefined;
}

function requiredPath(value: string | undefined, name: string): string {
	const path = optionalValue(value)?.replace(/\\/g, '/').replace(/^\/+/, '');
	if (!path || path.startsWith('../') || path.includes('/../') || path.includes('\0')) throw new Error(`${name} must be a safe vault-relative path.`);
	return path;
}

function parseObject(value: string | undefined, name: string): Record<string, unknown> {
	const source = optionalValue(value);
	if (!source) return {};
	if (source.length > MAX_ARGUMENT_CHARS) throw new Error(`${name} JSON is too large.`);
	let parsed: unknown;
	try { parsed = JSON.parse(source); }
	catch { throw new Error(`${name} must be valid JSON.`); }
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${name} must be a JSON object.`);
	return parsed as Record<string, unknown>;
}

function parseLocalDate(value: string | undefined): Date {
	const source = optionalValue(value);
	if (!source) return new Date();
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(source);
	if (!match) throw new Error('date must use YYYY-MM-DD.');
	const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) {
		throw new Error('date is not a valid calendar date.');
	}
	return date;
}

function integerOption(value: string | undefined, minimum: number, maximum: number, fallback: number): number {
	const source = optionalValue(value);
	if (!source) return fallback;
	const parsed = Number(source);
	if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`Expected an integer from ${minimum} to ${maximum}.`);
	return parsed;
}
