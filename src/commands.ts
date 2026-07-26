import { Notice, parseYaml, TFile } from 'obsidian';
import type CommandCenterPlugin from './main';
import type { Task } from './types';
import * as crypto from 'crypto';
import { loadWorkflowFromCanvas, loadWorkflowFromNote } from './workflows/native-workflow-parser';
import { collectWorkflowBatchInputs, collectWorkflowInputs } from './ui/workflow-modal';
import type { WorkflowDefinition } from './workflows/workflow-types';
import { VoicePromptModal } from './ui/voice-prompt-modal';

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

/** Resolve the workflow note/canvas referenced by a standalone Base definition. */
export async function workflowForBase(baseFile: TFile, plugin: CommandCenterPlugin): Promise<WorkflowDefinition> {
	const definition = record(parseYaml(await plugin.app.vault.read(baseFile))) ?? {};
	const commandCenter = record(definition.commandCenter) ?? record(definition.command_center);
	const reference = definition.workflow ?? definition.workflowPath ?? commandCenter?.workflow ?? commandCenter?.workflowPath;
	if (typeof reference !== 'string' || !reference.trim()) {
		throw new Error('The Base must define workflow: "path/to/workflow.md" (or commandCenter.workflow).');
	}
	const workflowFile = plugin.app.metadataCache.getFirstLinkpathDest(reference.trim(), baseFile.path)
		?? plugin.app.vault.getAbstractFileByPath(reference.trim());
	if (!(workflowFile instanceof TFile) || (workflowFile.extension !== 'md' && workflowFile.extension !== 'canvas')) {
		throw new Error(`Workflow file not found: ${reference}`);
	}
	return workflowFile.extension === 'canvas'
		? loadWorkflowFromCanvas(workflowFile, plugin.app)
		: loadWorkflowFromNote(workflowFile, plugin.app);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

export function registerCommands(plugin: CommandCenterPlugin) {
	plugin.addCommand({
		id: 'open-dashboard',
		name: 'Open Command Center',
		callback: () => plugin.activateCommandCenterView(),
	});

	plugin.addCommand({
		id: 'open-chat-panel',
		name: 'Open Chat Panel',
		callback: () => plugin.activateCommandCenterChatView(),
	});

	plugin.addCommand({
		id: 'quick-voice-prompt',
		name: 'Quick Voice Prompt',
		callback: () => new VoicePromptModal(plugin).open(),
	});

	plugin.addCommand({
		id: 'export-active-workflow-to-canvas',
		name: 'Export Active Workflow to Canvas',
		callback: () => plugin.exportActiveWorkflowToCanvas(),
	});

	plugin.addCommand({
		id: 'agent-execute-task',
		name: 'Execute agent task on current note',
		callback: async () => {
			const activeFile = plugin.app.workspace.getActiveFile();
			if (!activeFile) { new Notice('No active note.'); return; }

			// This palette command is explicitly a local-Pi operation. Recover the
			// daemon automatically instead of rejecting on a stale isRunning check.
			const ready = await plugin.ensureDaemonRunning();
			if (!ready) {
				new Notice(`Pi daemon failed to start: ${plugin.daemon.startError ?? 'unknown error'}`);
				return;
			}

			const taskId = crypto.randomUUID();
			new Notice(`Dispatching task ${taskId.slice(0, 8)}...`);

			// Enqueue through the task queue so streaming + history + status bar fire
			plugin.taskQueue.enqueue(
				{
					id: taskId,
					workerProfile: 'pi-daemon',
					prompt: `Analyze the note: ${activeFile.path}`,
					targetPath: activeFile.path,
					status: 'queued',
					createdAt: Date.now(),
				} satisfies Task,
				{
					onComplete: (result) => {
						const preview = (result.output || result.summary || JSON.stringify(result)).slice(0, 120);
						new Notice(`Task ${taskId.slice(0, 8)} complete: ${preview}`);
					},
					onError: (err) => {
						new Notice(`Task ${taskId.slice(0, 8)} failed: ${err}`);
					},
				},
			);
		},
	});

	plugin.addCommand({
		id: 'execute-workflow-note-or-canvas',
		name: 'Execute Workflow (Note or Canvas)',
		callback: async () => {
			const file = plugin.app.workspace.getActiveFile();
			if (!file || (file.extension !== 'md' && file.extension !== 'canvas')) {
				new Notice('Open a Markdown workflow note or Canvas workflow first.');
				return;
			}

			try {
				let workflow;
				if (file.extension === 'canvas') {
					workflow = await loadWorkflowFromCanvas(file, plugin.app);
				} else {
					const frontmatter: unknown = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
					const metadata = isRecord(frontmatter) ? frontmatter : undefined;
					const workflowMetadata = metadata?.workflow;
					const hasWorkflowMetadata = Array.isArray(metadata?.steps) ||
						(workflowMetadata !== null && typeof workflowMetadata === 'object');
					if (!hasWorkflowMetadata) {
						new Notice('The active Markdown note does not contain workflow frontmatter.');
						return;
					}
					workflow = loadWorkflowFromNote(file, plugin.app);
				}

				if (workflow.steps.length === 0) {
					new Notice('The active workflow has no executable steps.');
					return;
				}
				const inputs = Object.keys(workflow.inputs).length > 0
					? await collectWorkflowInputs(plugin.app, workflow)
					: {};
				if (inputs === null) return;

				new Notice(`Executing workflow: ${workflow.name}`);
				const context = await plugin.executeWorkflow(workflow, inputs, file);
				const completed = Object.values(context.stepStatuses).filter(status => status === 'completed').length;
				new Notice(`Workflow complete: ${completed}/${workflow.steps.length} steps.`);
			} catch (error) {
				new Notice(`Workflow failed: ${(error as Error).message}`);
			}
		},
	});

	plugin.addCommand({
		id: 'execute-workflow-current-base-queue',
		name: 'Execute Workflow on Current Base Queue',
		callback: async () => {
			const baseFile = plugin.app.workspace.getActiveFile();
			if (!baseFile || baseFile.extension !== 'base') {
				new Notice('Open a .base queue file first.');
				return;
			}
			try {
				const workflow = await workflowForBase(baseFile, plugin);
				if (workflow.steps.length === 0) {
					new Notice('The configured workflow has no executable steps.');
					return;
				}
				const batch = await collectWorkflowBatchInputs(plugin.app, workflow, 1);
				if (batch === null) return;
				new Notice(`Executing ${workflow.name} on the current Base queue (${batch.concurrency} at a time)…`);
				const results = await plugin.executeWorkflowOnTargets(workflow, batch.inputs, baseFile, {
					concurrency: batch.concurrency,
					continueOnError: true,
				});
				const completed = results.filter(result => result.context).length;
				const failed = results.length - completed;
				new Notice(`Base queue workflow complete: ${completed} completed${failed ? `, ${failed} failed` : ''}.`);
			} catch (error) {
				new Notice(`Base queue workflow failed: ${(error as Error).message}`);
			}
		},
	});

	plugin.addCommand({
		id: 'toggle-daemon',
		name: 'Toggle Agent Daemon',
		callback: async () => {
			if (plugin.daemon.isRunning()) {
				plugin.daemon.stop();
				plugin.statusBar.setState('stopped');
				plugin.commandCenterView?.updateDaemonStatus();
				new Notice('Daemon stopped.');
			} else {
				const ready = await plugin.ensureDaemonRunning();
				new Notice(ready
					? 'Daemon started.'
					: `Daemon failed to start: ${plugin.daemon.startError ?? 'unknown error'}`);
			}
		},
	});
}
