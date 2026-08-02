/**
 * Plugin Settings Tab — dynamic, interactive settings UI for Command Center.
 *
 * Features:
 *   • Collapsible provider credential cards with live health status dots
 *   • Secure API key inputs (password type, show/hide toggle)
 *   • Base URL configuration with one-click reset to provider defaults
 *   • Real-time connection health checks (per-provider + bulk "Test All")
 *   • Interactive task-to-model routing matrix with capability indicators
 *   • Fallback pipeline configuration with drag-friendly reordering
 *   • Debounced auto-save with visual feedback
 *   • Cost-tier badges, capability badges, and context-window labels
 */

import {
	App,
	PluginSettingTab,
	Setting,
	Notice,
	ButtonComponent,
	type TextComponent,
} from 'obsidian';
import CommandCenterPlugin from '../main';
import type {
	ProviderId,
	TaskType,
	ProviderModel,
} from '../providers/provider-types';
import { TASK_TYPE_LABELS, TASK_TYPE_ICONS } from '../providers/provider-types';
import {
	PROVIDER_REGISTRY,
	getDefaultModelForProvider,
} from '../providers/provider-registry';
import { DEFAULT_ROUTING } from '../routing';
import {
	METACOGNITIVE_DEPTH_MIN,
	METACOGNITIVE_DEPTH_MAX,
} from '../settings';
import { detectPiPath, clearPiDetectionCache } from '../daemon';
import { CredentialVaultModal } from '../security/CredentialVaultModal';

/* ═══════════════════════════════════════════════════════════
   Constants
   ═══════════════════════════════════════════════════════════ */

const DEVELOPER_SUPPORT_URL = 'https://buymeacoffee.com/DustinS';

const COST_TIER_LABELS: Record<string, string> = {
	free: '🆓 Free',
	cheap: '💸 Cheap',
	moderate: '💰 Moderate',
	expensive: '💎 Expensive',
};

const PROVIDER_ORDER: ProviderId[] = [
	'pi-daemon',
	'openai',
	'anthropic',
	'google-gemini',
	'openrouter',
	'groq',
	'deepinfra',
	'mistral',
	'cohere',
	'ollama',
	'lmstudio',
	'custom',
];

const TASK_TYPE_ORDER: TaskType[] = [
	'coding',
	'vision',
	'reading',
	'reasoning',
	'fast',
];

/** Background sync interval in milliseconds (5 minutes). */
const MODEL_SYNC_INTERVAL_MS = 5 * 60 * 1000;

/** Minimum time between syncs for a single provider (30 seconds). */
const MODEL_SYNC_THROTTLE_MS = 30_000;

/**
 * Per-provider model sync state (transient, not persisted).
 */
interface ModelSyncState {
	status: 'idle' | 'syncing' | 'synced' | 'error';
	lastSyncAt: number | null;
	modelCount: number;
	error?: string;
}

function makeSyncState(): ModelSyncState {
	return { status: 'idle', lastSyncAt: null, modelCount: 0 };
}

/* ═══════════════════════════════════════════════════════════
   PluginSettingsTab
   ═══════════════════════════════════════════════════════════ */

type SettingsTabId = 'all' | 'core' | 'providers' | 'routing' | 'health';

export class PluginSettingsTab extends PluginSettingTab {
	plugin: CommandCenterPlugin;

	/* ─── Transient UI state (not persisted) ─────────── */
	private healthStatus = new Map<
		ProviderId,
		'idle' | 'checking' | 'ok' | 'error'
	>();
	private healthErrors = new Map<ProviderId, string>();
	private collapsedSections = new Set<string>();
	private selectedTab: SettingsTabId = 'all';
	private saveIndicator: HTMLElement | null = null;
	private routesContainer: HTMLElement | null = null;

	/* ─── Model sync state (transient) ──────────────── */
	private modelSyncStates = new Map<ProviderId, ModelSyncState>();
	private backgroundSyncTimer: number | null = null;

	constructor(app: App, plugin: CommandCenterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Provide setting definitions for Obsidian 1.13.0+ settings search.
	 * Maps setting keys to display names so users can find Command Center
	 * settings by typing in the Obsidian settings search bar.
	 */
	getSettingDefinitions(): Array<{ key: string; name: string }> {
		return [];
	}

	/* ═══════════════════════════════════════════════════════
	   Display
	   ═══════════════════════════════════════════════════════ */

	display(): void {
		this.renderImperativeSettings();
	}

	/** Refresh the imperative settings UI after an interaction. */
	override update(): void {
		this.renderImperativeSettings();
	}

	private renderImperativeSettings(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('cc-settings');

		const header = containerEl.createDiv({ cls: 'cc-settings-header' });
		this.saveIndicator = header.createDiv({ cls: 'cc-save-indicator' });
		this.renderTabBar(containerEl);

		const content = containerEl.createDiv({ cls: 'cc-settings-content', attr: { role: 'tabpanel', 'aria-label': 'Command Center settings content' } });
		if (this.selectedTab === 'all' || this.selectedTab === 'core') {
			this.renderCoreSettings(content);
			this.renderMetacognitiveDepth(content);
		}
		if (this.selectedTab === 'all' || this.selectedTab === 'providers') {
			this.renderProviderCredentials(content);
		}
		if (this.selectedTab === 'all' || this.selectedTab === 'routing') {
			this.renderRoutingMatrix(content);
			this.renderFallbackPipeline(content);
		}
		if (this.selectedTab === 'all' || this.selectedTab === 'health') {
			this.renderHealthDashboard(content);
		}

		this.renderFooter(containerEl);
		this.startBackgroundSync();
	}

	/* ═══════════════════════════════════════════════════════
	   Section 1: Core Settings
	   ═══════════════════════════════════════════════════════ */

	private renderCoreSettings(containerEl: HTMLElement): void {
		this.renderSectionHeader(containerEl, 'core', '🔧 Core Configuration');

		const body = this.getSectionBody(containerEl, 'core');

		// Worker profile
		new Setting(body)
			.setName('Active Worker Profile')
			.setDesc(
				'Default agent profile used when no explicit profile is specified.',
			)
			.addDropdown((d) => {
				d.addOption('default-orchestrator', 'Orchestrator');
				d.addOption('retriever', 'Retriever');
				d.addOption('summarizer', 'Summarizer');
				d.addOption('editor', 'Editor');
				d.addOption('react-orchestrator', 'ReAct Orchestrator');
				d.setValue(this.plugin.settings.activeProfile).onChange((v) =>
					this.saveSetting('activeProfile', v),
				);
				return d;
			});

		new Setting(body)
			.setName('Audio cues')
			.setDesc('Play restrained cues when dictation starts/stops and AI work completes.')
			.addToggle(toggle => toggle.setValue(this.plugin.settings.audioCues).onChange(value => this.saveSetting('audioCues', value)));

		this.renderSpeechSettings(body);

		// Max tokens
		new Setting(body)
			.setName('Max Tokens')
			.setDesc(
				'Token budget ceiling for agent responses (legacy; per-provider settings override this).',
			)
			.addSlider((slider) =>
				slider
					.setLimits(512, 16384, 512)
					.setValue(this.plugin.settings.maxTokens)
					.onChange((v) => this.saveSetting('maxTokens', v)),
			);

		new Setting(body)
			.setName('Passive Prompt Context Budget')
			.setDesc('Controls how much memory and vault retrieval can be injected into chat, ReAct, and voice prompts. Higher values help long-context work; the interview flow is unaffected.')
			.addSlider((slider) =>
				slider
					.setLimits(2_000, 64_000, 1_000)
					.setValue(this.plugin.settings.contextCharLimit)
					.onChange((v) => this.saveSetting('contextCharLimit', v)),
			);

		// Pi path with auto-detect button and status
		let piDebounce: number | null = null;
		let piTextInput: TextComponent | null = null;

		const piSetting = new Setting(body)
			.setName('Pi Harness Path')
			.setDesc(
				'Path to the pi CLI binary. Use "Detect" to auto-find it, or type a custom path.',
			);

		// Status indicator showing whether the path is valid
		const isMissing = this.plugin.daemon.isBinaryMissing();
		const isRunning = this.plugin.daemon.isRunning();
		const statusEl = piSetting.descEl.createSpan({ cls: 'cc-pi-status' });
		if (isMissing) {
			statusEl.createSpan({
				cls: 'cc-pi-status-badge error',
				text: '⚠️ Not found',
			});
		} else if (isRunning) {
			statusEl.createSpan({
				cls: 'cc-pi-status-badge ok',
				text: '✅ Running',
			});
		} else if (
			this.plugin.settings.piPath &&
			this.plugin.settings.piPath !== 'pi'
		) {
			statusEl.createSpan({
				cls: 'cc-pi-status-badge idle',
				text: '◽ Configured',
			});
		} else {
			statusEl.createSpan({
				cls: 'cc-pi-status-badge idle',
				text: '◽ Default (pi)',
			});
		}

		piSetting
			.addText((text) => {
			piTextInput = text;
			text.setPlaceholder('pi')
				.setValue(this.plugin.settings.piPath)
					.onChange((value) => {
					if (piDebounce) window.clearTimeout(piDebounce);
					piDebounce = window.setTimeout( () => { void (async () => {
						piDebounce = null;
						const trimmed = value.trim();
							if (
								!trimmed ||
								trimmed === this.plugin.settings.piPath
							)
								return;
						const wasRunning = this.plugin.daemon.isRunning();
						const ok = this.plugin.setDaemonPath(trimmed);
						if (!ok) {
								new Notice(
									'Cannot change pi path while a task is active.',
								);
							text.setValue(this.plugin.settings.piPath);
							return;
						}
						this.plugin.settings.piPath = trimmed;
						await this.plugin.saveSettings();
						if (wasRunning) {
							this.plugin.restartDaemon();
							new Notice(`Daemon restarted with: ${trimmed}`);
						}
						this.showSaved();
					})(); }, 1000);
				});
			return text;
		})
			.addButton((btn) => {
			btn.setButtonText('🔍 Detect');
			btn.setTooltip('Auto-detect pi binary location');
			btn.onClick( () => { void (async () => {
				clearPiDetectionCache();
				btn.setDisabled(true);
				btn.setButtonText('⏳ Detecting...');
				try {
					const detected = detectPiPath();
					if (detected) {
						const wasRunning = this.plugin.daemon.isRunning();
						const ok = this.plugin.setDaemonPath(detected);
						if (!ok) {
								new Notice(
									'Cannot change pi path while a task is active.',
								);
							return;
						}
						this.plugin.settings.piPath = detected;
						await this.plugin.saveSettings();
						// Always start (or restart) the daemon with the detected path
						this.plugin.restartDaemon();
							new Notice(
								`✅ Pi detected and daemon ${wasRunning ? 'restarted' : 'started'}: ${detected}`,
							);
						this.showSaved();
						if (piTextInput) piTextInput.setValue(detected);
						this.update();
					} else {
							new Notice(
								'❌ Could not auto-detect pi. Install it via: npm i -g pi',
							);
					}
				} finally {
					btn.setDisabled(false);
					btn.setButtonText('🔍 Detect');
				}
			})(); });
			return btn;
		});

		// Enable daemon
		new Setting(body)
			.setName('Auto-start Daemon')
			.setDesc(
				'Launch the pi agent daemon automatically when the plugin loads.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableDaemon)
					.onChange( (v) => { void (async () => {
						this.plugin.settings.enableDaemon = v;
						await this.plugin.saveSettings();
						if (v && !this.plugin.daemon.isRunning()) {
							this.plugin.daemon.start();
							this.plugin.statusBar.setState('running');
						} else if (!v && this.plugin.daemon.isRunning()) {
							this.plugin.daemon.stop();
							this.plugin.statusBar.setState('stopped');
						}
					})(); }),
			);

		new Setting(body)
			.setName('Silent Daily Startup')
			.setDesc(
				'Morning Start evaluates capacity and assembles today’s note without intermediate approval prompts. Inbox proposals remain unapproved and are summarized for later review.',
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.silentDailyStartup)
					.onChange((v) => this.saveSetting('silentDailyStartup', v)),
			);

		// Memory bank limit
		new Setting(body)
			.setName('Memory Bank Limit')
			.setDesc('Maximum memory notes to retain before auto-pruning.')
			.addSlider((slider) =>
				slider
					.setLimits(20, 500, 20)
					.setValue(this.plugin.settings.memoryMaxNotes)
					.onChange((v) => this.saveSetting('memoryMaxNotes', v)),
			);
	}

