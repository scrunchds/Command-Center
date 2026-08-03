/**
 * System Prompt Manager — user-managed, vault-native system prompts.
 *
 * Each prompt is stored as a Markdown file under `.command-center/prompts/`
 * with YAML frontmatter containing metadata (id, name, description, variables).
 * Users can create, edit, delete, and assign prompts to projects or chat modes.
 *
 * Variable substitution supports:
 *   {{vault}} — vault name
 *   {{date}} — current date (YYYY-MM-DD)
 *   {{time}} — current time (HH:MM)
 *   {{datetime}} — current date and time
 *   {{user}} — user's name (from memory, if available)
 *   {{style}} — the user's writing style (from memory)
 *   {{memory}} — relevant memory context
 *
 * Vault interaction: reads/writes `.command-center/prompts/*.md` through
 * Obsidian's Vault API. No direct filesystem access.
 */

import { App, TFile, normalizePath } from 'obsidian';


/* ─── Types ─────────────────────────────────────────────── */

export interface SystemPromptMeta {
	/** Unique identifier (derived from the filename). */
	id: string;
	/** Human-readable name. */
	name: string;
	/** Optional description. */
	description: string;
	/** When this prompt was created. */
	createdAt: string;
	/** When this prompt was last modified. */
	updatedAt: string;
	/** Whether this is the default prompt for new conversations. */
	isDefault: boolean;
	/** Optional list of variable names this prompt uses. */
	variables: string[];
	/** Optional category tag for UI grouping. */
	category?: string;
}

export interface SystemPrompt {
	meta: SystemPromptMeta;
	/** The raw prompt body (without frontmatter). */
	body: string;
}

export interface PromptVariableResolver {
	/** Resolve a variable name to its value. */
	resolve(name: string): string | undefined;
}

export interface PromptFilter {
	category?: string;
	isDefault?: boolean;
	search?: string;
}

/* ─── Constants ─────────────────────────────────────────── */

const PROMPTS_DIR = '.command-center/prompts';
const PROMPT_EXTENSION = '.md';

import { DEFAULT_PROMPT } from './DefaultPrompt';

/* ─── SystemPromptManager ────────────────────────────────── */

export class SystemPromptManager {
	private readonly app: App;
	private readonly prompts = new Map<string, SystemPrompt>();
	private loaded = false;
	private defaultResolver: PromptVariableResolver;

	constructor(app: App, resolver?: PromptVariableResolver) {
		this.app = app;
		this.defaultResolver = resolver ?? {
			resolve: (name: string) => {
				const now = new Date();
				switch (name) {
					case 'vault': return app.vault.getName();
					case 'date': return now.toISOString().slice(0, 10);
					case 'time': return now.toTimeString().slice(0, 5);
					case 'datetime': return now.toISOString().replace('T', ' ').slice(0, 16);
					default: return undefined;
				}
			},
		};
	}

	/* ─── Lifecycle ────────────────────────────────────── */

	/**
	 * Load all system prompts from the vault.
	 * Creates the default prompt if none exist.
	 */
	async initialize(): Promise<void> {
		if (this.loaded) return;
		await this.ensurePromptsDirectory();
		await this.loadAllPrompts();
		if (this.prompts.size === 0) {
			await this.create(DEFAULT_PROMPT);
		}
		this.loaded = true;
	}

	/**
	 * Get a prompt by ID.
	 */
	get(id: string): SystemPrompt | undefined {
		return this.prompts.get(id);
	}

	/**
	 * Get all prompts, optionally filtered.
	 */
	list(filter?: PromptFilter): SystemPrompt[] {
		let results = Array.from(this.prompts.values());

		if (filter?.category) {
			results = results.filter(p => p.meta.category === filter.category);
		}
		if (filter?.isDefault !== undefined) {
			results = results.filter(p => p.meta.isDefault === filter.isDefault);
		}
		if (filter?.search) {
			const query = filter.search.toLowerCase();
			results = results.filter(p =>
				p.meta.name.toLowerCase().includes(query) ||
				p.meta.description.toLowerCase().includes(query) ||
				p.body.toLowerCase().includes(query),
			);
		}

		return results.sort((a, b) => a.meta.name.localeCompare(b.meta.name));
	}

