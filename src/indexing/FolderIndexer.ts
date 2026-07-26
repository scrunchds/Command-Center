import { App, normalizePath, TFile, TFolder, type EventRef } from 'obsidian';
import { getSharedFileLockManager } from '../file-lock';
import type {
	FileManifestEntry, FolderIndexMetadata, FolderIndexerOptions, FolderIndexResult,
	FolderMatch, FolderPurposeDeclaration, FolderPurposeHeader,
} from './IndexTypes';

export const SYSTEM_INDEX_HEADER = '<!-- COMMAND CENTER SYSTEM FILE: DO NOT MOVE OR RENAME. UPDATED AUTOMATICALLY BY PLUGIN. -->';
export const INDEX_FILE_NAME = '_index.md';


/**
 * Maintains stationary `_index.md` files using direct-child manifests.
 *
 * Deliberately does not recurse into subfolders or load note bodies. Manifest
 * summaries use metadata-cache frontmatter/headings and a filename fallback.
 */
export class FolderIndexer {
	private readonly declarations = new Map<string, FolderPurposeDeclaration>();
	private readonly debounceMs: number;
	private readonly maxSummaryLength: number;
	private readonly statusKeys: string[];
	private eventRefs: EventRef[] = [];
	private refreshTimers = new Map<string, number>();
	private updateChains = new Map<string, Promise<FolderIndexResult>>();
	private selfWrites = new Set<string>();
	private readonly locks;

	constructor(private readonly app: App, options: FolderIndexerOptions = {}) {
		this.locks = getSharedFileLockManager(app);
		this.debounceMs = Math.max(0, options.debounceMs ?? 750);
		this.maxSummaryLength = Math.max(60, options.maxSummaryLength ?? 180);
		this.statusKeys = options.statusKeys?.length ? [...options.statusKeys] : [];
	}

	/** Create folders/indexes and remember them for subsequent event updates. */
	async initialize(folders: ReadonlyArray<FolderPurposeDeclaration>): Promise<string[]> {
		const paths: string[] = [];
		for (const declaration of folders) {
			const normalized = this.normalizeDeclaration(declaration);
			this.declarations.set(normalized.path, normalized);
			await this.ensureFolder(normalized.path);
			const result = await this.update(normalized.path);
			paths.push(result.indexPath);
		}
		return paths;
	}

	/** Initialize one folder only from an explicit interview-derived declaration. */
	async initializeFolderIndex(folderPath: string, purpose: string, scope: string): Promise<void> {
		const path = this.safeFolderPath(folderPath);
		if (!purpose.trim() || !scope.trim()) throw new Error('Managed folder purpose and scope must come from interview configuration.');
		await this.ensureFolder(path);
		this.declarations.set(path, { path, purpose: purpose.trim(), scope: scope.trim() });
		await this.update(path);
	}

