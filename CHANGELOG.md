# Changelog

All notable changes to Command Center are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.1.1]: https://github.com/scrunchds/Command-Center/compare/1.1.0...1.1.1

## [1.1.0] - 2026-07-27

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
