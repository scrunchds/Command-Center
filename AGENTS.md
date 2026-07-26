# Command Center — Developer Guidelines

## Mandatory Rolling Handoff

After every completed implementation, verification, build, packaging, release, or operational task, update the workspace-level `SESSION_HANDOFF.md` (four directories above this plugin root) before reporting completion. This is not optional and does not require a separate user request.

The update must:
- Set the top-level **Updated** field using the machine’s current local date, time, timezone abbreviation, and UTC offset.
- Summarize the completed work and verification results without removing still-relevant history.
- Refresh affected status tables, architecture/file-map descriptions, artifact sizes, test counts, benchmark figures, environment/package state, and known issues.
- Distinguish the current root build from `release/command-center/`; never claim the release package is current unless `npm run package` was run after the latest source change.
- Record failures or incomplete verification honestly.

Treat handoff maintenance as the final step of the task’s definition of done.

> **Project:** Command Center — Autonomous agent orchestration layer for Obsidian
> **Entry point:** `src/main.ts` → compiled to `main.js`
> **Release artifacts:** `main.js`, `manifest.json`, `styles.css`
> **Tests:** `test/verify.mjs` — 32 tests (run with `npx tsx test/verify.mjs`)

---

## Development Environment

- **Node.js:** 18+ (LTS recommended)
- **Package manager:** npm
- **Bundler:** esbuild (configured in `esbuild.config.mjs`)
- **Language:** TypeScript (strict mode, `noUncheckedIndexedAccess`)
- **Types:** `obsidian` type definitions + `@types/node`

## Getting Started

```bash
npm install
npm run dev      # watch mode — auto-rebuilds on changes
npm run build    # production build — single-shot

# Run verification suite (no Obsidian required)
npx tsx test/verify.mjs
# Verbose:
VERBOSE=1 npx tsx test/verify.mjs
```

## Project Architecture (18 source files, ~2,650 lines)

```
src/
├── main.ts              # Plugin lifecycle + persistence + streaming wiring
│                        #   - creates PiAgentDaemon, TaskQueue, VaultWatcher,
│                        #     ConversationManager, PersistenceManager, StatusBar
│                        #   - registers view, ribbon icon, commands, settings
│                        #   - onQueueEvent wires task.onStream → view per-task buffers
│                        #   - restartDaemon(), setDaemonPath() for hot-restart
├── persistence.ts       # PersistenceManager: versioned, debounced writes
│                        #   - schema v1→v2 migration, validateHistory on load
│                        #   - stores: settings + history + sessions + queue snapshot
│                        #   - forceFlush() on unload, markDirty() on mutations
├── daemon.ts            # PiAgentDaemon — pi --mode rpc subprocess
│                        #   - strict JSONL framing (LF-only, no readline)
│                        #   - executeTask(task, onStream) → streaming + promise
│                        #   - steer/followUp/abort/prompt (multi-turn)
│                        #   - activeTaskId routing (no cross-task contamination)
│                        #   - cancelAllHandlers(reason) on stop/exit/crash
│                        #   - parse-error recovery: malformed JSONL dropped
│                        #   - setPiPath(path) with active-task guard
├── types.ts             # All shared types + TOKEN_LIMITS constants
│                        #   MAX_PROMPT_CHARS: 32K, MAX_STORED_CHARS: 2K, etc.
├── commands.ts          # 3 Obsidian commands (Open CC, Execute Task, Toggle Daemon)
│                        #   - Execute Task now routes through taskQueue (not daemon directly)
├── settings.ts          # Settings interface + SettingsTab with 4 controls
│                        #   - piPath: 1s debounced, hot-restart, active-task guard
│                        #   - enableDaemon: live-toggle starts/stops daemon
├── task-queue.ts        # TaskQueue: FIFO, concurrency=1, pre-enqueue validation
│                        #   - rejects prompts > MAX_PROMPT_CHARS before enqueue
│                        #   - events: enqueued → started → completed/failed → drained
├── vault-watcher.ts     # VaultWatcher: polls vault via Obsidian Vault API (no fs)
│                        #   - uses vault.getFiles() + TFile.stat.mtime
│                        #   - 3s poll, 2s debounce
├── status-bar.ts        # CommandCenterStatusBar: lifecycle-aware status display
│                        #   - states: running(▶), busy(⚡), stopped(■), error(✕)
├── conversation.ts      # ConversationManager: multi-turn context
│                        #   - 10 turn window, 1.5K/turn, 20 conv cap + LRU eviction
│                        #   - Auto-persists via onPersist callback after each turn
│                        #   - hydrate() for session rehydration from persistence
├── obsidian-tools.ts    # 5 Obsidian tools with strict input sanitization
│   (read_note, write_note, search_vault, list_files, get_active_note)
│                        #   - sanitizePath(): blocks traversal, absolute paths, null bytes
│                        #   - sanitizeQuery(): length cap, control-char stripping
│                        #   - sanitizeError(): strips filesystem paths, truncates
│                        #   - safeContent(): caps read/write output sizes
│                        #   - clampNum(): bounds maxResults (1-50), list depth (≤8)
├── obsidian-search.ts   # Two-phase vault search engine
│                        #   - Phase 1: metadata-cache-only filter (zero I/O) — tags, headings, fm
│                        #   - Phase 2: BM25 scoring via cachedRead() on survivors
│                        #   - Query: multi-term AND, "phrase", -exclude, tag:/path:/heading:/fm:k=v
│                        #   - Scoring: BM25 TF×IDF + filename×1.5 + heading×2.0 + fm×1.0 + phrase×4.0
├── ui/
│   └── command-center-view.ts  # Custom ItemView: dashboard + per-task streaming
│                        #   - startTaskStream(): creates <pre> block with header
│                        #   - appendStreamOutput(): incremental TextNode append
│                        #   - finalizeStreamOutput(): marks block completed
│                        #   - clearAllStreams() / clearTaskStream()
└── workers/
    ├── index.ts              # Worker registry (getWorkerProfile)
    ├── orchestrator.ts       # Orchestrator — plan multi-step workflows
    ├── retriever.ts          # Retriever — search vault for related notes
    ├── summarizer.ts         # Summarizer — extract key points/themes/actions
    └── editor.ts             # Editor — produce structural edit operations
    # Each worker is self-contained: profile + buildPrompt(maxTokens?) + parseResponse()
    # Budget = maxTokens × 4 (chars/token) - instruction_overhead - padding

test/
└── verify.mjs           # 32 tests: build, parsers, RPC routing, error recovery, queue lifecycle
```

