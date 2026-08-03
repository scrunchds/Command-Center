import { Modal, Notice, normalizePath, Plugin, TFile, type WorkspaceLeaf } from 'obsidian';
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
} from './settings/settings-model';
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
	CommandCenterBrowserView,
	COMMAND_CENTER_BROWSER_VIEW_TYPE,
} from './ui/browser-view';
import {
	COMMAND_CENTER_BASES_VIEW_ID,
	commandCenterBasesRegistration,
} from './ui/command-center-bases-view';
import { TaskQueue, type TaskExecutor } from './task-queue';
import { VaultWatcher } from './vault-watcher';
import { CommandCenterStatusBar } from './status-bar';
import type { Task, TaskResult, ToolConfirmationDecision, ToolConfirmationRequest, ToolDefinition } from './types';
import { TOKEN_LIMITS } from './types';
import type { Conversation, Turn } from './conversation';
import { ConversationManager } from './conversation';
import { createObsidianTools, createWebSearchTool } from './obsidian-tools';
import { registerExtendedVaultTools } from './extended-vault-tools';
import {
	getCapabilityRegistry,
	registerBuiltinCapabilities,
	applyCapabilityPreferences,
} from './capabilities';
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
import { CommandCenterCommandBridge } from './cli/command-bridge';
import { NativeAutoRouter } from './routing/NativeAutoRouter';
import { DataNormalizer } from './execution/DataNormalizer';
import { ExecutionRouter } from './execution/ExecutionRouter';
import { PythonWorkerTransport } from './execution/PythonWorkerTransport';
import { BUNDLED_PYTHON_WORKER } from './execution/BundledPythonWorker';
import { MemoryCredentialVault } from './security/VaultCrypto';
import { TopographySweep as PersistentTopographySweep, type VaultTopography } from './metacognition/TopographySweep';
import { SemanticDatabase } from './metacognition/SemanticDatabase';
import { DialecticRAG } from './metacognition/DialecticRAG';
import { ShadowTestHarness } from './testing/ShadowTestHarness';
import { AccessibilityAudio } from './audio/AccessibilityAudio';

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
	commandCenterBrowserView: CommandCenterBrowserView | null = null;

	/** Resolve the active Command Center dashboard view (guideline: no stored view refs). */
	getCommandCenterView(): CommandCenterView | null {
		const leaves = this.app.workspace.getLeavesOfType(COMMAND_CENTER_VIEW_TYPE);
		return leaves.length > 0 ? leaves[0]!.view as CommandCenterView : null;
	}

	/** Resolve the active Command Center chat view (guideline: no stored view refs). */
	getCommandCenterChatView(): CommandCenterChatView | null {
		const leaves = this.app.workspace.getLeavesOfType(COMMAND_CENTER_CHAT_VIEW_TYPE);
		return leaves.length > 0 ? leaves[0]!.view as CommandCenterChatView : null;
	}

	/** Multi-provider subsystem (v2.0). */
	providerFactory!: ProviderFactory;
	credentialVault!: MemoryCredentialVault;
	dispatcher!: ProviderDispatcher;
	router!: ModelRouter;
	endpointRouter!: EndpointModelRouter;
	workflowEngine!: WorkflowEngine;
	orchestrator!: Orchestrator;
	nativeAutoRouter!: NativeAutoRouter;
	executionRouter!: ExecutionRouter;
	pythonWorker!: PythonWorkerTransport;
	semanticDatabase!: SemanticDatabase;
	dialecticRag!: DialecticRAG;
	accessibilityAudio!: AccessibilityAudio;
	private persistentTopography: VaultTopography | null = null;

	private taskHistory: StoredTask[] = [];
	private readonly baseQueueTasks = new Map<string, { status: 'queued' | 'running'; targetPath: string }>();
	private readonly normalizer = new DataNormalizer();
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
		// ── Settings & persistence layer ────────────────
		// Must complete before any view, command, or subsystem registration so
		// the settings tab and all UI components read fully-hydrated values.
		this.persist = new PersistenceManager(this);
		const data = await this.persist.load();
		this.loadSettings(data.settings);
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
		const obsidianTools = createObsidianTools(this.app);
		this.daemon = new PiAgentDaemon(vaultPath, this.settings.piPath);
		this.frontmatterSync = new DebouncedFrontmatterSync(this.app, 750);
		this.daemon.setExecutionStateCallback((state) =>
			this.queueAgentStateUpdate(state),
		);
		this.daemon.registerTools(obsidianTools);
		this.memoryBank = new ReActMemoryBank(this.app);
		this.agentMemory = new AgentMemoryStore(this.app);
		await this.agentMemory.ready();
		const embeddingConnection = this.resolveEmbeddingConnection();
		this.hybridRetriever = new HybridRetriever({
			embeddings: new EmbeddingAdapter(embeddingConnection),
		});
		await this.hybridRetriever.indexVault(this.app);
		const contextCharLimit = Math.max(2_000, this.settings.contextCharLimit ?? 16_000);
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
		const vaultSearchTool = createVaultSearchTool(this.hybridRetriever, {
			canReadVault: () => true,
		});
		this.daemon.registerTools([vaultSearchTool]);
		this.providerFactory = new ProviderFactory(
			this.daemon,
			() => this.settings.multiProvider,
			this.credentialVault,
		);
		this.dispatcher = new ProviderDispatcher(
			this.providerFactory,
			() => this.settings.multiProvider,
		);
		// Mandatory route/normalization boundary for modality-aware command flows.
		this.nativeAutoRouter = new NativeAutoRouter(this.app, this.providerFactory, () => this.settings);
		await this.nativeAutoRouter.reload();
		this.pythonWorker = new PythonWorkerTransport({
			workerSource: BUNDLED_PYTHON_WORKER,
			cwd: vaultPath,
			timeoutMs: 60_000,
		});
		this.executionRouter = new ExecutionRouter(
			this.dispatcher,
			new DataNormalizer(),
			this.pythonWorker,
			this.nativeAutoRouter,
			this.credentialVault,
		);
		// SQLite is an optional injected desktop capability. The database remains
		// operational with an in-memory local index when no safe native driver exists.
		this.semanticDatabase = new SemanticDatabase(undefined, 384, this.app.vault.configDir);
		await this.semanticDatabase.open();
		this.dialecticRag = new DialecticRAG(
			this.nativeAutoRouter,
			this.pythonWorker,
			this.semanticDatabase,
		);
		// One canonical silent, read-only topology observation. It retains the
		// snapshot in memory and writes only the plugin-localized map.
		const persistentSweep = new PersistentTopographySweep(this.app);
		void persistentSweep.run().then(snapshot => { this.persistentTopography = snapshot; }).catch(error => {
			console.warn('[CC] Localized topography map unavailable:', error);
		});

		// ── Capability Registry ────────────────────────
		// Initialize the unified tool-calling surface. Wraps existing
		// obsidian-tools, vault search, extended tools, and web search
		// into a discoverable, user-configurable capability system.
		{
			const registry = getCapabilityRegistry();
			const webSearchTool = this.settings.webSearchEnabled
				? createWebSearchTool()
				: undefined;
			registerBuiltinCapabilities(this.app, [...obsidianTools, vaultSearchTool], webSearchTool);
			// Register extended vault tools (edit, delete, create/delete folder, rename, move)
			// that are not part of the original obsidian-tools surface.
			// The registry is idempotent — calling register again updates the tool definition.
			registerExtendedVaultTools(this.app);
			// Apply persisted user preferences on top of defaults
			if (this.settings.capabilityPreferences?.length) {
				applyCapabilityPreferences(this.settings.capabilityPreferences);
			}
			void registry;
		}

		this.router = new ModelRouter(
			this.providerFactory,
			() => this.settings.multiProvider,
			() => {
				// Use the capability registry so user-configurable tool settings
				// are honored across all model interactions.
				return getCapabilityRegistry().getEnabledToolDefinitions(true);
			},
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
				const key = reference?.trim() || endpoint.provider;
				return this.credentialVault.get(key).trim()
					|| this.credentialVault.get(endpoint.provider).trim()
					|| Object.values(
						this.settings.multiProvider.credentials,
					).find((credentials) => credentials?.providerId === key)
						?.apiKey?.trim();
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
						// Use the capability registry so user-configurable tools are honored
						// (enabled/disabled capabilities filter the tool surface).
						getCapabilityRegistry().getEnabledToolDefinitions(true),
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

				// ── Native intent routing + mandatory normalized execution boundary ──
				const resolution = this.nativeAutoRouter.resolve('text');
				const normalized = await this.executionRouter.execute({
					resolution,
					request: {
						systemPrompt: this.configManager.requireStyleGuide(),
						userPrompt: task.prompt,
						taskId: task.id,
						onStream: task.onStream,
					},
				});
				return {
					output: normalized.content,
					summary: normalized.success ? normalized.content : normalized.error,
					metadata: { normalizedExecution: normalized },
				};
			},
		};
		this.taskQueue = new TaskQueue(executor, 1);
		this.vaultWatcher = new VaultWatcher(this.app.vault);

		// ── Status bar ─────────────────────────────────
		const statusBarEl = this.addStatusBarItem();
		this.statusBar = new CommandCenterStatusBar(statusBarEl, 'CC');

		// ── Queue events → status bar + history + persistence + streaming ──
		const onQueueEvent = (_event: string, task: Task) => {
			const baseTask = this.baseQueueTasks.get(task.id);
			if (baseTask) {
				if (_event === 'started') baseTask.status = 'running';
				else if (_event === 'completed' || _event === 'failed') this.baseQueueTasks.delete(task.id);
			}
			const stats = this.taskQueue.getStats();
			this.statusBar.setStats(stats);
			this.statusBar.setState(
				stats.running > 0
					? 'busy'
					: this.daemon.isRunning()
						? 'running'
						: 'stopped',
			);

			if (_event === 'started' && this.getCommandCenterView()) {
				// Resolve the current view at delivery time; never retain a closed tab.
				const view = this.getCommandCenterView();
				if (view) {
					view.startTaskStream(
						task.id,
						task.workerProfile,
						task.targetPath,
					);
					task.onStream = (delta: string) => {
						const current = this.getCommandCenterView();
						if (!current) return;
						if (!current.hasTaskStream(task.id))
							current.startTaskStream(
								task.id,
								task.workerProfile,
								task.targetPath,
							);
						current.appendStreamOutput(delta, task.id);
					};
				}
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
				this.getCommandCenterView()?.finalizeStreamOutput(task.id);
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
			return new CommandCenterView(leaf, this);
		});
		this.registerView(COMMAND_CENTER_CHAT_VIEW_TYPE, (leaf) => {
			return new CommandCenterChatView(leaf, this);
		});
		this.registerView(COMMAND_CENTER_BROWSER_VIEW_TYPE, (leaf) => {
			const view = new CommandCenterBrowserView(leaf, this);
			this.commandCenterBrowserView = view;
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
		this.addRibbonIcon('command', 'Command center', () =>
			this.activateCommandCenterView(),
		);
		this.addRibbonIcon(
			'message-square',
			'Command center: Open chat panel',
			() => this.activateCommandCenterChatView(),
		);
		this.addRibbonIcon('globe', 'Command center: Open browser', () =>
			void this.activateCommandCenterBrowserView(),
		);
		this.addSettingTab(new PluginSettingsTab(this.app, this));
		registerCommands(this);
		this.commandBridge = new CommandCenterCommandBridge(this);
		this.commandBridge.register();
		this.addCommand({
			id: 'start-setup-onboarding-interview',
			name: 'Start setup / onboarding interview',
			callback: () => this.openOnboarding(),
		});
		this.addCommand({
			id: 'reset-reinitialize-vault-config',
			name: 'Reset and re-initialize vault config',
			callback: () => this.confirmResetConfiguration(),
		});
		this.addCommand({
			id: 'run-shadow-clone-diagnostics',
			name: 'Run shadow-clone diagnostics',
			callback: () => { void this.runShadowCloneDiagnostics(); },
		});
		this.addCommand({
			id: 'open-browser-panel',
			name: 'Open browser',
			callback: () => { void this.activateCommandCenterBrowserView(); },
		});

		// Defer first-run discovery until Obsidian's workspace is ready. The
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

	/** Route every destructive mutation decision through the full-page dashboard. */
	async requestDashboardApproval(request: ToolConfirmationRequest): Promise<ToolConfirmationDecision> {
		await this.activateCommandCenterView();
		const view = this.getCommandCenterView();
		if (!view) return 'rejected';
		return view.requestMutationApproval(request);
	}

	/** Normalize a provider/agent result before it reaches dashboard UI. */
	normalizeDashboardOutput(payload: unknown): ReturnType<DataNormalizer['normalize']> {
		return this.normalizer.normalize(payload, 'provider-dispatcher');
	}

	/** Open (or restart) discovery inside the full-page Command Center dashboard. */
	openOnboarding(): void {
		void (async () => {
			await this.activateCommandCenterView();
			const view = this.getCommandCenterView();
			if (!view) throw new Error('Command Center dashboard failed to initialize.');
			const engine = new InterviewEngine(this.app, this.dispatcher, this.configManager);
			await view.openOnboarding(engine, async (config) => {
				await this.folderIndexer.initialize(config.managedFolders);
				this.configureDailyEngines(config);
				await this.dailyEngine.ready();
			});
		})().catch((error: unknown) => {
			console.error('[CC] Dashboard onboarding failed:', error);
			new Notice(`Command Center setup failed: ${error instanceof Error ? error.message : String(error)}`, 15000);
		});
	}

	private confirmResetConfiguration(): void {
		const modal = new (class extends Modal {
			constructor(private readonly plugin: CommandCenterPlugin) {
				super(plugin.app);
			}
			onOpen(): void {
				this.contentEl.createEl('h2', {
					text: 'Reset command center configuration?',
				});
				this.contentEl.createEl('p', {
					text: 'This moves config.json and style-guide.md to trash, clears runtime configuration, and starts a new interview. Vault notes and indexes are not deleted.',
				});
				const actions = this.contentEl.createDiv({
					cls: 'modal-button-container',
				});
				const cancel = actions.createEl('button', { text: 'Cancel' });
				cancel.addEventListener('click', () => this.close());
				const reset = actions.createEl('button', {
					text: 'Reset and re-initialize',
					cls: 'mod-warning',
				});
				reset.addEventListener('click', () => { void (async () => {
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
			const credentials = this.settings.multiProvider.credentials[providerId];
			const meta = PROVIDER_REGISTRY[providerId];
			if (!credentials?.enabled || !credentials.baseUrl) continue;
			if (meta.requiresKey && !this.credentialVault.has(providerId)) continue;
			return {
				baseUrl: sanitizeBaseUrl(credentials.baseUrl),
				apiKey: this.credentialVault.get(providerId).trim(),
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

	private async runShadowCloneDiagnostics(): Promise<void> {
		const harness = new ShadowTestHarness(this.nativeAutoRouter);
		const report = await harness.runDiagnostics();
		const markdown = harness.formatReport(report);
		new Notice(`Shadow-Clone diagnostics: ${report.passed}/${report.total} passed. See developer console for the sanitized report.`, 8000);
		void markdown;
	}

	onunload(): void {
		this.credentialVault.lock();
		this.accessibilityAudio?.dispose();
		// Clear the capability registry so stale tool references are not
		// retained across plugin reloads.
		getCapabilityRegistry().clear();
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
		this.commandCenterBrowserView = null;
		this.pythonWorker?.dispose();
		await this.semanticDatabase?.close();
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
		this.getCommandCenterView()?.updateDaemonStatus();
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

	/**
	 * Hydrate the plugin settings object from persisted data, merging with
	 * DEFAULT_SETTINGS so every field is guaranteed a value. Called once
	 * synchronously at the top of onload() before any view or subsystem is
	 * registered.
	 */
	private loadSettings(loaded: Record<string, unknown>): void {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			loaded as Partial<CommandCenterSettings>,
		);
		this.settings.dashboardLayout = Array.isArray(this.settings.dashboardLayout)
			? this.settings.dashboardLayout
			: DEFAULT_SETTINGS.dashboardLayout.map(widget => ({ ...widget }));
		this.credentialVault = new MemoryCredentialVault(this.app.secretStorage, 'command-center');
		this.accessibilityAudio = new AccessibilityAudio(this);
		// Ensure multiProvider exists (migration from v1)
		if (!this.settings.multiProvider) {
			this.settings.multiProvider = DEFAULT_MULTI_PROVIDER;
		}
		console.debug('[CC] Settings loaded from persistence', {
			activeProfile: this.settings.activeProfile,
			maxTokens: this.settings.maxTokens,
			piPath: this.settings.piPath,
			providerCount: Object.keys(this.settings.multiProvider.credentials).length,
			dashboardLayout: this.settings.dashboardLayout?.length,
		});
	}

	async saveSettings(): Promise<void> {
		// Deep-clone settings so the mutation below never corrupts the live state.
		const clone = JSON.parse(JSON.stringify(this.settings)) as CommandCenterSettings;
		// Defense in depth: strip legacy plaintext fields before every disk write.
		// Operate on the clone so the live in-memory object retains API keys from
		// the vault. The vault is the source of truth for secrets; the settings
		// object mirrors them transiently for UI-bound code that has not yet been
		// migrated to the vault API (see getTranscriptionCandidates, etc.).
		for (const credentials of Object.values(clone.multiProvider.credentials)) {
			if (credentials && 'apiKey' in credentials) delete (credentials as unknown as { apiKey?: string }).apiKey;
		}
		console.debug('[CC] Saving settings (strip apiKey from clone, live object untouched)');
		this.persist.setSettings(clone as unknown as Record<string, unknown>);
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
		this.getCommandCenterView()?.addTaskToHistory(compacted);
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

	/** Aggregate non-sensitive state for the dashboard's Bases controller. */
	getBasesQueueTelemetry(): { pending: number; running: number; activeNotes: number; synchronized: number } {
		let pending = 0;
		let running = 0;
		for (const task of this.baseQueueTasks.values()) {
			if (task.status === 'running') running++;
			else pending++;
		}
		return {
			pending,
			running,
			activeNotes: new Set([...this.baseQueueTasks.values()].map(task => task.targetPath)).size,
			synchronized: this.taskHistory.filter(task => Boolean(task.targetPath) && task.status === 'completed').length,
		};
	}

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
				const taskId = crypto.randomUUID();
				this.baseQueueTasks.set(taskId, { status: 'queued', targetPath: file.path });
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
					id: taskId,
					workerProfile,
					prompt,
					targetPath: file.path,
					status: 'queued',
					createdAt: Date.now(),
					},
					{
						onComplete: () => { this.baseQueueTasks.delete(taskId); settled(); },
						onError: () => { this.baseQueueTasks.delete(taskId); settled(); },
					},
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
			new Notice('Open a Markdown workflow note to export it to canvas.');
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
		const view = this.getCommandCenterView();
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
					const currentView = this.getCommandCenterView();
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
			this.getCommandCenterView()?.appendStreamOutput(
				`\nWorkflow complete — ${context.totalTokens} tokens, ${context.totalLatencyMs} ms.`,
				streamId,
			);
			this.getCommandCenterView()?.finalizeStreamOutput(streamId);
			if (targetFile?.extension === 'md') {
				this.frontmatterSync.queue(targetFile, {
					status: 'completed',
					lastRun: new Date().toISOString(),
				});
			}
			return context;
		} catch (error) {
			this.getCommandCenterView()?.appendStreamOutput(
				`\nWorkflow failed: ${(error as Error).message}`,
				streamId,
			);
			this.getCommandCenterView()?.finalizeStreamOutput(streamId);
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
		this.getCommandCenterView()?.startTaskStream(
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
					const view = this.getCommandCenterView();
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
			this.getCommandCenterView()?.appendStreamOutput(
				`\nQueue complete — ${results.length} target notes.`,
				streamId,
			);
			this.getCommandCenterView()?.finalizeStreamOutput(streamId);
			return results;
		} catch (error) {
			this.getCommandCenterView()?.appendStreamOutput(
				`\nQueue failed: ${(error as Error).message}`,
				streamId,
			);
			this.getCommandCenterView()?.finalizeStreamOutput(streamId);
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
		const chatView = this.getCommandCenterChatView();
		if (chatView) {
			await chatView.submitExternalPrompt(
				spokenText,
				mode,
			);
			return;
		}

		const prompt = resolved.cleanedPrompt || spokenText;
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
				{ prompt, voicePrompt: prompt },
				activeFile,
			);
			return;
		}

		await this.activateCommandCenterView();
		const voiceTools = createObsidianTools(this.app);
		const streamId = `voice-${mode}-${Date.now().toString(36)}`;
		this.getCommandCenterView()?.startTaskStream(
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
						prompt,
						activeFile?.path,
						voiceTools,
						DEFAULT_REACT_CONFIG,
							(event) => {
								if (
									event.type === 'thought' ||
									event.type === 'action_complete' ||
									event.type === 'final_answer'
								) {
									this.getCommandCenterView()?.appendStreamOutput(
										event.data,
										streamId,
									);
							}
						},
					),
				);
				if (response.error) throw new Error(response.error);
				this.getCommandCenterView()?.appendStreamOutput(
					response.result?.output ?? response.result?.summary ?? '',
					streamId,
				);
			} else {
				const request = activeFile
					? `${prompt}\n\nActive vault context: [[${activeFile.path}]]`
					: prompt;
				let streamed = '';
				const result = await this.conversations.executeProviderTurn(
					this.dispatcher,
					request,
					'fast',
					(delta) => {
					streamed += delta;
						this.getCommandCenterView()?.appendStreamOutput(
							delta,
							streamId,
						);
					},
				);
				if (!streamed)
					this.getCommandCenterView()?.appendStreamOutput(
						result.output ?? result.summary ?? '',
						streamId,
					);
			}
			this.getCommandCenterView()?.finalizeStreamOutput(streamId);
		} catch (error) {
			this.getCommandCenterView()?.appendStreamOutput(
				`\nVoice prompt failed: ${(error as Error).message}`,
				streamId,
			);
			this.getCommandCenterView()?.finalizeStreamOutput(streamId);
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
		const allDashboards = workspace.getLeavesOfType(COMMAND_CENTER_VIEW_TYPE);
		const rootLeaves = new Set<WorkspaceLeaf>();
		workspace.iterateRootLeaves(leaf => rootLeaves.add(leaf));
		const rootDashboard = allDashboards.find(leaf => rootLeaves.has(leaf));

		if (rootDashboard) {
			// Keep one canonical main-area dashboard and remove stale duplicates,
			// including instances restored into either sidebar by older versions.
			for (const leaf of allDashboards) if (leaf !== rootDashboard) leaf.detach();
			await workspace.revealLeaf(rootDashboard);
			return;
		}

		// `tab` always targets the root workspace, even when a sidebar currently
		// has focus. Create the replacement before detaching a legacy sidebar leaf
		// so dashboard state remains continuously available during migration.
		const leaf = workspace.getLeaf('tab');
		await leaf.setViewState({ type: COMMAND_CENTER_VIEW_TYPE, active: true });
		for (const stale of allDashboards) stale.detach();
		await workspace.revealLeaf(leaf);
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

	/** Open the built-in web browser panel in a workspace leaf. */
	async activateCommandCenterBrowserView(url?: string): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(COMMAND_CENTER_BROWSER_VIEW_TYPE);
		let leaf = existing[0] ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(true) ?? workspace.getLeaf('split');
			if (!leaf) return;
			await leaf.setViewState({
				type: COMMAND_CENTER_BROWSER_VIEW_TYPE,
				active: true,
			});
		} else {
			await workspace.revealLeaf(leaf);
		}
		const view = this.commandCenterBrowserView ?? (leaf.view instanceof CommandCenterBrowserView ? leaf.view : null);
		if (view && url) view.open(url);
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
