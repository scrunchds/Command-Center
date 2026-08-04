/**
 * Composer Fuzzy Matching — surgical text replacement with multi-stage
 * fuzzy matching, line-ending normalization, and BOM handling.
 *
 * Three-stage matching strategy:
 *   1. Exact match (after line-ending normalization)
 *   2. Fuzzy match (NFKC normalization, smart quotes, dashes, spaces)
 *   3. Trimmed match (retry after stripping trailing newline)
 *
 * Vault interaction: pure string manipulation — no vault I/O.
 */

import type { DiffLine, DiffResult, EditOperation } from './ComposerTypes';

/* ─── Normalization ─────────────────────────────────────── */

/**
 * Normalize line endings to LF (\n) for consistent string matching.
 */
export function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Normalize text for fuzzy matching.
 * Strips trailing whitespace, smart quotes, special dashes, NBSP.
 */
export function normalizeForFuzzyMatch(text: string): string {
	return text
		.normalize('NFKC')
		.split('\n')
		.map(line => line.trimEnd())
		.join('\n')
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/[\u201C\u201D]/g, '"')
		.replace(/[\u2010-\u2015\u2212]/g, '-')
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}

/**
 * Strip UTF-8 BOM from content start.
 */
export function stripBOM(content: string): { content: string; hasBOM: boolean } {
	if (content.length > 0 && content.charCodeAt(0) === 0xFEFF) {
		return { content: content.slice(1), hasBOM: true };
	}
	return { content, hasBOM: false };
}

/* ─── Occurrence Counting ───────────────────────────────── */

function countOccurrences(content: string, searchText: string): number {
	if (!searchText) return 0;
	let count = 0;
	let pos = 0;
	while ((pos = content.indexOf(searchText, pos)) !== -1) {
		count++;
		pos += 1;
	}
	return count;
}

/* ─── Three-Stage Matching ──────────────────────────────── */

/**
 * Find text in content using a three-stage strategy.
 * All inputs must have LF line endings.
 */
export function findTextForReplacement(
	normalizedContent: string,
	normalizedOldText: string,
	normalizedNewText: string,
): { found: boolean; occurrences: number; workingContent: string; workingSearch: string; workingReplace: string; usedFuzzy: boolean } {
	// Stage 1: exact match
	const exactCount = countOccurrences(normalizedContent, normalizedOldText);
	if (exactCount > 0) {
		return { found: true, occurrences: exactCount, workingContent: normalizedContent, workingSearch: normalizedOldText, workingReplace: normalizedNewText, usedFuzzy: false };
	}

	// Compute fuzzy forms
	const fuzzyContent = normalizeForFuzzyMatch(normalizedContent);
	const fuzzySearch = normalizeForFuzzyMatch(normalizedOldText);

	// Stage 2: fuzzy match
	const fuzzyCount = countOccurrences(fuzzyContent, fuzzySearch);
	if (fuzzyCount > 0) {
		return { found: true, occurrences: fuzzyCount, workingContent: fuzzyContent, workingSearch: fuzzySearch, workingReplace: normalizedNewText, usedFuzzy: true };
	}

	// Stage 3: retry after stripping trailing newline
	if (normalizedOldText.endsWith('\n')) {
		const trimmedOldText = normalizedOldText.slice(0, -1);
		const trimmedNewText = normalizedNewText.endsWith('\n') ? normalizedNewText.slice(0, -1) : normalizedNewText;

		const trimmedExactCount = countOccurrences(normalizedContent, trimmedOldText);
		if (trimmedExactCount > 0) {
			return { found: true, occurrences: trimmedExactCount, workingContent: normalizedContent, workingSearch: trimmedOldText, workingReplace: trimmedNewText, usedFuzzy: false };
		}

		const fuzzyTrimmedSearch = normalizeForFuzzyMatch(trimmedOldText);
		const fuzzyTrimmedCount = countOccurrences(fuzzyContent, fuzzyTrimmedSearch);
		if (fuzzyTrimmedCount > 0) {
			return { found: true, occurrences: fuzzyTrimmedCount, workingContent: fuzzyContent, workingSearch: fuzzyTrimmedSearch, workingReplace: trimmedNewText, usedFuzzy: true };
		}
	}

	return { found: false, occurrences: 0, workingContent: fuzzyContent, workingSearch: fuzzySearch, workingReplace: normalizedNewText, usedFuzzy: true };
}

/* ─── Apply Edit ────────────────────────────────────────── */

/**
 * Apply a surgical edit to content with fuzzy matching.
 * Returns the modified content or an error reason.
 */
