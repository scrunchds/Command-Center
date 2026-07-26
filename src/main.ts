import { Modal, Notice, normalizePath, Plugin, TFile } from 'obsidian';
import {
	PiAgentDaemon,
	detectPiPath,
	type AgentExecutionState,
	type ReActStreamEvent,
} from './daemon';
import {
	CommandCenterSettings,
	DEFAULT_SETTINGS,
	DEFAULT_MULTI_PROVIDER,
	PluginSettingsTab,
} from './settings';
import { PersistenceManager } from './persistence';
import type { StoredTask, StoredSessions } from './persistence';
import { registerCommands } from './commands';
import {
	CommandCenterView,
	COMMAND_CENTER_VIEW_TYPE,
} from './ui/CommandCenterView';
import {
	CommandCenterChatView,
	COMMAND_CENTER_CHAT_VIEW_TYPE,
} from './ui/command-center-chat-view';
import {
	COMMAND_CENTER_BASES_VIEW_ID,
	commandCenterBasesRegistration,
} from './ui/command-center-bases-view';
import { TaskQueue, type TaskExecutor } from './task-queue';
import { VaultWatcher } from './vault-watcher';
import { CommandCenterStatusBar } from './status-bar';
import type { Task, TaskResult, ToolDefinition } from './types';
import { TOKEN_LIMITS } from './types';
import type { Conversation, Turn } from './conversation';
import { ConversationManager } from './conversation';
import { createObsidianTools } from './obsidian-tools';
import { DEFAULT_REACT_CONFIG } from './react';
import type { ReActContext, ReActTermination } from './react';
import { ReActMemoryBank } from './react/react-memory';
import { ProviderFactory } from './providers/provider-factory';
import { sanitizeBaseUrl } from './providers/provider-types';
import { PROVIDER_REGISTRY } from './providers/provider-registry';
import { ProviderDispatcher } from './dispatcher';
import { ModelRouter } from './routing/ModelRouter';
import { WorkflowEngine } from './workflows/workflow-engine';
import type {
	WorkflowDefinition,
	WorkflowExecutionContext,
} from './workflows/workflow-types';
import type {
	WorkflowBatchOptions,
	WorkflowTargetExecution,
} from './workflows/workflow-engine';
import { DebouncedFrontmatterSync } from './workflows/frontmatter-sync';
import {
	exportWorkflowToCanvas,
	loadWorkflowFromCanvas,
	loadWorkflowFromNote,
} from './workflows/native-workflow-parser';
import type { ResolvedChatContext } from './ui/chat-context';
import type { VoicePromptMode } from './ui/voice-prompt-modal';
import { AgentMemoryStore } from './memory/memory-store';
import { EmbeddingAdapter } from './rag/embeddings';
import { HybridRetriever } from './rag/hybrid-retriever';
import { createVaultSearchTool } from './rag/rag-tool';
import { CONFIG_PATH } from './engine/ConfigSerializer';
import type { OnboardingConfig } from './onboarding/OnboardingTypes';
import { FolderIndexer } from './indexing/FolderIndexer';
import { InboxTriager } from './daily/InboxTriager';
import { CapacityEngine } from './daily/CapacityEngine';
import { DailyEngine } from './daily/DailyEngine';
import { ConfigManager } from './engine/ConfigManager';
import { InterviewEngine } from './engine/InterviewEngine';
import { Orchestrator } from './engine/Orchestrator';
import { ModelRouter as EndpointModelRouter } from './engine/ModelRouter';
import { InterviewModal } from './ui/InterviewModal';
import { CommandCenterCommandBridge } from './cli/command-bridge';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

export default class CommandCenterPlugin extends Plugin {
	settings!: CommandCenterSettings;
	daemon!: PiAgentDaemon;
	taskQueue!: TaskQueue;
	vaultWatcher!: VaultWatcher;
	statusBar!: CommandCenterStatusBar;
	conversations!: ConversationManager;
	persist!: PersistenceManager;
	memoryBank!: ReActMemoryBank;
	agentMemory!: AgentMemoryStore;
	hybridRetriever!: HybridRetriever;
	folderIndexer!: FolderIndexer;
	inboxTriager!: InboxTriager;
	capacityEngine!: CapacityEngine;
	dailyEngine!: DailyEngine;
	configManager!: ConfigManager;
	commandCenterView: CommandCenterView | null = null;
	commandCenterChatView: CommandCenterChatView | null = null;

	/** Multi-provider subsystem (v2.0). */
	providerFactory!: ProviderFactory;
	dispatcher!: ProviderDispatcher;
	router!: ModelRouter;
	endpointRouter!: EndpointModelRouter;
	workflowEngine!: WorkflowEngine;
	orchestrator!: Orchestrator;

	private taskHistory: StoredTask[] = [];
	private readonly maxHistory = 100;
	/** Coalesces worker/session completions into metadata-cache-visible vault writes. */
	private frontmatterSync!: DebouncedFrontmatterSync;
	private commandBridge!: CommandCenterCommandBridge;

	/** Daemon auto-retry state for missing/failed pi binary. */
	private daemonRetryTimer: number | null = null;
	private daemonRetryCount = 0;
	private readonly DAEMON_RETRY_BASE_MS = 5_000;
	private readonly DAEMON_RETRY_MAX_MS = 120_000;
	private readonly DAEMON_RETRY_CAP = 6;

