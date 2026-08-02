# Changelog

All notable changes to Command Center are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.19] - 2026-08-02

### Fixed

- No changelog entry provided. Edit CHANGELOG.md to describe changes.

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