	/* ═══════════════════════════════════════════════════════
	   Section 1b: Metacognitive Depth (Command-Center)
	   ═══════════════════════════════════════════════════════ */

	private renderMetacognitiveDepth(containerEl: HTMLElement): void {
		this.renderSectionHeader(
			containerEl,
			'metacognitive',
			'🧭 Metacognitive Depth (Quality-Cost)',
			'Command-Center native auto-router. 1 = local / cheapest, 10 = cloud / premium. Integer only. Drives intent resolution against model_matrix.json; the existing fallback chain remains authoritative on any failure.',
		);
		const body = this.getSectionBody(containerEl, 'metacognitive');

		// Slider bound to plugin.settings.metacognitiveDepth. Clamped to
		// [METACOGNITIVE_DEPTH_MIN, METACOGNITIVE_DEPTH_MAX] on change so no
		// fractional or out-of-range value ever reaches the auto-router.
		const depthSetting = new Setting(body)
			.setName('Depth')
			.setDesc(
				`Integer ${METACOGNITIVE_DEPTH_MIN}-${METACOGNITIVE_DEPTH_MAX}. ` +
					'Lower biases toward local models (lmstudio / ollama / pi-daemon); ' +
					'higher escalates to cloud endpoints.',
			);

		// Numeric label that mirrors the slider — Obsidian's slider tooltip
		// shows decimal by default, so a discrete label keeps the 1-10 contract
		// explicit (Directive 1.6: integer scale only).
		const valueLabel = body.createDiv({ cls: 'cc-metacognitive-depth-value' });
		const renderLabel = (v: number): void => {
			valueLabel.textContent = String(v);
		};

		depthSetting.addSlider((slider) =>
			slider
				.setLimits(
					METACOGNITIVE_DEPTH_MIN,
					METACOGNITIVE_DEPTH_MAX,
					1,
				)
				.setValue(this.plugin.settings.metacognitiveDepth)
				.onChange((v) => {
					const clamped = Math.max(
						METACOGNITIVE_DEPTH_MIN,
						Math.min(METACOGNITIVE_DEPTH_MAX, Math.round(v)),
				);
					renderLabel(clamped);
					void this.saveSetting('metacognitiveDepth', clamped);
				}),
		);
		renderLabel(this.plugin.settings.metacognitiveDepth);

		// Reset-to-default affordance so a misconfigured slider is one click
		// from the local-first baseline (depth 3).
		depthSetting.addExtraButton((btn) =>
			btn
				.setIcon('rotate-ccw')
				.setTooltip('Reset to default (3)')
				.onClick(() => {
					void this.saveSetting('metacognitiveDepth', 3).then(() =>
						this.update(),
					);
				}),
		);
	}

