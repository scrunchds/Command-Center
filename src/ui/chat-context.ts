import type { App, TFile } from 'obsidian';
import { parseBaseQueue } from '../workflows/base-queue';

export interface ChatContextAttachment {
	name: string;
	type: 'note' | 'selection' | 'base';
	path?: string;
	/** Suggested attachments come from the active tab or recent vault files. */
	suggested?: boolean;
}

export interface ResolvedChatContext {
	cleanedPrompt: string;
	contextString: string;
	attachments: ChatContextAttachment[];
}

interface Mention {
	raw: string;
	reference: string;
	index: number;
}

/**
 * Extract unquoted @mentions. Paths may contain `/`, `-`, `_`, and spaces when
 * enclosed in angle brackets (for example `@<Project Notes/Plan.md>`).
 */
function extractMentions(input: string): Mention[] {
	const mentions: Mention[] = [];
	const pattern = /@<([^>]+)>|@([^\s@,;!?()[\]{}]+)/g;
	for (const match of input.matchAll(pattern)) {
		const enclosed = match[1] !== undefined;
		let reference = (match[1] ?? match[2] ?? '').trim();
		// Sentence punctuation is not part of a bare mention, while the dots in
		// `.md` and `.base` remain valid. Angle brackets provide an explicit
		// boundary for paths that intentionally contain spaces or punctuation.
		if (!enclosed) {
			reference = reference.replace(/[:"']+$/g, '');
			while (reference.endsWith('.') && !/\.(?:md|base)$/i.test(reference)) reference = reference.slice(0, -1);
		}
		if (!reference) continue;
		const raw = enclosed ? match[0] : `@${reference}`;
		mentions.push({ raw, reference, index: match.index ?? 0 });
	}
	return mentions;
}

function isFile(value: unknown): value is TFile {
	if (!value || typeof value !== 'object') return false;
	const file = value as Partial<TFile>;
	return typeof file.path === 'string' && typeof file.extension === 'string';
}

function resolveMentionFile(app: App, reference: string, sourcePath: string): TFile | null {
	const normalized = reference.replace(/^\[\[/, '').replace(/\]\]$/, '').split('|')[0]!.trim();
	const candidates = normalized.includes('.') ? [normalized] : [normalized, `${normalized}.md`, `${normalized}.base`];
	for (const candidate of candidates) {
		const direct = app.vault.getAbstractFileByPath(candidate);
		if (isFile(direct)) return direct;
		const linked = app.metadataCache.getFirstLinkpathDest(candidate, sourcePath);
		if (isFile(linked)) return linked;
	}
	return null;
}

function selectedEditorText(app: App): string {
	return app.workspace.activeEditor?.editor?.getSelection().trim() ?? '';
}

function printableFrontmatter(value: unknown): string {
	if (!value || typeof value !== 'object') return '';
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([key]) => key !== 'position')
		.map(([key, item]) => `${key}=${typeof item === 'string' ? item : JSON.stringify(item)}`);
	return entries.join(', ');
}

function recentContextFiles(app: App, active: TFile | null, limit = 3): TFile[] {
	const markdown = app.vault.getMarkdownFiles?.() ?? [];
	const recent = markdown
		.filter(file => file.path !== active?.path)
		.sort((left, right) => (right.stat?.mtime ?? 0) - (left.stat?.mtime ?? 0));
	return [...(active?.extension === 'md' ? [active] : []), ...recent].slice(0, limit);
}

/**
 * Resolve editor selection, vault @mentions, the active note, and recent notes
 * into prompt-ready context. Suggested notes are ordinary dismissible
 * attachments, so callers can remove them before dispatch. Missing or
 * unreadable files never prevent other attachments from resolving.
 */
export async function resolveChatContext(app: App, input: string, options: { suggestRecent?: boolean } = {}): Promise<ResolvedChatContext> {
	const attachments: ChatContextAttachment[] = [];
	const sections: string[] = [];
	const activeFile = app.workspace.getActiveFile();
	const sourcePath = activeFile?.path ?? '';
	const selection = selectedEditorText(app);
	if (selection) {
		attachments.push({ name: 'Selection', type: 'selection' });
		sections.push(`## [Selection]\n${selection}`);
	}

	const removals: Array<{ start: number; end: number }> = [];
	const seen = new Set<string>();
	for (const mention of extractMentions(input)) {
		const file = resolveMentionFile(app, mention.reference, sourcePath);
		if (!file) continue;
		if (seen.has(file.path)) {
			removals.push({ start: mention.index, end: mention.index + mention.raw.length });
			continue;
		}
		try {
			if (file.extension === 'base') {
				const queue = await parseBaseQueue(file, app);
				const rows = queue.map(item => {
					const metadata = printableFrontmatter(app.metadataCache.getFileCache(item)?.frontmatter);
					return `- ${item.path}${metadata ? ` (${metadata})` : ''}`;
				});
				attachments.push({ name: file.basename, type: 'base', path: file.path });
				sections.push(`## Base queue: ${file.path}\n${rows.length ? rows.join('\n') : '(empty queue)'}`);
			} else {
				const content = await app.vault.read(file);
				attachments.push({ name: file.basename, type: 'note', path: file.path });
				sections.push(`## Note: ${file.path}\n${content}`);
			}
			seen.add(file.path);
			removals.push({ start: mention.index, end: mention.index + mention.raw.length });
		} catch {
			// Preserve unresolved/unreadable mentions in the user prompt.
		}
	}

	if (options.suggestRecent) {
		for (const file of recentContextFiles(app, isFile(activeFile) ? activeFile : null)) {
			if (seen.has(file.path)) continue;
			try {
				const content = await app.vault.read(file);
				if (!content.trim()) continue;
				attachments.push({ name: file.basename, type: 'note', path: file.path, suggested: true });
				const excerpt = content.length > 4_000 ? `${content.slice(0, 4_000)}\n…` : content;
				sections.push(`## Suggested note: ${file.path}\n${excerpt}`);
				seen.add(file.path);
			} catch {
				// Recent-file suggestions are best effort and never block dispatch.
			}
		}
	}

	let cleanedPrompt = input;
	for (const removal of removals.sort((a, b) => b.start - a.start)) {
		cleanedPrompt = `${cleanedPrompt.slice(0, removal.start)}${cleanedPrompt.slice(removal.end)}`;
	}
	cleanedPrompt = cleanedPrompt.replace(/[ \t]{2,}/g, ' ').replace(/ *\n */g, '\n').trim();
	return {
		cleanedPrompt,
		contextString: sections.length ? `# Attached context\n\n${sections.join('\n\n---\n\n')}` : '',
		attachments,
	};
}
