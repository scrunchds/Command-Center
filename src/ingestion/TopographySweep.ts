import { App, getAllTags, TFile, TFolder } from 'obsidian';

export interface TopographyNode {
	path: string;
	folder: string;
	basename: string;
	tags: string[];
	frontmatterFields: string[];
	outboundLinks: string[];
	inboundLinks: string[];
}

export interface TopographyFolder {
	path: string;
	directNoteCount: number;
	descendantNoteCount: number;
}

export interface TopographyMap {
	generatedAt: number;
	nodes: ReadonlyMap<string, TopographyNode>;
	folders: ReadonlyMap<string, TopographyFolder>;
	tagCounts: ReadonlyMap<string, number>;
	frontmatterFieldCounts: ReadonlyMap<string, number>;
}

export interface TopographySweepProgress {
	processed: number;
	total: number;
	currentPath?: string;
}

export interface TopographySweepOptions {
	signal?: AbortSignal;
	onProgress?: (progress: TopographySweepProgress) => void;
	yieldEvery?: number;
}

const isExcluded = (path: string): boolean => path === '.obsidian' || path.startsWith('.obsidian/') || path === '.trash' || path.startsWith('.trash/');
const parentPath = (path: string): string => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

/**
 * Read-only, bounded vault mapper. It only queries Obsidian's Vault and
 * MetadataCache APIs and retains the resulting graph in memory.
 */
export class TopographySweep {
	private snapshot: TopographyMap | null = null;

	constructor(private readonly app: App) {}

	getSnapshot(): TopographyMap | null {
		return this.snapshot;
	}

	clear(): void {
		this.snapshot = null;
	}

	async run(options: TopographySweepOptions = {}): Promise<TopographyMap> {
		const files = this.app.vault.getMarkdownFiles().filter(file => !isExcluded(file.path));
		const folderPaths = this.app.vault.getAllLoadedFiles()
			.filter((entry): entry is TFolder => entry instanceof TFolder && !isExcluded(entry.path))
			.map(folder => folder.path);
		const mutableNodes = new Map<string, TopographyNode>();
		const tagCounts = new Map<string, number>();
		const fieldCounts = new Map<string, number>();
		const yieldEvery = Math.max(1, options.yieldEvery ?? 50);

		for (let index = 0; index < files.length; index++) {
			if (options.signal?.aborted) throw new DOMException('Topography sweep cancelled.', 'AbortError');
			const file = files[index];
			if (!(file instanceof TFile)) continue;
			const cache = this.app.metadataCache.getFileCache(file);
			const tags = [...new Set(cache ? getAllTags(cache) ?? [] : [])].sort();
			const frontmatterFields = cache?.frontmatter
				? Object.keys(cache.frontmatter).filter(key => key !== 'position').sort()
				: [];
			const outboundLinks = [...new Set((cache?.links ?? []).map(link => {
				return this.app.metadataCache.getFirstLinkpathDest(link.link, file.path)?.path ?? link.link;
			}))].sort();
			for (const tag of tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
			for (const field of frontmatterFields) fieldCounts.set(field, (fieldCounts.get(field) ?? 0) + 1);
			mutableNodes.set(file.path, {
				path: file.path,
				folder: parentPath(file.path),
				basename: file.basename,
				tags,
				frontmatterFields,
				outboundLinks,
				inboundLinks: [],
			});
			options.onProgress?.({ processed: index + 1, total: files.length, currentPath: file.path });
			if ((index + 1) % yieldEvery === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
		}

		for (const source of mutableNodes.values()) {
			for (const target of source.outboundLinks) {
				const node = mutableNodes.get(target);
				if (node && !node.inboundLinks.includes(source.path)) node.inboundLinks.push(source.path);
			}
		}
		for (const node of mutableNodes.values()) node.inboundLinks.sort();

		const folders = new Map<string, TopographyFolder>();
		for (const path of ['', ...folderPaths]) {
			const prefix = path ? `${path}/` : '';
			folders.set(path, {
				path,
				directNoteCount: files.filter(file => parentPath(file.path) === path).length,
				descendantNoteCount: files.filter(file => !path || file.path.startsWith(prefix)).length,
			});
		}
		this.snapshot = {
			generatedAt: Date.now(),
			nodes: mutableNodes,
			folders,
			tagCounts,
			frontmatterFieldCounts: fieldCounts,
		};
		return this.snapshot;
	}
}
