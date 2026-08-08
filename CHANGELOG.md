# Changelog

All notable changes to Command Center are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.11.1] - 2026-08-07

### Fixed
- **Core features no longer lock before onboarding completes** (`src/engine/ConfigManager.ts`, `src/main.ts`, `src/ui/command-center-chat-view.ts`, `src/ui/command-center-view.ts`, `src/cli/command-bridge.ts`): the dashboard and chat were documented as available without the interview, but `requireInitialized()` guards and `requireStyleGuide()` callbacks still threw `Command Center is uninitialized` for chat, workflow synthesis/execution, ReAct task execution, and CLI/URI workflow runs. A new non-throwing `ConfigManager.getStyleGuide()` returns an empty default style guide when the interview has not been run, and the throwing callbacks/early guards were removed from those code paths so they fall back gracefully. Onboarding remains required only for operations that genuinely depend on interview-derived config — daily-note assembly (`morning`), index refresh (`indexes`), capacity metrics, and reflection questions — which keep their `requireConfig()`/`requireStyleGuide()` guards.
- **Reranker settings copy now follows sentence case** (`src/settings/PluginSettingsTab.ts`): the reranker mode description, the `(Provider default)` placeholder, and the manual model-id field label/description were capitalized inconsistently with the rest of the settings UI, producing four lint warnings. They now match the sentence-case convention used everywhere else.

## [1.11.0] - 2026-08-07

### Added
- **GraphRAG retrieval** (`src/rag/graph-rag.ts`): a graph-augmented retrieval layer that reuses Obsidian's native link graph (`metadataCache.resolvedLinks`, the same data the Graph view uses) to expand 1–2 hops from BM25+semantic seed matches, pulling in the relevant chunks of connected notes (forward links + backlinks) and re-ranking them with a graph-boosted score that rewards hub/MOC notes. It degrades to plain hybrid retrieval when the vault has no links, and refreshes its adjacency map on the `metadataCache` `resolved` event so it stays current. A new `graphSearchVault` agent tool exposes graph-aware retrieval so agents can deliberately request it over the flat `searchVault` when an answer depends on how notes connect. The `graphSearchVault` tool is registered as an agent capability.
- **Reranker model selection** (`src/rag/reranker.ts`, `src/settings/settings-model.ts`, `src/settings/PluginSettingsTab.ts`): a dedicated rerank model can re-score retrieved chunks after fusion. Two modes are supported — API (calls a native `POST /v1/rerank` endpoint shared by Cohere, Jina, and Voyage) and LLM (asks any configured chat model to score candidates, routed through the existing `ProviderDispatcher`/`NativeAutoRouter`). Rerank models are discovered automatically: the `ModelPurpose` classification (`rerank`/`embedding`/`audio`/`image`/`chat`) is applied to every model returned by a provider's live-model list, so the settings dropdown surfaces only rerank-capable models for the selected provider. Settings → Command Center → Features exposes the mode, provider, model (with manual fallback when none are discovered), and candidate limit. `mergeReranker` backfills defaults and clamps invalid saved values on upgrade. Failures degrade to seed ranking.

### Fixed
- **Chat `@`-mention context now reaches the model** (`src/ui/command-center-chat-view.ts`): retained `@`-mention pills were resolved into `ResolvedChatContext.contextString` but `sendCurrentMessage` discarded that context, so the README promise that "only retained pills are sent" was not honored. The retained context is now prepended to the prompt sent to the model in Quick and ReAct modes (workflow mode keeps the cleaned prompt because the attached workflow defines its own context handling).
- **Onboarding workflows now default to agentic execution** (`src/onboarding/InterviewEngine.ts`): every step generated during the setup interview is coerced to the `react-orchestrator` worker profile, so each step executes as an autonomous tool-calling sub-agent (a ReAct loop with vault tools) rather than a single prompt, consistent with the plugin's agentic model. The interview system prompt was updated to instruct the model to set `workerProfile: "react-orchestrator"`.
- **Slash-command typeahead in the chat composer** (`src/ui/slash-command-typeahead.ts`, `src/ui/command-center-chat-view.ts`): typing `/` in the chat textarea now surfaces a popover of matching Obsidian commands; arrow keys navigate, Enter executes the selected command and clears the input (so no chat message is sent), and Escape closes it. This makes the chat panel a command surface like an agentic assistant's `/command` bar.

## [1.10.1] - 2026-08-07

### Fixed
- **Vault tools now create parent folders recursively** (`src/extended-vault-tools.ts`, `src/obsidian-tools.ts`): the `create_folder` tool advertised "Parent folders are created automatically" but called `vault.createFolder()` directly, which throws in real Obsidian when an intermediate folder is missing — so onboarding would announce "there was an issue with creating the folders and index files, let's try that again" and loop forever on nested managed-folder paths. `create_folder` now creates each missing parent segment first and treats an already-existing target folder as success rather than an error. The same latent failure mode was fixed across the rest of the write surface so onboarding can place every asset it needs on the first attempt: `write_note`/`append_note` now ensure the note's parent folder chain before `vault.create()`; `rename_note` and `move_note` now ensure the destination parent folder before `fileManager.renameFile()`. A file blocking a folder path produces a clear error instead of a silent retry loop. Read-only tools (`read_note`, `search_vault`, `list_files`, `get_active_note`) and existing-file edits (`edit_note`, which only mutates notes that already exist) needed no change.

## [1.10.0] - 2026-08-07

### Added
- **Inline per-panel collapse chevrons** (`src/ui/command-center-view.ts`): every collapsible dashboard widget now has a chevron in its section header that collapses or expands it in place, so rearranging panels no longer requires opening the full “Customize dashboard” editor. The chevron stays visible while a panel is collapsed (the existing `.is-widget-collapsed` CSS already preserved the header), and toggling routes through the same `updateWidget` path the editor uses, so the two surfaces stay consistent. A new `refreshCollapseChevrons()` pass keeps every chevron’s icon and a11y attributes in sync no matter where the toggle came from (inline chevron, the layout editor, or the settings tab). Mutation approvals remains always-expanded.
- **Command deck is now collapsible** (`src/ui/CommandDeck.ts`): the deck was the lone widget rendering its own header and the only one without a collapse chevron. It now accepts `onToggleCollapsed`/`collapsed` options and shows the same inline chevron as every other panel; the deck header is added to the collapse-survivor CSS list so the chevron stays visible when collapsed.
- **Clickable telemetry cards** (`src/ui/command-center-view.ts`, `src/main.ts`, `src/settings/PluginSettingsTab.ts`): the Route, Depth, Pi daemon, and Secrets cards are now buttons. Route opens Settings → Command Center → Provider Credentials, Depth opens the Metacognitive Depth section, Pi daemon scrolls the dashboard to the daemon panel, and Secrets opens the credential vault. A new `PluginSettingsTab.revealSection` expands a collapsed settings section and scrolls it into view; `openSettingsSection` on the plugin opens the tab and defers the reveal so the section DOM exists first.
- **Centralized widget label registry** (`src/ui/widget-descriptors.ts`): the display name for every built-in dashboard widget now lives in one `WIDGET_LABELS` map with a `widgetLabel()` helper, replacing two hardcoded copies that had drifted apart. This fixes a latent bug where the settings tab showed raw ids (“clock”, “schedule”, “chatbox”) for three widgets that were missing from its copy of the map. Custom-card labels still resolve through the live roster when one is available and fall back to the note path otherwise.

