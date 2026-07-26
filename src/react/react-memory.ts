/**
 * ReAct Memory Bank — persistent, searchable shared context for multi-agent sessions.
 *
 * Every cycle's thought, action, and observation is stored as a tagged Markdown
 * note in the vault. Agents can search past memory using the existing BM25 search
 * engine, enabling cross-cycle and cross-session knowledge retention.
 *
 * Memory notes live under a configurable vault folder (default: "Command Center/Memory").
 * Each note carries YAML frontmatter with session/cycle/agent metadata for filtering.
 */

import { App, TFile } from 'obsidian';
import type { ReActCycle, ReActContext } from './react-types';
import { parseQuery, phase1Filter, scoreBatch, stripYamlFrontmatter } from '../obsidian-search';
import { generateTopicClusters, rankTopicClusters } from './react-memory-topics';
import type { TopicCluster, TopicMemoryNote } from './react-memory-topics';
export { generateTopicClusters, rankTopicClusters } from './react-memory-topics';
export type { TopicCluster, TopicMemoryNote } from './react-memory-topics';

/* ─── Configuration ────────────────────────────────────── */

const MEMORY_FOLDER = 'Command Center/Memory';
const MAX_MEMORY_RESULTS = 10;
const MEMORY_NOTE_PREFIX = 'react-';
const DEFAULT_PRUNE_INTERVAL_MS = 5 * 60_000;
const MAX_CONTEXT_CHARS = 3_000;
/* ─── Memory Entry ──────────────────────────────────────── */

export interface MemoryEntry {
	/** Vault path of the memory note. */
	path: string;
	/** Which session this belongs to. */
	sessionId: string;
	/** Cycle index within the session. */
	cycleIndex: number;
	/** Which agent produced this (orchestrator/retriever/summarizer/editor). */
	agent: string;
	/** The thought/action/observation content. */
	content: string;
	/** ReAct-specific metadata. */
	type: 'thought' | 'action' | 'observation';
	/** Wall-clock timestamp. */
	timestamp: number;
	/** BM25 relevance score (when returned from search). */
	score: number;
}

export interface MemorySearchResult {
	entries: MemoryEntry[];
	query: string;
	totalHits: number;
}

/* ─── Memory Bank ───────────────────────────────────────── */

export class ReActMemoryBank {
	private app: App;
	private folderReady = false;
	private pruneTimer: number | null = null;
	private pruneInFlight: Promise<number> | null = null;
	private topicClusters: TopicCluster[] = [];
	private clustersDirty = true;

	constructor(app: App) {
		this.app = app;
	}

	/** Start periodic, non-overlapping pruning using the latest configured threshold. */
	startBackgroundPruning(
		getMaxNotes: () => number,
		intervalMs: number = DEFAULT_PRUNE_INTERVAL_MS,
	): void {
		this.stopBackgroundPruning();
		const run = () => {
			if (this.pruneInFlight) return;
			const maxNotes = Math.max(0, Math.floor(getMaxNotes()));
			this.pruneInFlight = this.prune(maxNotes)
				.then(async deleted => { await this.refreshTopicClusters(); return deleted; })
				.catch(error => {
					console.warn('[CC] Memory background prune failed:', error);
					return 0;
				})
				.finally(() => { this.pruneInFlight = null; });
		};
		run();
		this.pruneTimer = window.setInterval(run, Math.max(10_000, intervalMs));
	}

	/** Stop periodic pruning when the plugin unloads. */
	stopBackgroundPruning(): void {
		if (this.pruneTimer) window.clearInterval(this.pruneTimer);
		this.pruneTimer = null;
	}

	/** Ensure the memory folder exists. */
	private async ensureFolder(): Promise<void> {
		if (this.folderReady) return;
		const parts = MEMORY_FOLDER.split('/');
		let current = '';
		for (const part of parts) {
			current += (current ? '/' : '') + part;
			const exists = this.app.vault.getAbstractFileByPath(current);
			if (!exists) {
				await this.app.vault.createFolder(current);
			}
		}
		this.folderReady = true;
	}