	/**
	 * Get the default prompt.
	 */
	getDefault(): SystemPrompt {
		return this.prompts.get('default') ?? DEFAULT_PROMPT;
	}

	/**
	 * Create a new system prompt.
	 * Returns the created prompt with its generated id.
	 */
	async create(prompt: Omit<SystemPrompt, 'meta'> & { meta?: Partial<SystemPromptMeta> }): Promise<SystemPrompt> {
		const id = prompt.meta?.id ?? this.generateId(prompt.body ?? '');
		const now = new Date().toISOString();
		const full: SystemPrompt = {
			meta: {
				id,
				name: prompt.meta?.name ?? 'Unnamed Prompt',
				description: prompt.meta?.description ?? '',
				createdAt: now,
				updatedAt: now,
				isDefault: prompt.meta?.isDefault ?? false,
				variables: prompt.meta?.variables ?? this.extractVariables(prompt.body ?? ''),
				category: prompt.meta?.category,
			},
			body: prompt.body ?? '',
		};

		await this.writePromptFile(full);
		this.prompts.set(id, full);

		// If this is set as default, unset any other default
		if (full.meta.isDefault) {
			for (const [existingId, existing] of this.prompts) {
				if (existingId !== id && existing.meta.isDefault) {
					existing.meta.isDefault = false;
					await this.writePromptFile(existing);
				}
			}
		}

		return { ...full };
	}

	/**
	 * Update an existing system prompt.
	 */
	async update(id: string, updates: Partial<Omit<SystemPrompt, 'meta'>> & { meta?: Partial<SystemPromptMeta> }): Promise<SystemPrompt> {
		const existing = this.prompts.get(id);
		if (!existing) throw new Error(`Prompt "${id}" not found.`);

		const updated: SystemPrompt = {
			meta: {
				...existing.meta,
				...updates.meta,
				id, // id cannot change
				updatedAt: new Date().toISOString(),
			},
			body: updates.body ?? existing.body,
		};

		// Re-extract variables if body changed
		if (updates.body) {
			updated.meta.variables = this.extractVariables(updated.body);
		}

		await this.writePromptFile(updated);
		this.prompts.set(id, updated);

		// Handle default promotion
		if (updated.meta.isDefault) {
			for (const [existingId, existing] of this.prompts) {
				if (existingId !== id && existing.meta.isDefault) {
					existing.meta.isDefault = false;
					await this.writePromptFile(existing);
				}
			}
		}

		return { ...updated };
	}

	/**
	 * Delete a system prompt by ID.
	 * Cannot delete the default prompt.
	 */
	async delete(id: string): Promise<boolean> {
		if (id === 'default') throw new Error('Cannot delete the default prompt.');

		const prompt = this.prompts.get(id);
		if (!prompt) return false;

		const filePath = this.promptFilePath(id);
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (file instanceof TFile) {
			await this.app.fileManager.trashFile(file);
		}

		this.prompts.delete(id);
		return true;
	}