### Changed
- **Header buttons gain icons and a primary affordance** (`src/ui/command-center-view.ts`): the four dashboard header buttons (Export workflow to canvas, Customize dashboard, Open browser, Open secrets) now carry Lucide icons, and the Customize-dashboard button uses the `mod-cta` accent so the primary action reads at a glance. The browser-routing comment that lived inline moved into the existing plugin call path, which already handles leaf reuse.
- **Removed dead `engine/InterviewEngine.ts` re-export shim** (`src/main.ts`, `src/onboarding/OnboardingPrompts.ts`): it was a one-line `export * from '../onboarding/InterviewEngine'` left from a refactor. Its two importers now import from `src/onboarding/InterviewEngine` directly, and the plugin retains the settings-tab instance so the dashboard can deep-link into settings sections.
- **Per-widget view variants** (`src/ui/widget-descriptors.ts`, `src/ui/ClockPanel.ts`, `src/ui/CalendarPanel.ts`, `src/ui/IntelligenceCards.ts`): the Clock, Calendar, and Action items panels each support alternative presentations, selectable from a new view dropdown in both the in-dashboard layout editor and Settings → Dashboard. Clock offers digital/minimal; Calendar offers month/week/agenda (week shows a 7-day row anchored to the selected day, agenda lists the next two weeks of scheduled tasks); Action items offers kanban/list/compact. The active view is stored as an optional `view` field on each layout entry and survives the existing layout merge, so layouts saved before this change keep working untouched.

### Fixed
- **Onboarding interview grounded in the real vault**: the interview system prompt now states the vault-is-source-of-truth rule as a hard constraint (verify existence and contents with `list_files`/`read_note` before claiming, never invent structure, treat the snapshot as a cache, label proposals as proposals, and make agreed changes via tools only after approval). The same rule was added to the logic-discovery prompt, and the `list_files`, `read_note`, and `search_vault` tool descriptions were strengthened so the model treats them as verification instruments. The model is explicitly authorized to modify vault structure/files once the user agrees, while the write gate still confirms each destructive action.
- **Text selection in onboarding chat bubbles** (`src/styles.css`): onboarding interview bubbles now allow text selection (matching the main chat bubbles), with the read-aloud button excluded so it stays a clean click target.
- **README no longer describes unimplemented drag-grip layout editing**: the “Future improvements” section claimed panels could be dragged by grips, with edges for width/height and keyboard support, citing a `ensureWidgetChrome()` function that does not exist in the current code. It now accurately describes the Customize-dashboard editor (reorder, show/hide, collapse/expand, size, and view switching) that actually ships.

## [1.9.2] - 2026-08-07

### Changed
- **Audio capture migrated from deprecated `ScriptProcessorNode` to `AudioWorklet`** (`src/audio/audio-recorder.ts`): the raw-PCM tap that feeds the WAV fallback (used when the MediaRecorder Opus path emits a silent or corrupt track on some Windows/Electron builds) now runs on an `AudioWorklet` processor loaded from a Blob URL, eliminating all five `@typescript-eslint/no-deprecated` Web Audio warnings (`ScriptProcessorNode`, `createScriptProcessor`, `onaudioprocess`, `inputBuffer`). Recording, level metering, and the WAV fallback are unchanged; the worklet ships each input block to the main thread via a transferred `Float32Array`, and capture degrades gracefully to the MediaRecorder blob when `AudioWorklet` is unavailable.

### Fixed
- **Removed `display: contents` from custom-card mount** (`src/styles.css`, `src/ui/command-center-view.ts`): the Obsidian community-plugin CSS linter flagged `display: contents` as only partially supported. Custom-card `<section>` elements now mount directly into the dashboard grid as first-class grid items (the `.cc-custom-card-host` wrapper is gone), so `applyDashboardLayout()` still reorders them with no layout change.
- **Replaced `:has()` chatbox selector with a state class** (`src/styles.css`, `src/ui/ChatBoxPanel.ts`): the linter warned that `.cc-chatbox-bubble:has(.cc-chatbox-typing)` can cause broad selector invalidation. The typing bubble now toggles an `is-typing` class (set when the `…` indicator appears, cleared on first streamed token or error), and the rule targets `.cc-chatbox-bubble.is-typing`.
- **Replaced the unknown `webview` type selector with a class selector** (`src/styles.css`): `.cc-browser-panel-viewport webview.cc-browser-panel-frame, … iframe.cc-browser-panel-frame` is now `.cc-browser-panel-viewport .cc-browser-panel-frame`, resolving the “Unexpected unknown type selector” warning. Both the Electron `<webview>` and the sandboxed `<iframe>` fallback already share the class.

## [1.9.1] - 2026-08-06

### Fixed
- **Release assets lacked artifact attestations** (`.github/workflows/release.yml`): the 1.9.0 Release workflow failed after four runner-acquisition attempts (a transient GitHub hosted-runner capacity error), and the release was subsequently published manually, bypassing the `actions/attest` provenance step. As a result `main.js`, `styles.css`, and `manifest.json` on the 1.9.0 GitHub release shipped without Sigstore build-provenance attestations (`gh attestation verify` returned HTTP 404). 1.9.1 is cut through the automated release workflow so attestations are generated and cryptographically verified for every asset, as on 1.8.0 and earlier. Release automation must not be bypassed by a manual `gh release create` — if the workflow fails, re-run it until it is green before publishing.

### Documentation
- **Troubleshooting section refreshed** (`README.md`): added a “Release assets and artifact attestations” entry explaining how to verify any published asset with `gh attestation verify`, how to tell a workflow-built release (`github-actions[bot]` author, signed) from a manual one (`scrunchds` author, unsigned), and the requirement that releases be published only by the automated workflow. Corrected the onboarding command name to match the registered `Start setup / onboarding interview` command.

## [1.9.0] - 2026-08-06