---

## Key Design Decisions

### JSONL Protocol Compliance
The RPC protocol requires strict `\n`-delimited JSONL. Node's `readline` is **not compliant** because it splits on Unicode line/paragraph separators (`U+2028`, `U+2029`). The daemon uses manual buffer (`buffer.indexOf('\n')`) splitting instead. Malformed JSONL lines are silently dropped (no crash).

### Daemon vs. SDK
We spawn `pi --mode rpc` as a subprocess rather than using the SDK directly. Process isolation means any installed pi version works. The daemon rejects concurrent `executeTask` calls — the task queue's `concurrency=1` prevents RPC collisions.

### Handler Cancellation
When the daemon stops (planned or crash), `cancelAllHandlers(reason)` rejects every pending RPC Promise with a clear error (`"Daemon stopped."` or `"Daemon exited unexpectedly (code N)."`). This prevents orphaned Promises that would hang the queue.

### Two-Phase Search
`search_vault` uses a two-phase approach. **Phase 1** filters files using only Obsidian's in-memory `metadataCache` — tags, headings, frontmatter fields, path patterns — without reading any file. **Phase 2** reads only survivors via `vault.cachedRead()` and scores them with BM25 relevance weighting. Metadata-only queries (`tag:`, `path:`, `heading:`, `fm:`) never touch disk.

### Streaming Architecture
The streaming pipeline is: `pi` JSONL → `daemon.processLine()` → `streamCallback(delta, activeTaskId)` → executor wraps `task.onStream` → view `appendStreamOutput(delta, taskId)`. The view uses incremental DOM (`appendChild(TextNode)`) instead of full `textContent` replacement. Each task gets its own `<pre>` block — the second task does not overwrite the first.

### Token Budget Enforcement
The `TOKEN_LIMITS` constant object defines 5 hard limits enforced at the queue (`enqueue`), the daemon (`executeTask`), and persistence (`validateHistory`). Each worker's `buildPrompt(maxTokens?)` computes `budget = maxTokens × 4 chars/token`, subtracts instruction overhead, and slices content. Over-cap content is annotated with `[truncated]` or `[content capped]`.

### Input Sanitization
Every Obsidian tool enforces: `sanitizePath()` blocks `..` traversal, absolute Windows paths, null bytes, and forbidden chars; `sanitizeQuery()` caps length and strips control chars; `sanitizeError()` strips filesystem patterns like `C:\Users...` from error messages before returning them to the agent.

## Adding a New Worker Profile

1. Create `src/workers/<name>.ts` with three exports:
   - `profile: WorkerProfile` — name, label, description, systemPrompt, modelConfig (maxTokens, temperature)
   - `buildPrompt(...args, maxTokens?)` — constructs the prompt with token-budget-aware content slicing
   - `parseResponse(output)` — parses JSON response with try/catch fallback
2. Import and register in `src/workers/index.ts` → `workerRegistry`
3. No need to modify `types.ts` — profiles are self-contained

## Release Checklist

- [ ] Update `manifest.json` version + `minAppVersion`
- [ ] Update `versions.json` if needed
- [ ] Run `npm run build` — verify zero errors
- [ ] Run `npx tsx test/verify.mjs` — verify all 32 tests pass
- [ ] Commit and tag
- [ ] Create GitHub release with `main.js`, `manifest.json`, `styles.css`