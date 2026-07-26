import { App, normalizePath, TFile, TFolder } from 'obsidian';
import type { ConfigManager } from '../engine/ConfigManager';
import { getSharedFileLockManager } from '../file-lock';

const LOG_HEADING = '## Log & Updates';
const REFLECTION_HEADING = '## Evening Reflection';

export type InboxProposalAction = 'move' | 'archive' | 'delete' | 'leave';
export interface InboxProposal {
	id: string;
	filePath: string;
	sourceFolder: string;
	action: InboxProposalAction;
	targetFolder?: string;
	reason: string;
	requiresApproval: true;
	destructive: boolean;
}
export interface ApprovedInboxProposal { proposalId: string; action?: InboxProposalAction; targetFolder?: string; }
export interface ProposalExecutionResult { proposalId: string; action: InboxProposalAction; success: boolean; destination?: string; error?: string; }
export interface CapacityMetricEvaluation { metric: string; value?: number; normalized?: number; weight: number; missing: boolean; }
export interface CapacityMetrics {
	score: number;
	priorityCap: number;
	defaultPriorityCap: number;
	evaluated: CapacityMetricEvaluation[];
	missingMetrics: string[];
}
export interface FrogAuditTask { filePath: string; line: number; text: string; deferredDays: number; thresholdDays: number; reason: string; }
export interface DailyNoteAssembly { file: TFile; path: string; created: boolean; capacity: CapacityMetrics; }
export interface MorningStartupSummary {
	assembly: DailyNoteAssembly;
	proposalCount: number;
	missingMetrics: string[];
	silent: boolean;
}
export interface EveningCloseoutSummary {
	filePath: string;
	completed: number;
	pending: number;
	reflectionQuestions: string[];
	closedAt: string;
}

/** ConfigManager-backed runtime for non-destructive morning, lock-safe midday, and evening closeout. */
export class DailyEngine {
	private readonly locks;
	private readonly proposals = new Map<string, InboxProposal>();

	constructor(private readonly app: App, private readonly configs: ConfigManager) {
		this.locks = getSharedFileLockManager(app);
	}

	async ready(): Promise<void> {
		if (!this.configs.isInitialized()) await this.configs.load();
		this.configs.requireConfig();
		this.configs.requireStyleGuide();
	}

	/** Scan every configured inbox and retain proposals without mutating any file. */
	async generateInboxProposals(): Promise<InboxProposal[]> {
		const config = this.configs.requireConfig();
		const proposals: InboxProposal[] = [];
		for (const configuredPath of config.topology.inboxFolders) {
			const folderPath = safeFolderPath(configuredPath);
			const folder = this.app.vault.getAbstractFileByPath(folderPath);
			if (!(folder instanceof TFolder)) continue;
			for (const file of folder.children.filter((entry): entry is TFile => entry instanceof TFile).sort((a, b) => a.path.localeCompare(b.path))) {
				const action = config.triage.defaultAction;
				const targetFolder = action === 'move' ? config.triage.moveDestination : action === 'archive' ? config.triage.archiveDestination : undefined;
				const proposal: InboxProposal = {
					id: `${file.path}:${file.stat.mtime}`, filePath: file.path, sourceFolder: folderPath, action,
					...(targetFolder ? { targetFolder: safeFolderPath(targetFolder) } : {}),
					reason: `Configured triage policy proposes “${action}” for this capture.`, requiresApproval: true, destructive: action === 'delete',
				};
				this.proposals.set(proposal.id, proposal); proposals.push(proposal);
			}
		}
		return proposals;
	}

	/** Apply only explicit approvals. Deletion always uses the vault trash API. */
	async executeApprovedProposals(approvals: ReadonlyArray<ApprovedInboxProposal>): Promise<ProposalExecutionResult[]> {
		const results: ProposalExecutionResult[] = [];
		for (const approval of approvals) {
			const proposal = this.proposals.get(approval.proposalId);
			if (!proposal) { results.push({ proposalId: approval.proposalId, action: approval.action ?? 'leave', success: false, error: 'Proposal is missing or expired.' }); continue; }
			const action = approval.action ?? proposal.action;
			try {
				const result = await this.locks.withLock(proposal.filePath, async () => this.executeProposal(proposal, action, approval.targetFolder));
				results.push(result); this.proposals.delete(approval.proposalId);
			} catch (error) { results.push({ proposalId: proposal.id, action, success: false, error: (error as Error).message }); }
		}
		return results;
	}