### Added
- **Clock widget** (`src/ui/ClockPanel.ts`): a live, zero-token dashboard clock that respects your time-format preference (System / 12-hour / 24-hour). Customize it under **Settings → Command Center → Paths & Appearance**: toggle seconds, toggle the date, choose a date verbosity (long / short / numeric), and set an optional label. The clock auto-updates every second and picks up setting changes on the next tick without a reload.
- **Daily schedule widget** (`src/ui/DailySchedulePanel.ts`): a zero-cost "today by time" view built only from Obsidian's metadata cache. It surfaces tasks due today, parses inline time tags (`⏰ HH:MM` and `[time:: HH:MM]`), sorts timed entries before untimed ones, and click-throughs to the source note. No model calls, no token spend.
- **Dedicated Paths settings tab** (`src/settings/PluginSettingsTab.ts`): all asset-placement controls now live under **Settings → Command Center → Paths & Appearance** — workflow directory, workflow format (`.md` or `.json`), template directory, profile path, time format, and the full clock customization suite.
- **Full user control over asset placement** (`src/settings/settings-model.ts`, `src/main.ts`): workflows, templates, and the profile can now live anywhere in your vault, hidden or visible. A new `updateAssetPaths()` programmatic API validates, saves, and optionally migrates existing files to the new locations.
- **Workflows in `.md` format** (`src/workflows/WorkflowGenerator.ts`): generated workflows can be written as Markdown with YAML frontmatter (the `workflow:` key is read back unchanged by the existing sync `loadWorkflowFromNote`) plus a human-readable body, instead of only `.json`. Choose the format in Paths & Appearance or let the onboarding interview pick it.
- **System time-format detection** (`src/util/time-format.ts`): the clock, the daily schedule, and any future time display detect whether your OS uses 12- or 24-hour time, with an explicit override in Paths & Appearance.
- **Interview persistence** (`src/ui/DashboardOnboarding.ts`): the onboarding interview now resumes exactly where you left off after closing the dashboard or restarting Obsidian, including pending synthesis and connector approvals. Progress is cleared only when the interview completes or is explicitly reset.
- **Onboarding vault awareness** (`src/onboarding/InterviewEngine.ts`): the interview proactively references the scanned vault topology it already collected instead of deferring it, so the first questions are grounded in what was actually found.
- **Socratic, metacognitive, and frustration-aware interaction style** (`src/prompts/interaction-style.ts`): the core system prompt for every chat session now carries the Socratic and metacognitive directives plus a frustration protocol, wired into all dispatch sites so no chat path bypasses it.
- **Configurable "Happening now" cards** (`src/settings/settings-model.ts`, `src/ui/IntelligenceCards.ts`): the four intelligence cards can be reordered and individually shown or hidden under **Settings → Command Center → Dashboard → Happening now — cards**.
- **Configurable Action-items Kanban lanes** (`src/settings/settings-model.ts`, `src/ui/IntelligenceCards.ts`): the Action items card no longer ships four hard-coded lanes. Define your own lanes (columns) with a label, a deterministic filter (`overdue`, `due-today`, `upcoming`, `undated`, `done`, `all`), and a hide-when-empty flag. Add, remove, reorder, and reset lanes in the dashboard settings. A `done` lane surfaces completed work only when you add one, so the default board stays focused on open tasks.

### Changed
- **Path hygiene** (`src/settings/settings-model.ts`, `src/engine/ConfigSerializer.ts`): emoji and pictographs are stripped from model-suggested and user-entered asset paths at validation chokepoints, and the interview system prompt carries an explicit PATH HYGIENE rule, so generated folders never carry icon characters.
- **Settings UI reorganized**: placement, format, time-format, and clock controls moved to the dedicated Paths & Appearance tab; the intelligence-card and lane controls live under the Dashboard tab.

### Fixed
- **TTS only worked for four providers** (`src/audio/AccessibilityAudio.ts`): the settings dropdown listed DeepInfra, Groq, Custom, LM Studio, and Ollama as text-to-speech engines, but playback only checked `openai`, `openrouter`, `xai`, and `mistral`, silently falling back to browser TTS for the rest. `canUseProviderTts()` and `resolveTtsProvider()` now use the full transcription-provider order filtered by `TtsAdapter.supportsProvider()`, so every listed engine actually routes through its provider endpoint.
- **Chat output text could not be selected to copy** (`src/styles.css`): the AI output bubbles left rendered markdown children without an explicit `user-select: text` rule, so dragging to select inside a bubble was unreliable in some Obsidian themes. Selection is now enforced on the bubble, its content, and every rendered child (`a`, `code`, `pre`, `blockquote`, `li`), while the action bar, buttons, and timestamp are excluded from selection so they never pollute a copy.
- **Interview never resumed** (`src/ui/DashboardOnboarding.ts`): `persistProgress()` existed but `restoreProgress()` was never called in `open()`, so closing the dashboard mid-interview always restarted from scratch. Restore now runs first, and progress is cleared only at the three completion points.

## [1.8.0] - 2026-08-05

### Added
- **Chatbox widget** (`src/ui/ChatBoxPanel.ts`): a lightweight, always-on conversational surface distinct from the Orchestrator. Quick questions and answers stream back live on the fast compute tier — no workflow proposals or approvals. Reuses the same `ModelRouter` backend so every configured provider and fallback applies, with an optional read-aloud button. Auto-appears for existing users right after the Orchestrator widget.
- **Core Daily Notes fallback** (`src/intelligence/VaultDataBridge.ts`): the calendar now detects daily notes from Obsidian's core Daily Notes plugin settings when the onboarding interview has not been run, so the month grid and per-day detail work immediately instead of waiting for configuration.
- **Live note preview in the calendar** (`src/ui/CalendarPanel.ts`): clicking a date now reads the day's note and renders a short excerpt of its body (skipping frontmatter and checkbox tasks) alongside a prominent “Open note” / “Create note” button, so clicking a day actually surfaces its contents rather than only its tasks.

### Changed
- **Operational overview rethought** (`src/ui/command-center-view.ts`): the widget no longer shows a four-step orientation tutorial. It now reports genuine live state — daemon running/stopped, providers connected, pending approvals, today's note status, and overdue-task count — as a compact status strip where each chip offers the obvious next action when something needs attention. The strip refreshes whenever the intelligence snapshot updates or an approval lands, and the widget's default size is now `standard` rather than `expanded`.
- **“New workflow” now lands you on the input** (`src/ui/command-center-view.ts`): the Command Deck button used to show a toast and focus an off-screen textarea. It now scrolls the Orchestrator into view, un-hides it if hidden, pre-fills a prompt starter, places the caret, and pulses the section so it is obvious where to type.
- **Browser defaults to the system browser** (`src/ui/BrowserPanel.ts`): the primary action now opens the address in your system default browser via Electron's `shell.openExternal`, since embedded webviews drop `target="_blank"` links and break logins — `window.open` was opening another Obsidian window rather than your browser. Obsidian's core Web viewer is offered alongside when enabled (Native Obsidian Harmony). The embedded `<webview>` is kept as an opt-in “Preview inline” toggle, now with a `new-window` handler that redirects `target="_blank"` links into the current view instead of dropping them, and `did-navigate-in-page` syncing so the address bar stays accurate. The popped-out pane starts with the inline preview on so it actually shows the page.

### Fixed
- The calendar showed no daily notes and read “Configure daily notes” even with Obsidian's core Daily Notes enabled, because daily-note path resolution depended solely on the onboarding interview. The core-plugin fallback resolves this.
- The browser's “Open in your system browser” button opened another Obsidian window instead of the system browser; it now uses `shell.openExternal`.
- `target="_blank"` links inside the embedded browser did nothing; they now navigate the current webview in place.

## [1.7.7] - 2026-08-05

