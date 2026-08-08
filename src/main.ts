import { App, MarkdownView, Modal, Notice, normalizePath, Plugin, TFile, type WorkspaceLeaf } from 'obsidian';
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
	mergeReranker,
	PluginSettingsTab,
	structuredSafeDefaults,
	mergeMultiProvider,
	validateAssetPath,
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
import { withGlobalChatInteractionStyle } from './prompts/interaction-style';
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
import { WorkflowEngine, type WorkflowAgenticExecutor, type WorkflowStepExecutionResult } from './workflows/workflow-engine';
import type {
	WorkflowDefinition,
	WorkflowExecutionContext,
	WorkflowStep,
} from './workflows/workflow-types';
import type {
	WorkflowBatchOptions,
	WorkflowTargetExecution,
} from './workflows/workflow-engine';
import { WorkflowSynthesizer } from './workflows/WorkflowSynthesizer';
import { DebouncedFrontmatterSync } from './workflows/frontmatter-sync';
import {
	exportWorkflowToCanvas,
	loadWorkflowFromCanvas,
	loadWorkflowFromNote,
} from './workflows/native-workflow-parser';
import { collectWorkflowInputs } from './ui/workflow-modal';
import type { ResolvedChatContext } from './ui/chat-context';
import type { VoicePromptMode, VoicePromptFocus } from './ui/voice-prompt-modal';
import { AgentMemoryStore } from './memory/memory-store';
import { EmbeddingAdapter } from './rag/embeddings';
import { HybridRetriever } from './rag/hybrid-retriever';
import { GraphRAG } from './rag/graph-rag';
import { RerankerAdapter, DEFAULT_RERANKER } from './rag/reranker';
import { createVaultSearchTool, createGraphSearchTool } from './rag/rag-tool';
import { CONFIG_PATH } from './engine/ConfigSerializer';
import type { OnboardingConfig } from './onboarding/OnboardingTypes';
import { FolderIndexer } from './indexing/FolderIndexer';
import { InboxTriager } from './daily/InboxTriager';
import { CapacityEngine } from './daily/CapacityEngine';
import { DailyEngine } from './daily/DailyEngine';
import { ConfigManager } from './engine/ConfigManager';
import { VaultDataBridge } from './intelligence/VaultDataBridge';
import { WriteGate, gateTools } from './security/WriteGate';
import { TaskWriter } from './intelligence/TaskWriter';
import { InterviewEngine } from './onboarding/InterviewEngine';
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
import { MCPToolManager } from './mcp/MCPToolManager';
import { ingestMcpCapabilities, wrapToolAsCapability } from './capabilities/CapabilityToolAdapter';
import { ApiConnectorManager } from './connectors/ApiConnectorManager';

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
	graphRag!: GraphRAG;
	reranker!: RerankerAdapter;
	folderIndexer!: FolderIndexer;
	inboxTriager!: InboxTriager;
	capacityEngine!: CapacityEngine;
	dailyEngine!: DailyEngine;
	configManager!: ConfigManager;
	/** Deterministic, model-free vault intelligence for the dashboard cards. */
	vaultData!: VaultDataBridge;
	/** Single authority for every vault mutation proposed by a capability. */
	writeGate!: WriteGate;
	/** Gated task create/toggle/edit/delete used by the calendar and cards. */
	taskWriter!: TaskWriter;
	commandCenterBrowserView: CommandCenterBrowserView | null = null;
	private mcpToolManager: MCPToolManager | null = null;
	private capabilityRefreshPromise: Promise<void> | null = null;
	private apiConnectorManager: ApiConnectorManager | null = null;

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
	workflowEngine!: WorkflowEngine;
	workflowSynthesizer!: WorkflowSynthesizer;
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
	/** Settings tab instance, retained so the dashboard can deep-link into a specific settings section. */
	settingTab!: PluginSettingsTab;

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
		this.vaultData = new VaultDataBridge(this.app, this.configManager);
		// Principle 1: the gate is constructed before any capability is registered so
		// no tool surface can ever exist outside its authority.
		this.writeGate = new WriteGate({
			autoWriteEnabled: () => this.settings.autoWriteEnabled,
			protectedPaths: () => this.settings.protectedWritePaths,
			requestApproval: request => this.requestDashboardApproval(request),
			onRecord: record => this.getCommandCenterView()?.recordWriteGateDecision(record),
		});
		this.taskWriter = new TaskWriter(this.app, this.writeGate);
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
		const detectedPath = await detectPiPath(this.settings.piPath);
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
			() => this.configManager.getStyleGuide(),
		);

		// ── Multi-Provider Subsystem ──────────────────
		const vaultSearchTool = createVaultSearchTool(this.hybridRetriever, {
			canReadVault: () => true,
		});
		this.graphRag = new GraphRAG(this.hybridRetriever, this.app, { hopDepth: 1, useBacklinks: true });
		this.graphRag.refreshGraph();
		const graphSearchTool = createGraphSearchTool(this.graphRag, {
			canReadVault: () => true,
		});
		this.daemon.registerTools([vaultSearchTool, graphSearchTool]);
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
		// ── Reranker (GraphRAG / hybrid retrieval re-scoring) ────────────
		this.reranker = new RerankerAdapter({
			settings: this.settings.reranker,
			dispatcher: this.dispatcher,
			router: this.nativeAutoRouter,
			resolveEndpoint: (providerId) => this.resolveRerankEndpoint(providerId),
			logger: { warn: (message, error) => console.warn(message, error) },
		});
		this.graphRag.setReranker(this.reranker);
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
			// Discover external tools after the built-ins exist. Discovery is
			// best-effort: a broken MCP/API integration must never prevent the
			// native vault tools or chat from starting.
			void this.refreshExternalCapabilities();
			void registry;
		}

		this.router = new ModelRouter(
			this.providerFactory,
			() => this.settings.multiProvider,
			() => {
				// Use the capability registry so user-configurable tool settings
				// are honored across all model interactions.
				return this.getGatedTools();
			},
			{
				vaultPath,
				configDir: this.app.vault.configDir,
				memoryStore: this.agentMemory,
				retriever: this.hybridRetriever,
				contextCharLimit,
			},
		);
		this.workflowSynthesizer = new WorkflowSynthesizer(
			this.dispatcher,
			() => this.configManager.getStyleGuide(),
		);
		this.workflowEngine = new WorkflowEngine(
			this.dispatcher,
			this.router,
			() => this.configManager.getStyleGuide(),
			this.createAgenticStepExecutor(),
		);
		const executor: TaskExecutor = {
			execute: async (task: Task): Promise<TaskResult> => {
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
						this.getGatedTools(),
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
						systemPrompt: withGlobalChatInteractionStyle(this.configManager.getStyleGuide()),
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
		this.settingTab = new PluginSettingsTab(this.app, this);
		this.addSettingTab(this.settingTab);
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

		// Onboarding is optional. The dashboard and chat remain available without
		// an interview; users can start discovery from the dashboard or command
		// palette whenever they want a guided configuration.
		this.app.workspace.onLayoutReady(() => {
			if (!this.configManager.isInitialized() && !this.app.vault.getAbstractFileByPath(CONFIG_PATH)) {
				console.debug('[CC] Optional onboarding available from the dashboard.');
			}
		});

		// Auto-fetch live models (chat + STT + TTS) from every enabled provider's
		// /models endpoint after the workspace is ready. This keeps the model
		// dropdowns and the STT/TTS default-model resolution current without
		// waiting for the user to click “Refresh models” in settings. Fire-and-
		// forget: failures fall back to the static registry defaults.
		this.app.workspace.onLayoutReady(() => {
			void this.providerFactory.refreshLiveModels().then(({ synced, failed }) => {
				if (synced > 0) this.saveSettings().catch(() => undefined);
				console.debug(`[CC] Live model refresh: ${synced} synced${failed ? `, ${failed} failed` : ''}`);
			});
		});

		// Refresh the GraphRAG link adjacency when Obsidian resolves links, so
		// graph-augmented retrieval stays current as notes and wikilinks change.
		this.registerEvent(this.app.metadataCache.on('resolved', () => {
			this.graphRag.refreshGraph();
		}));

		if (this.settings.enableDaemon) {
			await this.daemon.prepareNodeExecutable();
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

	/**
	 * The only sanctioned way to obtain tools. Every returned capability has the
	 * write-gate embedded in its `execute`, so no call site can mutate the vault
	 * without passing Principle 1's approval boundary.
	 */
	/**
	 * Launch a workflow from its backing vault file. Supports the three surfaces
	 * the Command Deck can discover: Markdown notes, Canvas graphs, and the
	 * generated JSON produced by the approved workflow generator.
	 */
	async runWorkflowFile(file: TFile): Promise<void> {
		if (file.extension === 'json') {
			const definition: unknown = JSON.parse(await this.app.vault.read(file));
			if (!definition || typeof definition !== 'object' || !Array.isArray((definition as { steps?: unknown }).steps)) {
				throw new Error(`${file.path} is not an executable workflow definition.`);
			}
			await this.executeWorkflow(definition as WorkflowDefinition, {}, file);
			return;
		}
		const workflow = file.extension === 'canvas'
			? await loadWorkflowFromCanvas(file, this.app)
			: loadWorkflowFromNote(file, this.app);
		if (!workflow.steps.length) throw new Error(`${file.path} has no executable steps.`);
		await this.executeWorkflow(workflow, {}, file);
	}

	getGatedTools(): ToolDefinition[] {
		return gateTools(getCapabilityRegistry().getEnabledToolDefinitions(true), this.writeGate);
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
			const engine = new InterviewEngine(
				this.app,
				this.dispatcher,
				this.configManager,
				() => this.getGatedTools(),
				async (tool, params) => {
					if (!tool.confirmation) return true;
					const request = await tool.confirmation(params);
					if (!request) return true;
					return (await this.requestDashboardApproval(request)) === 'approved';
				},
				{
					getAssetPaths: () => ({
						workflowDirectory: this.settings.workflowDirectory,
						workflowFormat: this.settings.workflowFormat,
						templateDirectory: this.settings.templateDirectory,
						profilePath: this.settings.profilePath,
					}),
					updateAssetPaths: async patch => this.updateAssetPaths(patch),
				},
			);
			await view.openOnboarding(engine, async (config) => {
				await this.folderIndexer.initialize(config.managedFolders);
				this.configureDailyEngines(config);
				await this.dailyEngine.ready();
			}, async (connector) => {
				const connectors = [...(this.settings.apiConnectors ?? []).filter(item => item.id !== connector.id), connector];
				this.settings.apiConnectors = connectors;
				await this.saveSettings();
				await this.refreshExternalCapabilities();
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
		// Clear any persisted in-progress interview so the next onboarding
		// starts fresh rather than resuming the superseded session.
		const progressFile = this.app.vault.getAbstractFileByPath('.command-center/interview-progress.json');
		if (progressFile instanceof TFile) await this.app.fileManager.trashFile(progressFile).catch(() => undefined);
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

	/** Resolve a provider's base URL + API key for the native rerank API call. */
	private resolveRerankEndpoint(providerId: string): { baseUrl: string; apiKey: string } | undefined {
		if (!providerId) return undefined;
		const credentials = this.settings.multiProvider.credentials[providerId as keyof typeof PROVIDER_REGISTRY];
		if (!credentials?.enabled || !credentials.baseUrl) return undefined;
		const meta = PROVIDER_REGISTRY[providerId as keyof typeof PROVIDER_REGISTRY];
		if (meta?.requiresKey && !this.credentialVault.has(providerId)) return undefined;
		return {
			baseUrl: sanitizeBaseUrl(credentials.baseUrl),
			apiKey: this.credentialVault.get(providerId).trim(),
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
		this.mcpToolManager?.dispose();
		this.mcpToolManager = null;
		this.apiConnectorManager?.dispose();
		this.apiConnectorManager = null;
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
	 * Programmatic asset-path override. The plugin (e.g. the onboarding
	 * interview or a workflow that reorganizes the vault) can update where
	 * generated workflows, templates, and the profile are written, and
	 * optionally migrate existing files to the new locations. Settings UI
	 * changes route through here too, so there is a single owner of these
	 * paths and every live component reconfigures from one place.
	 */
	async updateAssetPaths(
		patch: Partial<{
			workflowDirectory: string;
			workflowFormat: 'md' | 'json';
			templateDirectory: string;
			profilePath: string;
		}>,
		options: { migrate?: boolean } = {},
	): Promise<void> {
		const next: Partial<CommandCenterSettings> = {};
		if (patch.workflowDirectory !== undefined) next.workflowDirectory = validateAssetPath(patch.workflowDirectory);
		if (patch.templateDirectory !== undefined) next.templateDirectory = validateAssetPath(patch.templateDirectory);
		if (patch.profilePath !== undefined) {
			const validated = validateAssetPath(patch.profilePath, { allowFile: true });
			if (!validated.endsWith('.json')) throw new Error('Profile path must end with .json');
			next.profilePath = validated;
		}
		if (patch.workflowFormat !== undefined) {
			if (patch.workflowFormat !== 'md' && patch.workflowFormat !== 'json') throw new Error('Workflow format must be "md" or "json".');
			next.workflowFormat = patch.workflowFormat;
		}
		Object.assign(this.settings, next);
		await this.saveSettings();
		if (options.migrate) await this.migrateAssetFiles();
		this.refreshCommandDeck();
		console.debug('[CC] Asset paths updated:', next);
	}

	/** Move existing generated assets from their previous locations to the current configured paths. */
	private async migrateAssetFiles(): Promise<void> {
		const oldWorkflowDir = '.command-center/workflows';
		const oldTemplateDir = '.command-center/templates';
		const moves: Array<[string, string]> = [];
		if (this.settings.workflowDirectory !== oldWorkflowDir) moves.push([oldWorkflowDir, this.settings.workflowDirectory]);
		if (this.settings.templateDirectory !== oldTemplateDir) moves.push([oldTemplateDir, this.settings.templateDirectory]);
		for (const [from, to] of moves) {
			const source = this.app.vault.getAbstractFileByPath(normalizePath(from));
			if (!source) continue;
			try {
				await this.ensureFolder(to);
				await this.app.vault.rename(source, normalizePath(to));
			} catch (error) {
				console.warn(`[CC] Could not migrate ${from} → ${to}:`, error);
			}
		}
	}

	private async ensureFolder(path: string): Promise<void> {
		const normalized = normalizePath(path);
		const existing = this.app.vault.getAbstractFileByPath(normalized);
		if (existing) return;
		const parent = normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : '';
		if (parent) await this.ensureFolder(parent);
		await this.app.vault.createFolder(normalized);
	}

	/** Re-scan the Command Deck so newly placed workflows appear without a reload. */
	refreshCommandDeck(): void {
		this.getCommandCenterView()?.refreshCommandDeck();
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

		const detectedPath = await detectPiPath(this.settings.piPath);
		if (detectedPath && detectedPath !== this.daemon.piPath) {
			if (!this.daemon.setPiPath(detectedPath)) return false;
			this.settings.piPath = detectedPath;
			await this.saveSettings();
		}

		// Remove any failed/stale process object before restarting.
		this.daemon.stop();
		await this.daemon.prepareNodeExecutable();
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
		// Deep-clone defaults so the shared DEFAULT_* constants are never
		// mutated through the live settings object, and any partial saved
		// multiProvider is backfilled with complete sub-objects.
		const base = structuredSafeDefaults();
		this.settings = Object.assign(base, loaded as Partial<CommandCenterSettings>);
		this.settings.multiProvider = mergeMultiProvider(DEFAULT_MULTI_PROVIDER, this.settings.multiProvider);
		this.settings.reranker = mergeReranker(DEFAULT_RERANKER, this.settings.reranker);
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

	async refreshExternalCapabilities(): Promise<void> {
		if (!this.settings.mcpEnabled || !this.settings.mcpServers?.length) {
			this.mcpToolManager?.dispose();
			this.mcpToolManager = null;
			return;
		}
		if (this.capabilityRefreshPromise) return this.capabilityRefreshPromise;
		this.capabilityRefreshPromise = (async () => {
			const registry = getCapabilityRegistry();
			// Remove stale MCP registrations before replacing the discovered
			// snapshot. Built-in capabilities are never touched.
			for (const id of registry.ids.filter(value => value.startsWith('mcp:'))) registry.unregister(id);
			this.mcpToolManager?.dispose();
			const manager = new MCPToolManager({ servers: this.settings.mcpServers });
			const tools = await manager.discoverTools();
			this.mcpToolManager = manager;
			if (tools.length) {
				this.daemon.registerTools(tools);
				for (const server of this.settings.mcpServers.filter(item => item.enabled)) {
					const serverTools = tools.filter(tool => tool.name.startsWith(`${server.id}:`));
					ingestMcpCapabilities(server.id, server.label, serverTools);
				}
			}
			for (const id of registry.ids.filter(value => value.startsWith('api:'))) registry.unregister(id);
			this.apiConnectorManager?.dispose();
			this.apiConnectorManager = new ApiConnectorManager({
				connectors: this.settings.apiConnectors ?? [],
				getSecret: ref => this.credentialVault.get(ref),
			});
			for (const tool of this.apiConnectorManager.discoverTools()) {
				this.daemon.registerTools([tool]);
				wrapToolAsCapability(tool, {
					id: tool.name,
					label: tool.label,
					description: tool.description,
					category: 'custom', executionMode: 'autonomous',
					confirmationPolicy: tool.confirmation ? 'always' : 'never', requiresVault: false,
				});
			}
			console.debug('[CC] External capabilities refreshed:', [...tools.map(tool => tool.name), ...this.apiConnectorManager.getTools().map(tool => tool.name)]);
		})().catch(error => {
			console.warn('[CC] External capability refresh failed:', error);
		}).finally(() => { this.capabilityRefreshPromise = null; });
		return this.capabilityRefreshPromise;
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
		// Settings changes take effect without a plugin reload. The registry is
		// the live tool surface used by all future provider turns.
		void this.refreshExternalCapabilities();
		// Propagate reranker setting changes without a plugin reload.
		if (this.reranker) this.reranker.updateSettings(this.settings.reranker);
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

	/**
	 * Build the autonomous tool-calling executor that turns `react-*`
	 * workflow steps into mini-Claude ReAct loops. Each step dispatches a
	 * full Reason→Act→Observe session with the gated capability surface, so
	 * a step is not a single prompt but an agent that can search, read, and
	 * write inside the write gate.
	 */
	private createAgenticStepExecutor(): WorkflowAgenticExecutor {
		return {
			executeStep: async (step: WorkflowStep, prompt: string, targetPath, onStream) => {
				const ready = await this.ensureDaemonRunning();
				if (!ready) throw new Error(`Pi daemon failed to start: ${this.daemon.startError ?? 'unknown error'}`);
				const taskId = `${step.id}:${targetPath ?? 'single'}:${Date.now()}`;
				const task: Task = {
					id: taskId,
					workerProfile: 'react-orchestrator',
					workerRole: step.assignedAgent,
					prompt,
					targetPath,
					status: 'queued',
					createdAt: Date.now(),
					onStream,
				};
				const result = await executeReActTask(
					this.daemon,
					this.getGatedTools(),
					task,
					this.memoryBank,
					this.router,
				);
				const output = result.output ?? result.summary ?? '';
				const meta: Record<string, unknown> = result.metadata ?? {};
				const tokens =
					typeof meta.totalTokens === 'number' ? meta.totalTokens :
					typeof meta.tokens === 'number' ? meta.tokens : 0;
				const latencyMs = typeof meta.latencyMs === 'number' ? meta.latencyMs : 0;
				return {
					result: output,
					output,
					tokens,
					latencyMs,
					metadata: meta,
				} satisfies WorkflowStepExecutionResult;
			},
		};
	}

	/**
	 * Synthesize a workflow DAG from a natural-language goal, surface it as a
	 * write-gate approval card, and — on approval — execute it. Every generated
	 * step runs as an autonomous tool-calling sub-agent behind the gate.
	 */
	async synthesizeAndRunWorkflow(goal: string): Promise<WorkflowExecutionContext | null> {
		const trimmed = goal.trim();
		if (!trimmed) throw new Error('Workflow goal is empty.');

		const streamId = `workflow-synth:${Date.now()}`;
		const view = this.getCommandCenterView();
		view?.startTaskStream(streamId, 'synthesizing workflow…');
		view?.appendStreamOutput(`Designing a workflow for: ${trimmed}\n`, streamId);

		let definition: WorkflowDefinition;
		try {
			definition = await this.workflowSynthesizer.synthesize(trimmed, {
				onStream: delta => view?.appendStreamOutput(delta, streamId),
			});
		} catch (error) {
			view?.appendStreamOutput(`\nSynthesis failed: ${(error as Error).message}`, streamId);
			view?.finalizeStreamOutput(streamId);
			throw error;
		}

		const summary = renderWorkflowPlanForApproval(definition);
		const decision = await this.requestDashboardApproval({
			toolName: 'Generate & run agentic workflow',
			targetPaths: [],
			proposedChanges: summary,
			timeoutMs: 0,
		});
		if (decision !== 'approved') {
			view?.appendStreamOutput('\nWorkflow not approved. Execution cancelled.', streamId);
			view?.finalizeStreamOutput(streamId);
			return null;
		}

		const inputs = Object.keys(definition.inputs).length > 0
			? await collectWorkflowInputs(this.app, definition)
			: {};
		if (inputs === null) {
			view?.finalizeStreamOutput(streamId);
			return null;
		}
		return this.executeWorkflow(definition, inputs);
	}

	/** Execute a compiled workflow while streaming all step output into Live Output. */
	async executeWorkflow(
		definition: WorkflowDefinition,
		inputs: Record<string, unknown>,
		targetFile?: TFile,
	): Promise<WorkflowExecutionContext> {
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
		focus?: VoicePromptFocus,
	): Promise<void> {
		const { workspace } = this.app;

		// Resolve the user's focus context. The global voice modal captures `focus`
		// before it takes keyboard focus, so the user's pre-recording intent
		// survives the asynchronous transcription delay. The internal quick-voice
		// entry point passes no snapshot, so we detect the active editor live.
		const mdView = focus?.markdownView ?? workspace.getActiveViewOfType(MarkdownView);

		// (3) Note Routing — a note editor is in focus: insert the transcribed text
		// directly into the active note at the cursor position.
		if (mdView?.editor) {
			try {
				const editor = mdView.editor;
				editor.replaceRange(spokenText, editor.getCursor());
				return;
			} catch {
				// The note may have been closed during recording — fall through to chat.
			}
		}

		// (4) Chat Routing — the chat panel is in focus, or no note editor is in
		// focus: route the transcribed text into the chat input field. Open the
		// chat panel if it is not already available, and populate (not send) so
		// the user can review the transcription before dispatching.
		let chatView = this.getCommandCenterChatView();
		if (!chatView) {
			await this.activateCommandCenterChatView();
			chatView = this.getCommandCenterChatView();
		}
		if (chatView) {
			chatView.populateChatInput(spokenText, mode);
			return;
		}

		// Defensive fallback — no note editor in focus and the chat panel could not
		// be opened: preserve prior behavior by running inline in the dashboard.
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
		const voiceTools = this.getGatedTools();
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
				const tools = this.getGatedTools();
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
					tools,
					async (name, params) => {
						const tool = tools.find(candidate => candidate.name === name);
						if (!tool) return { toolCallId: name, content: '', error: `Unknown tool: ${name}` };
						const approval = tool.confirmation ? await tool.confirmation(params) : null;
						if (approval && (await this.requestDashboardApproval(approval)) !== 'approved') return { toolCallId: name, content: '', error: 'Tool execution was not approved.' };
						try {
							console.debug('[Command Center] Voice executing tool:', name);
							const toolResult = await tool.execute(name, params);
							console.debug('[Command Center] Voice tool completed:', name);
							return { toolCallId: name, content: toolResult.content.map(item => item.text).join('') };
						} catch (error) {
							console.warn('[Command Center] Voice tool failed:', name, error);
							return { toolCallId: name, content: '', error: error instanceof Error ? error.message : String(error) };
						}
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

	/** Open the Command Center settings tab and scroll a named section into view.
	 * Used by the dashboard telemetry cards to deep-link the operator straight to
	 * the setting behind a status (e.g. Route → Provider Credentials). */
	openSettingsSection(sectionId: string): void {
		const appWithSetting = this.app as App & { setting: { open: () => void; openTab: (id: string) => unknown } };
		if (appWithSetting.setting) {
			appWithSetting.setting.open();
			appWithSetting.setting.openTab('Command Center');
		}
		// openTab re-renders asynchronously; defer the reveal to the next frame so
		// the section DOM exists before we try to scroll to it.
		window.setTimeout(() => this.settingTab.revealSection(sectionId), 50);
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

/** Render a synthesized workflow DAG as a human-reviewable plan for the approval card. */
function renderWorkflowPlanForApproval(definition: WorkflowDefinition): string {
	const lines: string[] = [];
	lines.push(`# ${definition.name}`);
	if (definition.description) lines.push('');
	lines.push(definition.description);
	lines.push('');
	lines.push(`**Steps:** ${definition.steps.length} · **Inputs:** ${Object.keys(definition.inputs).length || 'none'}`);
	lines.push('');
	lines.push('Each step runs as an autonomous, tool-calling sub-agent (ReAct loop) behind the write gate.');
	lines.push('');
	for (const step of definition.steps) {
		const deps = step.dependsOn.length ? ` → depends on ${step.dependsOn.map(d => `\`${d}\``).join(', ')}` : '';
		const cond = step.condition ? ` · when \`${step.condition}\`` : '';
		lines.push(`- **${step.name}** (\`${step.id}\`, ${step.assignedAgent}/${step.requiredTier}, ${step.actionType})${deps}${cond}`);
		lines.push(`  > ${step.promptTemplate.replace(/\n/g, '\n  > ').slice(0, 400)}${step.promptTemplate.length > 400 ? ' …' : ''}`);
	}
	lines.push('');
	lines.push('Approve to execute. Every vault mutation a step attempts still requires its own write-gate click unless Auto Write is enabled.');
	return lines.join('\n');
}
