/**
 * Command Center View — custom ItemView dashboard.
 * Shows daemon controls, queue stats, task history, and per-task live streaming output.
 */

import {
	ItemView,
	Modal,
	Notice,
	TFile,
	WorkspaceLeaf,
	normalizePath,
	type EventRef,
} from 'obsidian';
import type CommandCenterPlugin from '../main';
import type { QueueStats, ToolConfirmationDecision, ToolConfirmationRequest } from '../types';
import type { StoredTask } from '../persistence';
import type { ReActTraceEvent, TraceEventCallback } from '../react/react-trace';
import type { InterviewEngine } from '../onboarding/InterviewEngine';
import type { OnboardingConfig } from '../onboarding/OnboardingTypes';
import { DEFAULT_DASHBOARD_LAYOUT, type DashboardWidgetLayout, type DashboardWidgetSize } from '../settings/settings-model';
import { DashboardOnboarding } from './DashboardOnboarding';
import { CredentialVaultModal } from '../security/CredentialVaultModal';
import { ChatActionCard } from './chat-action-card';

const MAX_TRACE_ENTRIES = 50;
const MAX_COMPLETED_STREAMS = 3;
const TRACE_ICONS: Partial<Record<ReActTraceEvent['type'], string>> = {
	'session:start': '🚀',
	'session:pause': '⏸',
	'session:resume': '▶',
	'session:end': '🏁',
	'cycle:start': '🔄',
	'cycle:end': '✅',
	'agent:role:create': '✨',
	'agent:think:start': '🧠',
	'agent:think:end': '💡',
	'agent:act:start': '🔧',
	'agent:observe': '📋',
	'agent:correct': '🔄',
	'agent:validate': '🔍',
	'agent:error': '⚠️',
};

interface TraceRowSlot {
	entry: HTMLDivElement;
	icon: HTMLSpanElement;
	agent: HTMLSpanElement;
	label: HTMLSpanElement;
	content: HTMLSpanElement;
	badge: HTMLSpanElement;
	event: ReActTraceEvent | null;
}

export interface TraceRenderStats {
	flushes: number;
	rowsUpdated: number;
	maxPendingDepth: number;
	maxFlushMs: number;
	overBudgetFrames: number;
}

/** Stable persisted ID retained for workspace compatibility; placement is root-only. */
export const VIEW_TYPE_COMMAND_CENTER = 'command-center-sidebar';
export const COMMAND_CENTER_VIEW_TYPE = VIEW_TYPE_COMMAND_CENTER;
export const COMMAND_CENTER_VIEW_DISPLAY_TEXT = 'Command Center';

export class CommandCenterView extends ItemView {
	private plugin: CommandCenterPlugin;
	private taskListEl!: HTMLElement;
	private statusIndicator!: HTMLElement;
	private daemonErrorEl!: HTMLElement;
	private statsEls!: {
		pending: HTMLElement;
		running: HTMLElement;
		completed: HTMLElement;
		failed: HTMLElement;
	};
	private streamContainerEl!: HTMLElement;
	/** ReAct trace monitor container. */
	private reactMonitorEl!: HTMLElement;
	private debugToggleBtn!: HTMLButtonElement;
	private nextStepBtn!: HTMLButtonElement;
	private resumeSessionBtn!: HTMLButtonElement;
	/** Per-task stream buffers. Deltas are coalesced into one DOM write per frame. */
	private taskStreams = new Map<
		string,
		{ el: HTMLElement; pre: HTMLElement; pending: string }
	>();
	private pendingTraceEvents: ReActTraceEvent[] = [];
	/** Fixed DOM row pool, filled as a circular buffer. */
	private traceRows: TraceRowSlot[] = [];
	private traceNextRow = 0;
	private traceVisibleCount = 0;
	private traceFilter: 'all' | 'critical' | 'errors' = 'all';
	private traceFilterButtons: HTMLButtonElement[] = [];
	private reactEmptyEl: HTMLElement | null = null;
	private traceRenderStats: TraceRenderStats = {
		flushes: 0,
		rowsUpdated: 0,
		maxPendingDepth: 0,
		maxFlushMs: 0,
		overBudgetFrames: 0,
	};
	private renderFrame: number | null = null;
	private isViewOpen = false;
	private selectedSessionId: string | null = null;
	private configStateEl: HTMLElement | null = null;
	private workflowStateEl: HTMLElement | null = null;
	private chatMessagesEl: HTMLElement | null = null;
	private chatInputEl: HTMLTextAreaElement | null = null;
	private currentDailyFile: TFile | null = null;
	private dashboardWorkspaceEl: HTMLElement | null = null;
	private telemetryEl: HTMLElement | null = null;
	private basesTelemetryEl: HTMLElement | null = null;
	private approvalQueueEl: HTMLElement | null = null;
	private widgetHostEl: HTMLElement | null = null;
	private layoutEditorEl: HTMLElement | null = null;
	private readonly approvalCards = new Set<ChatActionCard>();
	private viewEventRefs: EventRef[] = [];
	private monitorTimer: number | null = null;
	private chatFrame: number | null = null;
	private pendingChatScroll = false;
	private readonly traceCallback: TraceEventCallback = (event) =>
		this.queueReActTrace(event);

	constructor(leaf: WorkspaceLeaf, plugin: CommandCenterPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return COMMAND_CENTER_VIEW_TYPE;
	}
	getDisplayText(): string {
		return COMMAND_CENTER_VIEW_DISPLAY_TEXT;
	}
	getIcon(): string {
		return 'command';
	}