### Added
- **Drag-and-drop dashboard layout** (`src/ui/layout-model.ts`): drag a panel by its grip to reorder it, drag the right edge to set its width on a twelve-column grid, and drag the bottom edge to pick a height. Double-click a grip to restore that panel's default. Grips are keyboard operable, and handles stay visible on touch devices where hover does not exist.
- **Native Web viewer handoff** (`src/ui/native-webviewer.ts`): when Obsidian's core Web viewer is enabled, the browser panel can hand the current address to it, so its history, favicons, ad blocking, and search-engine choice apply instead of a parallel set of the plugin's own. Detection is guarded against the internal-plugin registry changing shape and falls back to the plugin's own pane.

### Changed
- Widget width and height are stored as an optional `span` and `height` on each layout entry. Layouts saved by earlier versions keep working: a missing `span` is derived from the existing compact/standard/expanded size.

### Removed
- The mind map widget, along with its styles and tests. It added a panel whose upkeep outweighed what it showed over the core Outline view.

### Fixed
- Newly shipped widgets were appended to the bottom of an existing dashboard instead of appearing beside the panels they belong with, because the layout merge pushed unknown ids onto the end. New built-ins now anchor to the widget that precedes them in the default order, which also leaves a user's own arrangement untouched. Duplicate saved entries are collapsed rather than rendered twice.

## [1.7.6] - 2026-08-05

### Fixed
- The full-pane browser opened an empty split: it was a second, diverged implementation of the browser, and its `<webview>` had no resolved height. The pane is now a thin shell around the same `BrowserPanel` as the dashboard widget, so both surfaces share one implementation and any fix applies to both.
- The browser widget rendered only in the top portion of its card. A `<webview>` is a replaced element with an intrinsic 300x150px size, so it ignored `height: 100%`; it now uses `display: flex` inside a flex-sized viewport.
- Google properties (`gmail.com`, `mail.google.com`, `youtube.com`) returned 401 or refused to load because Electron's default user agent advertises `Electron/` and `obsidian/`. The webview now presents the underlying Chrome user agent, derived from the runtime so the version stays truthful.
- "Open browser" on the dashboard created a fresh split leaf on every click, bypassing leaf reuse and the address handoff. It now routes through `activateCommandCenterBrowserView()`.
- The browser pane's host element had no styling and would collapse; the toolbar now wraps in narrow side docks instead of overflowing.
- `scripts/release.mjs` called `execSync` with an argument array, which always threw, so changelog generation silently fell back to an unexpanded `- Release ${targetVersion}.` placeholder.

## [1.7.5] - 2026-08-04

### Added
- **Custom dashboard cards** (`src/ui/CustomCards.ts`, `src/ui/card-syntax.ts`): any note carrying `cc-card: true` becomes a dashboard card, discovered rather than registered and hot-registering on vault events. Bodies render through `MarkdownRenderer`, so embedded `.base` views, Dataview blocks, callouts, and transclusions work unchanged. Checkbox lines become interactive rows that write back through the write gate, with fenced code blocks correctly excluded. Optional `cc-card-title`, `cc-card-hint`, `cc-card-icon`, and `cc-card-order` frontmatter keys.
- **Embedded browser widget** (`src/ui/BrowserPanel.ts`, `src/ui/browser-url.ts`): read documentation and API references inline, expand to fill the dashboard, or pop out into a dedicated pane with the current address handed across. Uses Electron's `<webview>` — as Obsidian's own Web viewer does — so it browses the open web including sites that send `X-Frame-Options`, with an isolated storage partition and an “Open externally” handoff to the system browser. Bare hosts and `host:port` resolve as addresses, free text becomes a search, and `javascript:`, `data:`, and `file:` schemes are refused. Degrades to a sandboxed iframe, with a visible notice, where `<webview>` is unavailable. Hidden by default.
- **Absolute write gate** (`src/security/WriteGate.ts`): a single authority for every vault mutation. `gateTools()` wraps each capability so authorization runs inside `execute`, making bypass structurally impossible. New `autoWriteEnabled` and `protectedWritePaths` settings, an append-only decision log on the dashboard, and a live gate-posture banner.
- **Zero-cost intelligence bridge** (`src/intelligence/VaultDataBridge.ts`): deterministic vault analysis from Obsidian's `metadataCache` only, with no provider or token cost. Surfaces daily-note state, tracked metrics, evaluated capacity rules, capture entries, checkbox and property-driven tasks, inline/emoji due dates, managed folders, and native `.base` views.
- **Four “Happening now” dashboard cards**: Daily intelligence, Capture, Action items, and Workspaces, with Kanban-style task lanes (Overdue / Due today / Scheduled / Undated) derived from dates already present in the vault.
- **Calendar panel** (`src/ui/CalendarPanel.ts`): month grid marking days with notes and scheduled work. Create, complete, edit, reschedule, and delete dated tasks, and open or create any day's note — every write routed through the write gate.
- **Task mutation layer** (`src/intelligence/TaskWriter.ts` and pure `task-syntax.ts`): standard Markdown checkbox output compatible with Dataview, Tasks, Kanban, and Bases. Atomic `Vault.process` writes, heading-targeted insertion, CRLF preservation, path-traversal rejection, and concurrent-edit detection.
- **Vault doorway** (`src/ui/VaultNavigator.ts`): one ranked filter across note titles, folders, tags, canvases, and `.base` views, defaulting to recently edited notes. Folders reveal in the native file explorer; tags hand off to Obsidian's global search.
- **Command deck** (`src/ui/CommandDeck.ts`): a vertical launcher built from vault workflow files (`.md`, `.canvas`, generated `.json`), reading labels/descriptions/icons from native frontmatter and hot-registering on vault events without a restart.
- **Declarative REST connectors** (`src/connectors/ApiConnectorManager.ts`): user-approved HTTP connectors exposed as `api:<connector>:<endpoint>` tools, using Obsidian `requestUrl`, HTTPS-only base URLs, credential references resolved from Secret Storage, and confirmation gates on non-GET calls.
- **Conversational connector approval**: the onboarding orchestrator can propose an `action-api-connector` block from public API documentation; an explicit approval click registers it and refreshes the capability registry.
- **Global chat interaction style** (`src/prompts/interaction-style.ts`) plus a live capability inventory injected at every shared provider boundary, so all chat surfaces know exactly which tools exist.
- Per-section UX descriptions across the whole dashboard: each panel states what it shows and what to do with it.
- Obsidian's built-in browser is now reachable from the dashboard header.
- 48 new tests covering write-gate enforcement, Markdown task transforms, card parsing, and browser URL handling (216 in the core suite; 391 total).

### Changed
- Onboarding is now optional: Command Center no longer force-opens the setup interview on first run. Chat, tools, and the dashboard work immediately, and guided setup can be started at any time.
- Live external capability refresh recreates MCP and REST connector tools after settings changes, unregistering stale entries.
- Setup input redaction now permits links, paths, hosts, ports, and endpoint values, blocking only credential-like material.
- Dashboard layout gained `deck`, `navigator`, `intelligence`, `calendar`, and `browser` widgets, all reorderable and hideable. Custom cards participate in the same ordering.
- The full-pane browser view now shares the hardened URL normalizer with the dashboard widget, so both agree on addresses, searches, and refused schemes.
- README documents the six core principles and names the code enforcing each one.