	evaluateCapacity(metricInputs: Record<string, unknown>): CapacityMetrics {
		const config = this.configs.requireConfig();
		const defaultPriorityCap = positiveInteger(config.focus.defaultPriorityCap, 'focus.defaultPriorityCap');
		const rules = config.capacity.rules;
		if (!rules.length) return { score: 1, priorityCap: defaultPriorityCap, defaultPriorityCap, evaluated: [], missingMetrics: [] };
		const evaluations: CapacityMetricEvaluation[] = rules.map(rule => {
			const value = numberValue(metricInputs[rule.metric]);
			const weight = finitePositive(rule.weight) ? rule.weight : 1;
			if (value === undefined) return { metric: rule.metric, value, weight, missing: true };
			const min = finite(rule.min) ? rule.min : rule.operator === 'below' ? rule.threshold : 0;
			const max = finite(rule.max) ? rule.max : rule.operator === 'above' ? rule.threshold : Math.max(rule.threshold, min + 1);
			const low = Math.min(min, max), high = Math.max(min, max);
			const raw = high === low ? (value >= high ? 1 : 0) : clamp01((value - low) / (high - low));
			const higherIsBetter = rule.higherIsBetter ?? rule.operator === 'below';
			return { metric: rule.metric, value, normalized: higherIsBetter ? raw : 1 - raw, weight, missing: false };
		});
		const available = evaluations.filter(item => !item.missing && item.normalized !== undefined);
		const totalWeight = available.reduce((sum, item) => sum + item.weight, 0);
		const score = totalWeight ? clamp01(available.reduce((sum, item) => sum + (item.normalized ?? 0) * item.weight, 0) / totalWeight) : 1;
		return {
			score, priorityCap: Math.max(1, Math.round(defaultPriorityCap * score)), defaultPriorityCap, evaluated: evaluations,
			missingMetrics: evaluations.filter(item => item.missing).map(item => item.metric),
		};
	}

	/** Evaluate capacity and assemble the daily note as one morning operation. */
	async runMorningStartup(metricInputs: Record<string, unknown> = {}, options: { date?: Date; silent?: boolean } = {}): Promise<MorningStartupSummary> {
		await this.ready();
		const proposals = await this.generateInboxProposals();
		const assembly = await this.assembleDailyNote(metricInputs, options.date ?? new Date());
		return {
			assembly,
			proposalCount: proposals.length,
			missingMetrics: assembly.capacity.missingMetrics,
			silent: options.silent ?? false,
		};
	}