	private renderSpeechSettings(containerEl: HTMLElement): void {
		this.renderSectionHeader(containerEl, 'speech', '🗣️ Accessibility & Speech');

		const body = this.getSectionBody(containerEl, 'speech');

		new Setting(body)
			.setName('Enable text to speech')
			.setDesc('Read assistant output aloud with the browser or system speech engine.')
			.addToggle(toggle => toggle.setValue(this.plugin.settings.textToSpeechEnabled).onChange(value => this.saveSetting('textToSpeechEnabled', value)));

		window.setTimeout(() => this.updateVoiceSelects(), 0);

		const voices = this.getSpeechVoices();
		new Setting(body)
			.setName('Text-to-speech voice')
			.setDesc(voices.length > 0 ? 'Choose a specific browser or system voice, or leave it on the default.' : 'No browser voices were reported yet; the default voice will be used.')
			.addDropdown(dropdown => {
				dropdown.selectEl.addClass('cc-text-to-speech-voice');
				dropdown.addOption('', 'Default voice');
				for (const voice of voices) {
					dropdown.addOption(voice.name, `${voice.name}${voice.default ? ' (default)' : voice.lang ? ` · ${voice.lang}` : ''}`);
				}
				dropdown.setValue(this.plugin.settings.textToSpeechVoice);
				dropdown.onChange(value => this.saveSetting('textToSpeechVoice', value));
				return dropdown;
			});

		new Setting(body)
			.setName('Text-to-speech rate')
			.setDesc('Control how fast spoken responses are read.')
			.addSlider(slider => slider.setLimits(0.5, 2.0, 0.1).setValue(this.plugin.settings.textToSpeechRate).onChange(value => this.saveSetting('textToSpeechRate', value)));

		new Setting(body)
			.setName('Automatically read AI responses')
			.setDesc('Read completed AI responses aloud automatically. Every response also has a manual Read aloud control.')
			.addToggle(toggle => toggle.setValue(this.plugin.settings.autoReadAiResponses).onChange(value => this.saveSetting('autoReadAiResponses', value)));

		new Setting(body)
			.setName('Enable speech to text')
			.setDesc('Allow voice recording and transcription for chat, workflow voice prompts, and dictation.')
			.addToggle(toggle => toggle.setValue(this.plugin.settings.speechToTextEnabled).onChange(value => this.saveSetting('speechToTextEnabled', value)));

		const sttProviders: Array<'auto' | ProviderId> = ['auto', 'lmstudio', 'ollama', 'groq', 'openai', 'deepinfra', 'openrouter', 'custom'];
		new Setting(body)
			.setName('Speech-to-text provider')
			.setDesc('Auto uses the normal fallback order; pick a provider to prefer it first.')
			.addDropdown(dropdown => {
				for (const providerId of sttProviders) {
					dropdown.addOption(providerId, providerId === 'auto' ? 'Auto' : PROVIDER_REGISTRY[providerId].label);
				}
				dropdown.setValue(this.plugin.settings.speechToTextProviderId);
				dropdown.onChange(value => this.saveSetting('speechToTextProviderId', value as 'auto' | ProviderId));
				return dropdown;
			});

		new Setting(body)
			.setName('Speech-to-text model')
			.setDesc('Leave blank to use the provider default or live model discovery.')
			.addText(text => text.setPlaceholder('whisper-large-v3-turbo').setValue(this.plugin.settings.speechToTextModel).onChange(value => this.saveSetting('speechToTextModel', value)));
	}

	/* ═══════════════════════════════════════════════════════
	   Section 2: Provider Credentials
	   ═══════════════════════════════════════════════════════ */

	private renderProviderCredentials(containerEl: HTMLElement): void {
		const headerRow = this.renderSectionHeader(
			containerEl,
			'providers',
			'🌐 Provider Credentials',
			'Configure API keys and endpoints. Providers without credentials are skipped during routing.',
		);

		// Bulk action bar
		const actionBar = headerRow.createDiv({ cls: 'cc-provider-actions' });
		this.createButton(actionBar, '🔐 Manage API Keys', () => {
			new CredentialVaultModal(this.app, this.plugin, () => this.update()).open();
		});
		actionBar.createSpan({
			cls: 'cc-provider-key-badge',
			text: this.plugin.credentialVault.unlocked ? '🔓 Vault unlocked' : '🔒 Vault locked · local-only',
		});
		const testAllBtn = this.createButton(actionBar, 'Test All', async () => {
			testAllBtn.setButtonText('Testing...');
			testAllBtn.setDisabled(true);
			await this.healthCheckAll();
			testAllBtn.setButtonText('Test All');
			testAllBtn.setDisabled(false);
		});
		// Sync All Models — refreshes live models for all enabled providers
		const syncAllBtn = this.createButton(actionBar, '🔄 Sync All Models', async () => {
			syncAllBtn.setButtonText('⏳ Syncing...');
			syncAllBtn.setDisabled(true);
			await this.syncAllModels();
			syncAllBtn.setButtonText('🔄 Sync All Models');
			syncAllBtn.setDisabled(false);
		});
		this.createButton(actionBar, 'Collapse All', () => {
			for (const pid of PROVIDER_ORDER) this.collapsedSections.add(`provider-${pid}`);
			this.update();
		});
		this.createButton(actionBar, 'Expand All', () => {
			for (const pid of PROVIDER_ORDER) this.collapsedSections.delete(`provider-${pid}`);
			this.update();
		});

		const body = this.getSectionBody(containerEl, 'providers');
		body.addClass('cc-provider-grid');

		for (const pid of PROVIDER_ORDER) {
			this.renderProviderCard(body, pid);
		}
	}