### Fixed
- Layout editor did not collapse when “Done customizing” was clicked: the `.cc-dashboard-layout-editor.is-hidden` rule was missing entirely, so the panel was permanently expanded. Visibility is now explicit state, with a `Done` button inside the panel and correct `aria-expanded` reporting.
- HTTP 400 after successful tool execution: the assistant tool-call message is now inserted before tool results, with `toolCallId` forced on each result, for both streaming and non-streaming providers.
- Onboarding now closes and returns to the dashboard on completion.
- Removed the hardcoded `vault-setup.ts` scaffold, keeping the plugin methodology-agnostic.
- Replaced `fetch` with Obsidian's `requestUrl` in the REST connector transport.
- Layout reconciliation discarded any widget id absent from the built-in roster, which would have silently stripped custom cards on the next save.
- `localhost:3000` in the browser address bar was parsed as a `localhost:` scheme and rejected; `host:port` input is now correctly treated as an address.
- The browser surfaces used a plain iframe, which cannot load any site sending `X-Frame-Options` or CSP `frame-ancestors` — GitHub, MDN, Google, and Stack Overflow all silently failed to render. Both the widget and the full-pane view now use Electron's `<webview>`.
- Corrected UI text capitalization to sentence case in the write-gate settings and command deck.

## [1.7.4] - 2026-08-04

### Changed
- Release ${targetVersion}.

## [1.7.3] - 2026-08-04

### Changed
- Release ${targetVersion}.

## [1.7.2] - 2026-08-05

### Fixed
- Windows audio silence: disabled aggressive echo cancellation / noise suppression / auto gain control in `getUserMedia` constraints that suppressed speech during dictation recordings on Windows (Chromium/WASAPI).
- Peak-level tracking now always bootstraps the Web Audio analyser at recording start (previously skipped when no `onAudioLevel` listener was registered yet, leaving `peakLevel` at 0 and causing the silence guard to discard every recording).
- AudioContext `resume()` on Windows/Electron when the context starts in a `suspended` state (Chromium defers rendering until a user gesture).
- Codec-qualified MIME type selection (`audio/webm;codecs=opus`, `audio/ogg;codecs=opus`) pins the Opus encoder and avoids Chromium's internal fallback to a silent or corrupt codec on some Windows builds.
- Default 1-second timeslice for dictation recordings prevents silent buffer overflow on Windows/Chromium when no timeslice is specified.
- Blob MIME type now derived from `recorder.mimeType` only (removed `options.mimeType` fallback that could mismatch the actual encoded content, causing Whisper to decode silence).
- Start-cue tone delayed 200 ms after recording begins to prevent speaker bleed into the first audio frames.
- Silence guard threshold `SILENCE_LEVEL_THRESHOLD` now used consistently across chat view and voice prompt modal (replaced hardcoded `0.02`).

## [1.7.1] - 2026-08-04

### Changed
- Release ${targetVersion}.

## [1.7.0] - 2026-08-04

### Changed
- Release ${targetVersion}.

## [1.6.3] - 2026-08-04

### Changed
- Release ${targetVersion}.

## [1.6.2] - 2026-08-04

### Changed
- Release ${targetVersion}.

## [1.6.1] - 2026-08-04

### Changed
- Release ${targetVersion}.

## [1.6.0] - 2026-08-04

### Changed
- Release ${targetVersion}.

## [1.5.0] - 2026-08-03

### Changed
- Release ${targetVersion}.

## [1.5.0] - 2026-08-03

### Added

- **Capability Registry**: Unified tool-calling surface that wraps vault tools, MCP tools, and worker profiles into a discoverable, user-configurable capability system. Each capability has a category, execution mode (always/autonomous/explicit), confirmation policy, and @-command aliases. Users can enable/disable capabilities from Settings, grouped by category.
- **Project Mode**: Isolated AI workspaces with vault-native `.md` project files. Each project has its own model configuration, system prompt, file inclusion/exclusion rules, web/YouTube context sources, and isolated chat history.
- **Inline Composer — Fuzzy Matching**: Three-stage text replacement engine (exact → fuzzy → trimmed) with line-ending normalization, BOM handling, LCS-based diff computation, and multi-operation editing support.
- **@-Mention Typeahead**: Real-time inline suggestions for notes, folders, tags, and capabilities as you type @ in the editor. Categorized results with keyboard navigation and wikilink insertion.
- **User-Managed System Prompts**: Vault-native system prompt storage with YAML frontmatter, variable substitution ({{vault}}, {{date}}, {{time}}, {{user}}, {{style}}, {{memory}}), custom resolvers, and category filtering.
- **User Memory Manager**: Explicit "remember this" command processing, automatic fact extraction from conversation turns, profile building, contextual recall, and system prompt injection.
- **Extended vault tools**: Added edit_note, delete_note, create_folder, delete_folder, rename_note, and move_note tools with confirmation gates for destructive operations.
- **Capability Registry wiring**: Chat view, ModelRouter, and ReAct execution now use the Capability Registry for tool selection, honoring user enablement preferences.
- **Socratic Triage awareness**: Interview system prompt includes capability inventory so the Socratic consultant knows what instruments to propose.
- **39 new tests** across all new subsystems.
- **Transcription pipeline fixes**: Applied `sanitizeDictation()` to AccessibilityAudio (dashboard/onboarding dictation) and LiveTranscriber (live transcription) paths to fix Whisper silence hallucination leaks.

### Changed
- Test suite expanded from 282 to 321 tests.
- Settings UI now includes an Agent Capabilities section in the Features tab (Normal and Advanced modes).
- Plugin settings model extended with capability preferences, max autonomous calls, and capability system master toggle.
- README documentation updated with new feature sections.

## [1.4.0] - 2026-08-03

### Changed
- Release 1.4.0.

### Added

- **Capability Registry**: Unified tool-calling surface that wraps vault tools, MCP tools, and worker profiles into a discoverable, user-configurable capability system. Each capability has a category, execution mode (always/autonomous/explicit), confirmation policy, and @-command aliases. Users can enable/disable capabilities from Settings, grouped by category.
- **Project Mode**: Isolated AI workspaces with vault-native `.md` project files. Each project has its own model configuration, system prompt, file inclusion/exclusion rules, web/YouTube context sources, and isolated chat history.
- **Inline Composer — Fuzzy Matching**: Three-stage text replacement engine (exact → fuzzy → trimmed) with line-ending normalization, BOM handling, LCS-based diff computation, and multi-operation editing support.
- **@-Mention Typeahead**: Real-time inline suggestions for notes, folders, tags, and capabilities as you type @ in the editor. Categorized results with keyboard navigation and wikilink insertion.
- **User-Managed System Prompts**: Vault-native system prompt storage with YAML frontmatter, variable substitution ({{vault}}, {{date}}, {{time}}, {{user}}, {{style}}, {{memory}}), custom resolvers, and category filtering.
- **User Memory Manager**: Explicit "remember this" command processing, automatic fact extraction from conversation turns, profile building, contextual recall, and system prompt injection.
- **39 new tests** across all new subsystems (capability registry, user memory, system prompts, project manager, composer fuzzy matching, @-mention engine).

