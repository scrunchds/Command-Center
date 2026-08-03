/**
 * Project Manager — isolated AI workspaces within the vault.
 *
 * Each project is a vault-native Markdown file under `.command-center/projects/`
 * with YAML frontmatter containing configuration. Projects provide:
 *   - Isolated chat history
 *   - Per-project model/routing configuration
 *   - File inclusion/exclusion rules
 *   - Custom system prompt assignment
 *   - Web URL and YouTube URL context sources
 *
 * Vault interaction:
 *   - Reads/writes `.command-center/projects/*.md` via Obsidian Vault API
 *   - Reads file listings via MetadataCache (no direct filesystem access)
 *   - Never reads file contents beyond frontmatter unless explicitly loaded
 */

import { App, TFile, normalizePath } from 'obsidian';
import type { ProviderId, TaskType } from '../providers/provider-types';

/* ─── Types ─────────────────────────────────────────────── */

export interface ProjectConfig {
	/** Unique identifier. */
	id: string;
	/** Human-readable name. */
	name: string;
	/** Optional description. */
	description: string;
	/** When this project was created. */
	createdAt: string;
	/** When this project was last modified. */
	updatedAt: string;
	/** Optional system prompt ID to use for this project. */
	systemPromptId?: string;
	/** Provider model overrides for this project. */
	model?: {
		providerId: ProviderId;
		modelId: string;
		temperature?: number;
		maxTokens?: number;
	};
	/** File inclusion patterns (folder paths or tag names). */
	inclusions: string[];
	/** File exclusion patterns. */
	exclusions: string[];
	/** Web URLs to load as context. */
	webUrls: string[];
	/** YouTube video URLs to load transcripts from. */
	youtubeUrls: string[];
	/** Tags that define the project scope. */
	tags: string[];
	/** Whether this project is archived. */
	archived: boolean;
	/** Timestamp of last use (for sorting). */
	lastUsedAt: string | null;
	/** Number of conversations in this project. */
	conversationCount: number;
}

export interface ProjectSummary {
	id: string;
	name: string;
	description: string;
	updatedAt: string;
	archived: boolean;
	conversationCount: number;
}

export interface ProjectFilter {
	archived?: boolean;
	search?: string;
	sortBy?: 'name' | 'updatedAt' | 'lastUsedAt';
	sortOrder?: 'asc' | 'desc';
}

/* ─── Constants ─────────────────────────────────────────── */

const PROJECTS_DIR = '.command-center/projects';
const PROJECT_EXTENSION = '.md';

/* ─── ProjectManager ────────────────────────────────────── */

export class ProjectManager {
	private readonly app: App;
	private readonly projects = new Map<string, ProjectConfig>();
	private loaded = false;

	constructor(app: App) {
		this.app = app;
	}

	/* ─── Lifecycle ────────────────────────────────────── */

	/**
	 * Load all projects from the vault.
	 */
	async initialize(): Promise<void> {
		if (this.loaded) return;
		await this.ensureProjectsDirectory();
		await this.loadAllProjects();
		this.loaded = true;
	}

	/**
	 * Get a project by ID.
	 */
	get(id: string): ProjectConfig | undefined {
		return this.projects.get(id);
	}

	/**
	 * Get all projects, optionally filtered and sorted.
	 */
	list(filter?: ProjectFilter): ProjectConfig[] {
		let results = Array.from(this.projects.values());

		if (filter?.archived !== undefined) {
			results = results.filter(p => p.archived === filter.archived);
		}
		if (filter?.search) {
			const query = filter.search.toLowerCase();
			results = results.filter(p =>
				p.name.toLowerCase().includes(query) ||
				p.description.toLowerCase().includes(query),
			);
		}

		// Sort
		const sortBy = filter?.sortBy ?? 'updatedAt';
		const order = filter?.sortOrder ?? 'desc';
		results.sort((a, b) => {
			let comparison = 0;
			switch (sortBy) {
				case 'name':
					comparison = a.name.localeCompare(b.name);
					break;
				case 'lastUsedAt':
					comparison = (a.lastUsedAt ?? '').localeCompare(b.lastUsedAt ?? '');
					break;
				case 'updatedAt':
				default:
					comparison = a.updatedAt.localeCompare(b.updatedAt);
					break;
			}
			return order === 'desc' ? -comparison : comparison;
		});

		return results;
	}

	/**
	 * Get summaries of all active projects (for UI list).
	 */
	listSummaries(filter?: ProjectFilter): ProjectSummary[] {
		return this.list(filter).map(p => ({
			id: p.id,
			name: p.name,
			description: p.description,
			updatedAt: p.updatedAt,
			archived: p.archived,
			conversationCount: p.conversationCount,
		}));
	}

