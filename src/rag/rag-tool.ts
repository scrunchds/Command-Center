/** Agent-facing bridge and bounded prompt-context helpers for hybrid vault RAG. */

import type { ToolDefinition } from '../types';
import type { HybridMatch, HybridRetriever } from './hybrid-retriever';

const DEFAULT_RESULT_LIMIT = 3;
const DEFAULT_MAX_RESULTS = 20;
const DEFAULT_CONTEXT_BUDGET = 3_000;
const MAX_QUERY_CHARS = 2_000;

/** Structural subset used by the tool, which also keeps isolated tests lightweight. */
type SearchRetriever = Pick<HybridRetriever, 'search'> & Partial<Pick<HybridRetriever, 'formatContext'>>;

export interface VaultSearchToolOptions {
	/** Allows the host to disable vault reads without exposing filesystem access. */
	canReadVault?: () => boolean;
	maxResults?: number;
	logger?: Pick<Console, 'warn'>;
}

export interface InjectRagContextOptions {
	/** Existing memory or host context to place before retrieved vault context. */
	existingContext?: string;
	folderScope?: string | string[];
	limit?: number;
	/** Hard budget for the complete `<context>` block, including its tags. */
	charBudget?: number;
	logger?: Pick<Console, 'warn'>;
}

export interface VaultSearchResultDetails extends Record<string, unknown> {
	query: string;
	folderScope: string[];
	matchCount: number;
	error: boolean;
}

export class VaultSearchTool {
	private readonly retriever: SearchRetriever;
	private readonly options: VaultSearchToolOptions;

	constructor(retriever: SearchRetriever, options: VaultSearchToolOptions = {}) {
		this.retriever = retriever;
		this.options = options;
	}

	toToolDefinition(): ToolDefinition {
		return {
			name: 'searchVault',
			label: 'Search Vault (Hybrid RAG)',
			description: 'Search readable vault notes using hybrid BM25 and semantic retrieval. Returns source paths, line ranges, headings, and cited Markdown chunks.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Natural-language vault search query.' },
					folderScope: {
						type: ['string', 'array'],
						description: 'Optional vault folder path or array of folder paths used to constrain retrieval.',
						items: { type: 'string' },
					},
					limit: { type: 'integer', description: 'Maximum matching chunks to return.', default: DEFAULT_RESULT_LIMIT },
				},
				required: ['query'],
			},
			execute: async (_toolCallId, params) => this.execute(params),
		};
	}

	private async execute(params: Record<string, unknown>) {
		const query = typeof params.query === 'string' ? params.query.trim() : '';
		const folders = normalizeFolderScope(params.folderScope);
		if (this.options.canReadVault && !this.options.canReadVault()) {
			return this.result('Vault read permission is not available.', query, folders, 0, true);
		}
		if (!query) return this.result('Search query must be a non-empty string.', query, folders, 0, true);
		if (query.length > MAX_QUERY_CHARS) {
			return this.result(`Search query is too long (maximum ${MAX_QUERY_CHARS} characters).`, query.slice(0, MAX_QUERY_CHARS), folders, 0, true);
		}

		const ceiling = Math.max(1, Math.floor(this.options.maxResults ?? DEFAULT_MAX_RESULTS));
		const requested = typeof params.limit === 'number' && Number.isFinite(params.limit)
			? Math.floor(params.limit)
			: DEFAULT_RESULT_LIMIT;
		const limit = Math.max(1, Math.min(ceiling, requested));
		try {
			const matches = folders.length
				? await this.retriever.search(query, { limit, folders })
				: await this.retriever.search(query, limit);
			if (!matches.length) {
				return this.result(`No relevant vault content found matching query '${query}'. Try rephrasing the query or broadening the folder scope.`, query, folders, 0, false);
			}
			return this.result(matches.map(formatCitedMatch).join('\n\n'), query, folders, matches.length, false);
		} catch (error) {
			this.options.logger?.warn('[CC] searchVault retrieval failed:', error);
			if (!this.options.logger) console.warn('[CC] searchVault retrieval failed:', error);
			const message = cleanError(error);
			return this.result(`Vault retrieval failed: ${message}. Try rephrasing the query or changing the folder scope.`, query, folders, 0, true);
		}
	}

	private result(text: string, query: string, folderScope: string[], matchCount: number, error: boolean) {
		const details: VaultSearchResultDetails = { query, folderScope, matchCount, error };
		return { content: [{ type: 'text', text }], details };
	}
}

/** Render one match in the stable citation format consumed by agents and exports. */
export function formatCitedMatch(match: HybridMatch): string {
	const meta = match.chunk.metadata;
	const heading = meta.heading.trim() || '(No heading)';
	return `### Source: [[${meta.filePath}]] (Lines ${meta.startLine}–${meta.endLine})\n` +
		`> **Context:** ${heading}\n\n${match.chunk.text}`;
}

/**
 * Build passive memory + vault context without allowing the complete XML block to
 * exceed its character budget. Retrieval failure is non-fatal and preserves any
 * supplied memory context.
 */
export async function injectRagContext(
	retriever: SearchRetriever | null | undefined,
	query: string,
	options: InjectRagContextOptions = {},
): Promise<string> {
	const budget = Math.max(0, Math.floor(options.charBudget ?? DEFAULT_CONTEXT_BUDGET));
	const open = '<context>\n';
	const close = '\n</context>';
	if (budget < open.length + close.length) return '';
	const contentBudget = budget - open.length - close.length;
	const parts: string[] = [];
	const existing = options.existingContext?.trim();
	if (existing) parts.push(existing);

	const normalizedQuery = query.trim();
	if (retriever && normalizedQuery) {
		try {
			const folders = normalizeFolderScope(options.folderScope);
			const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_RESULT_LIMIT));
			const matches = folders.length
				? await retriever.search(normalizedQuery, { limit, folders })
				: await retriever.search(normalizedQuery, limit);
			if (matches.length) {
				const used = parts.join('\n\n').length;
				const heading = '## Relevant Vault Context\n';
				const available = Math.max(0, contentBudget - used - (parts.length ? 2 : 0) - heading.length);
				const formatted = retriever.formatContext
					? retriever.formatContext(matches, available)
					: matches.map(formatCitedMatch).join('\n\n').slice(0, available);
				if (formatted) parts.push(`${heading}${formatted}`);
			}
		} catch (error) {
			(options.logger ?? console).warn('[CC] Passive RAG retrieval failed:', error);
		}
	}

	const content = truncateCleanly(parts.join('\n\n'), contentBudget);
	return content ? `${open}${content}${close}` : '';
}

export function createVaultSearchTool(retriever: SearchRetriever, options?: VaultSearchToolOptions): ToolDefinition {
	return new VaultSearchTool(retriever, options).toToolDefinition();
}

function normalizeFolderScope(value: unknown): string[] {
	const raw = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
	return [...new Set(raw.filter((item): item is string => typeof item === 'string')
		.map(item => item.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
		.filter(item => item.length > 0 && !item.split('/').includes('..')))];
}

function truncateCleanly(value: string, budget: number): string {
	if (value.length <= budget) return value;
	if (budget <= 1) return value.slice(0, budget);
	const slice = value.slice(0, budget - 1);
	const boundary = slice.lastIndexOf('\n');
	return `${(boundary > budget * 0.6 ? slice.slice(0, boundary) : slice).trimEnd()}…`.slice(0, budget);
}

function cleanError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/[\r\n]+/g, ' ').slice(0, 240) || 'unknown retrieval error';
}
