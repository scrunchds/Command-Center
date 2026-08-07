/**
 * Obsidian Tools — 5 tool definitions for pi agent function calling.
 *
 * Every tool enforces:
 *   - Path sanitization (no traversal, vault-boundary, length-cap)
 *   - Content size limits (read + write)
 *   - Numeric clamping (maxResults, recursion depth)
 *   - Query sanitization (no ReDoS, length-cap)
 *   - Error sanitization (strip fs paths, truncate)
 */

import { App, TFile, TFolder, normalizePath } from 'obsidian';
import type { ToolDefinition } from './types';
import { parseQuery, phase1Filter, scoreBatch } from './obsidian-search';
import { getSharedFileLockManager } from './file-lock';
export { FileBusyError } from './file-lock';

export type ObsidianToolName = 'read_note' | 'write_note' | 'append_note' | 'search_vault' | 'list_files' | 'get_active_note';

const DEFAULT_CONFIRMATION_TIMEOUT_MS = 60_000;
const BULK_EDIT_PATH_THRESHOLD = 2;
const BULK_EDIT_CHAR_THRESHOLD = 8_000;

export function getVaultFileLockManager(app: App) { return getSharedFileLockManager(app); }

/* ═══════════════════════════════════════════════════════════
   Sanitization Constants & Utilities
   ═══════════════════════════════════════════════════════════ */

const SANITIZE = {
	MAX_PATH_LENGTH: 512,
	MAX_READ_CHARS: 100_000,
	MAX_WRITE_CHARS: 200_000,
	MAX_QUERY_LENGTH: 1_000,
	MAX_SEARCH_RESULTS: 50,
	MAX_LIST_DEPTH: 8,
	MAX_LIST_ENTRIES: 500,
	// eslint-disable-next-line no-control-regex -- null/control chars in regex used for input sanitization.
	FORBIDDEN_PATH_CHARS: /[\u0000-\u001f<>:"|?*\u007f]/,
	MAX_ERROR_LENGTH: 256,
} as const;

/** Returns `[ok, path]` — rejects traversal, absolute paths, null bytes, overlength. */
function sanitizePath(raw: unknown): [true, string] | [false, string] {
	if (typeof raw !== 'string' || raw.length === 0) return [false, 'Path must be a non-empty string.'];
	if (raw.length > SANITIZE.MAX_PATH_LENGTH) return [false, `Path too long (max ${SANITIZE.MAX_PATH_LENGTH} chars).`];
	if (SANITIZE.FORBIDDEN_PATH_CHARS.test(raw)) return [false, 'Path contains forbidden characters.'];
	if (raw.includes('..')) return [false, 'Path traversal (..) not allowed.'];
	if (/^[a-zA-Z]:[\\/]/.test(raw)) return [false, 'Absolute Windows paths not allowed.'];
	const cleaned = normalizePath(raw.trim());
	if (!cleaned || cleaned === '.') return [false, 'Path is empty after normalization.'];
	return [true, cleaned];
}

function sanitizeQuery(raw: unknown): [true, string] | [false, string] {
	if (typeof raw !== 'string' || raw.length === 0) return [false, 'Query must be a non-empty string.'];
	if (raw.length > SANITIZE.MAX_QUERY_LENGTH) return [false, `Query too long (max ${SANITIZE.MAX_QUERY_LENGTH} chars).`];
	// eslint-disable-next-line no-control-regex -- null/control chars in regex used for input sanitization.
	const cleaned = raw.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
	return [true, cleaned];
}

function clampNum(raw: unknown, min: number, max: number, fallback: number): number {
	if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(raw)));
}

/** Strip filesystem paths from error messages, then truncate. */
function sanitizeError(err: unknown): string {
	let msg = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error';
	msg = msg.replace(/(?:[A-Za-z]:[\\/]|\/[^\s:]*\/)[^\s:]*/g, '[path]').replace(/\\/g, '/');
	return msg.length > SANITIZE.MAX_ERROR_LENGTH ? msg.slice(0, SANITIZE.MAX_ERROR_LENGTH) + '…' : msg;
}