	private renderProviderCard(container: HTMLElement, pid: ProviderId): void {
		const meta = PROVIDER_REGISTRY[pid];
		if (!meta) return;

		const mp = this.plugin.settings.multiProvider;
		// Key-requiring providers default to enabled (a configured API key is the
		// opt-in); keyless local providers (LM Studio, Ollama, custom) default to
		// disabled so unconfigured localhost endpoints are never tried.
		const cred = mp.credentials[pid] ?? {
			providerId: pid,
			apiKey: '',
			baseUrl: meta.defaultBaseUrl ?? '',
			enabled: meta.requiresKey ? true : false,
		};
		if (!mp.credentials[pid]) mp.credentials[pid] = cred;

		const collapsed = this.collapsedSections.has(`provider-${pid}`);
		const health = this.healthStatus.get(pid) ?? 'idle';
		const credentialReady = !meta.requiresKey || this.plugin.credentialVault.has(pid);
		const enabled = cred.enabled;

		const card = container.createDiv({
			cls: `cc-provider-card ${enabled ? 'enabled' : ''} ${health === 'ok' ? 'healthy' : ''} ${health === 'error' ? 'unhealthy' : ''}`,
		});

		// ── Card Header ───────────────────────────────
		const cardHeader = card.createDiv({ cls: 'cc-provider-card-header' });

		// Health dot
		const dot = cardHeader.createSpan({ cls: `cc-health-dot ${health}` });
		dot.setAttribute(
			'title',
			health === 'ok'
				? 'Connected'
				: health === 'error'
					? (this.healthErrors.get(pid) ?? 'Error')
					: health === 'checking'
						? 'Checking...'
						: 'Not tested',
		);

		// Provider icon + name
		cardHeader.createSpan({ cls: 'cc-provider-icon', text: meta.icon });
		const info = cardHeader.createSpan({ cls: 'cc-provider-info' });
		info.createSpan({ cls: 'cc-provider-name', text: meta.label });
		const authentication = meta.authentication ?? (meta.requiresKey ? 'required' : 'none');
		info.createSpan({
			cls: `cc-provider-key-badge ${authentication === 'none' ? 'free' : ''}`,
			text: authentication === 'required' ? '🔑 Key Required' : authentication === 'optional' ? '🔐 Optional Authentication' : '🆓 No Key',
		});

		// Enable toggle (in header)
		const toggleContainer = cardHeader.createDiv({
			cls: 'cc-provider-toggle',
		});
		new Setting(toggleContainer).addToggle((toggle) => {
			toggle.setValue(enabled).onChange( (v) => { void (async () => {
						const c = mp.credentials[pid]!;
						c.enabled = v;
						this.plugin.providerFactory.invalidate(pid);
						if (!v) {
							this.healthStatus.set(pid, 'idle');
							this.healthErrors.delete(pid);
						}
						await this.plugin.saveSettings();
						this.showSaved();
						// Update card class without full re-render
				if (v) {
					card.addClass('enabled');
					card.removeClass('unhealthy');
				} else card.removeClass('enabled', 'healthy', 'unhealthy');
					})(); });
				return toggle;
			});

		// Collapse toggle
		const collapseBtn = cardHeader.createSpan({
			cls: 'cc-collapse-toggle',
		});
		collapseBtn.textContent = collapsed ? '▶' : '▼';
		collapseBtn.addEventListener('click', () => {
			if (collapsed) {
				this.collapsedSections.delete(`provider-${pid}`);
			} else {
				this.collapsedSections.add(`provider-${pid}`);
			}
			this.update();
		});

		// ── Card Body (collapsible) ───────────────────
		if (collapsed) {
			card.addClass('collapsed');
			return;
		}

		const cardBody = card.createDiv({ cls: 'cc-provider-card-body' });

		// Description
		cardBody.createEl('p', {
			cls: 'cc-provider-desc',
			text: meta.description,
		});

		// Capability badges
		const capsRow = cardBody.createDiv({ cls: 'cc-capability-badges' });
		const caps = meta.capabilities;
		if (caps.streaming)
			capsRow.createSpan({ cls: 'cc-cap-badge', text: '📡 Streaming' });
		if (caps.toolCalling)
			capsRow.createSpan({ cls: 'cc-cap-badge', text: '🔧 Tools' });
		if (caps.vision)
			capsRow.createSpan({ cls: 'cc-cap-badge', text: '👁️ Vision' });
		if (caps.promptCaching)
			capsRow.createSpan({ cls: 'cc-cap-badge', text: '💾 Caching' });
		if (caps.embeddings)
			capsRow.createSpan({ cls: 'cc-cap-badge', text: '📊 Embeddings' });
		capsRow.createSpan({
			cls: 'cc-cap-badge ctx',
			text: `📐 ${this.formatContext(caps.maxContextWindow)} ctx`,
		});

		// Required and optional API keys are managed only in the encrypted modal.
		if (authentication !== 'none') {
			const keyRow = cardBody.createDiv({ cls: 'cc-credential-row' });
			keyRow.createSpan({ cls: 'cc-credential-label', text: authentication === 'required' ? 'API Key' : 'Optional API Key' });
			keyRow.createSpan({
				cls: 'cc-provider-key-badge',
				text: !this.plugin.credentialVault.unlocked ? '🔒 Vault locked' : this.plugin.credentialVault.has(pid) ? '🔐 Configured' : authentication === 'optional' ? 'Not configured · unauthenticated' : 'Not configured',
			});
			const manage = keyRow.createEl('button', { text: 'Open Secrets' });
			manage.addEventListener('click', () => new CredentialVaultModal(this.app, this.plugin, () => this.update()).open());
		}

		// Base URL — HTTP providers only. Pi Daemon is a local subprocess.
		if (pid !== 'pi-daemon') {
			const urlRow = cardBody.createDiv({ cls: 'cc-credential-row' });
			urlRow.createSpan({ cls: 'cc-credential-label', text: 'Base URL' });

			const urlContainer = urlRow.createDiv({ cls: 'cc-url-container' });
			const urlInput = urlContainer.createEl('input', {
				type: 'text',
				cls: 'cc-url-input',
				attr: {
					placeholder: meta.defaultBaseUrl ?? '',
					spellcheck: 'false',
				},
			});
			const currentUrl =
				cred.baseUrl !== meta.defaultBaseUrl ? cred.baseUrl : '';
			urlInput.value = currentUrl;

			const defaultLabel = urlContainer.createSpan({
				cls: 'cc-url-default-label',
			});
			if (!currentUrl) {
				defaultLabel.textContent = `(default: ${meta.defaultBaseUrl ?? 'N/A'})`;
			}

			// Live advisory: the runtime keeps only the first comma-delimited URL
			// (sanitizeBaseUrl in provider-types.ts). Surface this so users do
			// not silently lose endpoints they pasted in bulk. The stored value
			// is unchanged; only the visual state reflects the runtime behavior.
			const urlWarning = urlContainer.createSpan({ cls: 'cc-url-warning' });
			const syncUrlWarning = (): void => {
				const invalid = urlInput.value.includes(',');
				urlInput.classList.toggle('cc-url-input-invalid', invalid);
				urlWarning.classList.toggle('is-visible', invalid);
				urlWarning.textContent = invalid
					? '⚠ Multiple URLs detected. Only the first URL will be used for connections.'
					: '';
			};
			syncUrlWarning();
			urlInput.addEventListener('input', syncUrlWarning);

			urlInput.addEventListener('change',  () => { void (async () => {
				const c = mp.credentials[pid]!;
				const val = urlInput.value.trim();
				c.baseUrl = val || (meta.defaultBaseUrl ?? '');
				defaultLabel.textContent = val
					? '(custom)'
					: `(default: ${meta.defaultBaseUrl ?? 'N/A'})`;
				this.plugin.providerFactory.invalidate(pid);
				this.healthStatus.set(pid, 'idle');
				this.healthErrors.delete(pid);
				await this.plugin.saveSettings();
				this.showSaved();
			})(); });

			if (meta.defaultBaseUrl && cred.baseUrl !== meta.defaultBaseUrl) {
				const resetBtn = urlContainer.createSpan({
					cls: 'cc-url-reset',
					text: '↩ Reset',
				});
				resetBtn.addEventListener('click',  () => { void (async () => {
					const c = mp.credentials[pid]!;
					c.baseUrl = meta.defaultBaseUrl!;
					urlInput.value = '';
					syncUrlWarning();
					defaultLabel.textContent = `(default: ${meta.defaultBaseUrl})`;
					this.plugin.providerFactory.invalidate(pid);
					await this.plugin.saveSettings();
					this.showSaved();
				})(); });
			}
		}

		// ── Available Models ──────────────────────────
		if (meta.models.length > 0 || pid !== 'pi-daemon') {
			const modelsRow = cardBody.createDiv({ cls: 'cc-models-row' });
			const modelsLabel = modelsRow.createDiv({
				cls: 'cc-models-header',
			});
			modelsLabel.createSpan({
				cls: 'cc-credential-label',
				text: 'Models',
			});

			// Sync state indicator
			const syncState = this.modelSyncStates.get(pid) ?? makeSyncState();
			const syncIndicator = modelsLabel.createSpan({
				cls: `cc-sync-indicator ${syncState.status}`,
			});
			this.updateSyncIndicator(syncIndicator, syncState);

			// Refresh Models button
			const refreshBtn = modelsLabel.createEl('button', {
				text: syncState.status === 'syncing' ? '⏳' : '🔄',
				cls: 'cc-refresh-models-btn',
				attr: { title: 'Fetch live models from provider' },
			});
			if (
				syncState.status === 'syncing' ||
				(!enabled && meta.requiresKey) ||
				!credentialReady
			) {
				refreshBtn.disabled = true;
				if (!credentialReady) {
					refreshBtn.setAttribute('title', 'Open Secrets to refresh live models.');
				}
			}
			refreshBtn.addEventListener('click',  () => { void (async () => {
				await this.syncProviderModels(pid);
				this.update();
			})(); });

			// Determine which models to display: live (synced) or static (fallback)
			const mp = this.plugin.settings.multiProvider;
			const liveModels = mp.liveModels?.[pid];
			const displayModels =
				liveModels && liveModels.length > 0 ? liveModels : meta.models;
			const isLive = liveModels && liveModels.length > 0;

			// Model count + source label
			if (displayModels.length > 0) {
				modelsLabel.createSpan({
					cls: 'cc-models-source',
					text: isLive
						? `${displayModels.length} live`
						: `${displayModels.length} static (fallback)`,
				});
			}

			const modelsList = modelsRow.createDiv({ cls: 'cc-models-list' });
			for (const m of displayModels) {
				const modelChip = modelsList.createSpan({
					cls: 'cc-model-chip',
				});
				modelChip.createSpan({
					cls: 'cc-model-chip-name',
					text: m.label,
				});
				if (m.supportsVision)
					modelChip.createSpan({
						cls: 'cc-model-chip-cap',
						text: '👁️',
					});
				if (m.supportsCaching)
					modelChip.createSpan({
						cls: 'cc-model-chip-cap',
						text: '💾',
					});
				modelChip.createSpan({
					cls: 'cc-model-chip-cost',
					text: COST_TIER_LABELS[m.costTier] ?? m.costTier,
				});
				modelChip.createSpan({
					cls: 'cc-model-chip-ctx',
					text: `${this.formatContext(m.contextWindow)} ctx`,
				});
			}

			// Show sync error if present
			if (syncState.status === 'error' && syncState.error) {
				modelsRow.createSpan({
					cls: 'cc-sync-error',
					text: `⚠️ Sync failed: ${syncState.error.slice(0, 80)}`,
				});
			}
		}

		// ── Test Connection & Actions ──────────────────
		const actionsRow = cardBody.createDiv({
			cls: 'cc-provider-actions-row',
		});

		// For pi-daemon with missing binary, show a prominent fix-it message
		if (pid === 'pi-daemon' && this.plugin.daemon.isBinaryMissing()) {
			const fixMsg = cardBody.createDiv({
				cls: 'cc-missing-binary-notice',
			});
			fixMsg.createSpan({ cls: 'cc-missing-binary-icon', text: '⚠️' });
			fixMsg.createSpan({
				cls: 'cc-missing-binary-text',
				text: 'Pi binary not detected. To fix: install pi via npm (npm i -g pi) or update the path above.',
			});
		}

		// Test button
		const testBtn = actionsRow.createEl('button', {
			text:
				health === 'checking' ? '⏳ Testing...' : '🔍 Test Connection',
			cls: 'cc-test-btn',
		});
		if (
			health === 'checking' ||
			(meta.requiresKey && (!enabled || !this.plugin.credentialVault.has(pid)))
		) {
			testBtn.disabled = true;
		}
		testBtn.addEventListener('click',  () => { void (async () => {
			await this.runHealthCheck(pid);
			this.update();
		})(); });

	}

