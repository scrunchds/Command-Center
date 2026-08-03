# Agent Instructions for Command Center

## Scope
- Apply these instructions to the entire repository unless a more specific `AGENTS.md` exists in a subdirectory.

## Working style
- Keep changes minimal, targeted, and consistent with existing code style.
- Prefer existing project patterns and Obsidian APIs over introducing new abstractions.
- Preserve current behavior unless the change is explicitly requested.
- Avoid touching generated bundles unless they are part of the release process.

## Validation
- Use the repo scripts for verification:
  - `npm run typecheck`
  - `npm run lint`
  - `npm run test`
  - `npm run package`
- When a change affects user-facing behavior, update `README.md` and `CHANGELOG.md`.

## Architecture notes
- **Capability Registry** (`src/capabilities/`): The central tool-calling surface. All tools (obsidian-tools, MCP, web search, worker profiles) register here. Capabilities have categories, execution modes, and @-command aliases. The model can autonomously select capabilities via `getEnabledToolDefinitions()`.
- **Project Mode** (`src/projects/`): Vault-native `.md` project files with YAML frontmatter. Projects provide isolated chat history, per-project model routing, and file inclusion/exclusion scoping.
- **System Prompts** (`src/system-prompts/`): Vault-native `.md` prompt files with frontmatter metadata. Support variable substitution ({{vault}}, {{date}}, {{time}}, {{user}}, {{style}}, {{memory}}).
- **User Memory** (`src/memory/UserMemoryManager.ts`): Extends AgentMemoryStore with explicit "remember this" commands, auto-extraction from conversation turns, and profile building.
- **Composer** (`src/composer/`): Pure string manipulation (no vault I/O). Three-stage fuzzy matching for surgical text edits, LCS-based diff computation.
- **Mentions** (`src/mentions/`): @-mention typeahead engine with vault-backed caching. Reads from MetadataCache and getAllTags — no writes.

## Safety and privacy
- Do not expose or log secrets, API keys, tokens, transcripts, or credential payloads.
- Keep credential handling memory-only unless the repo already persists encrypted data.
- Be careful with speech, dictation, and provider routing features; preserve explicit opt-ins and fallback behavior.
- New vault-native features (projects, system prompts) store data as `.md` files under `.command-center/` — the same pattern as existing config and memory storage. No new data exposure paths.

## Release workflow
- For release work, update `package.json`, `manifest.json`, `versions.json`, and `CHANGELOG.md` together.
- Build and package before publishing.
- If asked to publish, create the git tag and GitHub release from the committed release version.
