/**
 * TaskWriter — the only path by which the dashboard mutates tasks.
 *
 * Principle 1 (Absolute Write-Gate Authority): every method here is a proposal
 * first. Each mutation is described as a `ToolConfirmationRequest` and passed to
 * the `WriteGate`, so a dashboard click can never silently edit your notes when
 * the gate is armed. Approving in the UI is what performs the write.
 *
 * Principle 5 (Native Obsidian Harmony): writes go through `Vault.process`,
 * which is atomic and fully compatible with native File Recovery. Task syntax
 * is the standard Markdown checkbox, so Dataview, Tasks, Kanban, and Bases all
 * keep working on whatever this produces.
 */

import { type App, TFile, TFolder, normalizePath } from 'obsidian';
import type { ToolConfirmationRequest } from '../types';
import type { WriteGate } from '../security/WriteGate';
import {
	type NewTask,
	deleteTaskLine,
	editTaskLine,
	insertTaskLine,
	isTaskLine,
	renderTaskLine,
	rescheduleTaskLine,
	safeTaskPath,
	toggleTaskLine,
} from './task-syntax';

export type { NewTask };

/** Where a new task should be written. */
export interface TaskTarget {
	/** Vault-relative note path. Created when absent. */
	path: string;
	/** Optional heading to append beneath; appended at end of file otherwise. */
	heading?: string;
}


/** Creates, toggles, edits, and removes tasks behind the write gate. */
export class TaskWriter {
	constructor(
		private readonly app: App,
		private readonly gate: WriteGate,
	) {}

	/**
	 * Append a task to a note, creating the note when needed.
	 *
	 * @returns True when the task was written, false when approval was declined.
	 */
	async createTask(target: TaskTarget, task: NewTask): Promise<boolean> {
		const path = safeTaskPath(target.path);
		const line = renderTaskLine(task);
		const existing = this.app.vault.getAbstractFileByPath(path);
		const creating = !(existing instanceof TFile);
		const approved = await this.authorize({
			toolName: 'dashboard:create-task',
			targetPaths: [path],
			proposedChanges: creating
				? `Create ${path} and add:\n${line}`
				: `Append to ${path}${target.heading ? ` under "${target.heading}"` : ''}:\n${line}`,
		});
		if (!approved) return false;

		if (creating) {
			await this.ensureParent(path);
			const body = target.heading ? `## ${target.heading}\n\n${line}\n` : `${line}\n`;
			await this.app.vault.create(path, body);
			return true;
		}
		if (!(existing instanceof TFile)) throw new Error(`${path} is not a file.`);
		await this.app.vault.process(existing, content => insertTaskLine(content, line, target.heading));
		return true;
	}

	/** Flip a checkbox at a known 1-based line number. */
	async toggleTask(path: string, line: number, done: boolean): Promise<boolean> {
		const file = this.requireFile(path);
		const approved = await this.authorize({
			toolName: 'dashboard:toggle-task',
			targetPaths: [file.path],
			proposedChanges: `Mark line ${line} in ${file.path} as ${done ? 'complete' : 'incomplete'}.`,
		});
		if (!approved) return false;
		await this.app.vault.process(file, content => toggleTaskLine(content, line, done));
		return true;
	}

	/** Replace the text of an existing task, preserving its checkbox state. */
	async editTask(path: string, line: number, text: string): Promise<boolean> {
		const file = this.requireFile(path);
		const trimmed = text.trim().replace(/\r?\n+/g, ' ');
		if (!trimmed) throw new Error('A task needs text.');
		const approved = await this.authorize({
			toolName: 'dashboard:edit-task',
			targetPaths: [file.path],
			proposedChanges: `Rewrite line ${line} in ${file.path} as:\n${trimmed}`,
		});
		if (!approved) return false;
		await this.app.vault.process(file, content => editTaskLine(content, line, trimmed));
		return true;
	}

	/** Delete a task line outright. Always an explicit, described removal. */
	async deleteTask(path: string, line: number): Promise<boolean> {
		const file = this.requireFile(path);
		const current = (await this.app.vault.read(file)).split(/\r?\n/)[line - 1];
		if (current === undefined || !isTaskLine(current)) {
			throw new Error(`Line ${line} of ${file.path} is no longer a task. The note may have changed.`);
		}
		const approved = await this.authorize({
			toolName: 'dashboard:delete-task',
			targetPaths: [file.path],
			proposedChanges: `Remove line ${line} from ${file.path}:\n${current.trim()}`,
		});
		if (!approved) return false;
		// Pass the expected text so an edit made during approval aborts the delete.
		await this.app.vault.process(file, content => deleteTaskLine(content, line, current));
		return true;
	}

	/** Move a task's due date, used by calendar drag-and-drop and rescheduling. */
	async rescheduleTask(path: string, line: number, due: string | null): Promise<boolean> {
		const file = this.requireFile(path);
		const approved = await this.authorize({
			toolName: 'dashboard:reschedule-task',
			targetPaths: [file.path],
			proposedChanges: due
				? `Set the due date on line ${line} of ${file.path} to ${due}.`
				: `Remove the due date from line ${line} of ${file.path}.`,
		});
		if (!approved) return false;
		await this.app.vault.process(file, content => rescheduleTaskLine(content, line, due));
		return true;
	}

	/* ─── Helpers ────────────────────────────────────────── */

	private async authorize(request: ToolConfirmationRequest): Promise<boolean> {
		// Reuse the gate's full policy: Auto Write, protected paths, audit log.
		const verdict = await this.gate.authorize(
			{
				name: request.toolName,
				label: request.toolName,
				description: 'Dashboard task mutation',
				parameters: { type: 'object', properties: {}, required: [] },
				confirmation: async () => ({ ...request, timeoutMs: 120_000 }),
				execute: async () => ({ content: [], details: {} }),
			},
			{},
		);
		return verdict.allowed;
	}

	private requireFile(path: string): TFile {
		const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
		if (!(file instanceof TFile)) throw new Error(`${path} is no longer in the vault.`);
		return file;
	}

	/** Create missing parent folders for a new note. */
	private async ensureParent(path: string): Promise<void> {
		const parent = path.split('/').slice(0, -1).join('/');
		if (!parent) return;
		let current = '';
		for (const segment of parent.split('/')) {
			current = normalizePath(current ? `${current}/${segment}` : segment);
			const entry = this.app.vault.getAbstractFileByPath(current);
			if (entry instanceof TFolder) continue;
			if (entry) throw new Error(`A file blocks the folder ${current}.`);
			await this.app.vault.createFolder(current);
		}
	}
}