	async onload() {
		// ── Persistence layer ──────────────────────────
		this.persist = new PersistenceManager(this);
		const data = await this.persist.load();

		// ── Settings ───────────────────────────────────
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			data.settings as Partial<CommandCenterSettings>,
		);
		// Ensure multiProvider exists (migration from v1)
		if (!this.settings.multiProvider) {
			this.settings.multiProvider = DEFAULT_MULTI_PROVIDER;
		}
		// Normalize provider `enabled` flags: key-requiring providers with a
		// configured API key default to enabled (the key is the opt-in). Legacy
		// installs created credential records with `enabled: false` before the
		// toggle was wired into the dispatch path; this one-time upgrade makes the
		// toggle a proper opt-out rather than a required opt-in. Keyless local
		// providers (LM Studio, Ollama, custom) keep their explicit opt-in.
		{
			let changed = false;
			for (const [rawPid, cred] of Object.entries(this.settings.multiProvider.credentials)) {
				const pid = rawPid as keyof typeof PROVIDER_REGISTRY;
				const requiresKey = PROVIDER_REGISTRY[pid]?.requiresKey ?? true;
				if (requiresKey && cred && cred.apiKey && !cred.enabled) {
					cred.enabled = true;
					changed = true;
				}
			}
			if (changed) {
				this.persist.setSettings({ ...this.settings });
				this.persist.forceFlush().catch(() => {});
			}
		}
		this.taskHistory = data.history;
		this.configManager = new ConfigManager(this.app);
		this.folderIndexer = new FolderIndexer(this.app);
		const onboardingConfig = await this.configManager.load();
		if (onboardingConfig?.managedFolders.length)
			await this.folderIndexer.initialize(
				onboardingConfig.managedFolders,
			);
		this.folderIndexer.start();
		if (onboardingConfig) {
			this.configureDailyEngines(onboardingConfig);
			await this.dailyEngine.ready();
		}

		// Get vault root path — Obsidian's public API doesn't expose the
		// filesystem path, so we reach into the adapter's internals.
		const vaultPath =
			((this.app.vault.adapter as unknown as Record<string, unknown>)
				?.basePath as string) || '.';

		// ── Auto-detect pi binary path ────────────────
		// If the configured path is the default, try to auto-detect the real path.
		const detectedPath = detectPiPath(this.settings.piPath);
		if (detectedPath && detectedPath !== this.settings.piPath) {
			this.settings.piPath = detectedPath;
			// Persist the detected path for next launch
			this.persist.setSettings({ ...this.settings });
			this.persist.forceFlush().catch(() => {});
		}

		// ── Subsystems ─────────────────────────────────
		this.daemon = new PiAgentDaemon(vaultPath, this.settings.piPath);
		this.frontmatterSync = new DebouncedFrontmatterSync(this.app, 750);
		this.daemon.setExecutionStateCallback((state) =>
			this.queueAgentStateUpdate(state),
		);
		this.daemon.registerTools(createObsidianTools(this.app));
		this.memoryBank = new ReActMemoryBank(this.app);
		this.agentMemory = new AgentMemoryStore(this.app);
		await this.agentMemory.ready();
		const embeddingConnection = this.resolveEmbeddingConnection();
		this.hybridRetriever = new HybridRetriever({
			embeddings: new EmbeddingAdapter(embeddingConnection),
		});
		await this.hybridRetriever.indexVault(this.app);
		const contextCharLimit = Math.min(
			TOKEN_LIMITS.MAX_PROMPT_CHARS / 2,
			Math.max(2_000, this.settings.maxTokens * 4),
		);
		this.daemon.setMemoryStore(this.agentMemory);
		this.daemon.setRetriever(this.hybridRetriever, contextCharLimit);
		this.conversations = new ConversationManager(
			this.daemon,
			() => this.persistSessions(),
			this.agentMemory,
			this.hybridRetriever,
			contextCharLimit,
			() => this.configManager.requireStyleGuide(),
		);

		// ── Multi-Provider Subsystem ──────────────────
		this.daemon.registerTools([
			createVaultSearchTool(this.hybridRetriever, {
				canReadVault: () => true,
			}),
		]);
		this.providerFactory = new ProviderFactory(
			this.daemon,
			() => this.settings.multiProvider,
		);
		this.dispatcher = new ProviderDispatcher(
			this.providerFactory,
			() => this.settings.multiProvider,
		);
		this.router = new ModelRouter(
			this.providerFactory,
			() => this.settings.multiProvider,
			() => [
				...obsidianTools,
				createVaultSearchTool(this.hybridRetriever),
			],
			{
				vaultPath,
				configDir: this.app.vault.configDir,
				memoryStore: this.agentMemory,
				retriever: this.hybridRetriever,
				contextCharLimit,
			},
		);
		this.endpointRouter = new EndpointModelRouter(this.configManager, {
			resolveCredential: (reference, endpoint) => {
				const key = reference || endpoint.provider;
				return Object.values(
					this.settings.multiProvider.credentials,
				).find((credentials) => credentials?.providerId === key)
					?.apiKey;
			},
		});
		this.workflowEngine = new WorkflowEngine(
			this.dispatcher,
			this.router,
			() => this.configManager.requireStyleGuide(),
		);
		this.orchestrator = new Orchestrator(
			this.dispatcher,
			() => this.settings.multiProvider,
			() => this.configManager.requireStyleGuide(),
		);