### Changed
- Test suite expanded from 282 to 321 tests.
- Settings UI now includes an Agent Capabilities section in the Features tab (Normal and Advanced modes).
- Plugin settings model extended with capability preferences, max autonomous calls, and capability system master toggle.
- README documentation updated with new feature sections.

## [1.3.0] - 2026-08-03

### Added

- **Metacognitive interview enhancements**: The Socratic Triage consultant now reflects back understanding before advancing, surfaces assumptions behind the user's decisions, connects patterns across phases, explores tradeoffs, evaluates satisfaction with current approaches, future-proofs against changing needs, and proposes capabilities as testable hypotheses — all while preserving the consent-led, agnostic persona.
- **Interview navigation**: Back button to revisit and correct a previous answer, per-topic skip, and save/resume — progress persists to a vault note so closing the dashboard does not lose the conversation.
- **UI mode (Simple / Normal / Advanced)**: Progressive disclosure in Settings. Simple hides the routing matrix, fallback pipeline, and health dashboard and adds a one-click "Use local only" setup. Advanced adds the health dashboard and debug tools.
- **Feature subsystem toggles**: Independently enable/disable Vault RAG, persistent agent memory, the ReAct multi-agent engine, native workflows, the daily operations engine, chat history persistence, MCP tools, and web search — Command Center stays agnostic and never imposes any subsystem on a user's workflow.
- **Chat history persistence**: The chat view replays saved conversation turns on open, so conversations survive view close and plugin reload.
- **Chat export**: Conversations export to a tagged Markdown file under command-center/chats/ with frontmatter (type: command-center-chat, provider, mode, model, tags command-center/chat + command-center/transcript).
- **New conversation button** in the chat header.
- **Message actions**: Copy button (with "Copied ✓" feedback), delete button, and hover-revealed action bar on every chat message.
- **Code block copy buttons** on rendered messages.
- **Streaming cursor** (blinking ▊) on pending assistant messages.
- **Scroll-to-bottom button** appears when the chat history is scrolled up.
- **Voice output target persistence**: The chat voice destination (Chat / Note / Canvas / …) is now saved in settings.
- **Live transcription chunk duration** setting (1–6s slider) — smaller values give faster interim results, larger values reduce API cost.
- **Speech-to-text test button** in Settings that verifies provider reachability.
- **xAI and Cohere** added to the Speech-to-text provider dropdown.
- **Mic icon states**: The chat microphone uses SVG icons that change with state (mic → square → loader → radio) instead of a static emoji.
- **Audio level meter** in the chat composer during recording, and a **LIVE badge** during live transcription.

### Fixed

- **Cohere STT URL malformed**: transcriptionUrl now strips the version prefix from the server root, fixing `/v2/v2/audio/transcriptions` → `/v2/audio/transcriptions`.
- **Chat surface ignored provider transcriptionPath**: transcribeWithFallback in the chat view now passes candidate.transcriptionPath, so xAI (`/v1/stt`) and Cohere (`/v2/audio/transcriptions`) custom endpoints work from the chat surface.
- **Live transcription duplicated text on stop**: the textarea already held interim text from onInterim; stop() no longer appends the same text again.
- **buildTranscriptionCandidates silently included key-requiring providers** when no hasApiKey callback was provided — it now falls back to checking credentials.apiKey directly.
- **refreshSttStatus / refreshSttBadge** now pass getApiKey so local model discovery works when the credential vault holds the key.
- **Release script**: fixed duplicate `const totalTests` declaration that would fail the pre-flight gate; the final count now includes provider tests.

### Changed

- Speech-to-text section of Settings now includes the live chunk duration slider, an STT test button, and xAI/Cohere in the provider dropdown.
- Feature toggles moved behind a dedicated Features tab in Settings.
- Chat message layout: timestamp moved into a hover-revealed action bar with Copy and Read-aloud controls.

## [1.2.0] - 2026-08-02

### Added

- **xAI (Grok) provider**: New provider with 4 chat models (grok-4.5, grok-4.3, grok-4.20-reasoning, grok-build-0.1), native STT (/v1/stt), and TTS support (/v1/tts with voice discovery).
- **OpenRouterProvider**: Rich model metadata parsing from the live API — pricing, context window, modalities, supported parameters, and reasoning capabilities are extracted dynamically.
- **OpenRouter personalized model discovery**: Model list now uses the /api/v1/models/user endpoint, respecting user provider preferences, privacy settings, and guardrails.
- **OpenRouter web search tool**: Server-side web search via web_search_call. Controlled by a new webSearchEnabled setting toggle.
- **OpenRouter video/image generation URL builders**: getVideoGenerationUrl(), getVideoStatusUrl(), getVideoDownloadUrl(), and getImageGenerationUrl() stubbed for future implementation.
- **Vault media ingestion stubs**: Video MIME types (mp4, webm, mov, avi, mkv) and isVideoFile() helper added to image-utils.ts for future video generation features.
- **Cohere STT**: Native speech-to-text via /v2/audio/transcriptions with the cohere-transcribe-03-2026 model. Cohere added to the transcription fallback chain.
- **LM Studio model download**: JIT manager now auto-downloads missing models via POST /api/v1/models/download before loading. Download progress tracking via GET /api/v1/models/download/status.
- **MCP (Model Context Protocol) integration**: MCPClient (JSON-RPC 2.0) and MCPToolManager for discovering and executing remote tools from MCP servers. Configurable via mcpServers setting.

### Changed

- **OpenRouter STT model**: Corrected default model from whisper-large-v3-turbo to openai/whisper-large-v3 (OpenRouter uses prefixed model names).
- **OpenRouter registry**: Added TTS models (openai/tts-1, openai/tts-1-hd, mistralai/voxtral-mini-tts-2603, mistralai/voxtral-mini) and image generation models (openai/gpt-5-image, google/gemini-3.1-flash-image, etc.).
- **Cohere registry**: Updated with command-a-03-2026 and cohere-transcribe-03-2026 models.
- **Transcription infrastructure**: Added transcriptionPath option to TranscriberAdapter for non-standard STT endpoints (xAI /v1/stt, Cohere /v2/audio/transcriptions).
- **DEFAULT_STT_MODELS**: New registry for provider-specific STT model names, used by the transcription fallback chain.
- **ProviderId type**: Added 'xai' to the ProviderId union type.
- **Model matrix**: Updated with xAI entries in text, speech, and transcription modalities. OpenRouter entries in video modality.

### Fixed

- **OpenRouter model name**: Corrected STT model name to use the prefixed format (openai/whisper-large-v3).

## [1.1.21] - 2026-08-02