	async assembleDailyNote(metricInputs: Record<string, unknown> = {}, date = new Date()): Promise<DailyNoteAssembly> {
		const config = this.configs.requireConfig();
		const capacity = this.evaluateCapacity(metricInputs);
		const path = dailyNotePath(config.topology.dailyNotesFolder, config.topology.dailyNoteNameTemplate, date);
		await ensureFolder(this.app, parentPath(path));
		return this.locks.withLock(path, async () => {
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) {
				await this.setDailyFrontmatter(existing, date, capacity, 'active');
				return { file: existing, path, created: false, capacity };
			}
			if (existing) throw new Error(`Daily Note path is not a file: ${path}`);
			const content = `---\ndate: ${formatDate(date)}\ncapacity_score: ${capacity.score.toFixed(4)}\npriority_cap: ${capacity.priorityCap}\nagent_status: active\n---\n\n# ${formatDate(date)}\n\n## Top Priorities 🐸\n\n## Log & Updates\n\n## Evening Reflection\n`;
			const file = await this.app.vault.create(path, content);
			return { file, path, created: true, capacity };
		});
	}

	async appendTimestampedLog(file: TFile, text: string, timestamp = new Date()): Promise<string> {
		const entry = text.replace(/\r?\n+/g, ' ').trim();
		if (!entry) throw new Error('Log entry cannot be empty.');
		const line = `- **${formatTime(timestamp)}** - ${entry}`;
		await this.locks.withLock(file.path, async () => {
			await this.app.vault.process(file, content => appendUnderHeading(content, LOG_HEADING, line));
		});
		return line;
	}

	async performFrogAudit(files: ReadonlyArray<TFile> = this.app.vault.getMarkdownFiles()): Promise<FrogAuditTask[]> {
		const threshold = Math.max(0, Math.floor(this.configs.requireConfig().triage.frogRolloverThreshold));
		const flagged: FrogAuditTask[] = [];
		for (const file of files) {
			const content = await this.app.vault.cachedRead(file);
			for (const [index, line] of content.split(/\r?\n/).entries()) {
				const task = /^\s*[-*+]\s+\[ \]\s+(.+?)\s*$/.exec(line)?.[1];
				if (!task) continue;
				const explicit = /#deferred\/(\d+)d\b/i.exec(task);
				if (!explicit && !task.includes('🐸')) continue;
				const days = explicit ? Number(explicit[1]) : Math.max(0, Math.floor((Date.now() - file.stat.ctime) / 86_400_000));
				if (days < threshold) continue;
				flagged.push({ filePath: file.path, line: index + 1, text: task, deferredDays: days, thresholdDays: threshold, reason: `Deferred ${days} day(s); configured threshold is ${threshold}.` });
			}
		}
		return flagged;
	}

	async closeoutEvening(file: TFile, reflection = '', closedAt = new Date()): Promise<EveningCloseoutSummary> {
		const styleGuide = this.configs.requireStyleGuide();
		const content = await this.app.vault.cachedRead(file);
		const completed = countTasks(content, true), pending = countTasks(content, false);
		const reflectionQuestions = extractReflectionQuestions(styleGuide);
		const body = `${reflectionQuestions.map(question => `- ${question}`).join('\n')}\n\n${reflection.trim() || '_Awaiting reflection._'}\n\n### Closeout Summary\n\n- Completed: ${completed}\n- Pending: ${pending}\n- Closed: ${closedAt.toISOString()}\n`;
		await this.locks.withLock(file.path, async () => {
			await this.app.vault.process(file, current => replaceSection(current, REFLECTION_HEADING, body));
			await this.setDailyFrontmatter(file, closedAt, undefined, 'closed');
		});
		return { filePath: file.path, completed, pending, reflectionQuestions, closedAt: closedAt.toISOString() };
	}

	private async executeProposal(proposal: InboxProposal, action: InboxProposalAction, overrideTarget?: string): Promise<ProposalExecutionResult> {
		const source = this.app.vault.getAbstractFileByPath(proposal.filePath);
		if (!(source instanceof TFile)) throw new Error(`Inbox file no longer exists: ${proposal.filePath}`);
		if (action === 'leave') return { proposalId: proposal.id, action, success: true };
		if (action === 'delete') { await this.app.vault.trash(source, true); return { proposalId: proposal.id, action, success: true }; }
		const target = safeFolderPath(overrideTarget ?? proposal.targetFolder ?? '');
		await ensureFolder(this.app, target);
		const destination = await availablePath(this.app, target, source.name);
		await this.app.fileManager.renameFile(source, destination);
		return { proposalId: proposal.id, action, success: true, destination };
	}
	private async setDailyFrontmatter(file: TFile, date: Date, capacity: CapacityMetrics | undefined, status: 'active' | 'closed'): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, frontmatter => {
			frontmatter.date = formatDate(date); frontmatter.agent_status = status;
			if (capacity) { frontmatter.capacity_score = capacity.score; frontmatter.priority_cap = capacity.priorityCap; }
			if (status === 'closed') frontmatter.closed_at = date.toISOString();
		});
	}
}

