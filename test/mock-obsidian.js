/**
 * Mock Obsidian module for testing (ESM).
 * Provides minimal stubs for Obsidian types and functions used by Command Center modules.
 */

export class App {
	constructor() {
		this.vault = new Vault();
		this.metadataCache = new MetadataCache();
		this.workspace = new Workspace();
		this.secretStorage = { get: async () => null, set: async () => {}, delete: async () => {} };
		this.fileManager = { trashFile: async () => {}, processFrontMatter: async () => {} };
	}
}

export class Vault {
	constructor() {
		this.files = new Map();
		this.folders = new Set();
	}

	getMarkdownFiles() { return []; }
	getAllLoadedFiles() { return []; }
	getAbstractFileByPath(path) { return this.files.get(path) || null; }
	async read(file) { return ''; }
	async cachedRead(file) { return ''; }
	async modify(file, content) {}
	async create(path, content) {
		this.files.set(path, { path, name: path.split('/').pop(), basename: path.split('/').pop()?.replace(/\.md$/, '') });
	}
	async createFolder(path) { this.folders.add(path); }
	getName() { return 'Test Vault'; }
	getRoot() { return new TFolder('/'); }
}

export class TFile {
	constructor(path) {
		this.path = path;
		this.name = path.split('/').pop() || path;
		this.basename = this.name.replace(/\.md$/, '');
		this.extension = this.name.includes('.') ? this.name.split('.').pop() || '' : '';
		this.parent = path.includes('/') ? new TFolder(path.split('/').slice(0, -1).join('/')) : null;
	}
}

export class TFolder {
	constructor(path) {
		this.path = path;
		this.name = path.split('/').pop() || path;
		this.children = [];
	}
}

export class MetadataCache {
	constructor() { this.fileCaches = new Map(); }
	getFileCache(file) { return this.fileCaches.get(file?.path) || null; }
	getFirstLinkpathDest(link, source) { return null; }
	getTags() { return {}; }
	on() { return () => {}; }
	off() {}
}

export class Workspace {
	getActiveFile() { return null; }
	getLeavesOfType() { return []; }
	getActiveViewOfType() { return null; }
}

export class PluginSettingTab {
	constructor(app, plugin) {
		this.app = app;
		this.plugin = plugin;
		this.containerEl = { createDiv: () => ({ createDiv: () => {}, createEl: () => {} }), createEl: () => {}, empty: () => {}, addClass: () => {} };
	}
	display() {}
}

export class Setting {
	constructor(container) { this.containerEl = container; }
	setName(name) { return this; }
	setDesc(desc) { return this; }
	addToggle(cb) { return this; }
	addText(cb) { return this; }
	addButton(cb) { return this; }
	addSlider(cb) { return this; }
	addDropdown(cb) { return this; }
	setDisabled(v) { return this; }
	setValue(v) { return this; }
	setDynamicTooltip() { return this; }
	setLimits(min, max, step) { return this; }
	setWarning() { return this; }
	setDestructive() { return this; }
	setButtonText(text) { return this; }
	onChange(cb) { return this; }
}

export class Notice {
	constructor(message, timeout) {}
}

export class Plugin {
	constructor() {
		this.app = new App();
		this.manifest = { id: 'test', name: 'Test', version: '1.0.0', minAppVersion: '1.0.0', isDesktopOnly: false };
	}
}

export class Modal {
	constructor(app) { this.app = app; }
	open() {}
	close() {}
}

export function normalizePath(path) {
	return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

export function getAllTags(cache) {
	return null;
}

export function parseFrontMatterEntry(frontmatter, key) {
	return frontmatter?.[key] ?? null;
}

export function stringifyYaml(obj) {
	const lines = [];
	for (const [key, value] of Object.entries(obj)) {
		if (value === undefined || value === null) continue;
		if (Array.isArray(value)) {
			if (value.length === 0) continue;
			lines.push(`${key}:`);
			for (const item of value) {
				lines.push(`  - ${JSON.stringify(item)}`);
			}
		} else if (typeof value === 'object') {
			lines.push(`${key}:`);
			for (const [k, v] of Object.entries(value)) {
				if (v !== undefined && v !== null) {
					lines.push(`  ${k}: ${JSON.stringify(v)}`);
				}
			}
		} else {
			lines.push(`${key}: ${JSON.stringify(value)}`);
		}
	}
	return lines.join('\n');
}

export class Editor {
	constructor(content = '') { this.lines = content.split('\n'); }
	getLine(line) { return this.lines[line] || ''; }
	getCursor() { return { line: 0, ch: 0 }; }
	replaceRange(text, from, to) {}
	getSelection() { return ''; }
}

export class EditorPosition {
	constructor(line, ch) {
		this.line = line;
		this.ch = ch;
	}
}