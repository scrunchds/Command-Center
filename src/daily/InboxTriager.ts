import { App, normalizePath, TFile, TFolder } from 'obsidian';
import { getSharedFileLockManager } from '../file-lock';
import type { FolderIndexer } from '../indexing/FolderIndexer';
import type {
	ExtractedTask, InboxActionKind, InboxHandlingOption, InboxTriagerOptions, InboxTriageProposal,
} from './DailyTypes';

const STYLE_GUIDE_PATH = '.command-center/style-guide.md';
const INDEX_FILE_NAME = '_index.md';

/** Scans only a user-selected drop point and executes only explicitly approved actions. */
export class InboxTriager {
	private readonly proposals = new Map<string, InboxTriageProposal>();
	private readonly locks;

	constructor(
		private readonly app: App,
		private readonly folderIndexer: FolderIndexer,
		private readonly options: InboxTriagerOptions = {},
	) { this.locks = getSharedFileLockManager(app); }

	async scanAndProposeInboxActions(inboxFolderPath: string): Promise<InboxTriageProposal[]> {
		const folderPath = this.safePath(inboxFolderPath);
		const folder = this.app.vault.getAbstractFileByPath(folderPath);
		if (!(folder instanceof TFolder)) throw new Error(`Configured inbox folder does not exist: ${folderPath}`);
		const style = await this.loadStyleGuide();
		const files = folder.children.filter((entry): entry is TFile =>
			entry instanceof TFile && entry.extension === 'md' && entry.name !== INDEX_FILE_NAME);
		const proposals = await Promise.all(files.sort((a, b) => a.path.localeCompare(b.path)).map(file => this.propose(file, style)));
		for (const proposal of proposals) this.proposals.set(proposal.id, proposal);
		return proposals;
	}

	async executeApprovedAction(
		proposalId: string,
		chosenAction: InboxActionKind,
		targetFolderPath?: string,
	): Promise<void> {
		const proposal = this.proposals.get(proposalId);
		if (!proposal) throw new Error('Inbox proposal is missing or expired; scan the inbox again.');
		const approved = proposal.options.find(option => option.action === chosenAction);
		if (!approved) throw new Error(`Action ${chosenAction} was not offered for this proposal.`);
		if (chosenAction === 'leave') { this.proposals.delete(proposalId); return; }
		const source = this.app.vault.getAbstractFileByPath(proposal.filePath);
		if (!(source instanceof TFile)) throw new Error(`Inbox note no longer exists: ${proposal.filePath}`);

		await this.locks.withLock(source.path, async () => {
			if (chosenAction === 'move') {
				const destination = this.resolveTarget(targetFolderPath ?? approved.suggestedTargetFolderPath, 'Move');
				await this.moveFile(source, destination);
			} else if (chosenAction === 'summarize_and_archive') {
				const destination = this.resolveTarget(targetFolderPath ?? approved.suggestedTargetFolderPath ?? this.options.archiveFolderPath, 'Archive');
				await this.moveFile(source, destination);
			} else {
				// Destructive by definition: reaching this method with this selected action
				// is the explicit approval boundary. Tasks are persisted before trashing.
				if (proposal.tasks.length && !this.options.extractedTasksPath) {
					throw new Error('Extract & delete requires a configured extractedTasksPath so tasks are not lost.');
				}
				if (proposal.tasks.length) await this.appendExtractedTasks(proposal);
				const oldPath = source.path;
				await this.app.fileManager.trashFile(source);
				await this.folderIndexer.removeIndexEntry(oldPath);
			}
		});
		this.proposals.delete(proposalId);
	}

	private async propose(file: TFile, styleGuide: string): Promise<InboxTriageProposal> {
		const content = await this.app.vault.cachedRead(file);
		const frontmatter = this.copyFrontmatter(file);
		const tasks = this.extractTasks(content);
		const summary = this.summarize(content, file.basename);
		const route = await this.folderIndexer.findTargetFolder(`${file.basename} ${summary} ${tasks.map(task => task.text).join(' ')}`);
		const options: InboxHandlingOption[] = [];
		if (route && route.folderPath !== file.parent?.path) options.push({
			action: 'move', label: `Move to ${route.folderPath}`,
			description: `Route the complete note to the closest managed semantic scope (${Math.round(route.score * 100)}% lexical overlap).`,
			suggestedTargetFolderPath: route.folderPath, destructive: false, requiresConfirmation: true,
		});
		for (const candidate of this.options.candidateTargetFolders ?? []) {
			const path = this.safePath(candidate);
			if (!options.some(option => option.action === 'move' && option.suggestedTargetFolderPath === path)) options.push({
				action: 'move', label: `Move to ${path}`, description: 'Use a user-configured routing destination.',
				suggestedTargetFolderPath: path, destructive: false, requiresConfirmation: true,
			});
		}
		if (this.options.archiveFolderPath) options.push({
			action: 'summarize_and_archive', label: 'Summarize and archive',
			description: `Preserve the note in ${this.safePath(this.options.archiveFolderPath)}; the manifest retains its concise summary.`,
			suggestedTargetFolderPath: this.safePath(this.options.archiveFolderPath), destructive: false, requiresConfirmation: true,
		});
		if (!tasks.length || this.options.extractedTasksPath) options.push({
			action: 'extract_and_delete', label: tasks.length ? 'Extract tasks and delete source' : 'Delete temporary source',
			description: tasks.length ? `Append ${tasks.length} task(s) to the configured task note, then move the source to trash.` : 'Move this temporary source note to trash.',
			destructive: true, requiresConfirmation: true,
		});
		options.push({ action: 'leave', label: 'Keep in inbox', description: 'Take no vault action.', destructive: false, requiresConfirmation: false });
		const id = `${file.path}:${file.stat.mtime}`;
		return {
			id, filePath: file.path, fileName: file.name, summary, frontmatter, tasks, options,
			proposalText: this.formatProposal(file.name, summary, tasks.length, options, styleGuide),
			createdAt: Date.now(),
		};
	}

