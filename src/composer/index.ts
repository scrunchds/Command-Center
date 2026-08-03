/**
 * Composer — barrel export for the inline editing system.
 */

export { COMPOSER_DEFAULTS } from './ComposerTypes';
export type {
	EditOperation,
	EditOperationType,
	DiffLine,
	DiffResult,
	ApprovalRequest,
	ApprovalDecision,
	ComposerPosition,
	ComposerSelection,
	ComposerRequest,
	ComposerResponse,
	FuzzyMatchResult,
} from './ComposerTypes';

export {
	normalizeLineEndings,
	normalizeForFuzzyMatch,
	stripBOM,
	findTextForReplacement,
	applyEditToContent,
	computeDiff,
	applyOperations,
} from './ComposerFuzzyMatch';