	/**
	 * Create a new project.
	 */
	async create(config: Omit<ProjectConfig, 'id' | 'createdAt' | 'updatedAt' | 'conversationCount' | 'lastUsedAt'> & { id?: string }): Promise<ProjectConfig> {
		const now = new Date().toISOString();
		const project: ProjectConfig = {
			id: config.id ?? this.generateId(config.name),
			name: config.name,
			description: config.description ?? '',
			createdAt: now,
			updatedAt: now,
			systemPromptId: config.systemPromptId,
			model: config.model,
			inclusions: config.inclusions ?? [],
			exclusions: config.exclusions ?? [],
			webUrls: config.webUrls ?? [],
			youtubeUrls: config.youtubeUrls ?? [],
			tags: config.tags ?? [],
			archived: config.archived ?? false,
			lastUsedAt: null,
			conversationCount: 0,
		};

		await this.writeProjectFile(project);
		this.projects.set(project.id, project);
		return { ...project };
	}

	/**
	 * Update an existing project.
	 */
	async update(id: string, updates: Partial<Omit<ProjectConfig, 'id' | 'createdAt'>>): Promise<ProjectConfig> {
		const existing = this.projects.get(id);
		if (!existing) throw new Error(`Project "${id}" not found.`);

		const updated: ProjectConfig = {
			...existing,
			...updates,
			id, // id cannot change
			updatedAt: new Date().toISOString(),
		};

		await this.writeProjectFile(updated);
		this.projects.set(id, updated);
		return { ...updated };
	}

	/**
	 * Delete a project by ID.
	 */
	async delete(id: string): Promise<boolean> {
		const project = this.projects.get(id);
		if (!project) return false;

		const filePath = this.projectFilePath(project.id);
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (file instanceof TFile) {
			await this.app.fileManager.trashFile(file);
		}

		this.projects.delete(id);
		return true;
	}

	/**
	 * Archive a project (hide from active list but preserve data).
	 */
	async archive(id: string): Promise<ProjectConfig> {
		return this.update(id, { archived: true });
	}

	/**
	 * Unarchive a project.
	 */
	async unarchive(id: string): Promise<ProjectConfig> {
		return this.update(id, { archived: false });
	}

	/**
	 * Mark a project as recently used.
	 */
	async touch(id: string): Promise<void> {
		const project = this.projects.get(id);
		if (!project) return;
		project.lastUsedAt = new Date().toISOString();
		project.conversationCount++;
		await this.writeProjectFile(project);
	}

