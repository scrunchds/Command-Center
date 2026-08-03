/**
 * Composer Types — shared types for the inline composer system.
 *
 * The composer provides:
 *   - Diff preview (before/after comparison)
 *   - Fuzzy text matching for surgical edits
 *   - Approval UI for write operations
 *   - Inline editor popup for quick AI transformations
 */

/* ─── Edit Operations ───────────────────────────────────── */

export type EditOperationType = 'insert' | 'update' | 'delete' | 'replace';

export interface EditOperation {
	/** The type of edit to perform. */
	type: EditOperationType;
	/** Target file path (vault-relative). */
	path: string;
	/** Text to find (for update/delete/replace). */
	oldText?: string;
	/** Text to insert or replace with. */
	newText?: string;
	/** Position for insert operations. */
	position?: 'before' | 'after' | 'replace';
	/** Line number for position-based edits. */
	lineNumber?: number;
	/** Line range for multi-line edits. */
	lineStart?: number;
	lineEnd?: number;
}

/* ─── Diff Types ────────────────────────────────────────── */

export interface DiffLine {
	/** Line number in the original content (1-based). */
	originalLine: number | null;
	/** Line number in the modified content (1-based). */
	modifiedLine: number | null;
	/** The line content. */
	content: string;
	/** Whether this line is unchanged. */
	unchanged: boolean;
	/** Whether this line was added. */
	added: boolean;
	/** Whether this line was removed. */
	removed: boolean;
}

export interface DiffResult {
	/** The original file content. */
	original: string;
	/** The modified file content after applying edits. */
	modified: string;
	/** Line-by-line diff. */
	lines: DiffLine[];
	/** Summary statistics. */
	stats: {
		additions: number;
		deletions: number;
		unchanged: number;
	};
}

/* ─── Approval Types ────────────────────────────────────── */

export type ApprovalDecision = 'accepted' | 'rejected' | 'cancelled';

export interface ApprovalRequest {
	/** Unique request ID. */
	id: string;
	/** Target file path. */
	path: string;
	/** The diff between original and proposed content. */
	diff: DiffResult;
	/** Timestamp when the request was created. */
	createdAt: number;
	/** Optional timeout in milliseconds. */
	timeoutMs?: number;
	/** Decision callback. */
	resolve: (decision: ApprovalDecision) => void;
}

/* ─── Inline Composer Types ─────────────────────────────── */

export interface ComposerPosition {
	/** Line number in the editor. */
	line: number;
	/** Column number in the editor. */
	ch: number;
}

export interface ComposerSelection {
	from: ComposerPosition;
	to: ComposerPosition;
	text: string;
}

export interface ComposerRequest {
	/** The prompt/instruction for the AI transformation. */
	prompt: string;
	/** The selected text context (if any). */
	selection?: ComposerSelection;
	/** The full editor content. */
	content: string;
	/** The file path being edited. */
	path: string;
}

export interface ComposerResponse {
	/** The transformed content. */
	content: string;
	/** Description of what was changed. */
	summary: string;
	/** The diff between original and transformed content. */
	diff: DiffResult;
}

/* ─── Fuzzy Matching Types ──────────────────────────────── */

export interface FuzzyMatchResult {
	/** Whether the match was found. */
	found: boolean;
	/** Number of occurrences found. */
	occurrences: number;
	/** The matched text in the content. */
	matchedText: string;
	/** Start index of the match. */
	startIndex: number;
	/** End index of the match. */
	endIndex: number;
	/** Whether fuzzy matching was used. */
	usedFuzzy: boolean;
}

/* ─── Constants ─────────────────────────────────────────── */

export const COMPOSER_DEFAULTS = {
	/** Maximum file size in chars for diff preview. */
	MAX_DIFF_CHARS: 200_000,
	/** Default timeout for approval requests (ms). */
	APPROVAL_TIMEOUT_MS: 120_000,
	/** Maximum number of context lines around a change. */
	CONTEXT_LINES: 3,
	/** Maximum iterations for fuzzy matching attempts. */
	MAX_FUZZY_ITERATIONS: 3,
} as const;