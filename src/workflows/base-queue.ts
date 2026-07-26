import type { App, TFile } from 'obsidian';

type YamlParser = (yaml: string) => unknown;
type PropertyRecord = Record<string, unknown>;

let yamlParserOverride: YamlParser | null = null;

/** Normalize the user-facing Base batch concurrency to its supported range. */
export function clampBaseBatchConcurrency(value: number | undefined): number {
	if (!Number.isFinite(value)) return 1;
	return Math.max(1, Math.min(10, Math.floor(value!)));
}

/** Split a queue into bounded execution tiers, optionally limiting this run. */
export function splitBaseQueueBatches<T>(items: T[], concurrency: number, limit = items.length): T[][] {
	const size = clampBaseBatchConcurrency(concurrency);
	const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : items.length;
	const selected = items.slice(0, boundedLimit);
	const batches: T[][] = [];
	for (let index = 0; index < selected.length; index += size) batches.push(selected.slice(index, index + size));
	return batches;
}

/** Test-host hook; production always falls back to Obsidian's native parseYaml. */
export function setBaseYamlParserForTests(parser: YamlParser | null): void {
	yamlParserOverride = parser;
}

async function getYamlParser(): Promise<YamlParser> {
	if (yamlParserOverride) return yamlParserOverride;
	const obsidian = await import('obsidian');
	return obsidian.parseYaml as YamlParser;
}

function asRecord(value: unknown): PropertyRecord | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? value as PropertyRecord
		: undefined;
}

function embeddedBaseBlocks(source: string): string[] {
	const blocks: string[] = [];
	const pattern = /```base\s*\r?\n([\s\S]*?)\r?\n```/gi;
	for (const match of source.matchAll(pattern)) {
		if (match[1]?.trim()) blocks.push(match[1]);
	}
	return blocks;
}

function normalizePropertyName(raw: string): string {
	const property = raw.trim().replace(/^properties\./, '').replace(/^note\./, '');
	return property.startsWith('file.') ? property : property.replace(/^property\./, '');
}

function scalar(raw: string): unknown {
	const value = raw.trim();
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1);
	}
	if (value === 'true') return true;
	if (value === 'false') return false;
	if (value === 'null') return null;
	if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
	if (value.startsWith('[') && value.endsWith(']')) {
		return value.slice(1, -1).split(',').map(item => scalar(item)).filter(item => item !== '');
	}
	return value;
}

function comparable(value: unknown): string | number | boolean | null | undefined {
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
	return undefined;
}

function printable(value: unknown): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value.toString();
	if (value === null || value === undefined) return '';
	return JSON.stringify(value);
}

function equals(actual: unknown, expected: unknown): boolean {
	if (Array.isArray(actual)) return actual.some(value => equals(value, expected));
	if (Array.isArray(expected)) return expected.some(value => equals(actual, value));
	return comparable(actual) === comparable(expected);
}

function propertyValue(property: string, properties: PropertyRecord, file: TFile): unknown {
	switch (normalizePropertyName(property)) {
		case 'file.name': return file.name;
		case 'file.basename': return file.basename;
		case 'file.path': return file.path;
		case 'file.folder': return file.parent?.path ?? file.path.split('/').slice(0, -1).join('/');
		case 'file.ext':
		case 'file.extension': return file.extension;
		default: return properties[normalizePropertyName(property)];
	}
}

function evaluateExpression(expression: string, properties: PropertyRecord, file: TFile): boolean {
	const source = expression.trim();
	const tagCall = source.match(/^file\.hasTag\(\s*(["'])(.*?)\1\s*\)$/i);
	if (tagCall) {
		const tags = properties.tags ?? properties.tag;
		const expected = tagCall[2]!.replace(/^#/, '');
		const values = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(/[\s,]+/) : [];
		return values.some(value => String(value).replace(/^#/, '') === expected);
	}
	const contains = source.match(/^([\w.-]+)\s+(contains|in)\s+(.+)$/i);
	if (contains) {
		const actual = propertyValue(contains[1]!, properties, file);
		const expected = scalar(contains[3]!);
		if (contains[2]!.toLowerCase() === 'contains') {
			return Array.isArray(actual) ? actual.some(value => equals(value, expected)) : printable(actual).includes(printable(expected));
		}
		return Array.isArray(expected) && expected.some(value => equals(actual, value));
	}
	const comparison = source.match(/^([\w.-]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
	if (!comparison) return false;
	const actual = propertyValue(comparison[1]!, properties, file);
	const expected = scalar(comparison[3]!);
	switch (comparison[2]) {
		case '==': return equals(actual, expected);
		case '!=': return !equals(actual, expected);
		case '>': return (comparable(actual) as number | string) > (comparable(expected) as number | string);
		case '<': return (comparable(actual) as number | string) < (comparable(expected) as number | string);
		case '>=': return (comparable(actual) as number | string) >= (comparable(expected) as number | string);
		case '<=': return (comparable(actual) as number | string) <= (comparable(expected) as number | string);
		default: return false;
	}
}

function evaluateFilter(filter: unknown, properties: PropertyRecord, file: TFile): boolean {
	if (filter === undefined || filter === null || filter === '') return true;
	if (typeof filter === 'string') return evaluateExpression(filter, properties, file);
	if (Array.isArray(filter)) return filter.every(item => evaluateFilter(item, properties, file));
	const object = asRecord(filter);
	if (!object) return false;
	if ('and' in object) {
		const values = Array.isArray(object.and) ? object.and : [object.and];
		return values.every(item => evaluateFilter(item, properties, file));
	}
	if ('or' in object) {
		const values = Array.isArray(object.or) ? object.or : [object.or];
		return values.some(item => evaluateFilter(item, properties, file));
	}
	if ('not' in object) return !evaluateFilter(object.not, properties, file);
	return Object.entries(object).every(([property, expected]) => equals(propertyValue(property, properties, file), expected));
}

function filtersFromDefinition(definition: unknown): unknown {
	const object = asRecord(definition);
	return object?.filters ?? object?.filter;
}

/**
 * Resolve the active Markdown-note queue represented by an Obsidian Base.
 * Native parseYaml handles both standalone `.base` content and fenced `base` blocks.
 */
export async function parseBaseQueue(baseFile: TFile, app: App): Promise<TFile[]> {
	const source = await app.vault.read(baseFile);
	const yamlDocuments = baseFile.extension === 'base' ? [source] : embeddedBaseBlocks(source);
	if (yamlDocuments.length === 0) return [];
	const parseYaml = await getYamlParser();
	const filters: unknown[] = [];
	for (const document of yamlDocuments) {
		try {
			const definition = parseYaml(document);
			if (asRecord(definition)) filters.push(filtersFromDefinition(definition));
		} catch {
			// One malformed embedded view must not prevent other valid Base blocks from resolving.
		}
	}
	if (filters.length === 0) return [];
	const files = app.vault.getMarkdownFiles();
	return files.filter(file => {
		if (file.path === baseFile.path) return false;
		const cache = app.metadataCache.getFileCache(file);
		const frontmatter = { ...(asRecord(cache?.frontmatter) ?? {}) };
		if (frontmatter.tags === undefined && cache?.tags) {
			frontmatter.tags = cache.tags.map(tag => tag.tag);
		}
		const status = typeof frontmatter.agent_status === 'string'
			? frontmatter.agent_status.trim().toLowerCase()
			: '';
		if (status === 'completed' || status === 'failed') return false;
		// Multiple embedded Base blocks are treated as alternative queue views.
		return filters.some(filter => evaluateFilter(filter, frontmatter, file));
	});
}