	/**
	 * Check if a file path is included in a project's scope.
	 */
	isInScope(projectId: string, filePath: string): boolean {
		const project = this.projects.get(projectId);
		if (!project) return false;

		// Check exclusions first
		for (const exclusion of project.exclusions) {
			if (filePath.startsWith(exclusion) || filePath.includes(exclusion)) {
				return false;
			}
		}

		// If no inclusions specified, all files are in scope (minus exclusions)
		if (project.inclusions.length === 0) return true;

		// Check inclusions
		for (const inclusion of project.inclusions) {
			if (filePath.startsWith(inclusion) || filePath.includes(inclusion)) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Get the context string for a project (inclusions, URLs, etc.).
	 */
	async getContextString(projectId: string): Promise<string> {
		const project = this.projects.get(projectId);
		if (!project) return '';

		const parts: string[] = [];
		parts.push(`# Project: ${project.name}`);
		if (project.description) parts.push(`\n${project.description}`);
		parts.push('');

		// Collect included files
		if (project.inclusions.length > 0) {
			parts.push('## In Scope');
			for (const inclusion of project.inclusions) {
				parts.push(`- ${inclusion}`);
			}
			parts.push('');
		}

		// Collect web URLs
		if (project.webUrls.length > 0) {
			parts.push('## Web Sources');
			for (const url of project.webUrls) {
				parts.push(`- ${url}`);
			}
			parts.push('');
		}

		// Collect YouTube URLs
		if (project.youtubeUrls.length > 0) {
			parts.push('## Video Sources');
			for (const url of project.youtubeUrls) {
				parts.push(`- ${url}`);
			}
			parts.push('');
		}

		return parts.join('\n');
	}

	/* ─── Private ───────────────────────────────────────── */

	private async ensureProjectsDirectory(): Promise<void> {
		const dir = this.app.vault.getAbstractFileByPath(PROJECTS_DIR);
		if (!dir) {
			await this.app.vault.createFolder(PROJECTS_DIR);
		}
	}

	private async loadAllProjects(): Promise<void> {
		const files = this.app.vault.getMarkdownFiles().filter(f =>
			f.path.startsWith(PROJECTS_DIR + '/') && f.path.endsWith(PROJECT_EXTENSION),
		);

		for (const file of files) {
			try {
				const project = await this.readProjectFile(file);
				if (project) {
					this.projects.set(project.id, project);
				}
			} catch (error) {
				console.warn(`[CC] Failed to load project from ${file.path}:`, error);
			}
		}
	}

	private async readProjectFile(file: TFile): Promise<ProjectConfig | null> {
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!frontmatter || !frontmatter['id']) return null;

		const fm = frontmatter;
		const modelData = fm['model'] as Record<string, unknown> | undefined;

		// Safe string coercion from unknown frontmatter values.
		const toStr = (v: unknown, fallback = ''): string =>
			v == null ? fallback : typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : fallback;

		return {
			id: toStr(fm['id']),
			name: toStr(fm['name'], 'Unnamed'),
			description: toStr(fm['description']),
			createdAt: toStr(fm['created_at'], new Date().toISOString()),
			updatedAt: toStr(fm['updated_at'], new Date().toISOString()),
			systemPromptId: fm['system_prompt_id'] != null ? toStr(fm['system_prompt_id']) : undefined,
			model: modelData ? {
				providerId: (toStr(modelData['providerId']) || 'custom') as ProviderId,
				modelId: toStr(modelData['modelId']),
				temperature: Number(modelData['temperature']) || undefined,
				maxTokens: Number(modelData['maxTokens']) || undefined,
			} : undefined,
			inclusions: Array.isArray(fm['inclusions']) ? (fm['inclusions'] as string[]) : [],
			exclusions: Array.isArray(fm['exclusions']) ? (fm['exclusions'] as string[]) : [],
			webUrls: Array.isArray(fm['web_urls']) ? (fm['web_urls'] as string[]) : [],
			youtubeUrls: Array.isArray(fm['youtube_urls']) ? (fm['youtube_urls'] as string[]) : [],
			tags: Array.isArray(fm['tags']) ? (fm['tags'] as string[]) : [],
			archived: Boolean(fm['archived']),
			lastUsedAt: fm['last_used_at'] != null ? toStr(fm['last_used_at']) : null,
			conversationCount: Number(fm['conversation_count']) || 0,
		};
	}

	private async writeProjectFile(project: ProjectConfig): Promise<void> {
		const filePath = this.projectFilePath(project.id);
		const frontmatter: Record<string, unknown> = {
			id: project.id,
			name: project.name,
			description: project.description,
			created_at: project.createdAt,
			updated_at: project.updatedAt,
			archived: project.archived,
			last_used_at: project.lastUsedAt,
			conversation_count: project.conversationCount,
		};

		if (project.systemPromptId) frontmatter.system_prompt_id = project.systemPromptId;
		if (project.model) frontmatter.model = project.model;
		if (project.inclusions.length > 0) frontmatter.inclusions = project.inclusions;
		if (project.exclusions.length > 0) frontmatter.exclusions = project.exclusions;
		if (project.webUrls.length > 0) frontmatter.web_urls = project.webUrls;
		if (project.youtubeUrls.length > 0) frontmatter.youtube_urls = project.youtubeUrls;
		if (project.tags.length > 0) frontmatter.tags = project.tags;

		// Build the YAML frontmatter manually to avoid obsidian's stringifyYaml quirks
		const yamlLines = ['---'];
		for (const [key, value] of Object.entries(frontmatter)) {
			if (value === undefined || value === null) continue;
			if (Array.isArray(value)) {
				if (value.length === 0) continue;
				yamlLines.push(`${key}:`);
				for (const item of value) {
					yamlLines.push(`  - ${JSON.stringify(item)}`);
				}
			} else if (typeof value === 'object') {
				yamlLines.push(`${key}:`);
				for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
					if (v !== undefined && v !== null) {
						yamlLines.push(`  ${k}: ${JSON.stringify(v)}`);
					}
				}
			} else {
				yamlLines.push(`${key}: ${JSON.stringify(value)}`);
			}
		}
		yamlLines.push('---', '');

		const content = yamlLines.join('\n');

		const existing = this.app.vault.getAbstractFileByPath(filePath);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(filePath, content);
		}
	}

	private projectFilePath(id: string): string {
		const safeName = id.replace(/[^\w-]/g, '_').toLowerCase();
		return normalizePath(`${PROJECTS_DIR}/${safeName}${PROJECT_EXTENSION}`);
	}

	private generateId(name: string): string {
		const slug = name.toLowerCase()
			.replace(/[^\w\s-]/g, '')
			.replace(/\s+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40);
		return `${slug || 'project'}-${Date.now().toString(36)}`;
	}
}

export { PROJECTS_DIR as PROJECTS_DIRECTORY };