### Fixed

- **Whisper silence hallucinations**: Replaced regex-based `sanitizeTranscript` with exact-match `sanitizeDictation()` — intercepts every API response and strips known filler artifacts ("Thank you.", "Subtitles by Amara.org community", etc.) before any UI insertion.
- **Dictation text insertion**: Changed from cursor-position insertion to append + DOM event dispatch (`input`/`change` with `bubbles: true`) so Obsidian's state manager recognizes the new input.
- **Voice prompt modal**: Added silence/short-audio guard — clips under 500ms or below 0.02 RMS peak level are discarded without an API call.
- **AudioRecorder**: Exposed `getDurationMs()` and `getPeakLevel()` methods for callers to check recording quality before transcribing.

### Changed
- `sanitizeTranscript()` renamed to `sanitizeDictation()` with simplified exact-match hallucination list. Old name kept as deprecated alias, removed.

## [1.1.20] - 2026-08-02

### Changed


## [1.1.19] - 2026-08-02

### Fixed

- **Whisper silence hallucinations**: Dictation now runs a silence/short-audio guard before sending audio to the API — clips under 500ms or below 0.02 RMS peak level are discarded without an API call.
- **Transcript sanitization**: Added `sanitizeTranscript()` to strip known Whisper hallucination artifacts (`"Thank you."`, `"Thank you for watching."`, `"Subtitles by..."`, repetitive word loops) when they dominate the transcript.
- **Cursor-aware insertion**: Dictation now inserts at the textarea cursor position (with proper spacing) instead of blindly appending to the end of the value.
- **Clean status reset**: "No speech detected" notices auto-clear; "Listening..." / "Transcribing..." states reset on completion or error.
- **MIME-derived file extension**: Recording filename extension is derived from the actual audio MIME type so providers decode codecs correctly (avoids hallucinated filler from mislabeled .webm).

## [1.1.18] - 2026-08-02

### Fixed

- No changelog entry provided. Edit CHANGELOG.md to describe changes.

## [1.1.18] - 2026-08-02

### Fixed

- **Settings tab rendered blank or routed to wrong plugin**: Added `display()` override to `PluginSettingsTab` — the only render entry point Obsidian calls when the user clicks the settings tab. Without it, the base class `display()` does nothing, producing a blank view or appearing to cross-trigger another plugin's settings.
- Removed empty `getSettingDefinitions()` override (it returned `[]` which is the base class default) so the lint rule `no-deprecated-display` no longer fires.

## [1.1.17] - 2026-08-02

### Added

- **One-command release automation**: `scripts/release.mjs` — bumps versions, runs all checks, builds, commits, tags, and pushes in one step.
- **Pre-push validation hook**: `scripts/pre-push.hook` + `scripts/install-hooks.mjs` — blocks pushes with version sync, type, or sanitize failures.
- **Version sync checker**: `scripts/verify-version-sync.mjs` — verifies all version files, README, and CHANGELOG agree before any push.

### Fixed

- **Settings hydration lifecycle**: Added `loadSettings()` method called synchronously at the top of `onload()` before any views or subsystems are registered.
- **Missing `display()` override**: `PluginSettingsTab` now overrides `display()` so the imperative settings UI re-renders when the user navigates to the settings tab.

## [1.1.16] - 2026-08-02

### Fixed

- **Settings hydration lifecycle**: Added `loadSettings()` method called synchronously at the top of `onload()` before any views or subsystems are registered, ensuring `this.settings` is fully hydrated before the settings tab or any UI components read from it.
- **Missing `containerEl` render on tab navigation**: Added `display()` override to `PluginSettingsTab` so the imperative settings UI re-renders when the user navigates to the settings tab, preventing stale/empty renders.

## [1.1.15] - 2026-08-02

### Fixed

- **saveSettings() deep-clone**: `saveSettings()` now deep-clones the settings object before stripping `apiKey` fields, preventing in-memory corruption of the live credentials object. API keys are now retained in memory after save.
- **Vault credential routing**: `getTranscriptionCandidates()` and `candidates()` now use `credentialVault.has()` instead of reading `credentials.apiKey` directly (which was stripped on every save).
- **Race condition in stopRecordingAndTranscribe()**: Added `lockedRecorder` generation counter to prevent a new recording from being silently overwritten during async transcription.
- **Comprehensive logging**: Added `console.debug`/`console.error` at AudioRecorder state transitions, PersistenceManager load/flush, SettingsTab saves, and all transcription candidate attempts.

## [1.1.14] - 2026-08-02

### Added

- Buy Me a Coffee branded support button in settings footer with yellow pill styling matching the official widget
- Comprehensive test suite expanded from 44 to 103 tests: DataNormalizer sanitization (8 tests), JSON repair (7 tests), CacheManager (10 tests), ShadowTreeArchive (6 tests), release version sync (2 tests), release tag/manifest validation (6 tests), and Obsidian guideline compliance (20 tests)

### Changed

- `src/routing.ts` moved to `src/routing/routing-table.ts` and `src/settings.ts` moved to `src/settings/settings-model.ts` to eliminate root-level duplicates of existing folders

### Fixed

- `version-bump.mjs` now also syncs `package-lock.json` root version so the release workflow's version gate passes and artifact attestations are published
- All UI text now follows Obsidian's sentence-case guidelines (40 warnings resolved)

## [1.1.11] - 2026-08-02

### Fixed

