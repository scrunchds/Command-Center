# Changelog

All notable changes to Command Center are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
