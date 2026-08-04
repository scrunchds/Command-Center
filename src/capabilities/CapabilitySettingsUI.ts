/**
 * Capability Settings UI — integrates the Capability Registry into
 * Command Center's native Obsidian Settings tab.
 *
 * This adds a "Capabilities" collapsible section to the settings
 * where users can:
 *   - Enable/disable the capability system entirely (master toggle)
 *   - View all registered capabilities grouped by category
 *   - Toggle individual capabilities on/off
 *   - Configure the maximum autonomous tool calls per ReAct cycle
 *
 * The settings UI is rendered imperatively through Obsidian's
 * `Setting` API, consistent with the existing PluginSettingsTab.
 */

import { Setting } from 'obsidian';
import type { CommandCenterSettings } from '../settings/settings-model';

/**
 * Minimal plugin surface needed to render capability settings.
 * Avoids a circular dependency with main.ts.
 */
interface CapabilitySettingsHost {
	settings: CommandCenterSettings;
	saveSettings(): Promise<void>;
}
import type { CapabilityCategory } from './CapabilityTypes';
import { getCapabilityRegistry } from './CapabilityRegistry';
import { serializeCapabilityPreferences } from './CapabilityToolAdapter';

/* ─── Category Display Names ────────────────────────────── */

const CATEGORY_LABELS: Record<CapabilityCategory, string> = {
	search: 'Search',
	file: 'File Operations',
	media: 'Media',
	time: 'Time & Date',
	memory: 'Memory',
	system: 'System',
	mcp: 'MCP (External Tools)',
	custom: 'Custom Endpoints',
	agent: 'Agent Worker Profiles',
};

const CATEGORY_ICONS: Record<CapabilityCategory, string> = {
	search: 'search',
	file: 'file',
	media: 'image-file',
	time: 'clock',
	memory: 'brain',
	system: 'gear',
	mcp: 'puzzle',
	custom: 'wrench',
	agent: 'bot',
};

/* ─── Capability Settings Section ───────────────────────── */

/**
 * Render the capability settings section into the provided container.
 * Called from PluginSettingsTab.display().
 *
 * @param container  The settings container element.
 * @param plugin     The Command Center plugin instance.
 */
export function renderCapabilitySettings(
	container: HTMLElement,
	plugin: CapabilitySettingsHost,
): void {
	const registry = getCapabilityRegistry();
	const settings = plugin.settings;

	// ── Section header ───────────────────────────────────
	container.createEl('h3', { text: 'Agent capabilities' });
	container.createEl('p', {
		text: 'Capabilities are the instruments your agents can use. Enable or disable them to control what the agent can do.',
		cls: 'cc-settings-description',
	});
	container.createDiv({ cls: 'cc-settings-separator' });

	// ── Master toggle ────────────────────────────────────
	new Setting(container)
		.setName('Enable capability system')
		.setDesc('Master toggle for all agent capabilities. When disabled, agents operate in conversation-only mode without tool access.')
		.addToggle(toggle => toggle
			.setValue(settings.capabilitySystemEnabled ?? true)
			.onChange(async (value) => {
				settings.capabilitySystemEnabled = value;
				await plugin.saveSettings();
				// Refresh the section to show/hide capability toggles
				refreshCapabilitySection(container, plugin);
			}),
		);

	// Only show capability toggles when the system is enabled
	if (!(settings.capabilitySystemEnabled ?? true)) {
		return;
	}

	// ── Max autonomous calls ─────────────────────────────
	new Setting(container)
		.setName('Maximum autonomous tool calls')
		.setDesc('The maximum number of tool invocations per agent reasoning cycle before the model is forced to synthesize a response. Higher values allow more complex multi-step tasks but increase latency and cost.')
		.addSlider(slider => slider
			.setLimits(1, 32, 1)
			.setValue(settings.capabilityMaxAutonomousCalls ?? 8)
			.onChange(async (value) => {
				settings.capabilityMaxAutonomousCalls = value;
				await plugin.saveSettings();
			}),
		);

	container.createDiv({ cls: 'cc-settings-separator' });

	// ── Capability toggles grouped by category ───────────
	const byCategory = registry.getByCategory();
	const sortedCategories = [...byCategory.entries()]
		.sort(([a], [b]) => a.localeCompare(b));

	if (sortedCategories.length === 0) {
		container.createEl('p', {
			text: 'No capabilities registered. Capabilities are registered when the plugin initializes — try reloading the plugin.',
			cls: 'cc-settings-empty',
		});
		return;
	}

	for (const [category, capabilities] of sortedCategories) {
		renderCategorySection(container, category, capabilities, plugin);
	}

	// ── Reset to defaults ────────────────────────────────
	container.createDiv({ cls: 'cc-settings-separator' });
	new Setting(container)
		.setName('Reset capability preferences')
		.setDesc('Reset all capability toggles to their default states.')
		.addButton(button => button
			.setButtonText('Reset to defaults')
			.setDestructive()
			.onClick(async () => {
				// Re-register defaults by clearing and re-applying built-in tools
				// This is handled by the plugin's initialization path.
				settings.capabilityPreferences = [];
				settings.capabilityMaxAutonomousCalls = 8;
				settings.capabilitySystemEnabled = true;
				await plugin.saveSettings();
				// Rebuild the section
				refreshCapabilitySection(container, plugin);
			}),
		);
}