		const obsidianTools = createObsidianTools(this.app);
		const executor: TaskExecutor = {
			execute: async (task: Task): Promise<TaskResult> => {
				this.requireInitialized();
				if (task.prompt.length > TOKEN_LIMITS.MAX_PROMPT_CHARS) {
					throw new Error(
						`Prompt too large (${task.prompt.length} chars, max ${TOKEN_LIMITS.MAX_PROMPT_CHARS})`,
					);
				}

				// Route ReAct-capable profiles through the iterative loop
				if (
					task.workerProfile === 'react-orchestrator' ||
					task.workerProfile.startsWith('react')
				) {
					return executeReActTask(
						this.daemon,
						obsidianTools,
						task,
						this.memoryBank,
						this.router,
					);
				}

				// Command-palette local agent tasks explicitly target Pi.
				if (task.workerProfile === 'pi-daemon') {
					const routeResult = await this.router.routeDirect(
						task,
						'pi-daemon',
						'pi-default',
					);
					return routeResult.taskResult;
				}

				// ── Multi-provider routing for standard tasks ──
				const routeResult = await this.router.route(task);
				return routeResult.taskResult;
			},
		};
		this.taskQueue = new TaskQueue(executor, 1);
		this.vaultWatcher = new VaultWatcher(this.app.vault);

		// ── Status bar ─────────────────────────────────
		const statusBarEl = this.addStatusBarItem();
		this.statusBar = new CommandCenterStatusBar(statusBarEl, 'CC');

		// ── Queue events → status bar + history + persistence + streaming ──
		const onQueueEvent = (_event: string, task: Task) => {
			const stats = this.taskQueue.getStats();
			this.statusBar.setStats(stats);
			this.statusBar.setState(
				stats.running > 0
					? 'busy'
					: this.daemon.isRunning()
						? 'running'
						: 'stopped',
			);

			if (_event === 'started' && this.commandCenterView) {
				// Resolve the current view at delivery time; never retain a closed tab.
				this.commandCenterView.startTaskStream(
					task.id,
					task.workerProfile,
					task.targetPath,
				);
				task.onStream = (delta: string) => {
					const view = this.commandCenterView;
					if (!view) return;
					if (!view.hasTaskStream(task.id))
						view.startTaskStream(
							task.id,
							task.workerProfile,
							task.targetPath,
						);
					view.appendStreamOutput(delta, task.id);
				};
			}

			if (task.status === 'completed' || task.status === 'failed') {
				if (task.targetPath) {
					const metadata = task.result?.metadata;
					const score =
						typeof metadata?.agentEvalScore === 'number'
						? metadata.agentEvalScore
							: typeof metadata?.evalScore === 'number'
								? metadata.evalScore
								: undefined;
					this.queueAgentStateUpdate({
						targetPath: task.targetPath,
						status:
							task.status === 'completed'
								? 'completed'
								: 'failed',
						evalScore: score,
						completedAt: task.completedAt ?? Date.now(),
						workerProfile: task.workerProfile,
					});
				}
				this.addTaskToHistory(task);
				this.commandCenterView?.finalizeStreamOutput(task.id);
				task.onStream = undefined;
			}

			// Persist queue snapshot (pending tasks) on state changes
			this.persistQueue();
		};
		this.taskQueue.on('started', onQueueEvent);
		this.taskQueue.on('completed', onQueueEvent);
		this.taskQueue.on('failed', onQueueEvent);
		this.taskQueue.on('drained', onQueueEvent);

		// ── Rehydrate persisted queue (any queued tasks from last session) ──
		this.rehydrateQueue(data.queue ?? []);

		// ── Rehydrate persisted sessions ──────────────
		this.rehydrateSessions(data.sessions);

		// ── View, ribbon, settings, commands ───────────
		this.registerView(COMMAND_CENTER_VIEW_TYPE, (leaf) => {
			const view = new CommandCenterView(leaf, this);
			this.commandCenterView = view;
			return view;
		});
		this.registerView(COMMAND_CENTER_CHAT_VIEW_TYPE, (leaf) => {
			const view = new CommandCenterChatView(leaf, this);
			this.commandCenterChatView = view;
			return view;
		});
		const basesRegistered = this.registerBasesView(
			COMMAND_CENTER_BASES_VIEW_ID,
			commandCenterBasesRegistration(this),
		);
		if (!basesRegistered)
			console.warn(
				'[CC] Bases is unavailable; file-based Base queue parsing remains available.',
			);
		this.addRibbonIcon('command', 'Command Center', () =>
			this.activateCommandCenterView(),
		);
		this.addRibbonIcon(
			'message-square',
			'Command Center: Open Chat Panel',
			() => this.activateCommandCenterChatView(),
		);
		this.addSettingTab(new PluginSettingsTab(this.app, this));
		registerCommands(this);
		this.commandBridge = new CommandCenterCommandBridge(this);
		this.commandBridge.register();
		this.addCommand({
			id: 'start-setup-onboarding-interview',
			name: 'Start Setup / Onboarding Interview',
			callback: () => this.openOnboarding(),
		});
		this.addCommand({
			id: 'reset-reinitialize-vault-config',
			name: 'Reset and Re-Initialize Vault Config',
			callback: () => this.confirmResetConfiguration(),
		});

		// Defer the first-run modal until Obsidian's workspace is ready. The
		// vault configuration file is the durable completion marker.
		this.app.workspace.onLayoutReady(() => {
			if (
				!this.configManager.isInitialized() ||
				!this.app.vault.getAbstractFileByPath(CONFIG_PATH)
			)
				this.openOnboarding();
		});

		if (this.settings.enableDaemon) {
			this.daemon.start();
			if (this.daemon.startError) {
				this.statusBar.setState('error');
				// Only retry for transient errors, not missing binary
				if (!this.daemon.isBinaryMissing()) {
					this.scheduleDaemonRetry();
				}
			} else {
				this.statusBar.setState('running');
			}
		}
		this.vaultWatcher.start();