- `fetch()` usage in `_fetchStreaming()` is now explicitly documented as the required exception for SSE token streaming (Obsidian's `requestUrl` does not expose `ReadableStream`). Comment cites Obsidian's network requests guide.
- `REVIEWER_NOTES.md` updated with exact line reference and Obsidian docs URL for the streaming fetch exception

## [1.1.10] - 2026-08-02

### Added

- Live transcription from microphone (Shift+click mic button in chat view)
- Voice output target selector (Chat, Note, Canvas, Note+Audio, Canvas+Audio, All)
- Save audio recordings to vault with timestamped filenames
- Create transcription Canvas with text + audio file nodes
- `LiveTranscriber` — chunked sequential transcription for near-real-time STT

### Changed

- Mic button now supports Shift+click for live transcription mode
- Sentence case applied throughout settings, commands, and UI labels
- Conditional commands (`checkCallback`) hide when prerequisites aren't met
- `Vault.process` used instead of `Vault.modify` for atomic file writes
- `VaultWatcher` uses native vault events instead of polling `getFiles()`
- View references resolved via `getLeavesOfType()` instead of stored references
- Transcription response parsing handles multiple JSON formats and includes debug info

### Fixed

- `TranscriberAdapter` now extracts text from `transcript`, `results`, `content`, and nested fields
- Error messages include the actual response shape for debugging
- Text selection in chat bubbles preserved during streaming re-renders
- All lint warnings resolved (unused imports, unused variables, etc.)

[1.1.10]: https://github.com/scrunchds/Command-Center/compare/1.1.9...1.1.10

## [1.1.8] - 2026-08-02

### Changed

- Aligned plugin lifecycle cleanup and timer handling more closely with Obsidian's component and view guidelines.
- Migrated provider credential storage to Obsidian Secret Storage-backed handling and removed the legacy custom encrypted credential payload path.
- Updated release metadata, repository notes, and packaging defaults for the 1.1.8 release.

### Fixed

- Ensured settings-tab background sync timers are cleaned up when the tab hides.
- Tightened modal and view event handling to keep listeners scoped to their UI lifecycle.
- Updated the diagnostic harness to validate the Secret Storage credential path.
- Kept build, lint, tests, and release packaging green after the compliance sweep.

### Security

- Removed the legacy encrypted credential vault flow in favor of Obsidian Secret Storage.
- Kept release packaging and sanitization aligned with the repository's leak-prevention workflow.

## [1.1.7] - 2026-08-01

### Changed

- Reused a single Obsidian tool registration path so the daemon, routing layer, and voice-prompt fallback no longer construct duplicate tool arrays.
- Tightened provider usability checks so locked credential vaults are reflected consistently in routing, model refresh, and health-check UX.
- Simplified credential resolution for compute endpoints by preferring the process-memory vault and trimming stale settings fallbacks.

### Fixed

- Prevented settings-time model refresh and health checks from advertising locked cloud providers as actionable.
- Made the embedding bootstrap skip cloud providers that are configured but not yet unlocked, reducing confusing offline fallbacks.
- Kept legacy plaintext API-key cleanup in place while preserving backward-compatible settings loading.
- Added explicit accessibility speech controls for text-to-speech and speech-to-text in Settings.
- Added speech-to-text enablement gates for chat, dashboard dictation, and voice-prompt capture.
- Made assistant chat text selectable for copy/paste while preserving markdown rendering.

### Security

- Reduced the chance of stale credential data being surfaced in endpoint resolution or refresh flows.
- Preserved the encrypted vault boundary for provider credentials and local-only fallback behavior.

## [1.1.3] - 2026-07-29

### Added

- Added tabbed settings navigation with accessible keyboard support and clearer grouping for core, providers, routing, and health controls.
- Added an adjustable passive prompt context budget for chat, ReAct, and voice prompts.

### Changed

- Reduced prompt inflation in chat and voice fallback paths by separating user prompt text from attached context display.
- Increased passive context limits and made them configurable in Settings.
- Improved settings panel layout to better match Obsidian-style navigation and spacing.

### Fixed

- Preserved onboarding interview conversation history while removing unnecessary prompt concatenation from chat UI flows.
- Kept the onboarding interview context flow intact across turns.
- Maintained all verification coverage at 151 passing tests.

### Security

- Retained onboarding credential/endpoint guards and release validation checks.

[1.1.8]: https://github.com/scrunchds/Command-Center/compare/1.1.7...1.1.8
[1.1.3]: https://github.com/scrunchds/Command-Center/compare/1.1.2...1.1.3

## [1.1.2] - 2026-07-29

### Changed

- Reduced Obsidian review warnings by shortening command labels and removing redundant plugin-name wording.
- Switched compatibility-sensitive timers to `window.setTimeout()` / `window.clearTimeout()` in browser-facing paths.
- Replaced direct style mutations in dashboard textarea resizing with Obsidian-compatible CSS helper updates.
- Replaced `globalThis.crypto` access with `window.crypto` for popout-safe compatibility.
- Moved localized plugin data paths to vault-config-dir-aware resolution for topography, semantic memory, and native auto-routing.

### Fixed

- Removed unnecessary diagnostic console noise from Shadow-Clone diagnostics.
- Aligned release tests with the cleaned command label.

### Security

- Preserved the plugin's sanitization, validation, and release packaging checks.

[1.1.2]: https://github.com/scrunchds/Command-Center/compare/1.1.1...1.1.2

## [1.1.1] - 2026-07-29

### Changed

- Hardened interview configuration validation to reject malformed onboarding configs earlier and more explicitly.
- Validated schema version, completion timestamp, task-tracking fields, inbox handling, capacity rules, managed folders, and interview-derived nested sections.
- Kept secret detection intact while preserving the release packaging flow.

### Fixed

- Reduced the risk of invalid interview output reaching persisted vault state.
- Kept the release bundle and sanitize checks passing for Obsidian plugin packaging.

### Security

- Continued to prevent secret-like values from entering generated onboarding configuration.
- Maintained release sanitization and packaging checks before publication.

## [1.1.1] - 2026-07-29

### Added

- Added a two-stage **Socratic Triage** persona: discovery establishes the user's context and subjective definition of efficiency before introducing read-only vault-topology evidence.
- Added consent-led capability exploration for automation, semantic linking, retrieval, and multi-agent synthesis without imposing an organizational framework.
- Added silent `TopographySweep`, header-aware semantic chunking, SQLite-VSS-compatible semantic storage, Dialectic RAG, and bounded shadow-tree memory infrastructure.
- Added modality-aware `NativeAutoRouter`, normalized execution boundaries, bundled JSON-RPC Python worker transport, and Shadow-Clone security/routing diagnostics.
- Added encrypted AES-256-GCM credential-vault support, including optional bearer tokens for LM Studio Require Authentication, authenticated Ollama proxies, and custom OpenAI-compatible endpoints.
- Added embedded dashboard onboarding, live routing/daemon/vault/Base telemetry, persisted responsive widget customization, dashboard-owned mutation approvals, reusable dictation, optional audio cues, and AI response read-aloud.

### Changed

- Consolidated onboarding, Logic Discovery, orchestration, queues, ReAct monitoring, approvals, and daily operations into one reusable full-page Command Center dashboard in the central workspace.
- Kept the right-sidebar chat focused on Quick, ReAct, and Workflow interaction while moving destructive and bulk mutation consent to protected dashboard cards.
- Updated LM Studio routing to resolve native catalog state dynamically, prefer an already loaded conversational model, and otherwise select an eligible downloaded model while excluding embeddings and speculative drafts.
- Applied provider authentication consistently across inference, streaming, model discovery, health checks, transcription, and local JIT lifecycle requests.
- Routed provider, Python, streaming, and multi-agent output through `DataNormalizer` before UI or Markdown consumption.

### Fixed

- Corrected the routing matrix so LM Studio resolves explicitly instead of falling through an unintended provider mapping.
- Stabilized local model JIT discovery and lifecycle behavior across LM Studio API URL variants.
- Reused one central dashboard leaf, migrated stale sidebar dashboard leaves, and removed duplicate dashboard instances.
- Prevented pending mutation approvals from being hidden or collapsed by dashboard customization.
- Removed standalone discovery deck/modal paths that duplicated the canonical dashboard experience.

### Security

- Credentials remain encrypted at rest and decrypted only into process memory; Python workers never receive credentials through arguments or environment variables.
- Topology discovery remains asynchronous and read-only with respect to user notes, writing only localized plugin state.
- Added ignore rules for generated backup, Command Center log, and Command Center trace files.

[1.1.0]: https://github.com/scrunchds/Command-Center/compare/1.0.6...1.1.0