	/* ═══════════════════════════════════════════════════════
	   Section 3: Task Routing Matrix
	   ═══════════════════════════════════════════════════════ */

	private renderRoutingMatrix(containerEl: HTMLElement): void {
		const headerRow = this.renderSectionHeader(
			containerEl,
			'routing',
			'🔀 Task Routing Matrix',
			'Assign each task type to a provider and model. Routing determines which AI handles your requests.',
		);

		const actionBar = headerRow.createDiv({ cls: 'cc-provider-actions' });
		this.createButton(actionBar, 'Reset to Defaults', async () => {
			this.plugin.settings.multiProvider.routing = { ...DEFAULT_ROUTING };
			await this.plugin.saveSettings();
			this.showSaved();
			this.update();
		});

		const body = this.getSectionBody(containerEl, 'routing');
		this.routesContainer = body.createDiv({ cls: 'cc-routing-matrix' });

		// Table header
		const headerRow2 = this.routesContainer.createDiv({
			cls: 'cc-routing-header',
		});
		headerRow2.createSpan({
			cls: 'cc-routing-cell task',
			text: 'Task Type',
		});
		headerRow2.createSpan({
			cls: 'cc-routing-cell provider',
			text: 'Provider',
		});
		headerRow2.createSpan({ cls: 'cc-routing-cell model', text: 'Model' });
		headerRow2.createSpan({
			cls: 'cc-routing-cell status',
			text: 'Status',
		});

		const mp = this.plugin.settings.multiProvider;

		for (const tt of TASK_TYPE_ORDER) {
			const route = mp.routing[tt] ?? DEFAULT_ROUTING[tt];
			if (!mp.routing[tt]) mp.routing[tt] = { ...route };

			const row = this.routesContainer.createDiv({
				cls: 'cc-routing-row',
			});

			// Task type label
			const taskCell = row.createDiv({ cls: 'cc-routing-cell task' });
			taskCell.createSpan({
				cls: 'cc-routing-task-icon',
				text: TASK_TYPE_ICONS[tt],
			});
			taskCell.createSpan({
				cls: 'cc-routing-task-label',
				text: TASK_TYPE_LABELS[tt],
			});

			// Provider dropdown
			const providerCell = row.createDiv({
				cls: 'cc-routing-cell provider',
			});
			const enabledProviders = PROVIDER_ORDER.filter((pid) => {
				const cred = mp.credentials[pid];
				return pid === 'pi-daemon' || cred?.enabled;
			});

			const providerSelect = providerCell.createEl('select', {
				cls: 'cc-routing-select',
			});
			for (const pid of enabledProviders) {
				const meta = PROVIDER_REGISTRY[pid];
				const opt = providerSelect.createEl('option', {
					text: `${meta?.icon ?? ''} ${meta?.label ?? pid}`,
					value: pid,
				});
				if (pid === route.providerId) opt.selected = true;
			}

			// Model dropdown
			const modelCell = row.createDiv({ cls: 'cc-routing-cell model' });
			const modelSelectContainer = modelCell.createDiv({
				cls: 'cc-routing-model-container',
			});
			const modelSelect = modelSelectContainer.createEl('select', {
				cls: 'cc-routing-select',
			});
			this.populateModelDropdown(
				modelSelect,
				route.providerId,
				route.modelId,
				mp.liveModels?.[route.providerId],
			);

			// Refresh models button for this provider
			const syncState =
				this.modelSyncStates.get(route.providerId) ?? makeSyncState();
			const modelRefreshBtn = modelSelectContainer.createEl('button', {
				text: syncState.status === 'syncing' ? '⏳' : '🔄',
				cls: 'cc-routing-refresh-btn',
				attr: {
					title:
						syncState.status === 'synced'
							? `Synced ${this.formatTimeAgo(syncState.lastSyncAt)}`
							: 'Fetch live models',
				},
			});
			if (syncState.status === 'syncing') modelRefreshBtn.disabled = true;
			modelRefreshBtn.addEventListener('click',  () => { void (async () => {
				await this.syncProviderModels(route.providerId);
				// Re-populate with live (or fallback) models
				const mp = this.plugin.settings.multiProvider;
				const liveModels = mp.liveModels?.[route.providerId];
				modelSelect.empty();
				this.populateModelDropdown(
					modelSelect,
					route.providerId,
					route.modelId,
					liveModels,
				);
				const count =
					liveModels?.length ??
					PROVIDER_REGISTRY[route.providerId]?.models.length ??
					0;
				new Notice(`Models updated: ${count} available`);
			})(); });

			// Status indicator
			const statusCell = row.createDiv({ cls: 'cc-routing-cell status' });
			this.updateRouteStatus(statusCell, route.providerId, tt);

			// Provider change → update model list
			providerSelect.addEventListener('change',  () => { void (async () => {
				const newPid = providerSelect.value as ProviderId;
				const rt = mp.routing[tt];
				rt.providerId = newPid;
				rt.modelId = getDefaultModelForProvider(newPid, tt);
				await this.plugin.saveSettings();
				this.showSaved();
				// Update model dropdown in-place
				modelSelect.empty();
				this.populateModelDropdown(
					modelSelect,
					newPid,
					rt.modelId,
					mp.liveModels?.[newPid],
				);
				this.updateRouteStatus(statusCell, newPid, tt);
			})(); });

			modelSelect.addEventListener('change',  () => { void (async () => {
				const rt = mp.routing[tt];
				rt.modelId = modelSelect.value;
				await this.plugin.saveSettings();
				this.showSaved();
			})(); });
		}
	}

	/**
	 * Populate a model dropdown select element.
	 * When liveModels are provided, they replace the static registry models.
	 * Live models are merged with registry models for known metadata.
	 */
	private populateModelDropdown(
		select: HTMLSelectElement,
		providerId: ProviderId,
		selectedId: string,
		liveModels?: ProviderModel[],
	): void {
		const meta = PROVIDER_REGISTRY[providerId];
		const staticModels = meta?.models ?? [];

		// Choose which model list to show
		const models =
			liveModels && liveModels.length > 0 ? liveModels : staticModels;

		if (models.length === 0) {
			select.createEl('option', {
				text: 'No models available',
				value: 'unknown',
			});
			return;
		}

		// Build a map of registry model IDs → metadata for merging
		const registryMap = new Map<string, ProviderModel>();
		for (const m of staticModels) registryMap.set(m.id, m);

		for (const m of models) {
			// If we have live models, prefix them to distinguish from registry
			const isLive =
				liveModels && liveModels.length > 0 && !registryMap.has(m.id);
			const prefix = isLive ? '🌐 ' : '';
			const opt = select.createEl('option', {
				text: `${prefix}${m.label} (${this.formatContext(m.contextWindow)})`,
				value: m.id,
			});
			if (m.id === selectedId) opt.selected = true;
		}

		// If no live models were returned, show a note
		if (liveModels && liveModels.length === 0) {
			select.createEl('option', {
				text: '⚠️ No models found',
				value: 'unknown',
			});
		}
	}

	private updateRouteStatus(
		cell: HTMLElement,
		providerId: ProviderId,
		taskType: TaskType,
	): void {
		cell.empty();
		const provider = this.plugin.providerFactory.get(providerId);
		const caps = PROVIDER_REGISTRY[providerId]?.capabilities;

		if (!provider.isAvailable()) {
			cell.createSpan({
				cls: 'cc-route-status error',
				text: '⚠️ Unavailable',
			});
		} else if (taskType === 'vision' && caps && !caps.vision) {
			cell.createSpan({
				cls: 'cc-route-status warn',
				text: '⚠️ No vision',
			});
		} else if (taskType === 'coding' && caps && !caps.toolCalling) {
			cell.createSpan({
				cls: 'cc-route-status warn',
				text: '⚠️ No tools',
			});
		} else {
			const health = this.healthStatus.get(providerId);
			if (health === 'ok') {
				cell.createSpan({
					cls: 'cc-route-status ok',
					text: '✅ Ready',
				});
			} else if (health === 'error') {
				cell.createSpan({
					cls: 'cc-route-status warn',
					text: '⚠️ Unhealthy',
				});
			} else {
				cell.createSpan({
					cls: 'cc-route-status idle',
					text: '◽ Untested',
				});
			}
		}
	}