		// Continuously enforce the current vault memory-note threshold.
		this.memoryBank.startBackgroundPruning(
			() => this.settings.memoryMaxNotes,
		);
	}

	/** Open (or restart) the native conversational setup interview. */
	openOnboarding(): void {
		const engine = new InterviewEngine(
			this.app,
			this.dispatcher,
			this.configManager,
		);
		new InterviewModal(this.app, engine, {
			onComplete: async (config) => {
				await this.folderIndexer.initialize(config.managedFolders);
				this.configureDailyEngines(config);
				await this.dailyEngine.ready();
			},
		}).open();
	}

	private confirmResetConfiguration(): void {
		const modal = new (class extends Modal {
			constructor(private readonly plugin: CommandCenterPlugin) {
				super(plugin.app);
			}
			onOpen(): void {
				this.contentEl.createEl('h2', {
					text: 'Reset Command Center configuration?',
				});
				this.contentEl.createEl('p', {
					text: 'This moves config.json and style-guide.md to trash, clears runtime configuration, and starts a new interview. Vault notes and indexes are not deleted.',
				});
				const actions = this.contentEl.createDiv({
					cls: 'modal-button-container',
				});
				actions
					.createEl('button', { text: 'Cancel' })
					.addEventListener('click', () => this.close());
				const reset = actions.createEl('button', {
					text: 'Reset and Re-Initialize',
					cls: 'mod-warning',
				});
				reset.addEventListener('click',  () => { void (async () => {
					reset.disabled = true;
					try {
						await this.plugin.resetOnboardingRuntime();
						this.close();
						this.plugin.openOnboarding();
					} catch (error) {
						reset.disabled = false;
						new Notice(
							`Unable to reset Command Center: ${(error as Error).message}`,
						);
					}
				})(); });
			}
		})(this);
		modal.open();
	}

	/** Clear services derived from the old interview before starting replacement setup. */
	async resetOnboardingRuntime(): Promise<void> {
		this.folderIndexer.stop();
		await this.frontmatterSync.flush();
		this.inboxTriager = undefined as unknown as InboxTriager;
		this.capacityEngine = undefined as unknown as CapacityEngine;
		this.dailyEngine = undefined as unknown as DailyEngine;
		await this.configManager.reset();
		this.folderIndexer = new FolderIndexer(this.app);
		this.folderIndexer.start();
	}

	/** Operational entry points must never run against guessed or partial state. */
	requireInitialized(): OnboardingConfig {
		return this.configManager.requireConfig();
	}

	private configureDailyEngines(config: OnboardingConfig): void {
		const archiveFolderPath = config?.inbox?.archivePath;
		const candidateTargetFolders = config?.managedFolders
			?.map((folder) => folder.path)
			.filter(
				(path) =>
					path !== config?.inbox?.path && path !== archiveFolderPath,
			);
		this.inboxTriager = new InboxTriager(this.app, this.folderIndexer, {
			archiveFolderPath,
			candidateTargetFolders,
		});
		this.capacityEngine = new CapacityEngine(this.app);
		this.dailyEngine = new DailyEngine(this.app, this.configManager);
	}

	private resolveEmbeddingConnection(): ConstructorParameters<
		typeof EmbeddingAdapter
	>[0] {
		const candidates = [
			'ollama',
			'lmstudio',
			'openai',
			'openrouter',
			'custom',
		] as const;
		for (const providerId of candidates) {
			const credentials =
				this.settings.multiProvider.credentials[providerId];
			if (!credentials?.enabled || !credentials.baseUrl) continue;
			return {
				baseUrl: sanitizeBaseUrl(credentials.baseUrl),
				apiKey: credentials.apiKey,
				providerId,
				ttl: this.settings.multiProvider.defaults.ttl,
				keepAlive: this.settings.multiProvider.defaults.keepAlive,
			};
		}
		// Offline-safe default: failed requests transparently use local TF vectors.
		return {
			baseUrl: 'http://localhost:11434',
			providerId: 'ollama',
			model: 'nomic-embed-text',
		};
	}

	onunload(): void {
		void this.unloadAsync().catch((error: unknown) => {
			console.error('[CC] Final unload flush failed:', error);
		});
	}

	private async unloadAsync(): Promise<void> {
		this.clearDaemonRetry();
		await this.flushAgentStateUpdates();
		this.memoryBank.stopBackgroundPruning();
		this.vaultWatcher.stop();
		this.folderIndexer.stop();
		this.daemon.trace.clearCallback();
		this.commandCenterView = null;
		this.commandCenterChatView = null;
		this.daemon.stop();
		// Final persistence flush: conversations + history
		this.persistSessions();
		// Mark any still-queued tasks as lost
		this.persistQueue();
		await this.agentMemory.forceFlush();
		await this.persist.forceFlush();
	}

	/* ─── Daemon hot-restart ───────────────────────── */

	/**
	 * Update the daemon's pi binary path. Returns false if an active
	 * task is in flight (prevents orphaned RPC handlers).
	 */
	setDaemonPath(newPath: string): boolean {
		return this.daemon.setPiPath(newPath);
	}

	/**
	 * Restart the daemon and update the status bar. Safe to call
	 * after a path change or enable/disable toggle.
	 * Returns true if the daemon started successfully.
	 */
	restartDaemon(): boolean {
		this.clearDaemonRetry();
		this.daemonRetryCount = 0;
		try {
			this.daemon.start();
			if (this.daemon.startError) {
				this.statusBar.setState('error');
				this.scheduleDaemonRetry();
				return false;
			}
			this.statusBar.setState('running');
			return true;
		} catch (err) {
			this.statusBar.setState('error');
			console.error('[CC] Daemon restart failed:', err);
			return false;
		}
	}

	/** Attempt a manual retry of the daemon (e.g., from UI). */
	retryDaemon(): boolean {
		this.clearDaemonRetry();
		this.daemonRetryCount = 0;
		return this.restartDaemon();
	}

	/**
	 * Ensure the local Pi daemon is running before a daemon-only operation.
	 * Re-detects the executable, clears stale process state, starts Pi, then
	 * waits briefly because child_process spawn errors arrive asynchronously.
	 */
	async ensureDaemonRunning(): Promise<boolean> {
		if (this.daemon.isRunning() && !this.daemon.startError) return true;

		const detectedPath = detectPiPath(this.settings.piPath);
		if (detectedPath && detectedPath !== this.daemon.piPath) {
			if (!this.daemon.setPiPath(detectedPath)) return false;
			this.settings.piPath = detectedPath;
			await this.saveSettings();
		}

		// Remove any failed/stale process object before restarting.
		this.daemon.stop();
		this.daemon.start();

		// A successful spawn is immediately running; ENOENT/EINVAL arrives on
		// the async error event, so allow it time to settle before deciding.
		await new Promise<void>((resolve) => window.setTimeout(resolve, 350));
		const running = this.daemon.isRunning() && !this.daemon.startError;
		this.statusBar.setState(running ? 'running' : 'error');
		this.commandCenterView?.updateDaemonStatus();
		return running;
	}

	/* ─── Daemon auto-retry (exponential backoff) ───── */

	private scheduleDaemonRetry(): void {
		if (this.daemonRetryCount >= this.DAEMON_RETRY_CAP) {
			console.warn(
				'[CC] Daemon retry cap reached — giving up. Check pi binary path in settings.',
			);
			return;
		}
		const delay = Math.min(
			this.DAEMON_RETRY_BASE_MS * Math.pow(2, this.daemonRetryCount),
			this.DAEMON_RETRY_MAX_MS,
		);
		console.warn(
			`[CC] Daemon start failed — retrying in ${delay / 1000}s (attempt ${this.daemonRetryCount + 1}/${this.DAEMON_RETRY_CAP})`,
		);

		this.daemonRetryTimer = window.setTimeout(() => {
			this.daemonRetryTimer = null;
			if (!this.daemon.isRunning()) {
				this.daemon.stop(); // clean up any stale process
				this.daemon.start();
				if (this.daemon.startError) {
					this.daemonRetryCount++;
					this.scheduleDaemonRetry();
				} else {
					this.daemonRetryCount = 0;
					this.statusBar.setState('running');
				}
			}
		}, delay);
	}

	private clearDaemonRetry(): void {
		if (this.daemonRetryTimer !== null) {
			window.clearTimeout(this.daemonRetryTimer);
			this.daemonRetryTimer = null;
		}
	}

	/* ─── Settings persistence ──────────────────────── */

	async saveSettings(): Promise<void> {
		this.persist.setSettings({ ...this.settings });
		await this.persist.forceFlush();
	}

	/* ─── Task history ──────────────────────────────── */

	addTaskToHistory(task: Task): void {
		const compacted: StoredTask = {
			id: task.id,
			workerProfile: task.workerProfile,
			prompt: task.prompt.slice(0, TOKEN_LIMITS.MAX_STORED_CHARS),
			targetPath: task.targetPath,
			status: task.status,
			createdAt: task.createdAt,
			startedAt: task.startedAt,
			completedAt: task.completedAt,
			error: task.error?.slice(0, TOKEN_LIMITS.MAX_STORED_CHARS),
			result: task.result
				? {
						output: task.result.output?.slice(
							0,
							TOKEN_LIMITS.MAX_RESULT_OUTPUT_CHARS,
						),
						summary: task.result.summary?.slice(
							0,
							TOKEN_LIMITS.MAX_STORED_CHARS,
						),
				metadata: task.result.metadata,
					}
				: undefined,
		};
		this.taskHistory.unshift(compacted);
		if (this.taskHistory.length > this.maxHistory) {
			this.taskHistory = this.taskHistory.slice(0, this.maxHistory);
		}
		this.persist.setHistory(this.taskHistory);
		this.commandCenterView?.addTaskToHistory(compacted);
	}

	getTaskHistory(): StoredTask[] {
		return this.taskHistory;
	}

	/** Manually trigger memory bank pruning. */
	async pruneMemory(): Promise<number> {
		return this.memoryBank.prune(this.settings.memoryMaxNotes);
	}

	/* ─── Queue persistence ─────────────────────────── */

	private persistQueue(): void {
		// Snapshot pending tasks from the queue (no callbacks - they won't survive)
		const stats = this.taskQueue.getStats();
		// We can't access queue entries directly; mark as having pending state
		// For now, just keep the persisted queue as-is and clear on drain
		if (stats.pending === 0 && stats.running === 0) {
			this.persist.setQueue([]);
		}
	}

	private rehydrateQueue(stored: StoredTask[]): void {
		if (!stored || stored.length === 0) return;
		for (const st of stored) {
			if (st.status === 'queued' || st.status === 'running') {
				const task: Task = {
					id: st.id,
					workerProfile: st.workerProfile,
					prompt: st.prompt,
					targetPath: st.targetPath,
					status: 'queued',
					createdAt: Date.now(),
					// No onStream callback — this is a rehydrated task
				};
				this.taskQueue.enqueue(task, {
					onError: (err) => {
						this.addTaskToHistory({
							...task,
							status: 'failed',
							error: err,
							completedAt: Date.now(),
						});
					},
				});
			}
		}
	}

	/* ─── Session persistence ───────────────────────── */

	private persistSessions(): void {
		const active = this.conversations.getActive();
		const list = this.conversations.list();
		const sessions: StoredSessions = {
			activeId: active?.id ?? null,
			conversations: list.map((c) => ({
				id: c.id,
				name: c.name,
				workerProfile: c.workerProfile,
				createdAt: c.createdAt,
				updatedAt: c.updatedAt,
				turns: c.turns.map((t) => ({
					id: t.id,
					role: t.role,
					content: t.content.slice(0, TOKEN_LIMITS.MAX_TURN_CHARS),
					timestamp: t.timestamp,
					taskId: t.taskId,
				})),
			})),
		};
		this.persist.setSessions(sessions);
	}

	private rehydrateSessions(sessions: StoredSessions | null): void {
		if (!sessions || !sessions.conversations) return;

		for (const sc of sessions.conversations) {
			const conv: Conversation = {
				id: sc.id,
				name: sc.name,
				workerProfile: sc.workerProfile,
				createdAt: sc.createdAt,
				updatedAt: sc.updatedAt,
				turns: sc.turns.map((st) => ({
					id: st.id,
					role: st.role as Turn['role'],
					content: st.content,
					timestamp: st.timestamp,
					taskId: st.taskId,
				})),
			};
			this.conversations.hydrate(conv);
		}

		if (sessions.activeId) {
			this.conversations.setActive(sessions.activeId);
		}
	}

	/* ─── Native Bases queue ────────────────────────── */

	/** Enqueue Base files in bounded tiers, refreshing after each tier's state writes settle. */
	enqueueBaseFiles(
		files: TFile[],
		workerProfile: string,
		promptTemplate: string,
		batchConcurrency = 1,
		onBatchComplete?: () => void,
	): void {
		const size = Math.max(1, Math.min(10, Math.floor(batchConcurrency)));
		let cursor = 0;
		const enqueueNextBatch = () => {
			const batch = files.slice(cursor, cursor + size);
			cursor += batch.length;
			if (batch.length === 0) return;
			let remaining = batch.length;
			const settled = () => {
				remaining--;
				if (remaining > 0) return;
				void this.flushAgentStateUpdates().finally(() => {
					onBatchComplete?.();
					enqueueNextBatch();
				});
			};
			for (const file of batch) {
				const prompt = promptTemplate.replace(
					/\{\{\s*file\.(path|name|basename)\s*\}\}/g,
					(_match, field: string) => {
					if (field === 'name') return file.name;
					if (field === 'basename') return file.basename;
					return file.path;
					},
				);
				this.taskQueue.enqueue(
					{
					id: crypto.randomUUID(),
					workerProfile,
					prompt,
					targetPath: file.path,
					status: 'queued',
					createdAt: Date.now(),
					},
					{ onComplete: settled, onError: settled },
				);
			}
		};
		enqueueNextBatch();
	}

	/* ─── Agent state → note properties ─────────────── */

	/** Resolve a daemon/task completion signal to a note and debounce its native mutation. */
	private queueAgentStateUpdate(state: AgentExecutionState): void {
		const abstractFile = this.app.vault.getAbstractFileByPath(
			state.targetPath,
		);
		if (!(abstractFile instanceof TFile) || abstractFile.extension !== 'md')
			return;
		this.frontmatterSync.queue(abstractFile, {
			status: state.status,
			evalScore: state.evalScore,
			lastRun: new Date(state.completedAt).toISOString(),
		});
	}

	private async flushAgentStateUpdates(): Promise<void> {
		await this.frontmatterSync.flush();
	}

	/* ─── Native workflow execution ─────────────────── */

	/** Export the active Markdown workflow as a native Obsidian Canvas and open it. */
	async exportActiveWorkflowToCanvas(): Promise<TFile | null> {
		const source = this.app.workspace.getActiveFile();
		if (!source || source.extension !== 'md') {
			new Notice('Open a Markdown workflow note to export it to Canvas.');
			return null;
		}
		const rawFrontmatter: unknown = this.app.metadataCache.getFileCache(source)?.frontmatter;
		const frontmatter = isRecord(rawFrontmatter) ? rawFrontmatter : undefined;
		const workflowMetadata = frontmatter?.workflow;
		if (
			!Array.isArray(frontmatter?.steps) &&
			(workflowMetadata === null || typeof workflowMetadata !== 'object')
		) {
			new Notice(
				'The active Markdown note does not contain workflow frontmatter.',
			);
			return null;
		}
		const workflow = loadWorkflowFromNote(source, this.app);
		if (workflow.steps.length === 0) {
			new Notice('The active workflow has no steps to export.');
			return null;
		}
		const folder = source.parent?.path ?? '';
		const baseName = `${source.basename}.canvas`;
		let path = normalizePath(folder ? `${folder}/${baseName}` : baseName);
		let suffix = 2;
		while (this.app.vault.getAbstractFileByPath(path)) {
			path = normalizePath(
				folder
					? `${folder}/${source.basename}-${suffix++}.canvas`
					: `${source.basename}-${suffix++}.canvas`,
			);
		}
		const created = await this.app.vault.create(
			path,
			exportWorkflowToCanvas(workflow),
		);
		await this.app.workspace.getLeaf(false).openFile(created);
		new Notice(`Workflow exported to ${path}`);
		return created;
	}

	/** Execute a compiled workflow while streaming all step output into Live Output. */
	async executeWorkflow(
		definition: WorkflowDefinition,
		inputs: Record<string, unknown>,
		targetFile?: TFile,
	): Promise<WorkflowExecutionContext> {
		this.requireInitialized();
		await this.activateCommandCenterView();
		const streamId = `workflow:${definition.id}:${Date.now()}`;
		const view = this.commandCenterView;
		view?.startTaskStream(streamId, `workflow: ${definition.name}`);
		view?.appendStreamOutput(
			`Starting ${definition.name} (${definition.steps.length} steps)…\n`,
			streamId,
		);
		try {
			const context = await this.workflowEngine.execute(
				definition,
				inputs,
				{
					onStream: (delta) => {
					const currentView = this.commandCenterView;
					if (!currentView) return;
						if (!currentView.hasTaskStream(streamId))
							currentView.startTaskStream(
								streamId,
								`workflow: ${definition.name}`,
							);
					currentView.appendStreamOutput(delta, streamId);
				},
				},
			);
			this.commandCenterView?.appendStreamOutput(
				`\nWorkflow complete — ${context.totalTokens} tokens, ${context.totalLatencyMs} ms.`,
				streamId,
			);
			this.commandCenterView?.finalizeStreamOutput(streamId);
			if (targetFile?.extension === 'md') {
				this.frontmatterSync.queue(targetFile, {
					status: 'completed',
					lastRun: new Date().toISOString(),
				});
			}
			return context;
		} catch (error) {
			this.commandCenterView?.appendStreamOutput(
				`\nWorkflow failed: ${(error as Error).message}`,
				streamId,
			);
			this.commandCenterView?.finalizeStreamOutput(streamId);
			if (targetFile?.extension === 'md') {
				this.frontmatterSync.queue(targetFile, {
					status: 'failed',
					lastRun: new Date().toISOString(),
				});
			}
			throw error;
		}
	}

	/** Execute one workflow independently for every active note in a Base queue. */
	async executeWorkflowOnTargets(
		definition: WorkflowDefinition,
		inputs: Record<string, unknown>,
		targets: TFile | TFile[],
		options: WorkflowBatchOptions = {},
	): Promise<WorkflowTargetExecution[]> {
		await this.activateCommandCenterView();
		const streamId = `workflow-batch:${definition.id}:${Date.now()}`;
		this.commandCenterView?.startTaskStream(
			streamId,
			`workflow queue: ${definition.name}`,
		);
		try {
			const results = await this.workflowEngine.executeOnTargets(
				definition,
				inputs,
				targets,
				this.app,
				{
				...options,
				onStream: (delta, step, target) => {
					const view = this.commandCenterView;
					if (!view) return;
						if (!view.hasTaskStream(streamId))
							view.startTaskStream(
								streamId,
								`workflow queue: ${definition.name}`,
							);
						view.appendStreamOutput(
							`${target ? `[${target.path}] ` : ''}${delta}`,
							streamId,
						);
					options.onStream?.(delta, step, target);
				},
				},
			);
			this.commandCenterView?.appendStreamOutput(
				`\nQueue complete — ${results.length} target notes.`,
				streamId,
			);
			this.commandCenterView?.finalizeStreamOutput(streamId);
			return results;
		} catch (error) {
			this.commandCenterView?.appendStreamOutput(
				`\nQueue failed: ${(error as Error).message}`,
				streamId,
			);
			this.commandCenterView?.finalizeStreamOutput(streamId);
			throw error;
		}
	}

	/** Dispatch a resolved global voice prompt to the explicitly selected engine. */
	async dispatchVoicePrompt(
		mode: VoicePromptMode,
		spokenText: string,
		resolved: ResolvedChatContext,
	): Promise<void> {
		// Preserve the original speech when handing off to chat: the chat view owns
		// mention/selection resolution and will refresh its context pills before send.
		if (this.commandCenterChatView) {
			await this.commandCenterChatView.submitExternalPrompt(
				spokenText,
				mode,
			);
			return;
		}

		const prompt = resolved.cleanedPrompt || spokenText;
		const enrichedPrompt = resolved.contextString
			? `${prompt}\n\n${resolved.contextString}`
			: prompt;
		const activeFile = this.app.workspace.getActiveFile();

		if (mode === 'workflow') {
			if (
				!activeFile ||
				(activeFile.extension !== 'md' &&
					activeFile.extension !== 'canvas')
			) {
				throw new Error(
					'Open a Markdown or Canvas workflow before using Workflow voice mode.',
				);
			}
			const workflow =
				activeFile.extension === 'canvas'
				? await loadWorkflowFromCanvas(activeFile, this.app)
				: loadWorkflowFromNote(activeFile, this.app);
			if (!workflow.steps.length)
				throw new Error('The active workflow has no executable steps.');
			await this.executeWorkflow(
				workflow,
				{ prompt: enrichedPrompt, voicePrompt: enrichedPrompt },
				activeFile,
			);
			return;
		}

		await this.activateCommandCenterView();
		const streamId = `voice-${mode}-${Date.now().toString(36)}`;
		this.commandCenterView?.startTaskStream(
			streamId,
			`${mode}-voice`,
			activeFile?.path,
		);
		try {
			if (mode === 'react') {
				const ready = await this.ensureDaemonRunning();
				if (!ready)
					throw new Error(
						this.daemon.startError ?? 'Pi daemon is unavailable.',
					);
				const response = await this.router.withJitModel(
					'reasoning',
					() =>
					this.daemon.executeReActSession(
						enrichedPrompt,
						activeFile?.path,
						createObsidianTools(this.app),
						DEFAULT_REACT_CONFIG,
							(event) => {
								if (
									event.type === 'thought' ||
									event.type === 'action_complete' ||
									event.type === 'final_answer'
								) {
									this.commandCenterView?.appendStreamOutput(
										event.data,
										streamId,
									);
							}
						},
					),
				);
				if (response.error) throw new Error(response.error);
				this.commandCenterView?.appendStreamOutput(
					response.result?.output ?? response.result?.summary ?? '',
					streamId,
				);
			} else {
				const request = activeFile
					? `${enrichedPrompt}\n\nActive vault context: [[${activeFile.path}]]`
					: enrichedPrompt;
				let streamed = '';
				const result = await this.conversations.executeProviderTurn(
					this.dispatcher,
					request,
					'fast',
					(delta) => {
					streamed += delta;
						this.commandCenterView?.appendStreamOutput(
							delta,
							streamId,
						);
					},
				);
				if (!streamed)
					this.commandCenterView?.appendStreamOutput(
						result.output ?? result.summary ?? '',
						streamId,
					);
			}
			this.commandCenterView?.finalizeStreamOutput(streamId);
		} catch (error) {
			this.commandCenterView?.appendStreamOutput(
				`\nVoice prompt failed: ${(error as Error).message}`,
				streamId,
			);
			this.commandCenterView?.finalizeStreamOutput(streamId);
			throw error;
		}
	}

	/** Backward-compatible Quick-mode entry point. */
	async dispatchQuickVoicePrompt(
		spokenText: string,
		resolved: ResolvedChatContext,
	): Promise<void> {
		await this.dispatchVoicePrompt('quick', spokenText, resolved);
	}

	/* ─── View management ───────────────────────────── */

	async activateCommandCenterView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(COMMAND_CENTER_VIEW_TYPE);
		if (existing.length > 0) {
			void workspace.revealLeaf(existing[0]!);
			return;
		}
		const leaf = workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({
			type: COMMAND_CENTER_VIEW_TYPE,
			active: true,
		});
		void workspace.revealLeaf(leaf);
	}

	/** Reveal the existing chat panel or create a split in the right sidebar. */
	async activateCommandCenterChatView(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(
			COMMAND_CENTER_CHAT_VIEW_TYPE,
		);
		if (existing.length > 0) {
			await workspace.revealLeaf(existing[0]!);
			return;
		}
		const leaf = workspace.getRightLeaf(true);
		if (!leaf) return;
		await leaf.setViewState({
			type: COMMAND_CENTER_CHAT_VIEW_TYPE,
			active: true,
		});
		await workspace.revealLeaf(leaf);
	}
}

