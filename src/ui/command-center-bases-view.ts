import {
	BasesView, Notice, type BasesViewRegistration,
	type QueryController, type TFile,
} from 'obsidian';
import type CommandCenterPlugin from '../main';
import { parseQuery, scoreBatch, type ScoredResult } from '../obsidian-search';
import { filesFromNativeBaseEntries } from '../workflows/native-base-results';

export const COMMAND_CENTER_BASES_VIEW_ID = 'command-center-queue';

interface QueueRow {
	file: TFile;
	score?: number;
	excerpt?: string;
}

export class CommandCenterBasesView extends BasesView {
	type = COMMAND_CENTER_BASES_VIEW_ID;
	private readonly selected = new Set<string>();
	private renderVersion = 0;

	constructor(
		controller: QueryController,
		private readonly containerEl: HTMLElement,
		private readonly plugin: CommandCenterPlugin,
	) {
		super(controller);
	}

	onDataUpdated(): void {
		void this.render(++this.renderVersion);
	}

	private async render(version: number): Promise<void> {
		const nativeFiles = filesFromNativeBaseEntries(this.data.data, this.plugin.app);
		const rows = await this.rank(nativeFiles);
		if (version !== this.renderVersion) return;

		const activePaths = new Set(rows.map(row => row.file.path));
		for (const path of this.selected) if (!activePaths.has(path)) this.selected.delete(path);

		this.containerEl.empty();
		this.containerEl.addClass('cc-bases-queue');
		const toolbar = this.containerEl.createDiv({ cls: 'cc-bases-toolbar' });
		toolbar.createSpan({ text: `${rows.length} pending note${rows.length === 1 ? '' : 's'}` });
		const selectAll = toolbar.createEl('button', { text: 'Select all' });
		this.registerDomEvent(selectAll, 'click', () => {
			for (const row of rows) this.selected.add(row.file.path);
			void this.render(++this.renderVersion);
		});
		const runSelected = toolbar.createEl('button', { text: `Execute selected (${this.selected.size})`, cls: 'mod-cta' });
		runSelected.disabled = this.selected.size === 0;
		this.registerDomEvent(runSelected, 'click', () => {
			const files = rows.filter(row => this.selected.has(row.file.path)).map(row => row.file);
			this.enqueue(files);
		});
		const runAll = toolbar.createEl('button', { text: 'Execute pending' });
		runAll.disabled = rows.length === 0;
		this.registerDomEvent(runAll, 'click', () => this.enqueue(rows.map(row => row.file)));

		if (rows.length === 0) {
			this.containerEl.createEl('p', { text: 'No pending notes match this base.', cls: 'command-center-empty' });
			return;
		}
		const list = this.containerEl.createDiv({ cls: 'cc-bases-list' });
		for (const row of rows) {
			const item = list.createDiv({ cls: 'cc-bases-row' });
			const checkbox = item.createEl('input', { type: 'checkbox' });
			checkbox.checked = this.selected.has(row.file.path);
			this.registerDomEvent(checkbox, 'change', () => {
				if (checkbox.checked) this.selected.add(row.file.path);
				else this.selected.delete(row.file.path);
				runSelected.textContent = `Execute selected (${this.selected.size})`;
				runSelected.disabled = this.selected.size === 0;
			});
			const body = item.createDiv({ cls: 'cc-bases-row-body' });
			const link = body.createEl('a', { text: row.file.path, cls: 'internal-link' });
			this.registerDomEvent(link, 'click', event => {
				event.preventDefault();
				void this.plugin.app.workspace.getLeaf(false).openFile(row.file);
			});
			if (row.score !== undefined) body.createSpan({ text: `Relevance ${row.score.toFixed(3)}`, cls: 'cc-bases-score' });
			if (row.excerpt) body.createEl('small', { text: row.excerpt, cls: 'cc-bases-excerpt' });
		}
	}

	private async rank(files: TFile[]): Promise<QueueRow[]> {
		const query = this.option('relevanceQuery');
		const limitValue = this.config.get('maxResults');
		const limit = typeof limitValue === 'number' ? Math.max(1, Math.min(200, limitValue)) : 50;
		if (!query) return files.slice(0, limit).map(file => ({ file }));
		const scored = await scoreBatch(files, parseQuery(query), this.plugin.app, limit);
		const byPath = new Map(files.map(file => [file.path, file]));
		return scored.flatMap((result: ScoredResult) => {
			const file = byPath.get(result.path);
			return file ? [{ file, score: result.score, excerpt: result.excerpt }] : [];
		});
	}

	private enqueue(files: TFile[]): void {
		if (files.length === 0) return;
		const worker = this.option('workerProfile') || 'react-orchestrator';
		const prompt = this.option('taskPrompt') || 'Process the queued note at {{file.path}}. Read it, complete the requested work, and report the result.';
		const concurrencyValue = this.config.get('batchConcurrency');
		const concurrency = typeof concurrencyValue === 'number' ? Math.max(1, Math.min(10, Math.floor(concurrencyValue))) : 1;
		this.plugin.enqueueBaseFiles(files, worker, prompt, concurrency, () => this.onDataUpdated());
		this.selected.clear();
		new Notice(`Queued ${files.length} note${files.length === 1 ? '' : 's'} from Base (${concurrency} at a time).`);
		void this.render(++this.renderVersion);
	}

	private option(key: string): string {
		const value = this.config.get(key);
		return typeof value === 'string' ? value.trim() : '';
	}
}

export function commandCenterBasesRegistration(plugin: CommandCenterPlugin): BasesViewRegistration {
	return {
		name: 'Command Center Queue',
		icon: 'list-checks',
		factory: (controller, containerEl) => new CommandCenterBasesView(controller, containerEl, plugin),
		options: () => [
			{
				key: 'workerProfile', type: 'dropdown', displayName: 'Worker profile', default: 'react-orchestrator',
				options: {
					'react-orchestrator': 'ReAct orchestrator', retriever: 'Retriever',
					summarizer: 'Summarizer', editor: 'Editor', 'pi-daemon': 'Pi daemon',
				},
			},
			{
				key: 'relevanceQuery', type: 'text', displayName: 'Full-text relevance query',
				placeholder: 'Optional BM25 query applied after Base filters',
			},
			{
				key: 'maxResults', type: 'slider', displayName: 'Maximum queue entries',
				default: 50, min: 1, max: 200, step: 1,
			},
			{
				key: 'batchConcurrency', type: 'slider', displayName: 'Batch Concurrency',
				default: 1, min: 1, max: 10, step: 1,
			},
			{
				key: 'taskPrompt', type: 'text', displayName: 'Task prompt',
				placeholder: 'Use {{file.path}} for the target note',
			},
		],
	};
}