	/** Store a complete cycle's artifacts as a memory note. */
	async storeCycle(
		sessionId: string,
		cycle: ReActCycle,
	): Promise<string> {
		await this.ensureFolder();
		const timestamp = Date.now();
		const filename = `${MEMORY_NOTE_PREFIX}${sessionId.slice(0, 8)}-c${cycle.index}.md`;
		const path = `${MEMORY_FOLDER}/${filename}`;

		const tags = ['react-memory', `session-${sessionId.slice(0, 8)}`];
		if (cycle.action) tags.push(cycle.action.worker);

		const frontmatter = [
			'---',
			`session: "${sessionId}"`,
			`cycle: ${cycle.index}`,
			`tags: [${tags.join(', ')}]`,
			`timestamp: ${timestamp}`,
			'---',
		].join('\n');

		const thoughtBlock = `## Orchestrator Thought\n**Assessment:** ${cycle.thought.assessment}\n**Confidence:** ${cycle.thought.confidence.toFixed(2)}\n\n${cycle.thought.reasoning}`;

		let actionBlock = '';
		if (cycle.action) {
			actionBlock = `## Action\n**Worker:** ${cycle.action.worker}\n**Prompt:** ${cycle.action.prompt}\n**Expected:** ${cycle.action.expectedOutput}`;
		}

		let observationBlock = '';
		if (cycle.observation) {
			observationBlock = `## Observation\n**Success:** ${cycle.observation.success}\n\n${cycle.observation.output}`;
			if (cycle.observation.keyInsights.length > 0) {
				observationBlock += `\n\n### Key Insights\n${cycle.observation.keyInsights.map(k => `- ${k}`).join('\n')}`;
			}
		}

		const content = `${frontmatter}\n\n# Cycle ${cycle.index + 1}\n\n${thoughtBlock}\n\n${actionBlock}\n\n${observationBlock}`;

		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(path, content);
		}
		return path;
	}

	/** Store a session summary after completion. */
	async storeSessionSummary(ctx: ReActContext): Promise<string> {
		await this.ensureFolder();
		const path = `${MEMORY_FOLDER}/${MEMORY_NOTE_PREFIX}${ctx.sessionId.slice(0, 8)}-summary.md`;

		const frontmatter = [
			'---',
			`session: "${ctx.sessionId}"`,
			`tags: [react-memory, react-summary, session-${ctx.sessionId.slice(0, 8)}]`,
			`cycles: ${ctx.meta.totalCycles}`,
			`termination: ${ctx.meta.termination}`,
			`startedAt: ${ctx.meta.startedAt}`,
			`completedAt: ${ctx.meta.completedAt}`,
			'---',
		].join('\n');

		const summaries = ctx.cycles.map(c => {
			const obs = c.observation?.output.slice(0, 1000) ?? '(no observation)';
			return `### Cycle ${c.index + 1}\n- **Thought:** ${c.thought.reasoning.slice(0, 200)}\n- **Action:** ${c.action?.worker ?? 'none'}\n- **Observation:** ${obs.slice(0, 300)}`;
		}).join('\n\n');

		const content = `${frontmatter}\n\n# ReAct Session Summary\n\n**Task:** ${ctx.task.slice(0, 500)}\n**Cycles:** ${ctx.meta.totalCycles}\n**Termination:** ${ctx.meta.termination}\n\n${summaries}`;

		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(path, content);
		}
		this.clustersDirty = true;
		return path;
	}

	/** Rebuild thematic hubs from persisted session-summary notes. */
	async refreshTopicClusters(): Promise<TopicCluster[]> {
		const files = this.app.vault.getMarkdownFiles()
			.filter(file => file.path.startsWith(MEMORY_FOLDER) && file.name.includes('-summary'));
		const notes: TopicMemoryNote[] = [];
		for (const file of files) {
			const raw = await this.app.vault.cachedRead(file);
			const body = stripYamlFrontmatter(raw);
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			const sessionMatch = raw.match(/^session:\s*["']?([^"'\r\n]+)["']?/m);
			const taskMatch = body.match(/\*\*Task:\*\*\s*([^\r\n]+)/i);
			notes.push({
				path: file.path,
				sessionId: typeof fm?.session === 'string' ? fm.session : sessionMatch?.[1]?.trim() ?? '',
				task: taskMatch?.[1]?.trim() ?? file.basename,
				content: body,
				timestamp: Number(fm?.completedAt ?? file.stat.mtime),
			});
		}
		this.topicClusters = generateTopicClusters(notes);
		this.clustersDirty = false;
		return [...this.topicClusters];
	}

	getTopicClusters(): TopicCluster[] { return [...this.topicClusters]; }

	/** Search the memory bank for relevant past context using BM25. */
	async search(query: string, maxResults: number = MAX_MEMORY_RESULTS): Promise<MemorySearchResult> {
		const allFiles = this.app.vault.getMarkdownFiles()
			.filter(f => f.path.startsWith(MEMORY_FOLDER));

		if (allFiles.length === 0) {
			return { entries: [], query, totalHits: 0 };
		}

		const parsed = parseQuery(query);
		const candidates = phase1Filter(allFiles, parsed, this.app);
		const scored = await scoreBatch(candidates, parsed, this.app, maxResults);

		const entries: MemoryEntry[] = [];
		for (const result of scored) {
			const file = this.app.vault.getAbstractFileByPath(result.path);
			if (!(file instanceof TFile)) continue;
			const cache = this.app.metadataCache.getFileCache(file);
			const fm = cache?.frontmatter;
			if (fm && typeof fm === 'object') {
				const f = fm as Record<string, unknown>;
				entries.push({
					path: result.path,
					sessionId: typeof f.session === 'string' ? f.session : typeof f.session === 'number' ? String(f.session) : '',
					cycleIndex: Number(f.cycle ?? -1),
					agent: typeof f.agent === 'string' ? f.agent : 'unknown',
					content: result.excerpt,
					type: 'observation',
					timestamp: Number(f.timestamp ?? 0),
					score: result.score,
				});
			}
		}

		return { entries, query, totalHits: entries.length };
	}

	/** Hybrid BM25 + thematic-hub context, hard-capped for prompt budget safety. */
	async getRecentContext(task: string, maxEntries: number = 3): Promise<string> {
		const [results] = await Promise.all([
			this.search(task, maxEntries),
			this.clustersDirty ? this.refreshTopicClusters() : Promise.resolve(this.topicClusters),
		]);
		const hubs = rankTopicClusters(task, this.topicClusters, 2);
		if (results.entries.length === 0 && hubs.length === 0) return '';

		const sections: string[] = ['## Relevant Past Context'];
		if (hubs.length > 0) {
			sections.push('### Thematic History\n' + hubs.map(hub =>
				`**${hub.label}** (${hub.sessionIds.length} sessions; keywords: ${hub.keywords.slice(0, 5).join(', ')})\n${hub.summary}`
			).join('\n\n'));
		}
		if (results.entries.length > 0) {
			sections.push('### Specific Memories\n' + results.entries.map((entry, index) =>
				`**Memory ${index + 1}** (session ${entry.sessionId.slice(0, 8)}, cycle ${entry.cycleIndex})\n${entry.content.slice(0, 420)}`
			).join('\n\n'));
		}
		return sections.join('\n\n').slice(0, MAX_CONTEXT_CHARS);
	}

	/** List recent session summaries. */
	async listSessions(limit: number = 10): Promise<{ sessionId: string; task: string; cycles: number; date: string }[]> {
		const files = this.app.vault.getMarkdownFiles()
			.filter(f => f.path.startsWith(MEMORY_FOLDER) && f.name.includes('-summary'));

		const sessions: { sessionId: string; task: string; cycles: number; date: string }[] = [];
		for (const file of files.slice(0, limit)) {
			const cache = this.app.metadataCache.getFileCache(file);
			const fm = cache?.frontmatter;
			if (fm) {
				const f = fm as Record<string, unknown>;
				sessions.push({
					sessionId: typeof f.session === 'string' ? f.session : '',
					task: file.basename,
					cycles: Number(f.cycles ?? 0),
					date: new Date(Number(f.completedAt ?? 0)).toISOString().slice(0, 10),
				});
			}
		}
		return sessions;
	}

	/** Clean old memory notes beyond a retention count. */
	async prune(maxNotes: number = 100): Promise<number> {
		const retentionLimit = Math.max(0, Math.floor(maxNotes));
		const files = this.app.vault.getMarkdownFiles()
			.filter(f => f.path.startsWith(MEMORY_FOLDER))
			.sort((a, b) => b.stat.mtime - a.stat.mtime);

		let deleted = 0;
		for (const file of files.slice(retentionLimit)) {
			await this.app.fileManager.trashFile(file);
			deleted++;
		}
		if (deleted > 0) this.clustersDirty = true;
		return deleted;
	}
}