/* ─── ReAct Task Executor (module-level helper) ──────── */

async function executeReActTask(
	daemon: PiAgentDaemon,
	tools: ToolDefinition[],
	task: Task,
	memoryBank: ReActMemoryBank,
	router: ModelRouter,
): Promise<TaskResult> {
	const reactStream = task.onStream
		? (event: ReActStreamEvent) => {
			const prefix = `[Cycle ${event.cycleIndex + 1}] `;
			switch (event.type) {
					case 'thought':
						task.onStream!(`🧠 Reasoning...\n`);
						break;
					case 'action_start':
						task.onStream!(`${prefix}🔧 ${event.data}\n`);
						break;
					case 'observation':
						task.onStream!(`${prefix}📋 ${event.data}...\n`);
						break;
					case 'final_answer':
						task.onStream!(`✅ Final Answer:\n${event.data}\n`);
						break;
					case 'error':
						task.onStream!(`❌ ${event.data}\n`);
						break;
			}
		}
		: undefined;

	// Inject relevant past context from memory bank
	const memoryContext = await memoryBank.getRecentContext(task.prompt);
	const enrichedPrompt = memoryContext
		? `${memoryContext}\n\n---\n\n## Current Task\n${task.prompt}`
		: task.prompt;

	const response = await router.withJitModel('reasoning', () =>
		daemon.executeReActSession(
			enrichedPrompt,
			task.targetPath,
			tools,
			DEFAULT_REACT_CONFIG,
			reactStream,
		),
	);

	// Store session metadata in memory for future recall
	const metadata = response.result?.metadata;
	const sessionId =
		typeof metadata?.reactSessionId === 'string'
			? metadata.reactSessionId
			: '';
	if (sessionId) {
		const summaryCtx: ReActContext = {
			sessionId,
			task: task.prompt,
			targetPath: task.targetPath,
			cycles: [],
			meta: {
				startedAt: Date.now(),
				completedAt: Date.now(),
				totalCycles:
					typeof metadata?.cycles === 'number' ? metadata.cycles : 0,
				daemonCalls:
					typeof metadata?.daemonCalls === 'number'
						? metadata.daemonCalls
						: 0,
				toolCalls:
					typeof metadata?.toolCalls === 'number'
						? metadata.toolCalls
						: 0,
				termination:
					typeof metadata?.termination === 'string'
						? (metadata.termination as ReActTermination)
						: 'final_answer',
			},
		};
		memoryBank.storeSessionSummary(summaryCtx).catch(() => {
			/* non-critical */
		});
	}

	const output = response.result?.output ?? response.error ?? '';
	return {
		output:
			output.length > TOKEN_LIMITS.MAX_RESULT_OUTPUT_CHARS
				? output.slice(0, TOKEN_LIMITS.MAX_RESULT_OUTPUT_CHARS) +
					'\n\n[output truncated]'
				: output,
		summary: response.result?.summary ?? 'ReAct session completed.',
		metadata: response.result?.metadata,
	};
}