	async onOpen(): Promise<void> {
		this.isViewOpen = true;
		this.taskStreams.clear();
		this.pendingTraceEvents.length = 0;
		this.traceRows.length = 0;
		this.traceNextRow = 0;
		this.traceVisibleCount = 0;
		this.traceFilter = 'all';
		this.traceFilterButtons = [];
		this.reactEmptyEl = null;
		this.traceRenderStats = {
			flushes: 0,
			rowsUpdated: 0,
			maxPendingDepth: 0,
			maxFlushMs: 0,
			overBudgetFrames: 0,
		};
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('command-center-view');

		const title = container.createDiv({ cls: 'command-center-title-row' });
		const identity = title.createDiv({ cls: 'command-center-identity' });
		identity.createEl('h2', { text: 'Command center' });
		identity.createSpan( { text: 'Agentic operating system', cls: 'command-center-subtitle' });
		this.renderHeader(title);
		this.telemetryEl = container.createDiv({ cls: 'cc-dashboard-telemetry' });
		this.renderTelemetry();
		this.layoutEditorEl = container.createDiv({ cls: 'cc-dashboard-layout-editor is-hidden' });
		this.widgetHostEl = container.createDiv({ cls: 'cc-dashboard-widget-grid' });
		const widgetHost = this.widgetHostEl;
		this.dashboardWorkspaceEl = widgetHost.createEl('section', { cls: 'command-center-section cc-dashboard-workspace' });
		this.renderDashboardWorkspace();
		this.renderApprovalQueue(widgetHost);
		this.renderBasesController(widgetHost);
		this.renderDailyControls(widgetHost);
		this.renderWorkflowMonitor(widgetHost);
		this.renderOrchestratorChat(widgetHost);

		/* ─── Daemon Section ──────────────────────── */
		const daemonSection = widgetHost.createEl('section', {
			cls: 'command-center-section',
		});
		daemonSection.createEl('h3', { text: 'Daemon' });

		const controls = daemonSection.createDiv({
			cls: 'command-center-daemon-controls',
		});
		this.statusIndicator = controls.createSpan({
			cls: 'command-center-status-dot',
		});

		for (const [label, cls, action] of [
			[
				'Start',
				'mod-cta',
				() => {
					this.plugin.restartDaemon();
					this.updateDaemonStatus();
					window.setTimeout(() => {
						if (this.isViewOpen) this.updateDaemonStatus();
					}, 300);
				},
			],
			[
				'Stop',
				'',
				() => {
					this.plugin.daemon.stop();
					this.updateDaemonStatus();
				},
			],
			[
				'Restart',
				'',
				() => {
					this.plugin.daemon.stop();
					this.plugin.restartDaemon();
					this.updateDaemonStatus();
					window.setTimeout(() => {
						if (this.isViewOpen) this.updateDaemonStatus();
					}, 300);
				},
			],
		] as const) {
			const btn = controls.createEl('button', { text: label });
			if (cls) btn.addClass(cls);
			this.registerDomEvent(btn, 'click', action);
		}
		this.daemonErrorEl = daemonSection.createDiv({
			cls: 'command-center-daemon-error',
		});

		/* ─── Stats Section ───────────────────────── */
		const statsSection = widgetHost.createEl('section', {
			cls: 'command-center-section',
		});
		statsSection.createEl('h3', { text: 'Task queue' });
		const grid = statsSection.createDiv({
			cls: 'command-center-stats-grid',
		});
		this.statsEls = {
			pending: this.statCard(grid, 'Pending', '0'),
			running: this.statCard(grid, 'Running', '0'),
			completed: this.statCard(grid, 'Completed', '0'),
			failed: this.statCard(grid, 'Failed', '0'),
		};

		/* ─── History Section ─────────────────────── */
		const historySection = widgetHost.createEl('section', {
			cls: 'command-center-section',
		});
		const histHeader = historySection.createDiv({
			cls: 'command-center-section-header',
		});
		histHeader.createEl('h3', { text: 'Task history' });
		const clearBtn = histHeader.createEl('button', { text: 'Clear' });
		this.registerDomEvent(clearBtn, 'click', () => {
			this.taskListEl.empty();
			this.taskListEl.createEl('p', {
				text: 'No tasks yet.',
				cls: 'command-center-empty',
			});
		});

		this.taskListEl = historySection.createDiv({
			cls: 'command-center-task-list',
		});
		this.taskListEl.createEl('p', {
			text: 'No tasks yet.',
			cls: 'command-center-empty',
		});

		/* ─── Live Stream Section ─────────────────── */
		const streamSection = widgetHost.createEl('section', {
			cls: 'command-center-section',
		});
		const streamHeader = streamSection.createDiv({
			cls: 'command-center-section-header',
		});
		streamHeader.createEl('h3', { text: 'Live output' });
		const clearStreamBtn = streamHeader.createEl('button', {
			text: 'Clear all',
		});
		this.registerDomEvent(clearStreamBtn, 'click', () => this.clearAllStreams());

		this.streamContainerEl = streamSection.createDiv({
			cls: 'command-center-stream-container',
		});
		this.streamContainerEl.createEl('p', {
			text: 'Waiting for agent output…',
			cls: 'command-center-empty',
		});

		/* ─── ReAct Monitor Section ──────────────── */
		const reactSection = widgetHost.createEl('section', {
			cls: 'command-center-section',
		});
		const reactHeader = reactSection.createDiv({
			cls: 'command-center-section-header',
		});
		reactHeader.createEl('h3', { text: 'React monitor' });
		const reactActions = reactHeader.createDiv({ cls: 'cc-react-actions' });
		this.debugToggleBtn = reactActions.createEl('button', {
			text: 'Debug / step mode',
		});
		this.registerDomEvent(this.debugToggleBtn, 'click', () => {
			this.plugin.daemon.setDebugStepMode(
				!this.plugin.daemon.isDebugStepMode(),
			);
			this.updateDebugControls();
		});
		this.nextStepBtn = reactActions.createEl('button', {
			text: 'Next step',
		});
		this.registerDomEvent(this.nextStepBtn, 'click', () => {
			this.plugin.daemon.nextDebugStep();
			this.updateDebugControls();
		});
		this.resumeSessionBtn = reactActions.createEl('button', {
			text: 'Resume session',
		});
		this.registerDomEvent(this.resumeSessionBtn, 'click', () => {
			this.plugin.daemon.resumeDebugSession();
			this.updateDebugControls();
		});
		const exportReactBtn = reactActions.createEl('button', {
			text: 'Export session trace',
		});
		this.registerDomEvent(exportReactBtn, 'click', () => {
			void this.exportSessionTrace();
		});
		const clearReactBtn = reactActions.createEl('button', {
			text: 'Clear',
		});
		this.registerDomEvent(clearReactBtn, 'click', () => this.clearReActMonitor());
		this.updateDebugControls();

		const filters = reactSection.createDiv({
			cls: 'cc-react-filters',
			attr: { role: 'group', 'aria-label': 'ReAct event filters' },
		});
		for (const [filter, label] of [
			['all', 'All'],
			['critical', 'Actions & corrections'],
			['errors', 'Errors'],
		] as const) {
			const button = filters.createEl('button', {
				text: label,
				attr: {
					type: 'button',
					'aria-pressed': String(filter === this.traceFilter),
				},
			});
			button.dataset.filter = filter;
			button.toggleClass('mod-cta', filter === this.traceFilter);
			this.registerDomEvent(button, 'click', () =>
				this.setTraceFilter(filter),
			);
			this.traceFilterButtons.push(button);
		}

		this.reactMonitorEl = reactSection.createDiv({
			cls: 'cc-react-monitor',
		});
		this.initializeTraceRowPool();
		this.reactEmptyEl = this.reactMonitorEl.createEl('p', {
			text: 'No active React session.',
			cls: 'command-center-empty',
		});

		// Attach one stable listener and replay the retained tail after a tab reopen.
		this.plugin.daemon.trace.setCallback(this.traceCallback);
		const retained = this.plugin.daemon.trace.getEvents();
		this.pendingTraceEvents.push(...retained.slice(-MAX_TRACE_ENTRIES));
		this.scheduleRender();

		this.markWidget(this.dashboardWorkspaceEl, 'workspace');
		this.markWidget(daemonSection, 'daemon');
		this.markWidget(statsSection, 'queue');
		this.markWidget(historySection, 'history');
		this.markWidget(streamSection, 'live');
		this.markWidget(reactSection, 'react');
		this.applyDashboardLayout();
		this.updateDaemonStatus();
		this.bindOperationalRefresh();
		this.refreshConfigurationState();
	}

	/** Replace the operational overview with the consent-led setup interview. */
	async openOnboarding(
		engine: InterviewEngine,
		onComplete: (config: OnboardingConfig) => void | Promise<void>,
	): Promise<void> {
		if (!this.dashboardWorkspaceEl) throw new Error('Command Center dashboard workspace is unavailable.');
		const onboarding = new DashboardOnboarding(
			this.app,
			this.plugin,
			this.dashboardWorkspaceEl,
			this,
			engine,
			{
				onComplete,
				onClose: () => this.renderDashboardWorkspace(),
			},
		);
		await onboarding.open();
	}

	private renderDashboardWorkspace(): void {
		if (!this.dashboardWorkspaceEl) return;
		this.dashboardWorkspaceEl.empty();
		this.dashboardWorkspaceEl.removeClass('cc-dashboard-onboarding');
		const heading = this.dashboardWorkspaceEl.createDiv({ cls: 'cc-dashboard-workspace-heading' });
		heading.createDiv( { text: 'COMMAND CENTER DASHBOARD', cls: 'cc-dashboard-workspace-kicker' });
		heading.createEl('h2', { text: 'Operational overview' });
		heading.createEl('p', { text: 'Observe, understand, propose, approve, execute, evaluate, and remember.' });
		const cards = this.dashboardWorkspaceEl.createDiv({ cls: 'cc-dashboard-workspace-cards' });
		for (const [title, copy] of [
			['Agents', 'Multi-agent plans and active work'],
			['Queue', 'Pending and running operations'],
			['Memory', 'Vault context and semantic retrieval'],
			['Providers', 'Local-first routing and health'],
		] as const) {
			const card = cards.createDiv({ cls: 'cc-dashboard-workspace-card' });
			card.createEl('strong', { text: title });
			card.createDiv({ text: copy });
		}
		const actions = this.dashboardWorkspaceEl.createDiv({ cls: 'cc-dashboard-workspace-actions' });
		const discovery = actions.createEl('button', { text: 'Start or revise discovery', cls: 'mod-cta' });
		this.registerDomEvent(discovery, 'click', () => this.plugin.openOnboarding());
	}

	async onClose(): Promise<void> {
		this.isViewOpen = false;
		this.plugin.daemon.trace.clearCallback(this.traceCallback);
		// Never leave a headless session blocked if its controlling view closes.
		this.plugin.daemon.resumeDebugSession();
		if (this.renderFrame !== null) {
			window.cancelAnimationFrame(this.renderFrame);
			this.renderFrame = null;
		}
		if (this.chatFrame !== null) {
			window.cancelAnimationFrame(this.chatFrame);
			this.chatFrame = null;
		}
		if (this.monitorTimer !== null) {
			window.clearInterval(this.monitorTimer);
			this.monitorTimer = null;
		}
		for (const ref of this.viewEventRefs) this.app.vault.offref(ref);
		this.viewEventRefs = [];
		this.configStateEl = null;
		this.workflowStateEl = null;
		this.chatMessagesEl = null;
		this.chatInputEl = null;
		this.currentDailyFile = null;
		this.dashboardWorkspaceEl = null;
		this.telemetryEl = null;
		this.basesTelemetryEl = null;
		this.approvalQueueEl = null;
		this.widgetHostEl = null;
		this.layoutEditorEl = null;
		for (const card of this.approvalCards) card.dispose();
		this.approvalCards.clear();
		this.pendingTraceEvents.length = 0;
		for (const row of this.traceRows) row.event = null;
		this.traceRows.length = 0;
		this.traceNextRow = 0;
		this.traceVisibleCount = 0;
		this.traceFilterButtons = [];
		this.reactEmptyEl = null;
		this.taskStreams.clear();
	}