	/* ═══════════════════════════════════════════════════════
	   Section 4: Fallback Pipeline
	   ═══════════════════════════════════════════════════════ */

	private renderFallbackPipeline(containerEl: HTMLElement): void {
		this.renderSectionHeader(
			containerEl,
			'fallback',
			'🛟 Fallback Pipeline',
			'When the primary provider fails, the dispatcher cascades through fallback providers in order.',
		);

		const body = this.getSectionBody(containerEl, 'fallback');
		const fb = this.plugin.settings.multiProvider.fallback;

		// Toggles
		const togglesRow = body.createDiv({ cls: 'cc-fallback-toggles' });

		new Setting(togglesRow)
			.setName('Fallback on rate-limit errors')
			.addToggle((t) =>
				t.setValue(fb.fallbackOnRateLimit).onChange( (v) => { void (async () => {
					this.plugin.settings.multiProvider.fallback.fallbackOnRateLimit =
						v;
				await this.plugin.saveSettings();
				})(); }),
			);

		new Setting(togglesRow)
			.setName('Fallback on timeout errors')
			.addToggle((t) =>
				t.setValue(fb.fallbackOnTimeout).onChange( (v) => { void (async () => {
					this.plugin.settings.multiProvider.fallback.fallbackOnTimeout =
						v;
				await this.plugin.saveSettings();
				})(); }),
			);

		new Setting(togglesRow)
			.setName('Max fallback attempts')
			.setDesc('Total providers to try before giving up (1–5)')
			.addSlider((s) =>
				s
					.setLimits(1, 5, 1)
					.setValue(fb.maxAttempts)
					.onChange( (v) => { void (async () => {
						this.plugin.settings.multiProvider.fallback.maxAttempts =
							v;
				await this.plugin.saveSettings();
					})(); }),
			);

		// Fallback chain visual
		new Setting(body)
			.setName('Fallback Chain Order')
			.setHeading()
			.setClass('cc-subsection-title');

		const chainContainer = body.createDiv({ cls: 'cc-fallback-chain' });

		const allProviderIds: ProviderId[] = [
			'pi-daemon',
			'openai',
			'anthropic',
			'google-gemini',
			'openrouter',
			'groq',
			'deepinfra',
			'mistral',
			'cohere',
			'ollama',
			'lmstudio',
			'custom',
		];

		for (let i = 0; i < fb.fallbacks.length; i++) {
			const idx = i;
			const chainLink = chainContainer.createDiv({
				cls: 'cc-fallback-link',
			});
			chainLink.createSpan({
				cls: 'cc-fallback-position',
				text: `#${i + 1}`,
			});

			const select = chainLink.createEl('select', {
				cls: 'cc-fallback-select',
			});
			for (const pid of allProviderIds) {
				const opt = select.createEl('option', {
					text: `${PROVIDER_REGISTRY[pid]?.icon ?? ''} ${PROVIDER_REGISTRY[pid]?.label ?? pid}`,
					value: pid,
				});
				if (pid === fb.fallbacks[idx]) opt.selected = true;
			}
			select.addEventListener('change',  () => { void (async () => {
				this.plugin.settings.multiProvider.fallback.fallbacks[idx] =
					select.value as ProviderId;
				await this.plugin.saveSettings();
			})(); });

			// Remove button
			if (fb.fallbacks.length > 1) {
				const removeBtn = chainLink.createSpan({
					cls: 'cc-fallback-remove',
					text: '✕',
				});
				removeBtn.addEventListener('click',  () => { void (async () => {
					const newFallbacks = [
						...this.plugin.settings.multiProvider.fallback
							.fallbacks,
					];
					newFallbacks.splice(idx, 1);
					this.plugin.settings.multiProvider.fallback.fallbacks =
						newFallbacks;
					await this.plugin.saveSettings();
					this.update();
				})(); });
			}

			// Arrow between links
			if (i < fb.fallbacks.length - 1) {
				chainContainer.createSpan({
					cls: 'cc-fallback-arrow',
					text: '↓',
				});
			}
		}

		// Add fallback button
		const addBtn = body.createEl('button', {
			text: '+ Add Fallback',
			cls: 'cc-add-fallback-btn',
		});
		addBtn.addEventListener('click',  () => { void (async () => {
			fb.fallbacks.push('openrouter');
			await this.plugin.saveSettings();
			this.update();
		})(); });
	}

	/* ═══════════════════════════════════════════════════════
	   Section 5: Health Dashboard
	   ═══════════════════════════════════════════════════════ */

	private renderHealthDashboard(containerEl: HTMLElement): void {
		const headerRow = this.renderSectionHeader(
			containerEl,
			'health',
			'🏥 Health Dashboard',
			'Real-time connection status for all configured providers.',
		);

		const actionBar = headerRow.createDiv({ cls: 'cc-provider-actions' });
		this.createButton(actionBar, 'Refresh All', async () => {
			const btns = actionBar.querySelectorAll('button');
			const refreshBtn = btns[0] as HTMLButtonElement;
			refreshBtn.textContent = '⏳ Refreshing...';
			refreshBtn.disabled = true;
			await this.healthCheckAll();
			this.update();
		});

		const body = this.getSectionBody(containerEl, 'health');
		body.addClass('cc-health-grid');

		const mp = this.plugin.settings.multiProvider;

		for (const pid of PROVIDER_ORDER) {
			const meta = PROVIDER_REGISTRY[pid];
			if (!meta) continue;

			const cred = mp.credentials[pid];
			const configured = cred?.enabled ?? pid === 'pi-daemon';
			const credentialReady = pid === 'pi-daemon' || !meta.requiresKey || this.plugin.credentialVault.has(pid);
			const enabled = configured && credentialReady;
			const health = this.healthStatus.get(pid) ?? 'idle';

			const card = body.createDiv({
				cls: `cc-health-card ${enabled ? '' : 'disabled'} ${health}`,
			});

			// Left: icon + name
			const left = card.createDiv({ cls: 'cc-health-left' });
			left.createSpan({ cls: 'cc-health-icon', text: meta.icon });
			left.createSpan({ cls: 'cc-health-name', text: meta.label });

			// Center: status text
			const center = card.createDiv({ cls: 'cc-health-center' });
			if (!configured) {
				center.createSpan({
					cls: 'cc-health-status muted',
					text: 'Disabled',
				});
			} else if (!credentialReady) {
				center.createSpan({
					cls: 'cc-health-status muted',
					text: '🔒 Vault locked',
				});
			} else if (health === 'checking') {
				center.createSpan({
					cls: 'cc-health-status checking',
					text: '⏳ Checking...',
				});
			} else if (health === 'ok') {
				center.createSpan({
					cls: 'cc-health-status ok',
					text: '✅ Connected',
				});
			} else if (health === 'error') {
				const errMsg =
					this.healthErrors.get(pid) ?? 'Connection failed';
				center.createSpan({
					cls: 'cc-health-status error',
					text: `❌ ${errMsg.slice(0, 60)}`,
				});
			} else {
				center.createSpan({
					cls: 'cc-health-status idle',
					text: '◽ Not tested',
				});
			}

			// Right: action
			const right = card.createDiv({ cls: 'cc-health-right' });
			const testBtn = right.createEl('button', {
				text: 'Test',
				cls: 'cc-health-test-btn',
			});
			if (health === 'checking' || !enabled) testBtn.disabled = true;
			testBtn.addEventListener('click',  () => { void (async () => {
				await this.runHealthCheck(pid);
				this.update();
			})(); });
		}
	}

	/* ═══════════════════════════════════════════════════════
	   Footer
	   ═══════════════════════════════════════════════════════ */

