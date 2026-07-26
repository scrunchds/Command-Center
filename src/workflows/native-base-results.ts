import type { App, BasesEntry, TFile } from 'obsidian';

/**
 * Convert Obsidian's native Bases query result into an executable queue.
 * Filters/formulas/sorts/limits have already been evaluated by Obsidian before
 * these entries reach a custom BasesView.
 */
export function filesFromNativeBaseEntries(
	entries: readonly Pick<BasesEntry, 'file'>[],
	app: App,
): TFile[] {
	const seen = new Set<string>();
	const files: TFile[] = [];
	for (const entry of entries) {
		const file = entry.file;
		if (file.extension !== 'md' || seen.has(file.path)) continue;
		const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		const status = frontmatter?.agent_status;
		if (typeof status === 'string' && status.toLowerCase() === 'completed') continue;
		seen.add(file.path);
		files.push(file);
	}
	return files;
}