	/* ─── Operational Sidebar ───────────────────────── */

	private renderHeader(title: HTMLElement): void {
		const actions = title.createDiv({ cls: 'command-center-header-actions' });
		const exportWorkflowBtn = actions.createEl('button', { text: 'Export workflow to canvas' });
		this.registerDomEvent(exportWorkflowBtn, 'click', () => void this.plugin.exportActiveWorkflowToCanvas());
		const customize = actions.createEl('button', { text: 'Customize dashboard' });
		this.registerDomEvent(customize, 'click', () => this.toggleLayoutEditor(customize));
		const vault = actions.createEl('button', { text: 'Open secrets' });
		this.registerDomEvent(vault, 'click', () => new CredentialVaultModal(this.app, this.plugin, () => this.renderTelemetry()).open());
	}

	private renderTelemetry(): void {
		if (!this.telemetryEl) return;
		this.telemetryEl.empty();
		const route = this.plugin.nativeAutoRouter.resolve('text');
		const items = [
			{ label: 'Route', value: `${route.providerId} · ${route.modelId ?? 'default'}`, state: route.source === 'fail-closed' ? 'warning' : 'ok' },
			{ label: 'Depth', value: `${this.plugin.nativeAutoRouter.getDepth()} / 10`, state: 'neutral' },
			{ label: 'Pi daemon', value: this.plugin.daemon.isRunning() ? 'Running' : 'Stopped', state: this.plugin.daemon.isRunning() ? 'ok' : 'warning' },
			{ label: 'Secrets', value: `${this.plugin.credentialVault.count()} stored`, state: this.plugin.credentialVault.count() > 0 ? 'ok' : 'secure' },
		] as const;
		for (const item of items) {
			const card = this.telemetryEl.createDiv({ cls: `cc-telemetry-card is-${item.state}` });
			card.createDiv({ text: item.label, cls: 'cc-telemetry-label' });
			card.createDiv({ text: item.value, cls: 'cc-telemetry-value' });
		}
	}

	private toggleLayoutEditor(button: HTMLButtonElement): void {
		if (!this.layoutEditorEl) return;
		const opening = this.layoutEditorEl.hasClass('is-hidden');
		this.layoutEditorEl.toggleClass('is-hidden', !opening);
		button.setText(opening ? 'Done customizing' : 'Customize dashboard');
		if (opening) this.renderLayoutEditor();
	}

	private renderLayoutEditor(): void {
		if (!this.layoutEditorEl) return;
		this.layoutEditorEl.empty();
		const heading = this.layoutEditorEl.createDiv({ cls: 'command-center-section-header' });
		heading.createEl('h3', { text: 'Dashboard layout' });
		const reset = heading.createEl('button', { text: 'Reset default layout' });
		this.registerDomEvent(reset, 'click', () => {
			this.plugin.settings.dashboardLayout = DEFAULT_DASHBOARD_LAYOUT.map(widget => ({ ...widget }));
			void this.plugin.saveSettings();
			this.applyDashboardLayout();
			this.renderLayoutEditor();
		});
		const list = this.layoutEditorEl.createDiv({ cls: 'cc-layout-list' });
		for (const widget of this.normalizedLayout()) {
			const row = list.createDiv({ cls: 'cc-layout-row' });
			row.createEl('strong', { text: this.widgetLabel(widget.id) });
			const up = row.createEl('button', { text: '↑', attr: { 'aria-label': `Move ${this.widgetLabel(widget.id)} up` } });
			const down = row.createEl('button', { text: '↓', attr: { 'aria-label': `Move ${this.widgetLabel(widget.id)} down` } });
			this.registerDomEvent(up, 'click', () => this.moveWidget(widget.id, -1));
			this.registerDomEvent(down, 'click', () => this.moveWidget(widget.id, 1));
			const size = row.createEl('select', { attr: { 'aria-label': `${this.widgetLabel(widget.id)} size` } });
			for (const value of ['compact', 'standard', 'expanded'] as const) size.createEl('option', { value, text: value });
			size.value = widget.size;
			this.registerDomEvent(size, 'change', () => this.updateWidget(widget.id, { size: size.value as DashboardWidgetSize }));
			const protectedWidget = widget.id === 'approvals';
			const collapse = row.createEl('button', { text: widget.collapsed ? 'Expand' : 'Collapse' });
			collapse.disabled = protectedWidget;
			collapse.title = protectedWidget ? 'Mutation approvals must remain visible.' : '';
			this.registerDomEvent(collapse, 'click', () => this.updateWidget(widget.id, { collapsed: !widget.collapsed }));
			const visibility = row.createEl('button', { text: widget.hidden ? 'Show' : 'Hide' });
			visibility.disabled = protectedWidget;
			visibility.title = protectedWidget ? 'Mutation approvals cannot be hidden.' : '';
			this.registerDomEvent(visibility, 'click', () => this.updateWidget(widget.id, { hidden: !widget.hidden }));
		}
	}

	private normalizedLayout(): DashboardWidgetLayout[] {
		const configured = new Map(this.plugin.settings.dashboardLayout.map(widget => [widget.id, widget]));
		const ordered = this.plugin.settings.dashboardLayout.filter(widget => DEFAULT_DASHBOARD_LAYOUT.some(item => item.id === widget.id));
		for (const fallback of DEFAULT_DASHBOARD_LAYOUT) if (!configured.has(fallback.id)) ordered.push({ ...fallback });
		return ordered.map(widget => widget.id === 'approvals' ? { ...widget, hidden: false, collapsed: false } : { ...widget });
	}

	private applyDashboardLayout(): void {
		if (!this.widgetHostEl) return;
		const layout = this.normalizedLayout();
		this.plugin.settings.dashboardLayout = layout;
		for (const widget of layout) {
			const element = this.widgetHostEl.querySelector<HTMLElement>(`[data-widget-id="${widget.id}"]`);
			if (!element) continue;
			element.toggleClass('is-widget-hidden', widget.hidden);
			element.toggleClass('is-widget-collapsed', widget.collapsed);
			element.removeClass('is-size-compact', 'is-size-standard', 'is-size-expanded');
			element.addClass(`is-size-${widget.size}`);
			this.widgetHostEl.appendChild(element);
		}
	}

	private markWidget(element: HTMLElement, id: string): void { element.dataset.widgetId = id; }
	private widgetLabel(id: string): string { return ({ workspace: 'Dashboard workspace', approvals: 'Mutation approvals', orchestrator: 'Orchestrator', queue: 'Task queue', react: 'ReAct monitor', bases: 'Bases controller', daily: 'Daily cycle', system: 'System state', daemon: 'Daemon controls', live: 'Live output', history: 'Task history' } as Record<string, string>)[id] ?? id; }
	private updateWidget(id: string, patch: Partial<DashboardWidgetLayout>): void {
		this.plugin.settings.dashboardLayout = this.normalizedLayout().map(widget => widget.id === id ? { ...widget, ...patch, ...(id === 'approvals' ? { hidden: false, collapsed: false } : {}) } : widget);
		void this.plugin.saveSettings();
		this.applyDashboardLayout();
		this.renderLayoutEditor();
	}
	private moveWidget(id: string, direction: -1 | 1): void {
		const layout = this.normalizedLayout();
		const index = layout.findIndex(widget => widget.id === id);
		const target = index + direction;
		if (index < 0 || target < 0 || target >= layout.length) return;
		[layout[index], layout[target]] = [layout[target]!, layout[index]!];
		this.plugin.settings.dashboardLayout = layout;
		void this.plugin.saveSettings();
		this.applyDashboardLayout();
		this.renderLayoutEditor();
	}

	private renderApprovalQueue(container: HTMLElement): void {
		const section = container.createEl('section', { cls: 'command-center-section cc-dashboard-approvals' });
		this.markWidget(section, 'approvals');
		const heading = section.createDiv({ cls: 'command-center-section-header' });
		heading.createEl('h3', { text: 'Mutation approvals' });
		heading.createSpan( { text: 'Destructive and bulk operations stop here before any file is touched.', cls: 'cc-widget-caption' });
		this.approvalQueueEl = section.createDiv({ cls: 'cc-dashboard-approval-queue' });
		this.approvalQueueEl.createEl('p', { text: 'No operations awaiting approval.', cls: 'command-center-empty' });
	}

	async requestMutationApproval(request: ToolConfirmationRequest): Promise<ToolConfirmationDecision> {
		if (!this.approvalQueueEl || !this.isViewOpen) return 'rejected';
		this.approvalQueueEl.querySelector('.command-center-empty')?.remove();
		const card = new ChatActionCard(this.approvalQueueEl, {
			...request,
			timeoutMs: request.timeoutMs ?? 60_000,
		});
		this.approvalCards.add(card);
		const decision = await card.wait();
		this.approvalCards.delete(card);
		return decision;
	}

