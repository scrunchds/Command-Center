/**
 * task-syntax — pure Markdown task transforms, free of Obsidian imports.
 *
 * Every vault mutation the dashboard performs is ultimately one of these string
 * transforms. Keeping them pure means they are directly unit-testable and that
 * `TaskWriter` contains only I/O and gating, not parsing rules.
 *
 * Syntax is the standard Markdown checkbox with Dataview-style inline fields, so
 * output stays compatible with Dataview, Tasks, Kanban, and Bases.
 */

/** Matches a checkbox prefix, capturing the bracket, state, and trailing text. */
export const CHECKBOX = /^(\s*[-*+]\s*\[)( |x|X)(]\s*)/;

/** Inline and emoji due-date markers this module understands. */
const DUE_INLINE = /\s*\[(?:due|deadline|scheduled)::\s*[^\]]*]/gi;
const DUE_EMOJI = /\s*📅\s*\d{4}-\d{2}-\d{2}/g;

/** A task creation request. */
export interface NewTask {
	text: string;
	/** ISO-8601 date (YYYY-MM-DD) rendered as an inline due field. */
	due?: string | null;
}

/** True when a line is a Markdown checkbox task. */
export function isTaskLine(line: string): boolean {
	return CHECKBOX.test(line);
}

/**
 * Normalize a note path and reject traversal. Mirrors Obsidian's own
 * normalization for the cases that matter here, without importing it.
 */
export function safeTaskPath(raw: string): string {
	const path = raw.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
	if (!path || path === '.' || path === '..' || path.startsWith('../') || path.includes('/../') || path.endsWith('/..')) {
		throw new Error(`Unsafe note path: ${raw}`);
	}
	return path.endsWith('.md') ? path : `${path}.md`;
}

/** Render one task line. Throws when the text is empty. */
export function renderTaskLine(task: NewTask): string {
	const text = task.text.trim().replace(/\r?\n+/g, ' ');
	if (!text) throw new Error('A task needs text.');
	const due = task.due ? ` [due:: ${task.due}]` : '';
	return `- [ ] ${text}${due}`;
}

/** Split content while remembering whether it used CRLF. */
function split(content: string): { lines: string[]; eol: string } {
	return { lines: content.split(/\r?\n/), eol: content.includes('\r\n') ? '\r\n' : '\n' };
}

/** Require that a 1-based line exists and is a task. */
function requireTask(lines: string[], line: number): string {
	const current = lines[line - 1];
	if (current === undefined || !CHECKBOX.test(current)) {
		throw new Error(`Line ${line} is no longer a task. The note may have changed.`);
	}
	return current;
}

/** Flip the checkbox state of a 1-based line. */
export function toggleTaskLine(content: string, line: number, done: boolean): string {
	const { lines, eol } = split(content);
	const current = requireTask(lines, line);
	lines[line - 1] = current.replace(CHECKBOX, (_, open: string, __: string, close: string) => `${open}${done ? 'x' : ' '}${close}`);
	return lines.join(eol);
}

/** Replace task text, preserving the checkbox state and dropping stale due markers. */
export function editTaskLine(content: string, line: number, text: string): string {
	const trimmed = text.trim().replace(/\r?\n+/g, ' ');
	if (!trimmed) throw new Error('A task needs text.');
	const { lines, eol } = split(content);
	const current = requireTask(lines, line);
	const match = CHECKBOX.exec(current);
	if (!match) throw new Error(`Line ${line} is no longer a task. The note may have changed.`);
	lines[line - 1] = `${match[1]}${match[2]}${match[3]}${trimmed}`;
	return lines.join(eol);
}

/** Remove a task line entirely. */
export function deleteTaskLine(content: string, line: number, expected?: string): string {
	const { lines, eol } = split(content);
	const current = requireTask(lines, line);
	if (expected !== undefined && current !== expected) {
		throw new Error('The note changed before the deletion was approved. Nothing was removed.');
	}
	lines.splice(line - 1, 1);
	return lines.join(eol);
}

/** Set or clear a task's due date without duplicating existing markers. */
export function rescheduleTaskLine(content: string, line: number, due: string | null): string {
	const { lines, eol } = split(content);
	const current = requireTask(lines, line);
	const stripped = current.replace(DUE_INLINE, '').replace(DUE_EMOJI, '').trimEnd();
	lines[line - 1] = due ? `${stripped} [due:: ${due}]` : stripped;
	return lines.join(eol);
}

/**
 * Insert a task line under a heading when supplied, otherwise at end of file.
 * When the heading is absent it is created at the end rather than guessing.
 */
export function insertTaskLine(content: string, line: string, heading?: string): string {
	const { lines, eol } = split(content);
	if (heading) {
		const target = heading.trim().toLowerCase();
		const start = lines.findIndex(row => /^#{1,6}\s+/.test(row) && row.replace(/^#{1,6}\s+/, '').trim().toLowerCase() === target);
		if (start !== -1) {
			// Append after the section's last non-empty line, before the next heading.
			let cursor = start + 1;
			let lastContent = start;
			while (cursor < lines.length && !/^#{1,6}\s+/.test(lines[cursor] ?? '')) {
				if ((lines[cursor] ?? '').trim()) lastContent = cursor;
				cursor++;
			}
			lines.splice(lastContent + 1, 0, line);
			return lines.join(eol);
		}
		const body = content === '' || content.endsWith('\n') ? content : `${content}\n`;
		return `${body}\n## ${heading}\n\n${line}\n`;
	}
	const body = content === '' || content.endsWith('\n') ? content : `${content}\n`;
	return `${body}${line}\n`;
}
