/**
 * card-syntax — pure parsing for custom dashboard cards, free of Obsidian imports.
 *
 * Keeping these transforms dependency-free makes them directly unit-testable and
 * leaves `CustomCards.ts` responsible only for discovery, rendering, and gating.
 */

import { isTaskLine } from '../intelligence/task-syntax';

/** Frontmatter flag that turns an ordinary note into a dashboard card. */
export const CUSTOM_CARD_FLAG = 'cc-card';

/** Prefix for custom-card widget ids, keeping them distinct from built-ins. */
export const CUSTOM_WIDGET_PREFIX = 'custom:';

/** One parsed segment of a card body. */
export interface CardSegment {
	kind: 'markdown' | 'task';
	/** Markdown text for a prose segment, or the raw line for a task. */
	text: string;
	/** 1-based source line in the backing note; task segments only. */
	line: number;
	done: boolean;
	label: string;
}

/**
 * Strip a leading YAML frontmatter block.
 *
 * Frontmatter is configuration, not card content, so it must never render into
 * the card body. A mid-note horizontal rule is deliberately left alone.
 */
export function stripFrontmatter(content: string): string {
	if (!content.startsWith('---')) return content;
	const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
	return match ? content.slice(match[0].length) : content;
}

/**
 * Split a card body into interactive task rows and prose runs.
 *
 * Task lines are extracted individually so each row carries its true 1-based
 * source line. That exactness is what lets a checkbox click mutate the correct
 * line even when the note changed between renders. Everything else accumulates
 * into Markdown runs for native rendering, which keeps base embeds, Dataview
 * blocks, callouts, and images working.
 *
 * @param content Full note content, including any frontmatter.
 * @returns Ordered segments, with prose runs collapsed and blank runs dropped.
 */
export function parseCardBody(content: string): CardSegment[] {
	const body = stripFrontmatter(content);
	// Line numbers must refer to the real file, so measure the stripped prefix.
	const offset = content.slice(0, content.length - body.length).split(/\r?\n/).length - 1;
	const segments: CardSegment[] = [];
	let buffer: string[] = [];
	let fenced = false;

	const flush = (): void => {
		const joined = buffer.join('\n').trim();
		if (joined) segments.push({ kind: 'markdown', text: joined, line: 0, done: false, label: '' });
		buffer = [];
	};

	const lines = body.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? '';
		// Never treat fenced content as tasks: a code sample is not a checkbox.
		if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
		if (!fenced && isTaskLine(line)) {
			flush();
			const state = /^\s*[-*+]\s*\[([ xX])]/.exec(line);
			segments.push({
				kind: 'task',
				text: line,
				line: offset + index + 1,
				done: (state?.[1] ?? ' ').toLowerCase() === 'x',
				label: line.replace(/^\s*[-*+]\s*\[[ xX]]\s*/, '').trim(),
			});
			continue;
		}
		buffer.push(line);
	}
	flush();
	return segments;
}