	private renderBasesController(container: HTMLElement): void {
		const section = container.createEl('section', { cls: 'command-center-section cc-bases-controller' });
		this.markWidget(section, 'bases');
		const heading = section.createDiv({ cls: 'command-center-section-header' });
		heading.createEl('h3', { text: 'Bases queue controller' });
		heading.createSpan( { text: 'Native .base views remain the queue definition and execution surface.', cls: 'cc-widget-caption' });
		this.basesTelemetryEl = section.createDiv({ cls: 'cc-bases-telemetry' });
		this.refreshBasesTelemetry();
	}

	private refreshBasesTelemetry(): void {
		if (!this.basesTelemetryEl) return;
		this.basesTelemetryEl.empty();
		const telemetry = this.plugin.getBasesQueueTelemetry();
		for (const [label, value] of [
			['Pending', telemetry.pending], ['Running', telemetry.running],
			['Active notes', telemetry.activeNotes], ['Synced completions', telemetry.synchronized],
		] as const) {
			const item = this.basesTelemetryEl.createDiv({ cls: 'cc-bases-telemetry-item' });
			item.createEl('strong', { text: String(value) });
			item.createSpan({ text: label });
		}
	}

	private renderDailyControls(container: HTMLElement): void {
		const section = container.createEl('section', {
			cls: 'command-center-section cc-daily-controls',
		});
		this.markWidget(section, 'daily');
		section.createEl('h3', { text: 'Daily cycle' });
		const controls = section.createDiv({
			cls: 'command-center-daemon-controls',
		});
		const morning = controls.createEl('button', {
			text: '🌅 Morning start',
			cls: 'mod-cta',
		});
		const midday = controls.createEl('button', {
			text: '⏱️ midday append',
		});
		const evening = controls.createEl('button', {
			text: '🌙 Evening close',
		});
		this.registerDomEvent(morning, 
			'click',
			() => void this.runMorningTouchpoint(morning),
		);
		this.registerDomEvent(midday, 
			'click',
			() => void this.openMiddayPrompt(midday),
		);
		this.registerDomEvent(evening, 
			'click',
			() => void this.openEveningPrompt(evening),
		);
	}

	private renderWorkflowMonitor(container: HTMLElement): void {
		const section = container.createEl('section', {
			cls: 'command-center-section cc-system-monitor',
		});
		this.markWidget(section, 'system');
		section.createEl('h3', { text: 'System & workflow state' });
		this.configStateEl = section.createDiv({ cls: 'cc-config-state' });
		this.workflowStateEl = section.createDiv({ cls: 'cc-workflow-state' });
	}

