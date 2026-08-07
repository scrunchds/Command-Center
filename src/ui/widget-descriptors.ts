import { CUSTOM_WIDGET_PREFIX } from './card-syntax';

/**
 * widget-descriptors — declarative metadata for dashboard widgets that offer
 * alternative views.
 *
 * The dashboard layout editor (in both CommandCenterView and PluginSettingsTab)
 * reads this table to render a per-widget "view" dropdown without hardcoding
 * any panel's render modes. A widget appears in the editor's view selector only
 * when it has an entry here; widgets without entries keep their single built-in
 * presentation and get no dropdown, so adding a view never clutters unrelated
 * panels.
 *
 * Each panel that honors `view` resolves the active id through
 * {@link resolveWidgetView}, which falls back to the first listed view when the
 * saved value is absent or unknown. That keeps layouts saved before a view
 * existed working unchanged.
 */

/** One selectable view for a widget. */
export interface WidgetViewOption {
	/** Stable id stored in `DashboardWidgetLayout.view`. */
	id: string;
	/** Human label shown in the layout editor dropdown. */
	label: string;
}

/**
 * Widgets that expose alternative views, keyed by widget id.
 *
 * The first entry is the default. Add a widget here to make its views available
 * in the layout editor; the panel itself must also read the resolved view.
 */
export const WIDGET_VIEWS: Record<string, readonly WidgetViewOption[]> = {
	clock: [
		{ id: 'digital', label: 'Digital' },
		{ id: 'minimal', label: 'Minimal' },
	],
	calendar: [
		{ id: 'month', label: 'Month' },
		{ id: 'week', label: 'Week' },
		{ id: 'agenda', label: 'Agenda' },
	],
	intelligence: [
		{ id: 'kanban', label: 'Kanban' },
		{ id: 'list', label: 'List' },
		{ id: 'compact', label: 'Compact' },
	],
};

/** View options for a widget, or an empty array when it has no view variants. */
export function widgetViews(widgetId: string): readonly WidgetViewOption[] {
	return WIDGET_VIEWS[widgetId] ?? [];
}

/** Whether a widget offers any alternative views. */
export function widgetHasViews(widgetId: string): boolean {
	return (WIDGET_VIEWS[widgetId]?.length ?? 0) > 0;
}

/** The default view id for a widget, or an empty string when it has none. */
export function defaultWidgetView(widgetId: string): string {
	return WIDGET_VIEWS[widgetId]?.[0]?.id ?? '';
}

/**
 * Resolve a saved view against the widget's known views.
 *
 * Returns the saved value when it is still offered, the default when it is
 * absent or no longer recognized, and an empty string for widgets that have no
 * view variants. Callers can pass the result straight to a panel renderer.
 */
export function resolveWidgetView(widgetId: string, view: string | undefined): string {
	const views = WIDGET_VIEWS[widgetId];
	if (!views || views.length === 0) return '';
	if (view && views.some(option => option.id === view)) return view;
	return views[0]!.id;
}

/**
 * Human-readable labels for every built-in dashboard widget, keyed by id.
 *
 * This is the single source of truth for widget display names so the
 * dashboard view, the in-dashboard layout editor, and the settings tab all
 * agree on what to call a panel. Keeping it here (next to the view registry)
 * means a new widget's label and views are defined in one place.
 */
export const WIDGET_LABELS: Record<string, string> = {
	workspace: 'Operational overview',
	clock: 'Clock',
	deck: 'Command deck',
	navigator: 'Vault doorway',
	calendar: 'Calendar',
	schedule: 'Daily schedule',
	browser: 'Browser',
	intelligence: 'Happening now',
	approvals: 'Mutation approvals',
	orchestrator: 'Orchestrator',
	chatbox: 'Chatbox',
	queue: 'Task queue',
	react: 'ReAct monitor',
	bases: 'Bases controller',
	daily: 'Daily cycle',
	system: 'System state',
	daemon: 'Daemon controls',
	live: 'Live output',
	history: 'Task history',
};

/**
 * Resolve a widget id to its display label.
 *
 * Built-in ids look up {@link WIDGET_LABELS}. Custom-card ids (prefixed with
 * {@link CUSTOM_WIDGET_PREFIX}) resolve through the optional `customLabelFor`
 * callback, which lets the dashboard supply the backing note's title while the
 * settings tab (which has no live custom-card roster) falls back to the note
 * path. Both forms append “(custom card)” so the kind is always clear.
 */
export function widgetLabel(id: string, customLabelFor?: (id: string) => string | null): string {
	if (id.startsWith(CUSTOM_WIDGET_PREFIX)) {
		const custom = customLabelFor?.(id) ?? null;
		return custom ? `${custom} (custom card)` : `${id.slice(CUSTOM_WIDGET_PREFIX.length)} (custom card)`;
	}
	return WIDGET_LABELS[id] ?? id;
}