/* ─── Category Renderer ─────────────────────────────────── */

/**
 * Render a collapsible category section with capability toggles.
 */
function renderCategorySection(
	container: HTMLElement,
	category: CapabilityCategory,
	capabilities: Array<{ meta: { id: string; label: string; description: string; executionMode: string; aliases?: string[] }; enabled: boolean }>,
	plugin: CapabilitySettingsHost,
): void {
	const categoryLabel = CATEGORY_LABELS[category] ?? category;
	const categoryIcon = CATEGORY_ICONS[category] ?? 'bullet-list';

	// Category header with collapsible toggle
	const details = container.createEl('details', {
		cls: 'cc-capability-category',
		attr: { open: '' },
	});
	const summary = details.createEl('summary', { cls: 'cc-capability-category-summary' });
	summary.createSpan({ text: `${categoryIcon} ${categoryLabel} (${capabilities.length})`, cls: 'cc-capability-category-label' });

	// Capability toggles
	for (const capability of capabilities) {
		renderCapabilityToggle(details, capability, plugin);
	}
}

/**
 * Render a single capability toggle setting.
 */
function renderCapabilityToggle(
	container: HTMLElement,
	capability: { meta: { id: string; label: string; description: string; executionMode: string; aliases?: string[] }; enabled: boolean },
	plugin: CapabilitySettingsHost,
): void {
	const setting = new Setting(container)
		.setName(capability.meta.label)
		.setDesc(buildCapabilityDescription(capability.meta))
		.addToggle(toggle => toggle
			.setValue(capability.enabled)
			.onChange(async (value) => {
				// Update the registry
				getCapabilityRegistry().setEnabled(capability.meta.id, value);
				// Persist to settings
				await persistCapabilityPreferences(plugin);
			}),
		);

	// Always-enabled capabilities get a visual indicator
	if (capability.meta.executionMode === 'always') {
		setting.setDesc(buildCapabilityDescription(capability.meta) + ' (always enabled)');
		setting.setDisabled(true);
	}
}

/* ─── Helpers ───────────────────────────────────────────── */

/**
 * Build a human-readable description string for a capability.
 */
function buildCapabilityDescription(meta: { id: string; description: string; executionMode: string; aliases?: string[] }): string {
	const parts: string[] = [meta.description];

	if (meta.aliases && meta.aliases.length > 0) {
		parts.push(`Aliases: ${meta.aliases.join(', ')}`);
	}

	return parts.join(' — ');
}

/**
 * Persist current capability preferences to plugin settings.
 */
async function persistCapabilityPreferences(plugin: CapabilitySettingsHost): Promise<void> {
	plugin.settings.capabilityPreferences = serializeCapabilityPreferences();
	await plugin.saveSettings();
}

/**
 * Refresh the capability settings section in-place.
 * Destroys and re-renders the section.
 */
function refreshCapabilitySection(
	container: HTMLElement,
	plugin: CapabilitySettingsHost,
): void {
	// Find the capability section within the container and rebuild it.
	// We target the children after the first separator.
	const existing = Array.from(container.querySelectorAll('.cc-capability-category, .cc-settings-separator'));
	for (const el of existing) {
		el.remove();
	}

	// Re-render
	const byCategory = getCapabilityRegistry().getByCategory();
	const sortedCategories = [...byCategory.entries()]
		.sort(([a], [b]) => a.localeCompare(b));

	for (const [category, capabilities] of sortedCategories) {
		renderCategorySection(container, category, capabilities, plugin);
	}
}