	private renderOrchestratorChat(container: HTMLElement): void {
		const section = container.createEl('section', {
			cls: 'command-center-section cc-orchestrator-chat',
		});
		this.markWidget(section, 'orchestrator');
		const header = section.createDiv({ cls: 'command-center-section-header' });
		header.createEl('h3', { text: 'Orchestrator' });
		header.createSpan( { text: 'Dashboard agent workspace', cls: 'cc-widget-caption' });
		this.chatMessagesEl = section.createDiv({
			cls: 'cc-dashboard-orchestrator-messages',
			attr: { role: 'log', 'aria-live': 'polite' },
		});
		this.appendChatMessage(
			'assistant',
			'Ready. Prompts are routed through the configured reasoning tier.',
		);
		this.chatInputEl = section.createEl('textarea', {
			cls: 'cc-dashboard-orchestrator-input',
			attr: { rows: '6', placeholder: 'Ask the orchestrator…', 'aria-label': 'Orchestrator prompt' },
		});
		this.registerDomEvent(this.chatInputEl, 'input', () => this.resizeOrchestratorInput());
		this.resizeOrchestratorInput();
		const controls = section.createDiv({ cls: 'cc-dashboard-input-actions' });
		const dictate = controls.createEl('button', { text: '🎙 Dictate', attr: { 'aria-label': 'Start dictation' } });
		let stopDictation: (() => Promise<string>) | null = null;
		this.registerDomEvent(dictate, 'click', () => void (async () => {
			if (stopDictation) {
				dictate.disabled = true;
				dictate.setText('⏳ Transcribing…');
				try {
					const text = await stopDictation();
					if (text.trim()) {
						if (this.chatInputEl) {
							this.chatInputEl.value = [this.chatInputEl.value.trim(), text].filter(Boolean).join(' ');
							this.resizeOrchestratorInput();
						}
						this.plugin.accessibilityAudio.cue('complete');
					} else {
						new Notice('Dictation was empty — no text inserted.', 4000);
					}
				} catch (error) { new Notice(`Dictation failed: ${(error as Error).message}`); }
				finally { stopDictation = null; dictate.disabled = false; dictate.setText('🎙 Dictate'); }
			} else {
				try {
					if (!this.plugin.settings.speechToTextEnabled) throw new Error('Enable speech to text in Settings to use dictation.');
					const session = await this.plugin.accessibilityAudio.dictate(undefined, (phase, message) => {
						if (phase === 'error') new Notice(`Dictation: ${message}`, 5000);
					});
					stopDictation = session.stop;
					dictate.setText('■ stop dictation');
				} catch (error) { new Notice(`Dictation failed: ${(error as Error).message}`); }
			}
		})());
		const send = controls.createEl('button', {
			text: 'Send',
			cls: 'mod-cta',
		});
		const submit = () => void this.submitOrchestratorChat(send);
		this.registerDomEvent(send, 'click', submit);
		this.registerDomEvent(this.chatInputEl, 'keydown', (event) => {
			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				submit();
			}
		});
	}

	private resizeOrchestratorInput(): void {
		if (!this.chatInputEl) return;
		const minimum = 132;
		const maximum = Math.max(minimum, Math.floor(window.innerHeight * 0.45));
		this.chatInputEl.setCssStyles({ height: 'auto', overflowY: 'hidden' });
		this.chatInputEl.setCssStyles({
			height: `${Math.min(maximum, Math.max(minimum, this.chatInputEl.scrollHeight))}px`,
			overflowY: this.chatInputEl.scrollHeight > maximum ? 'auto' : 'hidden',
		});
	}

	appendChatMessage(
		role: 'user' | 'assistant' | 'error',
		message: string,
	): HTMLElement | null {
		if (!this.chatMessagesEl) return null;
		const pinned =
			this.chatMessagesEl.scrollHeight -
				this.chatMessagesEl.scrollTop -
				this.chatMessagesEl.clientHeight <
			28;
		const row = this.chatMessagesEl.createDiv({
			cls: `cc-dashboard-orchestrator-message is-${role}`,
		});
		row.setText(message);
		if (role === 'assistant' && message.trim()) {
			const read = row.createEl('button', { text: '🔊 Read aloud', cls: 'cc-read-aloud' });
			this.registerDomEvent(read, 'click', () => this.plugin.accessibilityAudio.speak(message));
			if (this.plugin.settings.autoReadAiResponses) this.plugin.accessibilityAudio.speak(message);
			this.plugin.accessibilityAudio.cue('complete');
		}
		if (pinned) {
			this.pendingChatScroll = true;
			this.scheduleChatScroll();
		}
		return row;
	}

	private async submitOrchestratorChat(
		button: HTMLButtonElement,
	): Promise<void> {
		const prompt = this.chatInputEl?.value.trim() ?? '';
		if (!prompt) return;
		this.plugin.requireInitialized();
		if (this.chatInputEl) this.chatInputEl.value = '';
		this.resizeOrchestratorInput();
		this.appendChatMessage('user', prompt);
		button.disabled = true;
		const responseEl = this.appendChatMessage('assistant', '');
		let streamed = '';
		try {
			const result = await this.plugin.router.route({
				id: crypto.randomUUID(),
				workerProfile: 'Orchestrator',
				workerRole: 'Orchestrator',
				preferredTier: 'tier2_reasoning',
				prompt,
				status: 'queued',
				createdAt: Date.now(),
				onStream: (delta) => {
					const normalizedDelta = this.plugin.normalizeDashboardOutput({ success: true, content: delta });
					if (!normalizedDelta.content) return;
					streamed += normalizedDelta.content;
					responseEl?.appendText(normalizedDelta.content);
					this.pendingChatScroll = true;
					this.scheduleChatScroll();
				},
			});
			const normalized = this.plugin.normalizeDashboardOutput({
				success: Boolean(result.servedBy),
				content: result.taskResult.output ?? result.taskResult.summary ?? '',
				...(result.servedBy ? {} : { error: result.taskResult.output ?? 'No reasoning provider completed the request.' }),
			});
			if (!normalized.success) throw new Error(normalized.error ?? 'Agent execution failed safely.');
			if (!streamed) responseEl?.setText(normalized.content || 'Completed.');
		} catch (error) {
			responseEl?.remove();
			this.appendChatMessage('error', (error as Error).message);
		} finally {
			button.disabled = false;
			this.chatInputEl?.focus();
		}
	}

	private async runMorningTouchpoint(
		button: HTMLButtonElement,
	): Promise<void> {
		button.disabled = true;
		try {
			const metrics = this.configuredMetricInputs();
			const silent = this.plugin.settings.silentDailyStartup;
			if (silent) {
				const summary = await this.plugin.dailyEngine.runMorningStartup(
					metrics,
					{ silent: true },
				);
				this.currentDailyFile = summary.assembly.file;
				await this.app.workspace
					.getLeaf(false)
					.openFile(summary.assembly.file);
				const capacity = summary.assembly.capacity;
				const review = summary.proposalCount
					? ` · ${summary.proposalCount} inbox proposal${summary.proposalCount === 1 ? '' : 's'} awaiting review`
					: '';
				const missing = summary.missingMetrics.length
					? ` · ${summary.missingMetrics.length} metric${summary.missingMetrics.length === 1 ? '' : 's'} unavailable`
					: '';
				new Notice(
					`Morning ready · capacity ${capacity.score.toFixed(2)} · cap ${capacity.priorityCap}${review}${missing}`,
				);
			} else {
				const proposals =
					await this.plugin.dailyEngine.generateInboxProposals();
				const approved = await this.confirmInboxProposals(proposals);
				if (approved.length)
					await this.plugin.dailyEngine.executeApprovedProposals(
						approved,
					);
				const assembled =
					await this.plugin.dailyEngine.assembleDailyNote(metrics);
				this.currentDailyFile = assembled.file;
				await this.app.workspace
					.getLeaf(false)
					.openFile(assembled.file);
				new Notice(
					`Morning ready · capacity ${assembled.capacity.score.toFixed(2)} · cap ${assembled.capacity.priorityCap}`,
				);
			}
			this.refreshConfigurationState();
		} catch (error) {
			new Notice(`Morning start failed: ${(error as Error).message}`);
		} finally {
			button.disabled = false;
		}
	}

	private async openMiddayPrompt(button: HTMLButtonElement): Promise<void> {
		const file = await this.resolveDailyFile();
		if (!file) {
			new Notice('Create today’s daily note with morning start first.');
			return;
		}
		new TextEntryModal(
			this.app,
			'Midday update',
			'Append update',
			async (text) => {
			button.disabled = true;
			try {
					await this.plugin.dailyEngine.appendTimestampedLog(
						file,
						text,
					);
					const frogs =
						await this.plugin.dailyEngine.performFrogAudit();
					new Notice(
						frogs.length
							? `${frogs.length} deferred priorit${frogs.length === 1 ? 'y' : 'ies'} need review.`
							: 'Midday update appended; no stale deferred priorities.',
					);
				} finally {
					button.disabled = false;
				}
			},
		).open();
	}

	private async openEveningPrompt(button: HTMLButtonElement): Promise<void> {
		const file = await this.resolveDailyFile();
		if (!file) {
			new Notice('Today’s configured daily note does not exist.');
			return;
		}
		const questions = this.reflectionQuestions();
		new TextEntryModal(
			this.app,
			questions.length ? questions.join('\n') : 'Evening reflection',
			'Close day',
			async (text) => {
			button.disabled = true;
				try {
					const summary =
						await this.plugin.dailyEngine.closeoutEvening(
							file,
							text,
						);
					new Notice(
						`Closed · ${summary.completed} completed · ${summary.pending} pending`,
					);
				} finally {
					button.disabled = false;
				}
			},
		).open();
	}

	private confirmInboxProposals(
		proposals: Awaited<
			ReturnType<
				CommandCenterPlugin['dailyEngine']['generateInboxProposals']
			>
		>,
	): Promise<Array<{ proposalId: string }>> {
		if (!proposals.length) return Promise.resolve([]);
		return new Promise((resolve) =>
			new ProposalApprovalModal(this.app, proposals, resolve).open(),
		);
	}

	private configuredMetricInputs(): Record<string, unknown> {
		const config = this.plugin.configManager.requireConfig();
		const active = this.app.workspace.getActiveFile();
		const frontmatter = active
			? this.app.metadataCache.getFileCache(active)?.frontmatter
			: undefined;
		return Object.fromEntries(
			config.capacity.rules.map((rule) => [
				rule.metric,
				frontmatter?.[rule.metric],
			]),
		);
	}

	private reflectionQuestions(): string[] {
		const style = this.plugin.configManager.requireStyleGuide();
		return style
			.split(/\r?\n/)
			.map((line) => line.replace(/^\s*[-*+]\s+/, '').trim())
			.filter((line) => line.endsWith('?'));
	}

	private async resolveDailyFile(): Promise<TFile | null> {
		if (
			this.currentDailyFile &&
			this.app.vault.getAbstractFileByPath(
				this.currentDailyFile.path,
			) instanceof TFile
		)
			return this.currentDailyFile;
		const assembled = await this.plugin.dailyEngine.assembleDailyNote();
		this.currentDailyFile = assembled.file;
		return assembled.file;
	}

	private bindOperationalRefresh(): void {
		const refresh = () => {
			this.refreshConfigurationState();
			this.renderTelemetry();
			this.refreshBasesTelemetry();
		};
		this.viewEventRefs.push(
			this.app.vault.on('create', refresh),
			this.app.vault.on('delete', refresh),
			this.app.vault.on('rename', refresh),
		);
		this.monitorTimer = this.registerInterval(window.setInterval(refresh, 5_000));
	}

	private refreshConfigurationState(): void {
		if (!this.configStateEl || !this.workflowStateEl) return;
		this.configStateEl.empty();
		this.workflowStateEl.empty();
		if (!this.plugin.configManager.isInitialized()) {
			this.configStateEl.setText('Configuration required.');
			return;
		}
		const config = this.plugin.configManager.requireConfig();
		const list = this.configStateEl.createEl('ul');
		list.createEl('li', {
			text: `Inboxes: ${config.topology.inboxFolders.join(', ')}`,
		});
		list.createEl('li', {
			text: `Daily Notes: ${config.topology.dailyNotesFolder}/${config.topology.dailyNoteNameTemplate}`,
		});
		list.createEl('li', {
			text: `Priority cap: ${config.focus.defaultPriorityCap}`,
		});
		list.createEl('li', {
			text: `Tracks: ${config.lifeDomains.map((domain) => domain.name).join(', ') || 'None configured'}`,
		});
		const indexed = config.managedFolders.filter(
			(folder) =>
				this.app.vault.getAbstractFileByPath(
					normalizePath(`${folder.path}/_index.md`),
				) instanceof TFile,
		).length;
		list.createEl('li', {
			text: `Indexes: ${indexed}/${config.managedFolders.length}`,
		});
		const stats = this.plugin.taskQueue?.getStats();
		this.workflowStateEl.setText(
			stats
				? `Workflows/tasks · ${stats.running} running · ${stats.pending} pending · ${stats.failed} failed`
				: 'Workflow queue unavailable.',
		);
	}

	private scheduleChatScroll(): void {
		if (this.chatFrame !== null) return;
		this.chatFrame = window.requestAnimationFrame(() => {
			this.chatFrame = null;
			if (this.pendingChatScroll && this.chatMessagesEl)
				this.chatMessagesEl.scrollTop =
					this.chatMessagesEl.scrollHeight;
			this.pendingChatScroll = false;
		});
	}

	/* ─── Daemon Status ─────────────────────────────── */

	updateDaemonStatus(): void {
		if (!this.statusIndicator) return;
		const running = this.plugin.daemon.isRunning();
		const err = this.plugin.daemon.startError;
		this.statusIndicator.removeClass('running', 'stopped', 'busy', 'error');
		this.statusIndicator.removeAttribute('title');
		if (running) {
			this.statusIndicator.addClass('running');
			this.statusIndicator.textContent = '● running';
		} else if (err) {
			this.statusIndicator.addClass('error');
			this.statusIndicator.textContent = '✕ error';
			this.statusIndicator.setAttribute('title', err);
		} else {
			this.statusIndicator.addClass('stopped');
			this.statusIndicator.textContent = '● stopped';
		}
		if (this.daemonErrorEl) {
			this.daemonErrorEl.textContent = err ? `Launch error: ${err}` : '';
			this.daemonErrorEl.toggleClass('is-hidden', !err);
		}
	}

	updateQueueStats(stats: QueueStats): void {
		if (!this.statsEls) return;
		this.statsEls.pending.textContent = String(stats.pending);
		this.statsEls.running.textContent = String(stats.running);
		this.statsEls.completed.textContent = String(stats.completed);
		this.statsEls.failed.textContent = String(stats.failed);
	}

	/* ─── History ───────────────────────────────────── */

	addTaskToHistory(_task: StoredTask): void {
		this.taskListEl.empty();
		for (const t of this.plugin.getTaskHistory()) {
			const entry = this.taskListEl.createDiv({
				cls: `command-center-task-entry ${t.status}`,
			});
			entry.createSpan({
				cls: 'command-center-task-status',
				text: t.status,
			});
			const info = entry.createSpan({ cls: 'command-center-task-info' });
			info.textContent = t.targetPath
				? `${t.workerProfile} — ${t.targetPath.split('/').pop() ?? t.targetPath}`
				: t.workerProfile;
			if (t.error) entry.setAttribute('title', t.error);
			entry.createSpan({
				cls: 'command-center-task-time',
				text: new Date(t.createdAt).toLocaleTimeString(),
			});
		}
	}

	/* ─── Per-Task Streaming ────────────────────────── */

	/**
	 * Start streaming output for a task. Creates a buffered <pre> block
	 * with a header showing the worker profile and target path.
	 * Called by the plugin when a task begins execution.
	 */
	startTaskStream(
		taskId: string,
		workerProfile: string,
		targetPath?: string,
	): void {
		if (!this.isViewOpen || !this.streamContainerEl?.isConnected) return;

		// Remove empty placeholder on first stream
		const placeholder = this.streamContainerEl.querySelector(
			'.command-center-empty',
		);
		if (placeholder) placeholder.remove();

		// Remove old completed streams beyond the visible window.
		const inactive = [...this.taskStreams.entries()].filter(
			([id]) => id !== taskId,
		);
		for (const [id] of inactive.slice(
			0,
			Math.max(0, inactive.length - MAX_COMPLETED_STREAMS),
		)) {
			this.taskStreams.get(id)?.el.remove();
			this.taskStreams.delete(id);
		}

		// Create stream block
		const block = this.streamContainerEl.createDiv({
			cls: 'cc-stream-block active',
		});
		const header = block.createDiv({ cls: 'cc-stream-header' });
		header.createSpan({
			cls: 'cc-stream-task-label',
			text: `${workerProfile}${targetPath ? ' → ' + targetPath : ''}`,
		});
		header.createSpan({
			cls: 'cc-stream-time',
			text: new Date().toLocaleTimeString(),
		});

		const pre = block.createEl('pre', { cls: 'cc-stream-content' });
		pre.textContent = '';

		this.taskStreams.set(taskId, { el: block, pre, pending: '' });
		this.streamContainerEl.scrollTop = this.streamContainerEl.scrollHeight;
	}

	/** Whether this view currently has a DOM buffer for the task. */
	hasTaskStream(taskId: string): boolean {
		return this.taskStreams.has(taskId);
	}

	/**
	 * Append a streaming text delta to the active task's buffer.
	 * Uses incremental DOM update — only appends the new text.
	 */
	appendStreamOutput(delta: string, taskId: string): void {
		const stream = this.taskStreams.get(taskId);
		if (!stream) return;

		stream.pending += delta;
		this.scheduleRender();
	}

	/**
	 * Mark a task stream as complete. Adds a completion marker
	 * and removes the 'active' class.
	 */
	finalizeStreamOutput(taskId: string): void {
		const stream = this.taskStreams.get(taskId);
		if (!stream) return;

		stream.pending += '\n\n─── Task Complete ───';
		stream.el.removeClass('active');
		stream.el.addClass('completed');
		this.scheduleRender();
	}

	/**
	 * Clear a single task's stream from the dashboard.
	 */
	clearTaskStream(taskId: string): void {
		const stream = this.taskStreams.get(taskId);
		if (stream) {
			stream.el.remove();
			this.taskStreams.delete(taskId);
		}

		if (this.taskStreams.size === 0) {
			this.streamContainerEl.createEl('p', {
				text: 'Waiting for agent output…',
				cls: 'command-center-empty',
			});
		}
	}

	/** Clear all stream blocks. */
	clearAllStreams(): void {
		for (const [, s] of this.taskStreams) s.el.remove();
		this.taskStreams.clear();
		this.streamContainerEl.empty();
		this.streamContainerEl.createEl('p', {
			text: 'Waiting for agent output…',
			cls: 'command-center-empty',
		});
	}

	/* ─── Helpers ───────────────────────────────────── */

	/** Coalesce model deltas and trace bursts into at most one layout per frame. */
	private scheduleRender(): void {
		if (!this.isViewOpen || this.renderFrame !== null) return;
		this.renderFrame = window.requestAnimationFrame(() => {
			this.renderFrame = null;
			if (!this.isViewOpen) return;
			this.flushStreamOutput();
			this.flushReActTrace();
		});
	}

	private flushStreamOutput(): void {
		for (const stream of this.taskStreams.values()) {
			if (!stream.pending) continue;
			const delta = stream.pending;
			stream.pending = '';
			if (!stream.pre.isConnected) continue;
			stream.pre.appendChild(document.createTextNode(delta));
			stream.pre.scrollTop = stream.pre.scrollHeight;
		}
	}

	private statCard(
		parent: HTMLElement,
		label: string,
		value: string,
	): HTMLElement {
		const card = parent.createDiv({ cls: 'command-center-stat-card' });
		card.createSpan({ cls: 'command-center-stat-value', text: value });
		card.createSpan({ cls: 'command-center-stat-label', text: label });
		return card;
	}

	/* ─── ReAct Monitor ──────────────────────────── */

	private queueReActTrace(event: ReActTraceEvent): void {
		if (!this.isViewOpen) return;
		if (
			event.type === 'session:pause' ||
			event.type === 'session:resume' ||
			event.type === 'session:end'
		) {
			this.updateDebugControls();
		}
		if (!this.traceEventVisible(event)) return;
		this.pendingTraceEvents.push(event);
		this.traceRenderStats.maxPendingDepth = Math.max(
			this.traceRenderStats.maxPendingDepth,
			this.pendingTraceEvents.length,
		);
		// The DOM is a virtualized rolling tail; events outside it remain in the collector.
		if (this.pendingTraceEvents.length > MAX_TRACE_ENTRIES) {
			this.pendingTraceEvents.splice(
				0,
				this.pendingTraceEvents.length - MAX_TRACE_ENTRIES,
			);
		}
		this.scheduleRender();
	}

	private updateDebugControls(): void {
		if (!this.debugToggleBtn) return;
		const enabled = this.plugin.daemon.isDebugStepMode();
		const paused = this.plugin.daemon.isDebugStepPaused();
		this.debugToggleBtn.classList.toggle('mod-cta', enabled);
		this.debugToggleBtn.setAttribute('aria-pressed', String(enabled));
		this.debugToggleBtn.setAttribute(
			'title',
			enabled
				? 'Disable cycle-by-cycle debugging'
				: 'Pause after each completed observation cycle',
		);
		this.nextStepBtn.hidden = !enabled;
		this.resumeSessionBtn.hidden = !enabled;
		this.nextStepBtn.disabled = !paused;
		this.resumeSessionBtn.disabled = !paused;
	}

	/** Runtime diagnostics for profiling sustained agent bursts in Obsidian. */
	getTraceRenderStats(): Readonly<TraceRenderStats> {
		return { ...this.traceRenderStats };
	}

	private setTraceFilter(filter: 'all' | 'critical' | 'errors'): void {
		if (this.traceFilter === filter) return;
		this.traceFilter = filter;
		for (const button of this.traceFilterButtons) {
			const selected = button.dataset.filter === filter;
			button.setAttribute('aria-pressed', String(selected));
			button.classList.toggle('mod-cta', selected);
		}
		this.rebuildFilteredTraceTail();
	}

	private traceEventVisible(event: ReActTraceEvent): boolean {
		if (this.traceFilter === 'all') return true;
		if (this.traceFilter === 'errors')
			return (
				event.type === 'agent:error' ||
				Boolean(
					event.detail?.toolInvocations?.some((tool) => tool.error),
				)
			);
		return (
			event.type === 'agent:act:start' ||
			event.type === 'agent:correct' ||
			event.type === 'agent:error'
		);
	}

	private rebuildFilteredTraceTail(): void {
		this.pendingTraceEvents.length = 0;
		this.traceNextRow = 0;
		this.traceVisibleCount = 0;
		for (const row of this.traceRows) this.hideTraceRow(row);
		const tail = this.plugin.daemon.trace
			.getEvents()
			.filter((event) => this.traceEventVisible(event))
			.slice(-MAX_TRACE_ENTRIES);
		this.pendingTraceEvents.push(...tail);
		if (this.reactEmptyEl) this.reactEmptyEl.hidden = tail.length > 0;
		this.scheduleRender();
	}

	private flushReActTrace(): void {
		if (
			!this.reactMonitorEl?.isConnected ||
			this.pendingTraceEvents.length === 0
		)
			return;
		const startedAt = performance.now();

		// Read scroll geometry once before mutations. Avoid forcing a post-update layout
		// unless the user was already following the live tail.
		const shouldAutoScroll =
			this.reactMonitorEl.scrollHeight -
				this.reactMonitorEl.scrollTop -
				this.reactMonitorEl.clientHeight <=
			24;
		const events = this.pendingTraceEvents
			.splice(0)
			.filter((event) => this.traceEventVisible(event));
		if (events.length === 0) return;
		if (this.reactEmptyEl) this.reactEmptyEl.hidden = true;

		// Circular rebinding means a steady-state flush updates only newly arrived
		// rows—not all 50 rows shifted by a rolling array.
		for (const event of events) {
			const row = this.traceRows[this.traceNextRow]!;
			this.updateTraceRow(row, event);
			this.traceNextRow = (this.traceNextRow + 1) % MAX_TRACE_ENTRIES;
			this.traceVisibleCount = Math.min(
				MAX_TRACE_ENTRIES,
				this.traceVisibleCount + 1,
			);
		}

		// CSS order presents the ring chronologically while every node remains fixed.
		const oldest =
			this.traceVisibleCount < MAX_TRACE_ENTRIES ? 0 : this.traceNextRow;
		for (let position = 0; position < this.traceVisibleCount; position++) {
			const rowIndex = (oldest + position) % MAX_TRACE_ENTRIES;
			const entry = this.traceRows[rowIndex]!.entry;
			const order = String(position);
			if (entry.style.order !== order) entry.setCssStyles({ order });
		}
		if (shouldAutoScroll)
			this.reactMonitorEl.scrollTop = this.reactMonitorEl.scrollHeight;

		const elapsed = performance.now() - startedAt;
		this.traceRenderStats.flushes++;
		this.traceRenderStats.rowsUpdated += events.length;
		this.traceRenderStats.maxFlushMs = Math.max(
			this.traceRenderStats.maxFlushMs,
			elapsed,
		);
		if (elapsed > 16.67) this.traceRenderStats.overBudgetFrames++;
	}

	private initializeTraceRowPool(): void {
		const pool = createDiv({ cls: 'cc-react-entry-pool' });
		for (let index = 0; index < MAX_TRACE_ENTRIES; index++) {
			const entry = pool.createDiv( { cls: 'cc-react-entry' });
			entry.hidden = true;
			entry.tabIndex = 0;
			entry.setAttribute('role', 'button');
			entry.dataset.poolIndex = String(index);
			const icon = this.createTraceSpan(entry, 'cc-react-icon');
			const agent = this.createTraceSpan(entry, 'cc-react-agent');
			const label = this.createTraceSpan(entry, 'cc-react-label');
			const content = this.createTraceSpan(entry, 'cc-react-content');
			const badge = this.createTraceSpan(entry, 'cc-react-role-badge');
			const row: TraceRowSlot = {
				entry,
				icon,
				agent,
				label,
				content,
				badge,
				event: null,
			};
			const inspect = () => {
				// Read the slot at activation time: pooled rows may have been rebound since
				// pointer-down, but the modal must always receive the currently displayed event.
				const selected = row.event;
				if (
					!selected ||
					entry.hidden ||
					entry.dataset.eventId !== selected.id
				)
					return;
				this.selectedSessionId = selected.sessionId;
				new SessionReplayModal(this.plugin, selected).open();
			};
			this.registerDomEvent(entry, 'click', inspect);
			this.registerDomEvent(entry, 'keydown', (keyboardEvent) => {
				if (
					keyboardEvent.key === 'Enter' ||
					keyboardEvent.key === ' '
				) {
					keyboardEvent.preventDefault();
					inspect();
				}
			});
			this.traceRows.push(row);
		}
		this.reactMonitorEl.append(...Array.from(pool.children));
	}

	private createTraceSpan(
		entry: HTMLDivElement,
		className: string,
	): HTMLSpanElement {
		return entry.createSpan( { cls: className });
	}

	private updateTraceRow(row: TraceRowSlot, event: ReActTraceEvent): void {
		const isDynamicRole =
			event.type === 'agent:role:create' ||
			event.meta?.dynamicRole === true;
		row.event = event;
		row.entry.hidden = false;
		const className = `cc-react-entry cc-react-${event.type.replace(/:/g, '-')}${isDynamicRole ? ' cc-react-dynamic-role' : ''}`;
		if (row.entry.className !== className) row.entry.className = className;
		row.entry.dataset.eventId = event.id;
		row.entry.dataset.sessionId = event.sessionId;
		row.entry.dataset.eventType = event.type;
		row.entry.setAttribute(
			'aria-label',
			`Inspect ${event.agent} ${event.label}`,
		);
		this.setTextIfChanged(row.icon, TRACE_ICONS[event.type] ?? '•');
		this.setTextIfChanged(row.agent, event.agent);
		this.setTextIfChanged(row.label, event.label);
		this.setTextIfChanged(
			row.content,
			event.content ? event.content.slice(0, 150) : '',
		);
		row.content.hidden = !event.content;
		const depth = String(Math.min(Math.max(event.cycleIndex + 1, 0), 3));
		if (row.entry.style.getPropertyValue('--cc-trace-depth') !== depth) {
			row.entry.setCssProps({ '--cc-trace-depth': depth });
		}
		this.setTextIfChanged(
			row.badge,
			isDynamicRole
				? event.type === 'agent:role:create'
					? 'NEW ROLE'
					: 'CUSTOM'
				: '',
		);
		row.badge.hidden = !isDynamicRole;
		if (isDynamicRole) {
			row.entry.setAttribute('title', this.dynamicRoleTooltip(event));
			const roleName =
				typeof event.meta?.roleName === 'string'
					? event.meta.roleName
					: event.agent;
			row.entry.setAttribute('aria-label', `Dynamic role ${roleName}`);
		} else {
			row.entry.removeAttribute('title');
		}
	}

	private setTextIfChanged(element: HTMLElement, value: string): void {
		if (element.textContent !== value) element.textContent = value;
	}

	private hideTraceRow(row: TraceRowSlot): void {
		row.event = null;
		row.entry.hidden = true;
		delete row.entry.dataset.eventId;
		delete row.entry.dataset.sessionId;
		delete row.entry.dataset.eventType;
	}

	private dynamicRoleTooltip(event: ReActTraceEvent): string {
		const tools = Array.isArray(event.meta?.allowedTools)
			? event.meta.allowedTools.join(', ')
			: '';
		const rules = Array.isArray(event.meta?.validationRules)
			? event.meta.validationRules.length
			: 0;
		return [
			event.content,
			tools ? `Allowed tools: ${tools}` : '',
			rules ? `Validation rules: ${rules}` : '',
		]
			.filter(Boolean)
			.join('\n');
	}

	private async exportSessionTrace(): Promise<void> {
		const allEvents = this.plugin.daemon.trace.getEvents();
		const sessionId =
			this.selectedSessionId ??
			allEvents[allEvents.length - 1]?.sessionId;
		if (!sessionId) {
			new Notice('No React session is available to export.');
			return;
		}
		const events = this.plugin.daemon.trace.getSessionEvents(sessionId);
		if (events.length === 0) {
			new Notice('The selected session is no longer retained.');
			return;
		}

		const memoryNotes: Array<{ path: string; content: string }> = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!file.path.startsWith('Command Center/Memory/')) continue;
			const content = await this.app.vault.cachedRead(file);
			if (
				content
					.match(/^session:\s*["']?([^"'\r\n]+)["']?/m)?.[1]
					?.trim() === sessionId
			) {
				memoryNotes.push({ path: file.path, content });
			}
		}

		const evaluations = events.flatMap((event) =>
			event.detail?.evaluation ? [event.detail.evaluation] : [],
		);
		const totals = events.reduce(
			(sum, event) => {
			const usage = event.detail?.tokenUsage;
			sum.prompt += usage?.promptTokens ?? 0;
			sum.completion += usage?.completionTokens ?? 0;
				sum.total +=
					usage?.totalTokens ??
					(usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0);
			return sum;
			},
			{ prompt: 0, completion: 0, total: 0 },
		);
		const started = events[0]?.timestamp ?? Date.now();
		const lines = [
			'---',
			`session: "${sessionId}"`,
			'tags: [command-center-audit, react-trace]',
			`exportedAt: ${Date.now()}`,
			'---',
			'',
			'# ReAct Session Audit Report',
			'',
			`- **Session:** \`${sessionId}\``,
			`- **Started:** ${new Date(started).toISOString()}`,
			`- **Events:** ${events.length}`,
			`- **Token usage:** ${totals.prompt} prompt / ${totals.completion} completion / ${totals.total} total`,
			'',
			'## Evaluation Summary',
			'',
			evaluations.length
				? evaluations
						.map(
							(evaluation, index) =>
								`### Evaluation ${index + 1}\n\n\`\`\`json\n${JSON.stringify(evaluation, null, 2)}\n\`\`\``,
						)
						.join('\n\n')
				: '_No evaluation scorecards were recorded._',
			'',
			'## Full Trace',
			'',
			...events.map((event, index) => formatAuditEvent(event, index)),
			'## Memory Notes',
			'',
			...(memoryNotes.length
				? memoryNotes.flatMap((note) => [
						`### ${note.path}`,
						'',
						'```markdown',
						note.content,
						'```',
						'',
					])
				: ['_No memory notes found for this session._', '']),
		];

		const folder = normalizePath('Command Center/Audit');
		if (!this.app.vault.getAbstractFileByPath('Command Center'))
			await this.app.vault.createFolder('Command Center');
		if (!this.app.vault.getAbstractFileByPath(folder))
			await this.app.vault.createFolder(folder);
		const stamp = new Date(started).toISOString().replace(/[:.]/g, '-');
		let path = normalizePath(
			`${folder}/react-audit-${sessionId.slice(0, 8)}-${stamp}.md`,
		);
		let suffix = 2;
		while (this.app.vault.getAbstractFileByPath(path))
			path = normalizePath(
				`${folder}/react-audit-${sessionId.slice(0, 8)}-${stamp}-${suffix++}.md`,
			);
		await this.app.vault.create(path, lines.join('\n'));
		new Notice(`Session trace exported to ${path}`);
	}

	clearReActMonitor(): void {
		if (!this.reactMonitorEl) return;
		this.pendingTraceEvents.length = 0;
		this.traceNextRow = 0;
		this.traceVisibleCount = 0;
		for (const row of this.traceRows) this.hideTraceRow(row);
		if (this.reactEmptyEl) this.reactEmptyEl.hidden = false;
		this.plugin.daemon.trace.clear();
		this.selectedSessionId = null;
	}
}