	/**
	 * Render a prompt with variable substitution.
	 */
	render(id: string, resolver?: PromptVariableResolver): string {
		const prompt = this.prompts.get(id);
		if (!prompt) throw new Error(`Prompt "${id}" not found.`);

		const activeResolver = resolver ?? this.defaultResolver;
		let rendered = prompt.body;

		// Replace {{variable}} patterns
		rendered = rendered.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
			return activeResolver.resolve(name) ?? match;
		});

		return rendered;
	}

	/**
	 * Render the default prompt.
	 */
	renderDefault(resolver?: PromptVariableResolver): string {
		return this.render('default', resolver);
	}

	/* ─── Private ───────────────────────────────────────── */

	private async ensurePromptsDirectory(): Promise<void> {
		const dir = this.app.vault.getAbstractFileByPath(PROMPTS_DIR);
		if (!dir) {
			await this.app.vault.createFolder(PROMPTS_DIR);
		}
	}

	private async loadAllPrompts(): Promise<void> {
		const dir = this.app.vault.getAbstractFileByPath(PROMPTS_DIR);
		if (!dir) return;

		const files = this.app.vault.getMarkdownFiles().filter(f =>
			f.path.startsWith(PROMPTS_DIR + '/') && f.path.endsWith(PROMPT_EXTENSION),
		);

		for (const file of files) {
			try {
				const prompt = await this.readPromptFile(file);
				if (prompt) {
					this.prompts.set(prompt.meta.id, prompt);
				}
			} catch (error) {
				console.warn(`[CC] Failed to load prompt from ${file.path}:`, error);
			}
		}
	}

	private async readPromptFile(file: TFile): Promise<SystemPrompt | null> {
		const content = await this.app.vault.read(file);
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const body = this.stripFrontmatter(content);

		if (!frontmatter || !frontmatter['id']) return null;

		const toStr = (v: unknown, fallback = ''): string =>
			v == null ? fallback : typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : fallback;

		return {
			meta: {
				id: toStr(frontmatter['id']),
				name: toStr(frontmatter['name'], 'Unnamed'),
				description: toStr(frontmatter['description']),
				createdAt: toStr(frontmatter['created_at'], new Date().toISOString()),
				updatedAt: toStr(frontmatter['updated_at'], new Date().toISOString()),
				isDefault: Boolean(frontmatter['is_default']),
				variables: Array.isArray(frontmatter['variables']) ? (frontmatter['variables'] as string[]) : [],
				category: frontmatter['category'] ? toStr(frontmatter['category']) : undefined,
			},
			body: body.trim(),
		};
	}

	private async writePromptFile(prompt: SystemPrompt): Promise<void> {
		const filePath = this.promptFilePath(prompt.meta.id);
		const frontmatter = {
			id: prompt.meta.id,
			name: prompt.meta.name,
			description: prompt.meta.description,
			created_at: prompt.meta.createdAt,
			updated_at: prompt.meta.updatedAt,
			is_default: prompt.meta.isDefault,
			variables: prompt.meta.variables.length > 0 ? prompt.meta.variables : undefined,
			category: prompt.meta.category,
		};
		const content = [
			'---',
			Object.entries(frontmatter)
				.filter(([, v]) => v !== undefined)
				.map(([k, v]) => `${k.replace(/_/g, '_')}: ${typeof v === 'string' ? `"${v}"` : JSON.stringify(v)}`)
				.join('\n'),
			'---',
			'',
			prompt.body,
		].join('\n');

		const existing = this.app.vault.getAbstractFileByPath(filePath);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(filePath, content);
		}
	}

	private promptFilePath(id: string): string {
		const safeName = id.replace(/[^\w-]/g, '_').toLowerCase();
		return normalizePath(`${PROMPTS_DIR}/${safeName}${PROMPT_EXTENSION}`);
	}

	private stripFrontmatter(content: string): string {
		const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
		return match?.[1]?.trim() ?? content;
	}

	private generateId(body: string): string {
		const firstLine = body.split('\n')[0]?.trim() ?? 'prompt';
		const slug = firstLine.toLowerCase()
			.replace(/[^\w\s-]/g, '')
			.replace(/\s+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40);
		return `${slug || 'prompt'}-${Date.now().toString(36)}`;
	}

	private extractVariables(body: string): string[] {
		const variables = new Set<string>();
		const pattern = /\{\{(\w+)\}\}/g;
		for (const match of body.matchAll(pattern)) {
			variables.add(match[1]!);
		}
		return Array.from(variables).sort();
	}
}

export { PROMPTS_DIR as SYSTEM_PROMPTS_DIR, DEFAULT_PROMPT as DEFAULT_SYSTEM_PROMPT };