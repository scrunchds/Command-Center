export interface GraphChunkMetadata { documentPath: string; heading: string; level: number; startLine: number; endLine: number; wikilinks: string[]; tags: string[]; aliases: string[]; }
export interface GraphChunk { id: string; content: string; metadata: GraphChunkMetadata; }
export interface ChunkingOptions { maxCharacters?: number; }

const WIKILINK = /\[\[([^\]]+)\]\]/g;
const links = (text: string): string[] => [...new Set([...text.matchAll(WIKILINK)].map(match => (match[1] ?? '').split('|')[0]?.split('#')[0]?.trim()).filter((value): value is string => Boolean(value)))];

/** Header-first Markdown chunker preserving H2/H3 thought blocks and graph edges. */
export class ChunkingEngine {
	private readonly maxCharacters: number;
	constructor(options: ChunkingOptions = {}) { this.maxCharacters = Math.max(500, options.maxCharacters ?? 6_000); }

	chunk(content: string, documentPath: string, frontmatter: { tags?: unknown; aliases?: unknown } = {}): GraphChunk[] {
		const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
		const sections: Array<{ heading: string; level: number; start: number; lines: string[] }> = [];
		let current = { heading: '', level: 0, start: 1, lines: [] as string[] };
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index] ?? '';
			const heading = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
			if (heading) {
				if (current.lines.some(value => value.trim())) sections.push(current);
				current = { heading: heading[2]?.replace(/\s+#+$/, '').trim() ?? '', level: heading[1]?.length ?? 2, start: index + 1, lines: [line] };
			} else current.lines.push(line);
		}
		if (current.lines.some(value => value.trim())) sections.push(current);
		const tags = this.values(frontmatter.tags);
		const aliases = this.values(frontmatter.aliases);
		const chunks: GraphChunk[] = [];
		for (const section of sections) {
			const sectionText = section.lines.join('\n').trim();
			const parts = this.bound(sectionText);
			let cursor = section.start;
			for (const part of parts) {
				const lineCount = part.split(/\r?\n/).length;
				chunks.push({ id: `${documentPath}:${cursor}-${cursor + lineCount - 1}:${chunks.length}`, content: part, metadata: { documentPath, heading: section.heading, level: section.level, startLine: cursor, endLine: cursor + lineCount - 1, wikilinks: links(part), tags: [...tags], aliases: [...aliases] } });
				cursor += lineCount;
			}
		}
		return chunks;
	}

	private bound(text: string): string[] {
		if (text.length <= this.maxCharacters) return [text];
		const paragraphs = text.split(/\n{2,}/); const output: string[] = []; let current = '';
		for (const paragraph of paragraphs) {
			if (current && current.length + paragraph.length + 2 > this.maxCharacters) { output.push(current); current = ''; }
			if (paragraph.length > this.maxCharacters) for (let offset = 0; offset < paragraph.length; offset += this.maxCharacters) output.push(paragraph.slice(offset, offset + this.maxCharacters));
			else current = current ? `${current}\n\n${paragraph}` : paragraph;
		}
		if (current) output.push(current); return output.filter(Boolean);
	}
	private values(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : typeof value === 'string' ? value.split(',').map(item => item.trim()).filter(Boolean) : []; }
}