function safeContent(content: string, maxChars: number): string {
	if (content.length <= maxChars) return content;
	return content.slice(0, maxChars) + `\n\n[content truncated at ${maxChars.toLocaleString()} characters]`;
}

/* ═══════════════════════════════════════════════════════════
   Tool Definitions
   ═══════════════════════════════════════════════════════════ */

export function createObsidianTools(app: App): ToolDefinition[] {
	return [readNote(app), writeNote(app), appendNote(app), searchVault(app), listFiles(app), getActiveNote(app)];
}

/* ─── read_note ──────────────────────────────────────────── */

function readNote(app: App): ToolDefinition {
	return {
		name: 'read_note', label: 'Read Note',
		description: 'Read a vault note by path. Returns frontmatter and body. Use this to verify any claim about a note’s contents, tags, or frontmatter before stating it — the vault is the source of truth.',
		parameters: { type: 'object', properties: {
			path: { type: 'string', description: 'Note path (e.g., "folder/note.md")' },
			includeFrontmatter: { type: 'boolean', description: 'Include YAML frontmatter', default: true },
		}, required: ['path'] },
		execute: async (_id, params: Record<string, unknown>) => {
			try {
				const [ok, path] = sanitizePath(params.path);
				if (!ok) return errRsp(path);

				const file = app.vault.getAbstractFileByPath(path);
				if (!file || !(file instanceof TFile)) return errRsp('Note not found.');

				const raw = await app.vault.read(file);
				const content = safeContent(raw, SANITIZE.MAX_READ_CHARS);
				const fm = app.metadataCache.getFileCache(file)?.frontmatter;
				let out = '';
				if (params.includeFrontmatter !== false && fm) {
					out = '---\n' + Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n') + '---\n\n';
				}
				return okRsp(out + content, { path, size: raw.length });
			} catch (err) { return errRsp(sanitizeError(err)); }
		},
	};
}

/* ─── write_note ─────────────────────────────────────────── */

function writeNote(app: App): ToolDefinition {
	return {
		name: 'write_note', label: 'Write Note',
		description: 'Create or overwrite a vault note.',
		parameters: { type: 'object', properties: {
			path: { type: 'string', description: 'Note path' },
			content: { type: 'string', description: 'Full content to write' },
			append: { type: 'boolean', description: 'Append instead of overwrite', default: false },
		}, required: ['path', 'content'] },
		confirmation: params => writeConfirmation(app, 'write_note', params),
		execute: async (_id, params: Record<string, unknown>) => executeNoteWrite(app, params),
	};
}

/* ─── append_note ─────────────────────────────────────────── */

function appendNote(app: App): ToolDefinition {
	return {
		name: 'append_note', label: 'Append Note',
		description: 'Append content to a vault note without overwriting it.',
		parameters: { type: 'object', properties: {
			path: { type: 'string', description: 'Note path' },
			content: { type: 'string', description: 'Content to append' },
		}, required: ['path', 'content'] },
		confirmation: params => writeConfirmation(app, 'append_note', { ...params, append: true }),
		execute: async (_id, params: Record<string, unknown>) => executeNoteWrite(app, { ...params, append: true }),
	};
}

async function writeConfirmation(app: App, toolName: string, params: Record<string, unknown>) {
	const rawPaths = Array.isArray(params.paths) ? params.paths : [params.path];
	const paths = rawPaths.flatMap(raw => {
		const [ok, path] = sanitizePath(raw);
		return ok ? [path] : [];
	});
	const content = typeof params.content === 'string' ? params.content : '';
	const overwrite = !params.append && paths.some(path => app.vault.getAbstractFileByPath(path) instanceof TFile);
	const bulk = paths.length >= BULK_EDIT_PATH_THRESHOLD || content.length >= BULK_EDIT_CHAR_THRESHOLD;
	if (!overwrite && !bulk) return null;
	const preview = content.length > 4_000 ? `${content.slice(0, 4_000)}\n… [preview truncated]` : content;
	return {
		toolName,
		targetPaths: paths,
		proposedChanges: params.append ? `Append:\n${preview}` : `Replace file contents with:\n${preview}`,
		timeoutMs: DEFAULT_CONFIRMATION_TIMEOUT_MS,
	};
}