class TextEntryModal extends Modal {
	constructor(
		app: CommandCenterPlugin['app'],
		private readonly title: string,
		private readonly actionLabel: string,
		private readonly submit: (text: string) => void | Promise<void>,
	) {
		super(app);
	}
	onOpen(): void {
		this.contentEl.createEl('h2', { text: this.title });
		const input = this.contentEl.createEl('textarea', {
			attr: { rows: '6', placeholder: 'Enter text…' },
		});
		const actions = this.contentEl.createDiv({
			cls: 'modal-button-container',
		});
		const cancel = actions.createEl('button', { text: 'Cancel' });
		cancel.addEventListener('click', () => this.close());
		const submit = actions.createEl('button', {
			text: this.actionLabel,
			cls: 'mod-cta',
		});
		submit.addEventListener('click',  () => { void (async () => {
			const value = input.value.trim();
			if (!value) return;
			submit.disabled = true;
			try {
				await this.submit(value);
				this.close();
			} finally {
				submit.disabled = false;
			}
		})(); });
		input.focus();
	}
}

class ProposalApprovalModal extends Modal {
	private settled = false;
	constructor(
		app: CommandCenterPlugin['app'],
		private readonly proposals: Awaited<
			ReturnType<
				CommandCenterPlugin['dailyEngine']['generateInboxProposals']
			>
		>,
		private readonly resolve: (
			approved: Array<{ proposalId: string }>,
		) => void,
	) {
		super(app);
	}
	onOpen(): void {
		this.contentEl.createEl('h2', { text: 'Approve inbox proposals' });
		this.contentEl.createEl('p', {
			text: 'Review configured proposals. Only checked items will mutate the vault.',
		});
		const inputs = this.proposals.map((proposal) => {
			const row = this.contentEl.createEl('label', {
				cls: 'cc-onboarding-asset-option',
			});
			const input = row.createEl('input', { type: 'checkbox' });
			row.createSpan({
				text: `${proposal.action}: ${proposal.filePath}${proposal.targetFolder ? ` → ${proposal.targetFolder}` : ''}`,
			});
			return { proposal, input };
		});
		const actions = this.contentEl.createDiv({
			cls: 'modal-button-container',
		});
		actions
			.createEl('button', { text: 'Leave all' })
			.addEventListener('click', () => {
				this.settled = true;
				this.resolve([]);
				this.close();
			});
		actions
			.createEl('button', { text: 'Execute checked', cls: 'mod-warning' })
			.addEventListener('click', () => {
				this.settled = true;
				this.resolve(
					inputs
						.filter((item) => item.input.checked)
						.map((item) => ({ proposalId: item.proposal.id })),
				);
				this.close();
			});
	}
	onClose(): void {
		if (!this.settled) {
			this.settled = true;
			this.resolve([]);
		}
	}
}