export function applyEditToContent(
	content: string,
	oldText: string,
	newText: string,
): { ok: true; content: string } | { ok: false; reason: 'NOT_FOUND' | 'AMBIGUOUS'; occurrences?: number } {
	const { content: contentNoBOM, hasBOM } = stripBOM(content);

	const crlfCount = (contentNoBOM.match(/\r\n/g) || []).length;
	const lfCount = (contentNoBOM.match(/(?<!\r)\n/g) || []).length;
	const usesCrlf = crlfCount > lfCount;

	const normalizedContent = normalizeLineEndings(contentNoBOM);
	const normalizedOldText = normalizeLineEndings(oldText);
	const normalizedNewText = normalizeLineEndings(newText);

	const searchResult = findTextForReplacement(normalizedContent, normalizedOldText, normalizedNewText);

	if (!searchResult.found) {
		return { ok: false, reason: 'NOT_FOUND' };
	}
	if (searchResult.occurrences > 1) {
		return { ok: false, reason: 'AMBIGUOUS', occurrences: searchResult.occurrences };
	}

	const matchStart = searchResult.workingContent.indexOf(searchResult.workingSearch);
	const matchEnd = matchStart + searchResult.workingSearch.length;

	let modifiedContent = searchResult.workingContent.substring(0, matchStart) + searchResult.workingReplace + searchResult.workingContent.substring(matchEnd);

	if (usesCrlf) {
		modifiedContent = modifiedContent.replace(/\n/g, '\r\n');
	}
	if (hasBOM) {
		modifiedContent = '\uFEFF' + modifiedContent;
	}

	return { ok: true, content: modifiedContent };
}

/* ─── Diff Builder ──────────────────────────────────────── */

/**
 * Compute a line-level diff between two strings.
 */
export function computeDiff(original: string, modified: string): DiffResult {
	const origLines = original.split('\n');
	const modLines = modified.split('\n');

	const lcs = buildLCSTable(origLines, modLines);

	let i = origLines.length;
	let j = modLines.length;
	const diffLines: DiffLine[] = [];

	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && origLines[i - 1] === modLines[j - 1]) {
			diffLines.unshift({
				originalLine: i,
				modifiedLine: j,
				content: origLines[i - 1]!,
				unchanged: true,
				added: false,
				removed: false,
			});
			i--;
			j--;
		} else if (j > 0 && (i === 0 || lcs[i]![j - 1]! >= lcs[i - 1]![j]!)) {
			diffLines.unshift({
				originalLine: null,
				modifiedLine: j,
				content: modLines[j - 1]!,
				unchanged: false,
				added: true,
				removed: false,
			});
			j--;
		} else if (i > 0) {
			diffLines.unshift({
				originalLine: i,
				modifiedLine: null,
				content: origLines[i - 1]!,
				unchanged: false,
				added: false,
				removed: true,
			});
			i--;
		}
	}

	const stats = {
		additions: diffLines.filter(l => l.added).length,
		deletions: diffLines.filter(l => l.removed).length,
		unchanged: diffLines.filter(l => l.unchanged).length,
	};

	return { original, modified, lines: diffLines, stats };
}

function buildLCSTable(a: string[], b: string[]): number[][] {
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0));
	for (let i = 1; i <= m; i++) {
		const aLine = a[i - 1]!;
		for (let j = 1; j <= n; j++) {
			if (aLine === b[j - 1]) {
				dp[i]![j] = dp[i - 1]![j - 1]! + 1;
			} else {
				dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
			}
		}
	}
	return dp;
}

/* ─── Apply Edit Operations ─────────────────────────────── */

/**
 * Apply a sequence of edit operations to a file's content.
 * Operations are applied in order; each operation updates the running content.
 */
export function applyOperations(content: string, operations: EditOperation[]): string {
	let current = content;
	for (const op of operations) {
		const oldText = op.oldText ?? '';
		const newText = op.newText ?? '';
		const lineNumber = op.lineNumber ?? 0;
		const lineStart = op.lineStart ?? 0;
		const lineEnd = op.lineEnd ?? 0;

		switch (op.type) {
			case 'insert': {
				if (op.position === 'before' && lineNumber > 0) {
					const lines = current.split('\n');
					const idx = Math.min(lineNumber, lines.length);
					lines.splice(idx, 0, newText);
					current = lines.join('\n');
				} else if (op.position === 'after' && lineNumber > 0) {
					const lines = current.split('\n');
					const idx = Math.min(lineNumber + 1, lines.length);
					lines.splice(idx, 0, newText);
					current = lines.join('\n');
				} else {
					current += '\n' + newText;
				}
				break;
			}
			case 'update':
			case 'replace': {
				const result = applyEditToContent(current, oldText, newText);
				if (result.ok) {
					current = result.content;
				}
				break;
			}
			case 'delete': {
				if (oldText) {
					const result = applyEditToContent(current, oldText, '');
					if (result.ok) {
						current = result.content;
					}
				} else if (lineStart > 0 && lineEnd > 0) {
					const lines = current.split('\n');
					lines.splice(lineStart - 1, lineEnd - lineStart + 1);
					current = lines.join('\n');
				}
				break;
			}
		}
	}
	return current;
}