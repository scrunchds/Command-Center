/**
 * mindmap-model — pure tree construction for the mind map widget.
 *
 * Kept free of `obsidian` imports so it is unit-testable: the plugin's type
 * package ships no runtime, so anything importing it cannot load under the test
 * harness. Rendering and vault access live in MindMapPanel.
 */

/** A heading as reported by Obsidian's metadata cache. */
export interface HeadingInput {
	/** Heading text, already stripped of leading `#` markers. */
	heading: string;
	/** Heading depth, 1 for `#` through 6 for `######`. */
	level: number;
	/** Zero-based line in the source note, used to jump to the heading. */
	line: number;
}

/** A node in the rendered mind map. */
export interface MindMapNode {
	text: string;
	level: number;
	line: number;
	children: MindMapNode[];
}

/** Trim, collapse whitespace, and drop Markdown that would render as noise. */
function cleanHeading(text: string): string {
	return text
		// Links become their display text: [[a|b]] -> b, [a](url) -> a.
		.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
		.replace(/\[\[([^\]]+)\]\]/g, '$1')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		// Emphasis and code markers carry no meaning in a node label.
		.replace(/[*_`~]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Build a heading tree from a flat, ordered heading list.
 *
 * Real notes skip levels (an `h1` followed by an `h3`) and sometimes start deep.
 * Rather than dropping those headings or inventing placeholder parents, each
 * heading attaches to the nearest preceding heading of a lower level, and
 * otherwise becomes a root. Document order is always preserved.
 */
export function buildMindMap(headings: HeadingInput[]): MindMapNode[] {
	const roots: MindMapNode[] = [];
	// Ancestors of the node being placed, ordered shallowest to deepest.
	const stack: MindMapNode[] = [];

	for (const raw of headings) {
		const text = cleanHeading(raw.heading);
		// An empty heading (`##` alone, or only formatting) has no label to show.
		if (!text) continue;

		const node: MindMapNode = { text, level: raw.level, line: raw.line, children: [] };

		// Discard any ancestor at or below this level; it cannot be the parent.
		for (let top = stack[stack.length - 1]; top && top.level >= node.level; top = stack[stack.length - 1]) {
			stack.pop();
		}

		const parent = stack[stack.length - 1];
		if (parent) parent.children.push(node);
		else roots.push(node);

		stack.push(node);
	}

	return roots;
}

/** Total nodes in a forest, for the "N headings" provenance label. */
export function countNodes(nodes: MindMapNode[]): number {
	let total = 0;
	for (const node of nodes) total += 1 + countNodes(node.children);
	return total;
}

/** Greatest nesting depth in a forest, used to decide default collapsing. */
export function maxDepth(nodes: MindMapNode[]): number {
	let deepest = 0;
	for (const node of nodes) deepest = Math.max(deepest, 1 + maxDepth(node.children));
	return deepest;
}

/**
 * Flatten to indented text, for copying a map out as an outline.
 *
 * Uses tabs so the result pastes into a Markdown list without reformatting.
 */
export function toOutline(nodes: MindMapNode[], depth = 0): string {
	const lines: string[] = [];
	for (const node of nodes) {
		lines.push(`${'\t'.repeat(depth)}- ${node.text}`);
		if (node.children.length > 0) lines.push(toOutline(node.children, depth + 1));
	}
	return lines.join('\n');
}
