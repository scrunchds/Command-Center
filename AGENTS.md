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

## Safety and privacy
- Do not expose or log secrets, API keys, tokens, transcripts, or credential payloads.
- Keep credential handling memory-only unless the repo already persists encrypted data.
- Be careful with speech, dictation, and provider routing features; preserve explicit opt-ins and fallback behavior.

## Release workflow
- For release work, update `package.json`, `manifest.json`, `versions.json`, and `CHANGELOG.md` together.
- Build and package before publishing.
- If asked to publish, create the git tag and GitHub release from the committed release version.
