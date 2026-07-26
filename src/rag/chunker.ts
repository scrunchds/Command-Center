/** Semantic, line-aware Markdown chunking for vault RAG. */

export interface MarkdownChunkMetadata {
	filePath: string;
	/** Active H1/H2 hierarchy, e.g. "Project > Decisions". */
	heading: string;
	/** One-based, inclusive source lines. */
	startLine: number;
	/** One-based, inclusive source lines. */
	endLine: number;
	/** Normalized link targets referenced by this chunk (aliases are removed). */
	wikilinks?: string[];
}

export interface MarkdownChunk {
	id: string;
	text: string;
	wordCount: number;
	metadata: MarkdownChunkMetadata;
	/** Convenience mirror of metadata.wikilinks. */
	wikilinks: string[];
}

export interface MarkdownChunkerOptions {
	minWords?: number;
	maxWords?: number;
	targetWords?: number;
}

interface SemanticUnit {
	text: string;
	startLine: number;
	endLine: number;
	words: number;
	heading: string;
	isHeading: boolean;
}

const WORD_RE = /[\p{L}\p{N}_'-]+/gu;
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

function wordCount(text: string): number {
	return text.match(WORD_RE)?.length ?? 0;
}

function extractWikilinks(text: string): string[] {
	const links = new Set<string>();
	for (const match of text.matchAll(WIKILINK_RE)) {
		const target = (match[1] ?? '').split('|', 1)[0]?.split('#', 1)[0]?.trim();
		if (target) links.add(target);
	}
	return [...links];
}

/**
 * Chunks Markdown around headings and paragraph boundaries. Paragraphs are the
 * smallest normal unit; only a single paragraph larger than maxWords is split,
 * first at sentence boundaries and finally at words as a safety valve.
 */
export class MarkdownChunker {
	readonly minWords: number;
	readonly maxWords: number;
	readonly targetWords: number;

	constructor(options: MarkdownChunkerOptions = {}) {
		this.minWords = Math.max(1, Math.floor(options.minWords ?? 300));
		this.maxWords = Math.max(this.minWords, Math.floor(options.maxWords ?? 500));
		this.targetWords = Math.min(this.maxWords, Math.max(this.minWords, Math.floor(options.targetWords ?? 400)));
	}

	chunk(content: string, filePath: string): MarkdownChunk[] {
		const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
		const units: SemanticUnit[] = [];
		const headings: string[] = [];
		let paragraph: string[] = [];
		let paragraphStart = 1;
		let inFrontmatter = lines[0]?.trim() === '---';

		const activeHeading = (): string => headings.slice(0, 2).filter(Boolean).join(' > ');
		const flushParagraph = (endLine: number): void => {
			if (!paragraph.length) return;
			const text = paragraph.join('\n').trim();
			if (text) this.addBoundedUnit(units, text, paragraphStart, endLine, activeHeading(), false);
			paragraph = [];
		};

		for (let index = 0; index < lines.length; index++) {
			const text = lines[index] ?? '';
			if (inFrontmatter) {
				if (index > 0 && text.trim() === '---') inFrontmatter = false;
				continue;
			}
			const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(text);
			if (headingMatch) {
				flushParagraph(index);
				const level = headingMatch[1]?.length ?? 1;
				const title = headingMatch[2]?.replace(/\s+#+\s*$/, '').trim() ?? '';
				headings.length = Math.max(0, level - 1);
				headings[level - 1] = title;
				units.push({ text, startLine: index + 1, endLine: index + 1, words: wordCount(text), heading: activeHeading(), isHeading: true });
			} else if (!text.trim()) {
				flushParagraph(index);
			} else {
				if (!paragraph.length) paragraphStart = index + 1;
				paragraph.push(text);
			}
		}
		flushParagraph(lines.length);

		const chunks: MarkdownChunk[] = [];
		let current: SemanticUnit[] = [];
		let currentWords = 0;
		const flush = (): void => {
			if (!current.length) return;
			const text = current.map(unit => unit.text).join('\n\n').trim();
			const startLine = current[0]?.startLine ?? 1;
			const endLine = current[current.length - 1]?.endLine ?? startLine;
			const heading = [...current].reverse().find(unit => unit.heading)?.heading ?? '';
			const wikilinks = extractWikilinks(text);
			const metadata: MarkdownChunkMetadata = { filePath, heading, startLine, endLine };
			// Keep legacy enumerable metadata shape while exposing typed link metadata.
			Object.defineProperty(metadata, 'wikilinks', { value: wikilinks, enumerable: false });
			const baseId = `${filePath}:${startLine}-${endLine}`;
			const id = chunks.some(chunk => chunk.id === baseId) ? `${baseId}:${chunks.length}` : baseId;
			chunks.push({ id, text, wordCount: wordCount(text), metadata, wikilinks });
			current = [];
			currentWords = 0;
		};

		for (const unit of units) {
			if (unit.isHeading && currentWords >= this.minWords) flush();
			if (currentWords >= this.targetWords || (currentWords > 0 && currentWords + unit.words > this.maxWords)) flush();
			current.push(unit);
			currentWords += unit.words;
		}
		flush();
		return chunks;
	}

	private addBoundedUnit(units: SemanticUnit[], text: string, startLine: number, endLine: number, heading: string, isHeading: boolean): void {
		if (wordCount(text) <= this.maxWords) {
			units.push({ text, startLine, endLine, words: wordCount(text), heading, isHeading });
			return;
		}
		const sentences = text.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)?.map(value => value.trim()).filter(Boolean) ?? [text];
		let parts: string[] = [];
		let words = 0;
		const emit = (): void => {
			if (!parts.length) return;
			const value = parts.join(' ').trim();
			units.push({ text: value, startLine, endLine, words: wordCount(value), heading, isHeading });
			parts = []; words = 0;
		};
		for (const sentence of sentences) {
			const sentenceWords = sentence.match(WORD_RE) ?? [];
			if (sentenceWords.length > this.maxWords) {
				emit();
				for (let offset = 0; offset < sentenceWords.length; offset += this.maxWords) {
					const value = sentenceWords.slice(offset, offset + this.maxWords).join(' ');
					units.push({ text: value, startLine, endLine, words: wordCount(value), heading, isHeading });
				}
			} else {
				if (words > 0 && words + sentenceWords.length > this.maxWords) emit();
				parts.push(sentence); words += sentenceWords.length;
			}
		}
		emit();
	}
}

/** Functional API used by lightweight callers. */
export function chunkMarkdown(fileContent: string, filePath: string, options: MarkdownChunkerOptions = {}): MarkdownChunk[] {
	return new MarkdownChunker(options).chunk(fileContent, filePath);
}

export { wordCount as countMarkdownWords, extractWikilinks };