function dailyNotePath(folder: string, template: string, date: Date): string {
	const name = replaceDateTokens(template, date);
	const leaf = /\.md$/i.test(name) ? name : `${name}.md`;
	const path = normalizePath(`${safeFolderPath(folder)}/${leaf}`);
	if (path.startsWith('../') || path.includes('/../')) throw new Error('Unsafe Daily Note path.');
	return path;
}
function replaceDateTokens(value: string, date: Date): string { return value.replace(/\{date}|YYYY-MM-DD/g, formatDate(date)).replace(/\{YYYY}|YYYY/g, String(date.getFullYear())).replace(/\{MM}|MM/g, String(date.getMonth() + 1).padStart(2, '0')).replace(/\{DD}|DD/g, String(date.getDate()).padStart(2, '0')); }
function safeFolderPath(value: string): string { const path = normalizePath(value.trim().replace(/^\/+|\/+$/g, '')); if (!path || path === '.' || path.startsWith('../') || path.includes('/../') || path === '.command-center') throw new Error(`Unsafe configured folder path: ${value}`); return path; }
async function ensureFolder(app: App, path: string): Promise<void> { if (!path) return; let current = ''; for (const segment of path.split('/')) { current = normalizePath(current ? `${current}/${segment}` : segment); const entry = app.vault.getAbstractFileByPath(current); if (entry instanceof TFolder) continue; if (entry) throw new Error(`A file blocks folder creation: ${current}`); await app.vault.createFolder(current); } }
async function availablePath(app: App, folder: string, fileName: string): Promise<string> { const dot = fileName.lastIndexOf('.'), stem = dot > 0 ? fileName.slice(0, dot) : fileName, extension = dot > 0 ? fileName.slice(dot) : ''; let path = normalizePath(`${folder}/${fileName}`), suffix = 2; while (app.vault.getAbstractFileByPath(path)) path = normalizePath(`${folder}/${stem} ${suffix++}${extension}`); return path; }
function appendUnderHeading(content: string, heading: string, line: string): string { const source = content.trimEnd(); const headingAt = source.search(new RegExp(`^${escapeRegex(heading)}\\s*$`, 'm')); if (headingAt < 0) return `${source}\n\n${heading}\n\n${line}\n`; const afterHeading = headingAt + source.slice(headingAt).indexOf('\n') + 1; const nextHeading = source.slice(afterHeading).search(/^##\s/m); const insertAt = nextHeading < 0 ? source.length : afterHeading + nextHeading; return `${source.slice(0, insertAt).trimEnd()}\n${line}\n\n${source.slice(insertAt).trimStart()}`.trimEnd() + '\n'; }
function replaceSection(content: string, heading: string, body: string): string { const source = content.trimEnd(); const pattern = new RegExp(`^${escapeRegex(heading)}\\s*$[\\s\\S]*?(?=^##\\s|$)`, 'm'); const section = `${heading}\n\n${body.trimEnd()}\n`; return pattern.test(source) ? `${source.replace(pattern, section).trimEnd()}\n` : `${source}\n\n${section}`; }
function extractReflectionQuestions(styleGuide: string): string[] { const section = /^##\s+(?:Evening )?Reflection Questions?\s*$([\s\S]*?)(?=^##\s|$)/im.exec(styleGuide)?.[1] ?? ''; const questions = section.split(/\r?\n/).map(line => line.replace(/^\s*[-*+]\s+/, '').trim()).filter(line => line.endsWith('?')); return questions.length ? questions : styleGuide.split(/\r?\n/).map(line => line.trim()).filter(line => line.endsWith('?')); }
function countTasks(content: string, complete: boolean): number { const expression = complete ? /^\s*[-*+]\s+\[[xX]\]\s+/gm : /^\s*[-*+]\s+\[ \]\s+/gm; return content.match(expression)?.length ?? 0; }
function numberValue(value: unknown): number | undefined { if (typeof value === 'number') return Number.isFinite(value) ? value : undefined; if (typeof value === 'string' && value.trim()) { const number = Number(value); return Number.isFinite(number) ? number : undefined; } return undefined; }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function finitePositive(value: unknown): value is number { return finite(value) && value > 0; }
function positiveInteger(value: unknown, label: string): number { if (!finite(value) || value <= 0) throw new Error(`${label} must be a positive number.`); return Math.floor(value); }
function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
function parentPath(path: string): string { const index = path.lastIndexOf('/'); return index < 0 ? '' : path.slice(0, index); }
function formatDate(date: Date): string { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function formatTime(date: Date): string { return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
