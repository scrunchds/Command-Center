import { App, getAllTags, normalizePath, TAbstractFile, TFile, TFolder } from 'obsidian';

export const VAULT_TOPOGRAPHY_PATH = 'plugins/command-center/vault_topography.json';

export interface FolderTopology { path: string; parent: string | null; noteCount: number; children: string[]; }
export interface HubNote { path: string; title: string; inboundLinks: number; outboundLinks: number; }
export interface VaultTopography {
	schemaVersion: 1;
	generatedAt: string;
	folders: FolderTopology[];
	tags: Array<{ tag: string; count: number }>;
	hubs: HubNote[];
	noteCount: number;
}

const excluded = (path: string): boolean => path === '.obsidian' || path.startsWith('.obsidian/') || path === '.trash' || path.startsWith('.trash/');
const parent = (path: string): string | null => !path ? null : path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

/** Read-only with respect to user content; only its localized plugin map is written. */
export class TopographySweep {
	constructor(private readonly app: App, private readonly outputPath = VAULT_TOPOGRAPHY_PATH) {}

	async run(signal?: AbortSignal): Promise<VaultTopography> {
		const loaded: TAbstractFile[] = this.app.vault.getAllLoadedFiles().filter(file => !excluded(file.path));
		const notes = loaded.filter((file): file is TFile => file instanceof TFile && file.extension === 'md');
		const folders = loaded.filter((file): file is TFolder => file instanceof TFolder);
		const tags = new Map<string, number>();
		const inbound = new Map<string, number>();
		const outbound = new Map<string, number>();

		for (let index = 0; index < notes.length; index++) {
			if (signal?.aborted) throw new DOMException('Topography sweep cancelled.', 'AbortError');
			const file = notes[index]!;
			const cache = this.app.metadataCache.getFileCache(file);
			for (const tag of new Set(cache ? getAllTags(cache) ?? [] : [])) tags.set(tag, (tags.get(tag) ?? 0) + 1);
			const destinations = new Set<string>();
			for (const link of cache?.links ?? []) {
				const destination = this.app.metadataCache.getFirstLinkpathDest(link.link, file.path);
				if (destination instanceof TFile) destinations.add(destination.path);
			}
			outbound.set(file.path, destinations.size);
			for (const destination of destinations) inbound.set(destination, (inbound.get(destination) ?? 0) + 1);
			if ((index + 1) % 100 === 0) await new Promise<void>(resolve => window.setTimeout(resolve, 0));
		}

		const map: VaultTopography = {
			schemaVersion: 1,
			generatedAt: new Date().toISOString(),
			noteCount: notes.length,
			folders: ['', ...folders.map(folder => folder.path)].map(path => ({
				path,
				parent: parent(path),
				noteCount: notes.filter(note => (note.parent?.path ?? '') === path).length,
				children: folders.filter(folder => (folder.parent?.path ?? '') === path).map(folder => folder.path).sort(),
			})),
			tags: [...tags].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
			hubs: notes.map(file => ({ path: file.path, title: file.basename, inboundLinks: inbound.get(file.path) ?? 0, outboundLinks: outbound.get(file.path) ?? 0 }))
				.filter(note => note.inboundLinks > 0 || note.outboundLinks > 0)
				.sort((a, b) => b.inboundLinks - a.inboundLinks || b.outboundLinks - a.outboundLinks).slice(0, 100),
		};
		await this.app.vault.adapter.write(normalizePath(`${this.app.vault.configDir}/${this.outputPath}`), JSON.stringify(map, null, 2));
		return map;
	}
}
