/**
 * Vault Search Engine — two-phase metadata-cache-first search with BM25 scoring.
 *
 * Phase 1: filter files using only Obsidian's in-memory metadata cache
 *   (zero file I/O) — tags, headings, frontmatter fields, path patterns.
 * Phase 2: for survivors, read via cachedRead() and score with
 *   BM25 term weighting + field boosts + phrase bonuses.
 *
 * Query syntax:
 *   multi term search          → implicit AND
 *   "exact phrase"             → phrase boost (4× per match)
 *   -excluded                  → drop files containing this
 *   tag:name                   → filter by tag (metadata cache)
 *   path:folder                → filter by path prefix
 *   heading:text               → filter by heading match (metadata cache)
 *   fm:key=value               → frontmatter field equality (metadata cache)
 */

import { App, TFile } from 'obsidian';
import type { CachedMetadata } from 'obsidian';

/* ─── Types ─────────────────────────────────────────────── */

export interface ParsedQuery {
	terms: string[];
	phrase: string | null;
	excludeTerms: string[];
	tag: string | null;
	path: string | null;
	heading: string | null;
	fmKey: string | null;
	fmValue: string | null;
}

export interface ScoredResult {
	path: string;
	score: number;
	excerpt: string;
	headingPath: string;
	matchBreakdown: { term: string; count: number }[];
	mtime: number;
	size: number;
	tags: string[];
}

export interface ScoreBatchDiagnostics {
	candidateDocuments: number;
	prefilterSkipped: number;
	scoredDocuments: number;
}

export interface ScoreBatchOptions {
	/** Enabled by default; exposed so tests can compare against exhaustive scoring. */
	useTokenPrefilter?: boolean;
	diagnostics?: ScoreBatchDiagnostics;
}

/* ─── Query Parser ─────────────────────────────────────── */

export function parseQuery(raw: string): ParsedQuery {
	const q: ParsedQuery = { terms: [], phrase: null, excludeTerms: [], tag: null, path: null, heading: null, fmKey: null, fmValue: null };
	let rest = raw;

	const phraseM = rest.match(/"([^"]+)"/);
	if (phraseM) { q.phrase = phraseM[1]!.toLowerCase(); rest = rest.replace(phraseM[0], ' '); }

	const fmM = rest.match(/\bfm:(\w+)=(\S+)\b/);
	if (fmM) { q.fmKey = fmM[1]!; q.fmValue = String(fmM[2]); rest = rest.replace(fmM[0], ' '); }

	const tagM = rest.match(/\btag:([\w/-]+)\b/i);
	if (tagM) { q.tag = tagM[1]!.toLowerCase(); rest = rest.replace(tagM[0], ' '); }

	const pathM = rest.match(/\bpath:([\w/.\\-]+)\b/i);
	if (pathM) { q.path = pathM[1]!.toLowerCase().slice(0, 200); rest = rest.replace(pathM[0], ' '); }

	const hM = rest.match(/\bheading:(\S[\w\s-]*\S)\b/i);
	if (hM) { q.heading = hM[1]!.toLowerCase(); rest = rest.replace(hM[0], ' '); }

	for (const w of rest.trim().split(/\s+/).filter(Boolean)) {
		if (w.startsWith('-') && w.length > 1) q.excludeTerms.push(w.slice(1).toLowerCase());
		else q.terms.push(w.toLowerCase());
	}
	return q;
}

/* ─── Phase 1: Metadata-only filtering (zero file I/O) ── */

export function phase1Filter(files: TFile[], q: ParsedQuery, app: App): TFile[] {
	const needsMetadata = Boolean(q.tag || q.heading || q.fmKey);
	return files.filter(file => {
		if (q.path && !file.path.toLowerCase().includes(q.path)) return false;
		// Most ReAct searches are text-only; do not traverse metadata for them.
		const cache = needsMetadata ? app.metadataCache.getFileCache(file) : null;

		if (q.tag) {
			const tags = collectTags(cache);
			if (!tags.some(t => t === q.tag || t.startsWith(q.tag! + '/'))) return false;
		}

		if (q.heading) {
			if (!cache?.headings?.some(h => h.heading.toLowerCase().includes(q.heading!))) return false;
		}

		if (q.fmKey && cache?.frontmatter) {
			const val = (cache.frontmatter as Record<string, unknown>)[q.fmKey];
			const valStr = typeof val === 'string' ? val : typeof val === 'number' || typeof val === 'boolean'
				? String(val) : JSON.stringify(val);
		const fmValue = q.fmValue;
			if (val === undefined || (fmValue && valStr.toLowerCase() !== fmValue.toLowerCase())) return false;
		}

		return true;
	});
}