async function executeNoteWrite(app: App, params: Record<string, unknown>) {
	try {
		const [ok, path] = sanitizePath(params.path);
		if (!ok) return errRsp(path);
		if (typeof params.content !== 'string') return errRsp('Content must be a string.');
		const content = params.content;
		if (content.length > SANITIZE.MAX_WRITE_CHARS) return errRsp(
			`Content too large (max ${SANITIZE.MAX_WRITE_CHARS.toLocaleString()} chars).`);
		if (content.length === 0 && !params.append) return errRsp('Cannot write empty content.');

		// Queue same-path mutations in arrival order; read+modify+write stays atomic.
		return await getVaultFileLockManager(app).withLock(path, async () => {
			const file = app.vault.getAbstractFileByPath(path);
			if (file && file instanceof TFile) {
				if (params.append) {
					const existing = await app.vault.read(file);
					if (existing.length + content.length > SANITIZE.MAX_WRITE_CHARS) {
						return errRsp('Append would exceed max note size.');
					}
					await app.vault.process(file, current => current + '\n' + content);
				} else {
					await app.vault.modify(file, content);
				}
			} else {
				await app.vault.create(path, content);
			}
			return okRsp(`Successfully ${file && file instanceof TFile ? 'updated' : 'created'} note.`, { path });
		});
	} catch (err) { return errRsp(sanitizeError(err)); }
}

/* ─── search_vault ───────────────────────────────────────── */

function searchVault(app: App): ToolDefinition {
	return {
		name: 'search_vault', label: 'Search Vault',
		description:
			'Search vault notes with multi-term BM25 relevance scoring.\n' +
			'Supports: tag:name path:folder heading:text fm:key=value "exact phrase" -exclude.\n' +
			'Use this to verify whether a tag, frontmatter field, path, or note actually exists before claiming it does — the vault is the source of truth.',
		parameters: { type: 'object', properties: {
			query: { type: 'string', description: 'Search text with optional qualifiers' },
			maxResults: { type: 'number', description: 'Max results (default: 10, max: 50)', default: 10 },
		}, required: ['query'] },
		execute: async (_id, params: Record<string, unknown>) => {
			try {
				const [ok, rawQuery] = sanitizeQuery(params.query);
				if (!ok) return errRsp(rawQuery);

				const maxR = clampNum(params.maxResults, 1, SANITIZE.MAX_SEARCH_RESULTS, 10);
				const parsed = parseQuery(rawQuery);

				// Phase 1: metadata-cache-only filter (zero file I/O)
				const allFiles = app.vault.getMarkdownFiles();
				const candidates = phase1Filter(allFiles, parsed, app);

				// Phase 2: BM25 scoring on survivors via cachedRead()
				const results = await scoreBatch(candidates, parsed, app, maxR);

				if (results.length === 0) {
					return okRsp('No results found.', { query: rawQuery, count: 0 });
				}

				const formatted = results.map((r, i) =>
					`${i + 1}. **${r.path}** (score: ${r.score.toFixed(1)})\n` +
					`   Heading: ${r.headingPath}\n` +
					(r.tags.length ? `   Tags: ${r.tags.join(', ')}\n` : '') +
					`   Matches: ${r.matchBreakdown.map(b => `${b.term}(${b.count})`).join(', ')}\n` +
					`   > ${r.excerpt}`
				).join('\n\n');

				return okRsp(formatted, { query: rawQuery, count: results.length, results });
			} catch (err) { return errRsp(sanitizeError(err)); }
		},
	};
}