class SessionReplayModal extends Modal {
	constructor(
		private plugin: CommandCenterPlugin,
		private selected: ReActTraceEvent,
	) {
		super(plugin.app);
	}

	onOpen(): void {
		this.modalEl.addClass('cc-trace-detail-modal');
		this.contentEl.empty();
		const events = this.plugin.daemon.trace.getSessionEvents(
			this.selected.sessionId,
		);
		const index = Math.max(
			0,
			events.findIndex((event) => event.id === this.selected.id),
		);
		const header = this.contentEl.createDiv({
			cls: 'cc-trace-detail-header',
		});
		header.createEl('h2', { text: 'Session replay / log detail' });
		header.createEl('p', {
			text: `Step ${index + 1} of ${events.length} · ${this.selected.agent} · ${this.selected.type}`,
		});

		const nav = this.contentEl.createDiv({ cls: 'cc-trace-detail-nav' });
		const previous = nav.createEl('button', { text: '← previous' });
		previous.disabled = index === 0;
		previous.addEventListener('click', () => this.select(events[index - 1]));
		const next = nav.createEl('button', { text: 'Next →' });
		next.disabled = index >= events.length - 1;
		next.addEventListener('click', () => this.select(events[index + 1]));

		this.addField(
			'Timestamp',
			new Date(this.selected.timestamp).toISOString(),
		);
		this.addField('Label', this.selected.label);
		this.addField('Raw input prompt', this.selected.detail?.inputPrompt);
		this.addField(
			'Model response',
			this.selected.detail?.modelResponse ?? this.selected.content,
		);
		this.addJsonField(
			'Tool arguments and results',
			this.selected.detail?.toolInvocations,
		);
		this.addJsonField(
			'Evaluation scores',
			this.selected.detail?.evaluation,
		);
		this.addJsonField('Token usage', this.selected.detail?.tokenUsage);
		this.addJsonField('Event metadata', this.selected.meta);
	}

