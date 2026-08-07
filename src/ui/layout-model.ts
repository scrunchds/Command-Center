/**
 * layout-model — pure dashboard layout arithmetic.
 *
 * Kept free of `obsidian` imports so it is unit-testable: the plugin's type
 * package ships no runtime, so anything importing it cannot load under the test
 * harness. DOM wiring lives in CommandCenterView.
 */

/** Grid is twelve columns, so spans divide evenly by 2, 3, 4, and 6. */
export const GRID_COLUMNS = 12;
export const MIN_SPAN = 3;

/** Discrete widget heights. Named rather than free pixels so themes hold. */
export const WIDGET_HEIGHTS = ['auto', 'short', 'tall', 'taller'] as const;
export type WidgetHeight = (typeof WIDGET_HEIGHTS)[number];

export type WidgetSize = 'compact' | 'standard' | 'expanded';

/** One widget's placement. `span`/`height`/`view` are optional for older saved data. */
export interface LayoutEntry {
	id: string;
	hidden: boolean;
	collapsed: boolean;
	size: WidgetSize;
	span?: number;
	height?: WidgetHeight;
	/** Alternative view id for widgets that offer more than one presentation. */
	view?: string;
}

/** Column span implied by a legacy size name, used when `span` is absent. */
export function spanForSize(size: WidgetSize): number {
	if (size === 'compact') return 4;
	if (size === 'expanded') return GRID_COLUMNS;
	return 6;
}

/** Constrain a span to the grid, snapping fractional drags to whole columns. */
export function clampSpan(span: number): number {
	if (!Number.isFinite(span)) return 6;
	return Math.min(GRID_COLUMNS, Math.max(MIN_SPAN, Math.round(span)));
}

/** Effective span for an entry, preferring an explicit drag-resized value. */
export function effectiveSpan(entry: LayoutEntry): number {
	return entry.span === undefined ? spanForSize(entry.size) : clampSpan(entry.span);
}

/** Effective height, defaulting to content-sized. */
export function effectiveHeight(entry: LayoutEntry): WidgetHeight {
	const height = entry.height;
	return height && WIDGET_HEIGHTS.includes(height) ? height : 'auto';
}

/** Convert a pixel width into a column span, given the grid's own metrics. */
export function spanFromWidth(width: number, gridWidth: number, gap: number): number {
	if (gridWidth <= 0) return 6;
	// Gaps sit between columns, so remove them before dividing.
	const track = (gridWidth - gap * (GRID_COLUMNS - 1)) / GRID_COLUMNS;
	if (track <= 0) return 6;
	return clampSpan((width + gap) / (track + gap));
}

/**
 * Reconcile a saved layout against the widgets that actually exist.
 *
 * A saved entry survives only if its widget still exists, so deleting a card
 * note also retires its row. Newly shipped built-ins are inserted at their
 * default neighbour rather than appended, because appending would drop a new
 * panel at the bottom of an existing user's dashboard — far from the related
 * panels it was designed to sit beside. Custom cards are appended, since the
 * default order has no opinion about where a user's own note belongs.
 */
export function mergeLayout(saved: LayoutEntry[], defaults: LayoutEntry[], customIds: string[]): LayoutEntry[] {
	const defaultIndex = new Map(defaults.map((entry, index) => [entry.id, index]));
	const known = new Set([...defaultIndex.keys(), ...customIds]);
	const seen = new Set<string>();

	// Keep the user's order, dropping retired widgets and any duplicates.
	const merged: LayoutEntry[] = [];
	for (const entry of saved) {
		if (!known.has(entry.id) || seen.has(entry.id)) continue;
		seen.add(entry.id);
		merged.push({ ...entry });
	}

	for (const fallback of defaults) {
		if (seen.has(fallback.id)) continue;
		seen.add(fallback.id);

		// Anchor to the nearest widget that precedes it in the default order and
		// insert just after it. Anchoring to the *following* widget instead looks
		// equivalent but breaks once the user reorders: a panel whose default
		// successor was dragged to the top would be pulled to the top with it.
		const rank = defaultIndex.get(fallback.id) ?? Number.MAX_SAFE_INTEGER;
		let at = -1;
		for (let i = 0; i < merged.length; i++) {
			const entry = merged[i];
			if (!entry) continue;
			const entryRank = defaultIndex.get(entry.id);
			if (entryRank !== undefined && entryRank < rank) at = i;
		}
		merged.splice(at + 1, 0, { ...fallback });
	}

	for (const id of customIds) {
		if (seen.has(id)) continue;
		seen.add(id);
		merged.push({ id, hidden: false, collapsed: false, size: 'standard' });
	}

	return merged;
}

/**
 * Move `id` so it sits before `beforeId`, or last when `beforeId` is null.
 *
 * Returns the original array when the move is a no-op, so callers can skip a
 * redundant save and re-render.
 */
export function reorderLayout(layout: LayoutEntry[], id: string, beforeId: string | null): LayoutEntry[] {
	const from = layout.findIndex(entry => entry.id === id);
	if (from === -1 || id === beforeId) return layout;

	const without = layout.filter(entry => entry.id !== id);
	const to = beforeId === null ? without.length : without.findIndex(entry => entry.id === beforeId);
	if (to === -1) return layout;
	// Dropping onto the position it already occupies changes nothing.
	if (to === from) return layout;

	const moved = layout[from];
	if (!moved) return layout;
	without.splice(to, 0, moved);
	return without;
}

/** Shift a widget one slot up (-1) or down (+1), clamped at the ends. */
export function nudgeLayout(layout: LayoutEntry[], id: string, delta: number): LayoutEntry[] {
	const from = layout.findIndex(entry => entry.id === id);
	if (from === -1) return layout;
	const to = from + delta;
	if (to < 0 || to >= layout.length) return layout;

	const next = layout.map(entry => ({ ...entry }));
	const [moved] = next.splice(from, 1);
	if (!moved) return layout;
	next.splice(to, 0, moved);
	return next;
}