	private async moveFile(file: TFile, targetFolderPath: string): Promise<void> {
		await this.ensureFolder(targetFolderPath);
		const oldPath = file.path;
		const destination = await this.availablePath(targetFolderPath, file.name);
		await this.app.fileManager.renameFile(file, destination);
		await this.folderIndexer.removeIndexEntry(oldPath);
		await this.folderIndexer.updateIndexEntry(destination);
	}

	private async appendExtractedTasks(proposal: InboxTriageProposal): Promise<void> {
		const configured = this.options.extractedTasksPath;
		if (!configured) return;
		const path = this.safeFilePath(configured);
		await this.ensureFolder(this.parentPath(path));
		const block = `\n\n## Extracted from [[${proposal.filePath}]]\n${proposal.tasks.map(task => `- [ ] ${task.text}`).join('\n')}\n`;
		await this.locks.withLock(path, async () => {
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) await this.app.vault.modify(existing, `${await this.app.vault.read(existing)}${block}`);
			else if (existing) throw new Error(`Task extraction path is not a file: ${path}`);
			else await this.app.vault.create(path, `# Extracted Inbox Tasks${block}`);
		});
		await this.folderIndexer.updateIndexEntry(path);
	}

	private extractTasks(content: string): ExtractedTask[] {
		const tasks: ExtractedTask[] = [];
		for (const [index, line] of content.split(/\r?\n/).entries()) {
			const match = /^\s*[-*+]\s+\[ \]\s+(.+?)\s*$/.exec(line);
			if (match?.[1]) tasks.push({ text: match[1], line: index + 1, raw: line });
		}
		return tasks;
	}

	private summarize(content: string, fallback: string): string {
		const body = content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trimStart();
		for (const paragraph of body.split(/\r?\n\s*\r?\n/)) {
			const clean = paragraph.replace(/^#{1,6}\s+.*$/gm, '').replace(/^\s*[-*+]\s+\[[ xX]\].*$/gm, '')
				.replace(/<!--[^]*?-->/g, '').replace(/\s+/g, ' ').trim();
			if (clean) return clean.length > 220 ? `${clean.slice(0, 220).trimEnd()}…` : clean;
		}
		return `Inbox note: ${fallback}`;
	}

	private copyFrontmatter(file: TFile): Record<string, unknown> {
		const source = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		if (!source) return {};
		return Object.fromEntries(Object.entries(source).filter(([key]) => key !== 'position'));
	}

	private formatProposal(name: string, summary: string, taskCount: number, options: InboxHandlingOption[], style: string): string {
		const persona = /minimalist/i.test(style) ? '' : ` Summary: ${summary}`;
		return `${name}:${persona} ${taskCount} open task${taskCount === 1 ? '' : 's'}. Choose: ${options.map(option => option.label).join(' / ')}.`.replace(/\s+/g, ' ').trim();
	}

	private async loadStyleGuide(): Promise<string> {
		const file = this.app.vault.getAbstractFileByPath(STYLE_GUIDE_PATH);
		if (!(file instanceof TFile)) throw new Error('Command Center style guide is missing. Complete the interview first.');
		return this.app.vault.cachedRead(file);
	}
	private resolveTarget(value: string | undefined, label: string): string { if (!value) throw new Error(`${label} requires an explicitly selected target folder.`); return this.safePath(value); }
	private safePath(value: string): string { const path = normalizePath(value.trim().replace(/^\/+|\/+$/g, '')); if (!path || path === '.' || path.startsWith('../') || path.includes('/../')) throw new Error(`Unsafe vault folder path: ${value}`); return path; }
	private safeFilePath(value: string): string { const path = normalizePath(value.trim().replace(/^\/+/, '')); if (!path || path.endsWith('/') || path.startsWith('../') || path.includes('/../')) throw new Error(`Unsafe vault file path: ${value}`); return path; }
	private parentPath(path: string): string { const at = path.lastIndexOf('/'); return at < 0 ? '' : path.slice(0, at); }
	private async ensureFolder(path: string): Promise<void> { if (!path) return; let current = ''; for (const segment of path.split('/')) { current = normalizePath(current ? `${current}/${segment}` : segment); const entry = this.app.vault.getAbstractFileByPath(current); if (entry instanceof TFolder) continue; if (entry) throw new Error(`A file blocks folder creation at ${current}.`); await this.app.vault.createFolder(current); } }
	private async availablePath(folder: string, fileName: string): Promise<string> { const dot = fileName.lastIndexOf('.'); const stem = dot > 0 ? fileName.slice(0, dot) : fileName; const extension = dot > 0 ? fileName.slice(dot) : ''; let path = normalizePath(`${folder}/${fileName}`), suffix = 2; while (this.app.vault.getAbstractFileByPath(path)) path = normalizePath(`${folder}/${stem} ${suffix++}${extension}`); return path; }
}