/* ─── list_files ─────────────────────────────────────────── */

function listFiles(app: App): ToolDefinition {
	return {
		name: 'list_files', label: 'List Files',
		description: 'List the files and folders in a vault directory. Use path "/" (default) with recursive true to show the user their real, current vault structure. This is the authoritative source of truth for what exists in the vault — never describe folders or files that this tool has not returned.',
		parameters: { type: 'object', properties: {
			path: { type: 'string', description: 'Directory path (default: "/")', default: '/' },
			recursive: { type: 'boolean', description: 'Recursive listing', default: false },
		}, required: [] },
		execute: async (_id, params: Record<string, unknown>) => {
			try {
				const rawPath = typeof params.path === 'string' ? params.path : '/';
				const [ok, path] = sanitizePath(rawPath === '/' ? '' : rawPath);
				if (!ok) return errRsp(path);

				const folder = path ? app.vault.getAbstractFileByPath(path) : app.vault.getRoot();
				if (!folder || !(folder instanceof TFolder)) return errRsp('Folder not found.');

				const entries: string[] = [];
				const walk = (f: TFolder, pre: string, depth: number) => {
					if (depth > SANITIZE.MAX_LIST_DEPTH || entries.length >= SANITIZE.MAX_LIST_ENTRIES) return;
					for (const ch of f.children) {
						if (entries.length >= SANITIZE.MAX_LIST_ENTRIES) return;
						if (ch instanceof TFolder) { entries.push(`${pre}📁 ${ch.name}/`); if (params.recursive) walk(ch, pre + '  ', depth + 1); }
						else if (ch instanceof TFile) entries.push(`${pre}📄 ${ch.name}`);
					}
				};
				walk(folder, '', 0);

				let out = entries.join('\n');
				if (entries.length >= SANITIZE.MAX_LIST_ENTRIES) out += '\n\n[listing truncated]';
				return okRsp(out || '(empty folder)', { path: path || '/', count: entries.length });
			} catch (err) { return errRsp(sanitizeError(err)); }
		},
	};
}

/* ─── get_active_note ────────────────────────────────────── */

/**
 * Create a web search tool definition for OpenRouter's server-side web search.
 *
 * When included in a request and routed through OpenRouter, the model can
 * invoke web_search_call to perform a live web search. OpenRouter handles
 * the search server-side and returns results with citations.
 */
export function createWebSearchTool(maxResults = 5): ToolDefinition {
	return {
		name: 'web_search',
		label: 'Web Search',
		description: 'Search the web for current information. Results include citations and source URLs.',
		parameters: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'The search query to look up on the web' },
				max_results: { type: 'number', description: 'Maximum number of search results (1-10)', default: maxResults },
			},
			required: ['query'],
		},
		execute: async (toolCallId: string, params: Record<string, unknown>) => {
			return {
				content: [{ type: 'text', text: 'Web search completed via OpenRouter server-side handling.' }],
				details: { toolCallId, params, provider: 'openrouter' },
			};
		},
	};
}

function getActiveNote(app: App): ToolDefinition {
	return {
		name: 'get_active_note', label: 'Get Active Note',
		description: 'Get path and content of the currently open note.',
		parameters: { type: 'object', properties: {}, required: [] },
		execute: async () => {
			try {
				const file = app.workspace.getActiveFile();
				if (!file) return okRsp('No active note open.', { isError: false });
				const raw = await app.vault.read(file);
				const content = safeContent(raw, SANITIZE.MAX_READ_CHARS);
				return okRsp(`**Active Note:** ${file.path}\n\n${content}`, { path: file.path, size: raw.length });
			} catch (err) { return errRsp(sanitizeError(err)); }
		},
	};
}

/* ─── Helpers ────────────────────────────────────────────── */

function okRsp(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: 'text' as const, text }], details };
}

function errRsp(text: string) {
	return { content: [{ type: 'text' as const, text }], details: { isError: true } };
}