	private renderTabBar(containerEl: HTMLElement): void {
		const tabs = containerEl.createDiv({ cls: 'cc-settings-tabs', attr: { role: 'tablist', 'aria-label': 'Command Center settings sections' } });
		const tabsDef: Array<{ id: SettingsTabId; label: string; desc: string }> = [
			{ id: 'all', label: 'All', desc: 'Show every settings group' },
			{ id: 'core', label: 'Core', desc: 'General behavior, memory, and prompt budget' },
			{ id: 'providers', label: 'Providers', desc: 'Credentials, endpoints, and model sync' },
			{ id: 'routing', label: 'Routing', desc: 'Task routing and fallback pipeline' },
			{ id: 'health', label: 'Health', desc: 'Connection checks and diagnostics' },
		];
		const buttons: HTMLButtonElement[] = [];
		const activate = (tabId: SettingsTabId): void => {
			this.selectedTab = tabId;
			this.update();
		};
		for (const tab of tabsDef) {
			const active = this.selectedTab === tab.id;
			const btn = tabs.createEl('button', {
				text: tab.label,
				cls: `cc-settings-tab${active ? ' is-active' : ''}`,
				attr: {
					role: 'tab',
					'aria-selected': String(active),
					tabindex: active ? '0' : '-1',
					title: tab.desc,
				},
			});
			buttons.push(btn);
			btn.addEventListener('click', () => activate(tab.id));
			btn.addEventListener('keydown', (event: KeyboardEvent) => {
				const currentIndex = buttons.indexOf(btn);
				if (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'Home' || event.key === 'End') {
					event.preventDefault();
					const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowRight' ? (currentIndex + 1) % buttons.length : (currentIndex - 1 + buttons.length) % buttons.length;
					buttons[nextIndex]?.focus();
					activate(tabsDef[nextIndex]!.id);
				}
			});
		}
	}

	private renderFooter(containerEl: HTMLElement): void {
		const support = containerEl.createDiv({ cls: 'cc-developer-support' });
		const supportCopy = support.createDiv({
			cls: 'cc-developer-support-copy',
		});
		new Setting(supportCopy)
			.setName('Thank the developer')
			.setDesc(
				'If Command Center helps your workflow, you can support its continued development.',
			)
			.setHeading()
			.setClass('cc-developer-support-heading');
		const donate = support.createEl('button', {
			text: '☕ Open support page',
			cls: 'mod-cta cc-developer-support-button',
			attr: { type: 'button' },
		});
		donate.addEventListener('click', () => {
			void this.plugin.activateCommandCenterBrowserView(DEVELOPER_SUPPORT_URL);
		});
		donate.setAttribute('aria-label', 'Open support page in the built-in browser panel');

		const footer = containerEl.createDiv({ cls: 'cc-settings-footer' });
		footer.createEl('p', {
			text: 'Changes are saved automatically. Provider configurations are stored locally in your Obsidian vault.',
			cls: 'cc-footer-text',
		});
	}

	/* ═══════════════════════════════════════════════════════
	   Shared Helpers
	   ═══════════════════════════════════════════════════════ */

	/** Render a collapsible section header and return the header row for action buttons. */
	private renderSectionHeader(
		containerEl: HTMLElement,
		sectionId: string,
		title: string,
		description?: string,
	): HTMLElement {
		const collapsed = this.collapsedSections.has(sectionId);
		const headerDiv = containerEl.createDiv({ cls: 'cc-section-header' });

		const leftDiv = headerDiv.createDiv({ cls: 'cc-section-header-left' });
		const collapseBtn = leftDiv.createSpan({
			cls: 'cc-section-collapse',
			text: collapsed ? '▶' : '▼',
		});

		const sectionHeading = new Setting(leftDiv)
			.setName(title)
			.setHeading()
			.setClass('cc-section-title-group');
		if (description) {
			sectionHeading.setDesc(description);
		}

		collapseBtn.addEventListener('click', () => {
			if (collapsed) {
				this.collapsedSections.delete(sectionId);
			} else {
				this.collapsedSections.add(sectionId);
			}
			this.update();
		});

		if (collapsed) {
			return headerDiv; // Body will be hidden via getSectionBody checking collapsed
		}

		return headerDiv;
	}

	/** Get the body container for a section, respecting collapsed state. */
	private getSectionBody(
		containerEl: HTMLElement,
		sectionId: string,
	): HTMLElement {
		const collapsed = this.collapsedSections.has(sectionId);
		return containerEl.createDiv({
			cls: `cc-section-body ${collapsed ? 'cc-collapsed' : ''}`,
		});
	}

	/** Create a small action button in a parent container. */
	private createButton(
		parent: HTMLElement,
		text: string,
		onClick: () => void | Promise<void>,
	): ButtonComponent {
		const btn = new ButtonComponent(parent);
		btn.setButtonText(text);
		btn.onClick(() => void onClick());
		return btn;
	}

	private getSpeechVoices(): SpeechSynthesisVoice[] {
		if (!('speechSynthesis' in window) || typeof window.speechSynthesis.getVoices !== 'function') return [];
		return window.speechSynthesis.getVoices().filter(voice => voice && typeof voice.name === 'string');
	}

	private updateVoiceSelects(): void {
		const voices = this.getSpeechVoices();
		for (const select of Array.from(this.containerEl.querySelectorAll('select.cc-text-to-speech-voice'))) {
			const el = select as HTMLSelectElement;
			const current = this.plugin.settings.textToSpeechVoice;
			const selected = Array.from(el.options).find(option => option.value === current);
			el.innerHTML = '';
			el.add(new Option('Default voice', ''));
			for (const voice of voices) {
				el.add(new Option(
					`${voice.name}${voice.default ? ' (default)' : voice.lang ? ` · ${voice.lang}` : ''}`,
					voice.name,
				));
			}
			el.value = selected ? selected.value : current;
		}
	}

	/** Save a single settings key and show the save indicator. */
	private async saveSetting<K extends keyof CommandCenterPlugin['settings']>(
		key: K,
		value: CommandCenterPlugin['settings'][K],
	): Promise<void> {
		(this.plugin.settings as unknown as Record<string, unknown>)[key] =
			value;
		await this.plugin.saveSettings();
		this.showSaved();
	}

	/** Flash the save indicator briefly. */
	private showSaved(): void {
		if (!this.saveIndicator) return;
		this.saveIndicator.textContent = '✅ Saved';
		this.saveIndicator.addClass('visible');
		window.setTimeout(() => {
			if (this.saveIndicator) {
				this.saveIndicator.removeClass('visible');
				this.saveIndicator.textContent = '';
			}
		}, 2000);
	}

	/** Update the key strength indicator based on key format heuristics. */
	private updateKeyStrength(el: HTMLElement, key: string): void {
		el.removeClass('weak', 'ok', 'good');
		if (!key) {
			el.textContent = '';
			return;
		}
		const len = key.trim().length;
		if (len < 10) {
			el.textContent = '⚠️ Too short';
			el.addClass('weak');
		} else if (len < 20) {
			el.textContent = '• Weak';
			el.addClass('weak');
		} else if (len >= 30 && /^sk-/.test(key)) {
			el.textContent = '• Strong';
			el.addClass('good');
		} else {
			el.textContent = '• OK';
			el.addClass('ok');
		}
	}

	/** Format a context window size for display. */
	private formatContext(size: number): string {
		if (size >= 1_000_000) return `${(size / 1_000_000).toFixed(1)}M`;
		if (size >= 1_000) return `${(size / 1_000).toFixed(0)}K`;
		return String(size);
	}

	/* ═══════════════════════════════════════════════════════════
	   Real-Time Model Discovery & Background Sync
	   ═══════════════════════════════════════════════════════════ */

	/**
	 * Sync models for a single provider: fetch live, persist, update sync state.
	 * Falls back to static registry on failure (no-op, display doesn't change).
	 */
	private async syncProviderModels(pid: ProviderId): Promise<void> {
		const provider = this.plugin.providerFactory.get(pid);
		if (!provider.fetchLiveModels) {
			this.modelSyncStates.set(pid, {
				status: 'idle',
				lastSyncAt: null,
				modelCount: 0,
			});
			return;
		}

		// Throttle: don't re-sync if recently synced
		const existing = this.modelSyncStates.get(pid);
		if (
			existing?.lastSyncAt &&
			Date.now() - existing.lastSyncAt < MODEL_SYNC_THROTTLE_MS
		) {
			if (existing.status === 'synced') return;
		}

		// Mark syncing
		const syncState: ModelSyncState = {
			status: 'syncing',
			lastSyncAt: null,
			modelCount: 0,
		};
		this.modelSyncStates.set(pid, syncState);

		try {
			const liveModels = await provider.fetchLiveModels();
			const merged = this._mergeLiveWithRegistry(pid, liveModels);

			// Persist to settings so it survives page reloads
			const mp = this.plugin.settings.multiProvider;
			if (!mp.liveModels) mp.liveModels = {};
			if (merged.length > 0) {
				mp.liveModels[pid] = merged;

				// Replace stale static placeholders (notably LM Studio's `local-model`)
				// or server models that no longer exist with a model reported live.
				const liveIds = new Set(merged.map((model) => model.id));
				for (const route of Object.values(mp.routing)) {
					if (
						route.providerId === pid &&
						!liveIds.has(route.modelId)
					) {
						route.modelId = merged[0]!.id;
					}
				}
			} else {
				delete mp.liveModels[pid];
			}
			// Save asynchronously (fire-and-forget for responsiveness)
			this.plugin.saveSettings().catch(() => {});

			this.modelSyncStates.set(pid, {
				status: 'synced',
				lastSyncAt: Date.now(),
				modelCount: merged.length,
			});
		} catch (err) {
			this.modelSyncStates.set(pid, {
				status: 'error',
				lastSyncAt: null,
				modelCount: 0,
				error: (err as Error).message,
			});
		}
	}

