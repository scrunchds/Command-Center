/**
 * Shared time-formatting helpers.
 *
 * The plugin reads the user's OS hour12/24h preference by default
 * (`timeFormat: 'system'`) and lets them force 12h or 24h from the Paths tab.
 * Centralizing this keeps the clock widget, schedule widget, write-gate log,
 * and chat timestamps consistent.
 */

export type TimeFormatPreference = 'system' | '12h' | '24h';

/** Detect whether the system locale prefers 12-hour (AM/PM) display. */
export function systemUses12Hour(): boolean {
	try {
		// Intl resolves the locale's hour12 default without constructing a Date.
		const parts = new Intl.DateTimeFormat(undefined, { hour: 'numeric' });
		return /(?:a\.?m\.?|p\.?m\.?)/i.test(parts.format(new Date(0))) || parts.resolvedOptions().hour12 === true;
	} catch {
		return false;
	}
}

/** Resolve the effective hour12 flag for a user preference. */
export function resolveHour12(preference: TimeFormatPreference): boolean {
	if (preference === '12h') return true;
	if (preference === '24h') return false;
	return systemUses12Hour();
}

/**
 * Format a Date as a wall-clock time, honoring the user's preference.
 * `withSeconds` adds a seconds field (used by the clock widget).
 */
export function formatTime(date: Date, preference: TimeFormatPreference = 'system', withSeconds = false): string {
	const hour12 = resolveHour12(preference);
	try {
		return new Intl.DateTimeFormat(undefined, {
			hour: 'numeric',
			minute: '2-digit',
			...(withSeconds ? { second: '2-digit' } : {}),
			hour12,
		}).format(date);
	} catch {
		// Last-resort deterministic fallback so a bad locale never blanks a clock.
		const pad = (n: number) => String(n).padStart(2, '0');
		return withSeconds
			? `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
			: `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	}
}