function collectTags(cache: CachedMetadata | null): string[] {
	const tags: string[] = [];
	if (cache?.tags) for (const tc of cache.tags) tags.push(tc.tag.toLowerCase().replace(/^#/, ''));
	const fm = cache?.frontmatter;
	if (fm) {
		const ft: unknown = fm.tags;
		if (typeof ft === 'string') tags.push(ft.toLowerCase());
		else if (Array.isArray(ft)) tags.push(...ft.map(t => String(t).toLowerCase()));
	}
	return tags;
}

/* ─── Phase 2: BM25 Scoring ───────────────────────────── */

const BM25_K1 = 1.5;
const BM25_B = 0.75;

interface IndexedDocument {
	mtime: number;
	size: number;
	content: string;
	contentLower: string;
	/** Unique normalized keys used only as a cheap rejection filter. */
	tokenKeys: Set<string>;
}

/** Lightweight English suffix normalization; BM25 itself retains its existing terms. */
function stemToken(token: string): string {
	if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
	if (token.length > 4 && token.endsWith('ied')) return token.slice(0, -3) + 'y';
	if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
	if (token.length > 4 && token.endsWith('ies')) return token.slice(0, -3) + 'y';
	if (token.length > 4 && token.endsWith('es')) return token.slice(0, -2);
	if (token.length > 3 && token.endsWith('s')) return token.slice(0, -1);
	return token;
}

const stemCache = new Map<string, string>();
function cachedStemToken(token: string): string {
	const cached = stemCache.get(token);
	if (cached !== undefined) return cached;
	const stem = stemToken(token);
	// Bound shared vocabulary memory while reusing common terms across notes.
	if (stemCache.size >= 8192) stemCache.clear();
	stemCache.set(token, stem);
	return stem;
}

function buildTokenKeys(lowerText: string): Set<string> {
	const keys = new Set<string>();
	let start = -1;
	for (let index = 0; index <= lowerText.length; index++) {
		const code = index < lowerText.length ? lowerText.charCodeAt(index) : 0;
		// Fast path for ASCII note/query tokens.
		const isToken = (code >= 48 && code <= 57)
			|| (code >= 97 && code <= 122)
			|| code >= 0x80;
		if (isToken) {
			if (start === -1) start = index;
		} else if (start !== -1) {
			const len = index - start;
			if (len <= 3) {
				keys.add(lowerText.slice(start, index));
			} else {
				keys.add(cachedStemToken(lowerText.slice(start, index)));
			}
			start = -1;
		}
	}
	return keys;
}

/** Per-vault content index. Unchanged notes are not read again on every search cycle. */
const searchIndexes = new WeakMap<App, Map<string, IndexedDocument>>();
const pendingIndexReads = new WeakMap<App, Map<string, Promise<IndexedDocument>>>();

/** Remove leading YAML so metadata cannot distort BM25 scores or leak into excerpts. */
export function stripYamlFrontmatter(content: string): string {
	return content.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '');
}

async function getIndexedDocuments(files: TFile[], app: App): Promise<Map<string, IndexedDocument>> {
	let index = searchIndexes.get(app);
	if (!index) {
		index = new Map();
		searchIndexes.set(app, index);
	}

	let pending = pendingIndexReads.get(app);
	if (!pending) {
		pending = new Map();
		pendingIndexReads.set(app, pending);
	}

	const documents = new Map<string, IndexedDocument>();
	for (const file of files) {
		let document = index.get(file.path);
		if (!document || document.mtime !== file.stat.mtime || document.size !== file.stat.size) {
			const readKey = `${file.path}\0${file.stat.mtime}\0${file.stat.size}`;
			let read = pending.get(readKey);
			if (!read) {
				read = app.vault.cachedRead(file).then(raw => {
					const content = stripYamlFrontmatter(raw);
					const contentLower = content.toLowerCase();
					return {
						mtime: file.stat.mtime,
						size: file.stat.size,
						content,
						contentLower,
						tokenKeys: buildTokenKeys(contentLower),
					};
				});
				pending.set(readKey, read);
				void read.then(
					() => pending?.delete(readKey),
					() => pending?.delete(readKey),
				);
			}
			document = await read;
			index.set(file.path, document);
		}
		documents.set(file.path, document);
	}
	return documents;
}

export async function scoreBatch(
	files: TFile[], q: ParsedQuery, app: App,
	maxResults: number,
	options: ScoreBatchOptions = {},
): Promise<ScoredResult[]> {
	const diagnostics = options.diagnostics;
	if (diagnostics) {
		diagnostics.candidateDocuments = files.length;
		diagnostics.prefilterSkipped = 0;
		diagnostics.scoredDocuments = 0;
	}
	if (files.length === 0) return [];

	const documents = await getIndexedDocuments(files, app);

	const avgLen = [...documents.values()].reduce((sum, doc) => sum + Math.max(1, doc.content.length), 0) / files.length;
	const termDocFreqs = computeTermDocFreqs(files, q, documents);

	const ctx = { docCount: files.length, avgLen, termDocFreqs };
	const queryTokenKeys = buildTokenKeys([...q.terms, q.phrase ?? ''].join(' '));
	const useTokenPrefilter = options.useTokenPrefilter !== false && queryTokenKeys.size > 0;
	const results: ScoredResult[] = [];

	for (const file of files) {
		const document = documents.get(file.path);
		if (!document) continue;
		if (useTokenPrefilter && !setsIntersect(document.tokenKeys, queryTokenKeys)) {
			// Preserve the existing substring semantics for partial-token queries while
			// keeping the common exact/stemmed path to O(query-token-count) Set probes.
			const fname = file.name.toLowerCase();
			const hasSubstringMatch = q.terms.some(term => document.contentLower.includes(term) || fname.includes(term))
				|| Boolean(q.phrase && document.contentLower.includes(q.phrase));
			if (!hasSubstringMatch) {
				if (diagnostics) diagnostics.prefilterSkipped++;
				continue;
			}
		}
		if (diagnostics) diagnostics.scoredDocuments++;
		const result = scoreFile(file, document.content, document.contentLower, q, ctx);
		if (result) results.push(result);
	}

	results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
	const selected = results.slice(0, maxResults);
	// Metadata is only needed for returned results; avoid touching every candidate's cache.
	for (const result of selected) {
		const file = files.find(candidate => candidate.path === result.path);
		if (!file) continue;
		const cache = app.metadataCache.getFileCache(file);
		result.headingPath = buildHeadingPath(cache);
		result.tags = cache?.tags?.map(tc => tc.tag.replace(/^#/, '')) ?? [];
	}
	return selected;
}

function setsIntersect(documentKeys: Set<string>, queryKeys: Set<string>): boolean {
	// Query sets are normally only 1–5 entries. Probe the larger cached document
	// set directly rather than iterating or allocating an intersection set.
	for (const key of queryKeys) if (documentKeys.has(key)) return true;
	return false;
}

function computeTermDocFreqs(
	files: TFile[], q: ParsedQuery,
	documents: Map<string, IndexedDocument>,
): Map<string, number> {
	const df = new Map<string, number>();
	for (const term of q.terms) df.set(term, 0);

	for (const file of files) {
		const contentLower = documents.get(file.path)?.contentLower ?? '';
		const fname = file.name.toLowerCase();
		for (const term of q.terms) {
			if (contentLower.includes(term) || fname.includes(term)) {
				df.set(term, (df.get(term) ?? 0) + 1);
			}
		}
	}
	return df;
}

function scoreFile(
	file: TFile, content: string, contentLower: string, q: ParsedQuery,
	ctx: { docCount: number; avgLen: number; termDocFreqs: Map<string, number> },
): ScoredResult | null {
	const fname = file.name.toLowerCase();
	let score = 0;
	const breakdown: { term: string; count: number }[] = [];

	for (const term of q.terms) {
		let count = 0, pos = 0;
		while ((pos = contentLower.indexOf(term, pos)) !== -1) { count++; pos += term.length; }
		if (count > 0) {
			breakdown.push({ term, count });
			const df = ctx.termDocFreqs.get(term) ?? 1;
			score += bm25(count, content.length, ctx.docCount, df, ctx.avgLen);
		}
		if (fname.includes(term)) score += 1.5;
	}

	if (q.phrase && contentLower.includes(q.phrase)) {
		let c = 0, p = 0;
		while ((p = contentLower.indexOf(q.phrase, p)) !== -1) { c++; p += q.phrase.length; }
		score += c * 4;
		breakdown.push({ term: `"${q.phrase}"`, count: c });
	}

	for (const ext of q.excludeTerms) {
		if (contentLower.includes(ext) || fname.includes(ext)) return null;
	}

	if (score <= 0 && !q.tag && !q.path && !q.heading && !q.fmKey) return null;

	return {
		path: file.path,
		score,
		excerpt: buildExcerpt(content, q, contentLower),
		headingPath: '/',
		matchBreakdown: breakdown,
		mtime: file.stat.mtime,
		size: file.stat.size,
		tags: [],
	};
}

function bm25(tf: number, contentLength: number, docCount: number, docsWithTerm: number, avgLen: number): number {
	const idf = Math.log((docCount - docsWithTerm + 0.5) / (docsWithTerm + 0.5) + 1);
	const num = tf * (BM25_K1 + 1);
	const den = tf + BM25_K1 * (1 - BM25_B + BM25_B * (contentLength / avgLen));
	return idf * (num / den);
}

function buildExcerpt(content: string, q: ParsedQuery, contentLower: string): string {
	const targets = [...q.terms];
	if (q.phrase) targets.push(q.phrase);
	if (targets.length === 0) return content.slice(0, 200) + (content.length > 200 ? '...' : '');

	let bestPos = -1;
	for (const t of targets) {
		const idx = contentLower.indexOf(t);
		if (idx !== -1 && (bestPos === -1 || idx < bestPos)) bestPos = idx;
	}
	if (bestPos === -1) return content.slice(0, 200) + (content.length > 200 ? '...' : '');

	const start = Math.max(0, bestPos - 120);
	const end = Math.min(content.length, bestPos + 200);
	let s = content.slice(start, end);
	if (start > 0) s = '...' + s;
	if (end < content.length) s = s + '...';
	return s;
}

function buildHeadingPath(cache: CachedMetadata | null): string {
	if (!cache?.headings || cache.headings.length === 0) return '/';
	return cache.headings.filter(h => h.level <= 3).map(h => h.heading).join(' / ');
}