	/**
	 * Sync models for ALL enabled/candidate providers.
	 * Runs with concurrency control to avoid hammering endpoints.
	 */
	private async syncAllModels(): Promise<void> {
		const mp = this.plugin.settings.multiProvider;
		const toSync = PROVIDER_ORDER.filter((pid) => {
			if (pid === 'pi-daemon') return false; // no live listing
			const provider = this.plugin.providerFactory.get(pid);
			if (!provider.fetchLiveModels) return false;
			const cred = mp.credentials[pid];
			return cred?.enabled && provider.isAvailable();
		});

		if (toSync.length === 0) {
			new Notice('No enabled providers support live model listing.');
			return;
		}

		// Mark all as syncing
		for (const pid of toSync) {
			this.modelSyncStates.set(pid, {
				status: 'syncing',
				lastSyncAt: null,
				modelCount: 0,
			});
		}

		// Sync with concurrency of 3
		const concurrency = 3;
		let synced = 0;
		let failed = 0;
		for (let i = 0; i < toSync.length; i += concurrency) {
			const batch = toSync.slice(i, i + concurrency);
			const results = await Promise.allSettled(
				batch.map((pid) => this.syncProviderModels(pid)),
			);
			for (const r of results) {
				if (r.status === 'fulfilled') synced++;
				else failed++;
			}
		}

		new Notice(
			`Model sync complete: ${synced} synced${failed > 0 ? `, ${failed} failed` : ''}`,
		);
	}

	/**
	 * Merge live models with static registry for enriched metadata.
	 * Registry entries take precedence for known model IDs.
	 */
	private _mergeLiveWithRegistry(
		pid: ProviderId,
		liveModels: ProviderModel[],
	): ProviderModel[] {
		if (!liveModels || liveModels.length === 0) return [];

		const meta = PROVIDER_REGISTRY[pid];
		const staticModels = meta?.models ?? [];
		const registryMap = new Map<string, ProviderModel>();
		for (const m of staticModels) registryMap.set(m.id, m);

		return liveModels.map((lm) => {
			const registered = registryMap.get(lm.id);
			if (registered) return { ...registered };
			return lm;
		});
	}

	/**
	 * Start the background sync timer.
	 * Syncs all providers on a configurable interval.
	 * Only runs when the settings tab is displayed.
	 */
	private startBackgroundSync(): void {
		if (this.backgroundSyncTimer !== null) return;

		// Do an initial sync for providers with API keys configured
		// This runs after a short delay so the UI renders first
		const initialSync = () => {
			const mp = this.plugin.settings.multiProvider;
			for (const pid of PROVIDER_ORDER) {
				if (pid === 'pi-daemon') continue;
				const cred = mp.credentials[pid];
				if (!cred?.enabled) continue;
				// Only sync providers that have live models support
				const provider = this.plugin.providerFactory.get(pid);
				if (!provider.fetchLiveModels) continue;
				// Don't re-sync if we already have persisted models
				if (mp.liveModels?.[pid] && mp.liveModels[pid].length > 0)
					continue;
				// Fire-and-forget for responsiveness
				this.syncProviderModels(pid).catch(() => {});
			}
		};

		// Delay initial sync to allow UI to render
		window.setTimeout(initialSync, 1000);

		// Set up periodic background sync
		this.backgroundSyncTimer = window.setInterval( () => { void (async () => {
			const mp = this.plugin.settings.multiProvider;
			const toSync = PROVIDER_ORDER.filter((pid) => {
				if (pid === 'pi-daemon') return false;
				const cred = mp.credentials[pid];
				if (!cred?.enabled) return false;
				const provider = this.plugin.providerFactory.get(pid);
				if (!provider.fetchLiveModels) return false;
				// Throttle: only sync if last sync was > interval ago
				const state = this.modelSyncStates.get(pid);
				if (
					state?.lastSyncAt &&
					Date.now() - state.lastSyncAt < MODEL_SYNC_INTERVAL_MS
				)
					return false;
				return true;
			});

			if (toSync.length === 0) return;

			// Sync with concurrency 2 (gentle)
			for (let i = 0; i < toSync.length; i += 2) {
				const batch = toSync.slice(i, i + 2);
				await Promise.allSettled(
					batch.map((pid) => this.syncProviderModels(pid)),
				);
			}

			// Re-render to show updated sync states (debounced)
			this.update();
		})(); }, MODEL_SYNC_INTERVAL_MS);
	}

	/**
	 * Stop the background sync timer. Called implicitly when tab is hidden
	 * (via Obsidian lifecycle), but we provide a stop method for cleanup.
	 */
	private stopBackgroundSync(): void {
		if (this.backgroundSyncTimer !== null) {
			window.clearInterval(this.backgroundSyncTimer);
			this.backgroundSyncTimer = null;
		}
	}

	/**
	 * Update the sync indicator span based on sync state.
	 */
	private updateSyncIndicator(el: HTMLElement, state: ModelSyncState): void {
		switch (state.status) {
			case 'idle':
				el.textContent = '◽';
				el.setAttribute('title', 'Not synced');
				break;
			case 'syncing':
				el.textContent = '⏳';
				el.setAttribute('title', 'Syncing...');
				break;
			case 'synced':
				el.textContent = '✅';
				el.setAttribute(
					'title',
					`Synced ${this.formatTimeAgo(state.lastSyncAt)} — ${state.modelCount} models`,
				);
				break;
			case 'error':
				el.textContent = '⚠️';
				el.setAttribute(
					'title',
					`Sync failed: ${state.error ?? 'Unknown error'}`,
				);
				break;
		}
	}

	/**
	 * Format a timestamp as a human-readable "time ago" string.
	 */
	private formatTimeAgo(timestamp: number | null): string {
		if (!timestamp) return 'never';
		const diff = Date.now() - timestamp;
		const seconds = Math.floor(diff / 1000);
		if (seconds < 60) return `${seconds}s ago`;
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.floor(hours / 24);
		return `${days}d ago`;
	}

	/* ─── Health Check Methods ─────────────────────── */

	/** Run a health check for a single provider and update transient state. */
	private async runHealthCheck(pid: ProviderId): Promise<void> {
		this.healthStatus.set(pid, 'checking');
		this.healthErrors.delete(pid);

		try {
			const provider = this.plugin.providerFactory.get(pid);
			const err = await provider.healthCheck();
			if (err) {
				this.healthStatus.set(pid, 'error');
				this.healthErrors.set(pid, err);
			} else {
				this.healthStatus.set(pid, 'ok');
			}
		} catch (err) {
			this.healthStatus.set(pid, 'error');
			this.healthErrors.set(pid, (err as Error).message);
		}
	}

	/** Run health checks for all enabled providers. */
	private async healthCheckAll(): Promise<void> {
		const mp = this.plugin.settings.multiProvider;
		const toCheck = PROVIDER_ORDER.filter((pid) => {
			const cred = mp.credentials[pid];
			const meta = PROVIDER_REGISTRY[pid];
			const enabled = pid === 'pi-daemon' || cred?.enabled;
			const credentialReady = pid === 'pi-daemon' || !meta?.requiresKey || this.plugin.credentialVault.has(pid);
			return enabled && credentialReady;
		});

		// Mark all as checking
		for (const pid of toCheck) {
			this.healthStatus.set(pid, 'checking');
			this.healthErrors.delete(pid);
		}
		this.update();

		// Run in parallel with a concurrency limit of 3
		const concurrency = 3;
		for (let i = 0; i < toCheck.length; i += concurrency) {
			const batch = toCheck.slice(i, i + concurrency);
			await Promise.all(
				batch.map((pid) => this.runHealthCheck(pid).catch(() => {})),
			);
		}
	}
}