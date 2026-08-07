import { MarkdownView, Notice, parseYaml, TFile } from 'obsidian';
import type CommandCenterPlugin from './main';
import type { Task } from './types';
import * as crypto from 'crypto';
import { loadWorkflowFromCanvas, loadWorkflowFromNote } from './workflows/native-workflow-parser';
import { collectWorkflowBatchInputs, collectWorkflowInputs } from './ui/workflow-modal';
import type { WorkflowDefinition } from './workflows/workflow-types';
import { VoicePromptModal, type VoicePromptFocus } from './ui/voice-prompt-modal';
import { GoalPromptModal } from './ui/goal-prompt-modal';

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
		name: 'Dashboard',
		callback: () => plugin.activateCommandCenterView(),
	});

	plugin.addCommand({
		id: 'open-chat-panel',
		name: 'Chat panel',
		callback: () => plugin.activateCommandCenterChatView(),
	});

	plugin.addCommand({
		id: 'quick-voice-prompt',
		name: 'Voice prompt',
		// Capture the focused note *before* the modal takes keyboard focus. The
		// modal holds focus for the duration of recording, so any focus check run
		// after the async transcription delay would miss the note the user was
		// actually editing. This snapshot is what makes contextual note-vs-chat
		// routing reliable across that delay.
		callback: () => {
			const focus: VoicePromptFocus = {
				markdownView: plugin.app.workspace.getActiveViewOfType(MarkdownView),
			};
			new VoicePromptModal(plugin, focus).open();
		},
	});

	plugin.addCommand({
		id: 'export-active-workflow-to-canvas',
		name: 'Export workflow to canvas',
		checkCallback: (checking: boolean) => {
			const source = plugin.app.workspace.getActiveFile();
			const available = Boolean(source && source.extension === 'md');
			if (checking) return available;
			if (available) void plugin.exportActiveWorkflowToCanvas();
			return available;
		},
	});

	plugin.addCommand({
		id: 'agent-execute-task',
		name: 'Execute agent task on current note',
		checkCallback: (checking: boolean) => {
			const activeFile = plugin.app.workspace.getActiveFile();
			if (!activeFile || activeFile.extension !== 'md') return false;
			if (checking) return true;

			// This palette command is explicitly a local-Pi operation. Recover the
			// daemon automatically instead of rejecting on a stale isRunning check.
			void (async () => {
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
			})();
			return true;
		},
	});

	plugin.addCommand({
		id: 'generate-and-run-agentic-workflow',
		name: 'Generate & run agentic workflow…',
		callback: () => {
			void (async () => {
				try {
					const goal = await GoalPromptModal.prompt(plugin.app);
					if (!goal) return;
					new Notice('Designing workflow…');
					const context = await plugin.synthesizeAndRunWorkflow(goal);
					if (!context) return;
					const completed = Object.values(context.stepStatuses).filter(status => status === 'completed').length;
					new Notice(`Agentic workflow complete: ${completed} steps.`);
				} catch (error) {
					new Notice(`Agentic workflow failed: ${(error as Error).message}`);
				}
			})();
		},
	});

	plugin.addCommand({
		id: 'execute-workflow-note-or-canvas',
		name: 'Execute workflow (note or canvas)',
		checkCallback: (checking: boolean) => {
			const file = plugin.app.workspace.getActiveFile();
			if (!file || (file.extension !== 'md' && file.extension !== 'canvas')) return false;
			if (checking) return true;

			void (async () => {
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
			})();
			return true;
		},
	});

	plugin.addCommand({
		id: 'execute-workflow-current-base-queue',
		name: 'Execute workflow on current base queue',
		checkCallback: (checking: boolean) => {
			const baseFile = plugin.app.workspace.getActiveFile();
			if (!baseFile || baseFile.extension !== 'base') return false;
			if (checking) return true;

			void (async () => {
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
			})();
			return true;
		},
	});

	plugin.addCommand({
		id: 'toggle-daemon',
		name: 'Toggle agent daemon',
		callback: async () => {
			if (plugin.daemon.isRunning()) {
				plugin.daemon.stop();
				plugin.statusBar.setState('stopped');
				plugin.getCommandCenterView()?.updateDaemonStatus();
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