	private select(event: ReActTraceEvent | undefined): void {
		if (!event) return;
		this.selected = event;
		this.onOpen();
	}

	private addField(label: string, value: string | undefined): void {
		const section = this.contentEl.createEl('section', {
			cls: 'cc-trace-detail-section',
		});
		section.createEl('h3', { text: label });
		section.createEl('pre', {
			text: value?.trim() || 'Not recorded for this step.',
		});
	}

	private addJsonField(label: string, value: unknown): void {
		this.addField(
			label,
			value === undefined || (Array.isArray(value) && value.length === 0)
				? undefined
				: JSON.stringify(value, null, 2),
		);
	}
}

function formatAuditEvent(event: ReActTraceEvent, index: number): string {
	const detail = event.detail;
	const blocks = [
		`### ${index + 1}. ${event.label}`,
		'',
		`- **Time:** ${new Date(event.timestamp).toISOString()}`,
		`- **Agent:** ${event.agent}`,
		`- **Type:** \`${event.type}\``,
		`- **Cycle/Sub-cycle:** ${event.cycleIndex}/${event.subCycle}`,
		'',
		'#### Event Content',
		'',
		event.content || '_Empty_',
		'',
	];
	if (detail?.inputPrompt)
		blocks.push(
			'#### Raw Input Prompt',
			'',
			'```text',
			detail.inputPrompt,
			'```',
			'',
		);
	if (detail?.modelResponse)
		blocks.push(
			'#### Model Response',
			'',
			'```text',
			detail.modelResponse,
			'```',
			'',
		);
	if (detail?.toolInvocations?.length)
		blocks.push(
			'#### Tool Arguments and Results',
			'',
			'```json',
			JSON.stringify(detail.toolInvocations, null, 2),
			'```',
			'',
		);
	if (detail?.evaluation)
		blocks.push(
			'#### Evaluation',
			'',
			'```json',
			JSON.stringify(detail.evaluation, null, 2),
			'```',
			'',
		);
	if (detail?.tokenUsage)
		blocks.push(
			'#### Token Usage',
			'',
			'```json',
			JSON.stringify(detail.tokenUsage, null, 2),
			'```',
			'',
		);
	if (event.meta)
		blocks.push(
			'#### Metadata',
			'',
			'```json',
			JSON.stringify(event.meta, null, 2),
			'```',
			'',
		);
	return blocks.join('\n');
}