	/**
	 * Update one manifest row in place. Writes are debounced by event handlers
	 * and protected by a per-index FIFO lock when called directly.
	 */
	async updateIndexEntry(filePath: string): Promise<void> {
		const path = normalizePath(filePath);
		if (path.endsWith(`/${INDEX_FILE_NAME}`)) return;
		const folderPath = this.parentPath(path);
		if (!this.declarations.has(folderPath)) return;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) { await this.removeIndexEntry(path); return; }
		const indexPath = normalizePath(`${folderPath}/${INDEX_FILE_NAME}`);
		if (!(this.app.vault.getAbstractFileByPath(indexPath) instanceof TFile)) {
			await this.update(folderPath);
			return;
		}
		await this.locks.withLock(indexPath, async () => {
			const index = this.app.vault.getAbstractFileByPath(indexPath);
			if (!(index instanceof TFile)) return;
			const current = await this.app.vault.read(index);
			if (!current.startsWith(SYSTEM_INDEX_HEADER)) throw new Error(`${indexPath} is not a Command Center system file.`);
			const entry = await this.toManifestEntry(file);
			const row = this.renderRow(entry);
			const lines = current.split('\n');
			const rowAt = this.findManifestRow(lines, path);
			if (rowAt >= 0) lines[rowAt] = row;
			else {
				const emptyAt = lines.findIndex(line => line.startsWith('| _No files indexed yet._ |'));
				if (emptyAt >= 0) lines[emptyAt] = row;
				else lines.push(row);
			}
			await this.writeIfChanged(index, `${lines.join('\n').replace(/\n*$/, '')}\n`, current);
		});
	}

	/** Remove one exact manifest row from its former parent index. */
	async removeIndexEntry(filePath: string): Promise<void> {
		const path = normalizePath(filePath);
		const folderPath = this.parentPath(path);
		if (!this.declarations.has(folderPath)) return;
		const indexPath = normalizePath(`${folderPath}/${INDEX_FILE_NAME}`);
		await this.locks.withLock(indexPath, async () => {
			const index = this.app.vault.getAbstractFileByPath(indexPath);
			if (!(index instanceof TFile)) return;
			const current = await this.app.vault.read(index);
			if (!current.startsWith(SYSTEM_INDEX_HEADER)) return;
			const lines = current.split('\n');
			const rowAt = this.findManifestRow(lines, path);
			if (rowAt < 0) return;
			lines.splice(rowAt, 1);
			const headerAt = lines.findIndex(line => line === '| --- | --- | --- | --- |');
			if (headerAt >= 0 && !lines.slice(headerAt + 1).some(line => /^\| \[\[/.test(line))) {
				lines.splice(headerAt + 1, 0, '| _No files indexed yet._ | — | — | — |');
			}
			await this.writeIfChanged(index, `${lines.join('\n').replace(/\n*$/, '')}\n`, current);
		});
	}

	/** Recreate missing anchors and refresh every managed index. */
	async verifyIndexAnchors(): Promise<void> {
		for (const declaration of this.declarations.values()) {
			await this.ensureFolder(declaration.path);
			const anchor = this.app.vault.getAbstractFileByPath(normalizePath(`${declaration.path}/${INDEX_FILE_NAME}`));
			if (!(anchor instanceof TFile)) await this.update(declaration.path);
			else {
				const content = await this.app.vault.read(anchor);
				if (!content.startsWith(SYSTEM_INDEX_HEADER)) throw new Error(`${anchor.path} blocks the required Command Center index anchor.`);
			}
		}
	}

	/** Read only the compact header region of every stationary index in the vault. */
	async getFolderPurposeHeaders(): Promise<FolderPurposeHeader[]> {
		const indexes = this.app.vault.getMarkdownFiles().filter(file => file.name === INDEX_FILE_NAME);
		const headers: FolderPurposeHeader[] = [];
		for (const file of indexes) {
			const content = await this.app.vault.cachedRead(file);
			const header = content.split(/\n---\s*(?:\n|$)/, 1)[0] ?? '';
			if (!header.startsWith(SYSTEM_INDEX_HEADER)) continue;
			const purpose = /^> \*\*Purpose:\*\*\s*(.+?)(?: {2})?$/m.exec(header)?.[1]?.replace(/<br>/g, '\n').trim() ?? '';
			const scopeValue = /^> \*\*Scope & Content Types:\*\*\s*(.+)$/m.exec(header)?.[1]?.replace(/<br>/g, '\n').trim() ?? '';
			if (purpose || scopeValue) headers.push({ folderPath: this.parentPath(file.path), purpose, scope: scopeValue });
		}
		return headers.sort((a, b) => a.folderPath.localeCompare(b.folderPath));
	}

	/** Rank compact folder-purpose headers for semantic routing without note crawling. */
	async findTargetFolder(query: string): Promise<FolderMatch | null> {
		const terms = new Set(this.tokenize(query));
		let best: FolderMatch | null = null;
		for (const header of await this.getFolderPurposeHeaders()) {
			const haystack = this.tokenize(`${header.folderPath} ${header.purpose} ${header.scope}`);
			let overlap = 0;
			for (const term of haystack) if (terms.has(term)) overlap++;
			const score = terms.size ? overlap / terms.size : 0;
			if (!best || score > best.score) best = { ...header, score };
		}
		return best && best.score > 0 ? best : null;
	}

	/** Start automatic create/modify/delete/rename maintenance. Safe to call twice. */
	start(): void {
		if (this.eventRefs.length) return;
		this.eventRefs = [
			this.app.vault.on('create', file => this.handleVaultChange(file.path, 'update')),
			this.app.vault.on('modify', file => this.handleVaultChange(file.path, 'update')),
			this.app.vault.on('delete', file => this.handleVaultChange(file.path, 'remove')),
			this.app.vault.on('rename', (file, oldPath) => {
				this.handleVaultChange(oldPath, 'remove');
				this.handleVaultChange(file.path, 'update');
			}),
		];
	}

	/** Stop listeners and pending updates. */
	stop(): void {
		for (const ref of this.eventRefs) this.app.vault.offref(ref);
		this.eventRefs = [];
		for (const timer of this.refreshTimers.values()) window.clearTimeout(timer);
		this.refreshTimers.clear();
	}

	/** Regenerate one managed folder index, serialized per folder. */
	async update(folderPath: string): Promise<FolderIndexResult> {
		const path = this.safeFolderPath(folderPath);
		const declaration = this.declarations.get(path);
		if (!declaration) throw new Error(`Folder is not managed by Command Center: ${path}`);
		const previous = this.updateChains.get(path) ?? Promise.resolve(undefined as unknown as FolderIndexResult);
		const next = previous.catch(() => undefined).then(() => this.performUpdate(declaration));
		this.updateChains.set(path, next);
		try { return await next; }
		finally { if (this.updateChains.get(path) === next) this.updateChains.delete(path); }
	}

	/** Build metadata without writing the index file. */
	async scan(folderPath: string): Promise<FolderIndexMetadata> {
		const path = this.safeFolderPath(folderPath);
		const declaration = this.declarations.get(path);
		if (!declaration) throw new Error(`Folder is not managed by Command Center: ${path}`);
		const folder = this.app.vault.getAbstractFileByPath(path);
		if (!(folder instanceof TFolder)) throw new Error(`Managed folder does not exist: ${path}`);
		const files = folder.children
			.filter((entry): entry is TFile => entry instanceof TFile && entry.name !== INDEX_FILE_NAME)
			.sort((a, b) => a.path.localeCompare(b.path));
		const manifest = await Promise.all(files.map(file => this.toManifestEntry(file)));
		return {
			folderPath: path,
			folderName: path.split('/').pop() ?? path,
			indexPath: normalizePath(`${path}/${INDEX_FILE_NAME}`),
			purpose: declaration.purpose,
			scope: this.scopeFor(declaration),
			generatedAt: new Date().toISOString(),
			fileCount: manifest.length,
			manifest,
		};
	}

	private async performUpdate(declaration: FolderPurposeDeclaration): Promise<FolderIndexResult> {
		const metadata = await this.scan(declaration.path);
		const content = this.render(metadata);
		return this.locks.withLock(metadata.indexPath, async () => {
			const existing = this.app.vault.getAbstractFileByPath(metadata.indexPath);
			let operation: FolderIndexResult['operation'];
			this.selfWrites.add(metadata.indexPath);
			try {
				if (existing instanceof TFile) {
					const current = await this.app.vault.read(existing);
					if (!current.startsWith(SYSTEM_INDEX_HEADER)) {
						throw new Error(`${metadata.indexPath} already exists and is not a Command Center system file.`);
					}
					if (current === content) operation = 'unchanged';
					else { await this.app.vault.modify(existing, content); operation = 'updated'; }
				} else if (existing) {
					throw new Error(`${metadata.indexPath} exists but is not a Markdown file.`);
				} else {
					await this.app.vault.create(metadata.indexPath, content);
					operation = 'created';
				}
			} finally {
				queueMicrotask(() => this.selfWrites.delete(metadata.indexPath));
			}
			return { ...metadata, operation };
		});
	}

	private handleVaultChange(changedPath: string, action: 'update' | 'remove'): void {
		const path = normalizePath(changedPath);
		if (this.selfWrites.has(path)) return;
		const folderPath = this.parentPath(path);
		if (!this.declarations.has(folderPath)) return;
		if (path === normalizePath(`${folderPath}/${INDEX_FILE_NAME}`)) {
			if (action === 'remove') this.schedule(path, 'verify');
			return;
		}
		this.schedule(path, action);
	}

	private schedule(path: string, action: 'update' | 'remove' | 'verify'): void {
		const key = action === 'verify' ? `verify:${path}` : `file:${path}`;
		const existing = this.refreshTimers.get(key);
		if (existing !== undefined) window.clearTimeout(existing);
		const timer = window.setTimeout(() => {
			this.refreshTimers.delete(key);
			const operation = action === 'verify' ? this.verifyIndexAnchors()
				: action === 'remove' ? this.removeIndexEntry(path) : this.updateIndexEntry(path);
			void operation.catch(error => console.error(`[CC] Unable to maintain folder index for ${path}:`, error));
		}, this.debounceMs);
		this.refreshTimers.set(key, timer);
	}

	private async toManifestEntry(file: TFile): Promise<FileManifestEntry> {
		const cache = this.app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter;
		let description = this.frontmatterDescription(frontmatter);
		if (!description && file.extension === 'md') {
			description = await this.firstParagraphSummary(file);
			if (!description) {
				const heading = cache?.headings?.find(item => item.level <= 2)?.heading;
				description = heading ? `Note about ${heading}` : `Markdown note: ${file.basename}`;
			}
		}
		if (!description) description = `${file.extension.toUpperCase() || 'Vault'} file: ${file.basename}`;
		return {
			path: file.path,
			description: this.cleanCell(description),
			status: this.statusFor(frontmatter),
			lastModified: this.formatTimestamp(file.stat.mtime),
		};
	}

	private async firstParagraphSummary(file: TFile): Promise<string> {
		try {
			const text = await this.app.vault.cachedRead(file);
			const body = text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trimStart();
			const paragraphs = body.split(/\r?\n\s*\r?\n/);
			for (const paragraph of paragraphs) {
				const clean = paragraph.replace(/^#{1,6}\s+.*$/gm, '').replace(/<!--[^]*?-->/g, '')
					.replace(/```[^]*?```/g, '').replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
					.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?]]/g, '$2$1').replace(/\s+/g, ' ').trim();
				if (clean) return clean;
			}
		} catch { /* A filename summary remains available. */ }
		return '';
	}

	private frontmatterDescription(frontmatter?: Record<string, unknown>): string {
		if (!frontmatter) return '';
		for (const key of ['description', 'summary', 'abstract']) {
			const value = frontmatter[key];
			if (typeof value === 'string' && value.trim()) return value.trim();
		}
		return '';
	}

	private statusFor(frontmatter?: Record<string, unknown>): string {
		if (!frontmatter) return '—';
		for (const key of this.statusKeys) {
			const value = frontmatter[key];
			if (value !== undefined && value !== null && this.displayValue(value).trim()) {
				return `\`${this.cleanCell(key)}: ${this.cleanCell(this.displayValue(value))}\``;
			}
		}
		return '—';
	}

	private render(metadata: FolderIndexMetadata): string {
		const rows = metadata.manifest.length
			? metadata.manifest.map(entry => this.renderRow(entry)).join('\n')
			: '| _No files indexed yet._ | — | — | — |';
		return `${SYSTEM_INDEX_HEADER}\n\n# Folder Index: ${this.cleanHeading(metadata.folderName)}\n\n> **Purpose:** ${this.blockquote(metadata.purpose)}  \n> **Scope & Content Types:** ${this.blockquote(metadata.scope)}\n\n---\n\n## File Manifest\n\n| File Path | Description / Summary | Status / Frontmatter | Last Modified |\n| --- | --- | --- | --- |\n${rows}\n`;
	}

	private renderRow(entry: FileManifestEntry): string {
		return `| [[${this.escapeLink(entry.path)}]] | ${entry.description} | ${entry.status} | ${entry.lastModified} |`;
	}

	private findManifestRow(lines: string[], filePath: string): number {
		const exact = `[[${this.escapeLink(filePath)}]]`;
		return lines.findIndex(line => line.startsWith('| [[') && line.includes(exact));
	}

	private async writeIfChanged(file: TFile, content: string, current: string): Promise<void> {
		if (content === current) return;
		this.selfWrites.add(file.path);
		try { await this.app.vault.modify(file, content); }
		finally { queueMicrotask(() => this.selfWrites.delete(file.path)); }
	}

	private tokenize(value: string): string[] {
		return value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter(term => term.length > 2) ?? [];
	}

	private normalizeDeclaration(value: FolderPurposeDeclaration): FolderPurposeDeclaration {
		const purpose = value.purpose?.trim();
		const scope = value.scope?.trim() || value.contentTypes?.filter(Boolean).join(', ');
		if (!purpose || !scope) throw new Error(`Managed folder ${value.path} requires interview-defined purpose and scope.`);
		return { ...value, path: this.safeFolderPath(value.path), purpose, scope };
	}
	private scopeFor(value: FolderPurposeDeclaration): string {
		const scope = value.scope?.trim() || value.contentTypes?.filter(Boolean).join(', ');
		if (!scope) throw new Error(`Managed folder ${value.path} has no interview-defined scope.`);
		return scope;
	}
	private safeFolderPath(path: string): string {
		const normalized = normalizePath(path.trim().replace(/^\/+|\/+$/g, ''));
		if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../') || normalized === '.command-center') throw new Error(`Unsafe managed folder path: ${path}`);
		return normalized;
	}
	private async ensureFolder(path: string): Promise<void> {
		let current = '';
		for (const segment of path.split('/')) {
			current = normalizePath(current ? `${current}/${segment}` : segment);
			const entry = this.app.vault.getAbstractFileByPath(current);
			if (entry instanceof TFolder) continue;
			if (entry) throw new Error(`Cannot create folder; a file exists at ${current}.`);
			await this.app.vault.createFolder(current);
		}
	}
	private parentPath(path: string): string { const at = path.lastIndexOf('/'); return at < 0 ? '' : path.slice(0, at); }
	private displayValue(value: unknown): string {
		if (Array.isArray(value)) return value.map(item => this.displayValue(item)).join(', ');
		if (value !== null && typeof value === 'object') return JSON.stringify(value);
		if (typeof value === 'string') return value;
		if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value.toString();
		return '';
	}
	private cleanCell(value: string): string {
		const cleaned = value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/`/g, "'").replace(/\s+/g, ' ').trim();
		return cleaned.length > this.maxSummaryLength ? `${cleaned.slice(0, this.maxSummaryLength).trimEnd()}…` : cleaned;
	}
	private cleanHeading(value: string): string { return value.replace(/[\r\n#]/g, ' ').trim(); }
	private blockquote(value: string): string { return value.replace(/\r?\n+/g, '<br>').replace(/\|/g, '\\|').trim(); }
	private escapeLink(path: string): string { return path.replace(/\|/g, '\\|').replace(/]]/g, ']\\]'); }
	private formatTimestamp(timestamp: number): string {
		const date = new Date(timestamp);
		const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
		const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? '';
		return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
	}
}
