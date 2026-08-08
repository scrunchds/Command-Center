# Command Center for Obsidian

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.13%2B-7C3AED?logo=obsidian)](https://obsidian.md/)
[![Node.js](https://img.shields.io/badge/Node.js-20%20%7C%2022%20%7C%2024-339933?logo=node.js&logoColor=white)](package.json)
[![Tests](https://img.shields.io/badge/tests-426%20passing-brightgreen)](#quality-security-and-release-controls)
[![Attestations](https://img.shields.io/badge/attestations-Sigstore-blue?logo=sigstore)](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds)
[![Desktop only](https://img.shields.io/badge/platform-desktop--only-informational)](manifest.json)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-Support%20development-FFDD00?logo=buymeacoffee&logoColor=000)](https://buymeacoffee.com/DustinS)

**Command Center is a personal operational OS for Obsidian — a local-first AI multi-agent orchestrator that turns your vault into a single, navigable control room.** One dashboard gives you a zero-token “happening now” snapshot of today's note, unfiled captures, open tasks, and managed workspaces; a calendar for creating and completing dated work; a doorway that jumps to any note, folder, tag, or Bases view; and a Markdown-backed Command Deck that turns your workflow files into one-click buttons. Behind it sits a 13-provider routing layer, a local Pi ReAct engine with Orchestrator–Worker loops, hybrid vault RAG (BM25 + semantic retrieval), persistent agent memory, native Markdown/Canvas workflows with Bases queue integration, voice input and live transcription, extensible MCP and REST connectors, and headless automation — all behind an absolute write gate, and all without imposing a productivity framework on your notes.

> [!IMPORTANT]
> Command Center can modify vault files when you approve or run mutating operations. Keep backups, review destructive action cards, and test workflows on non-critical notes first.

## Why Command Center?

Most AI integrations add a chat box. Command Center adds an operational layer:

- **Framework-agnostic by design** — no required PARA, GTD, Johnny.Decimal, folder taxonomy, note schema, or life-management methodology. The setup interview learns the structures already used in your vault.
- **Metacognitive Partner, not prescriptive organizer** — two-stage Socratic Triage first learns your goals, constraints, language, and personal definition of efficiency, then negotiates topology observations as neutral evidence. It preserves intentional friction and proposes capabilities only with consent.
- **Interview-driven configuration** — embedded dashboard discovery collects topology, life map, capacity rules, triage policy, focus constraints, and writing style; confirmation and synthesis then generate only the assets you approve.
- **Token-efficient stationary indexing** — protected `_index.md` files describe folder purpose and direct-child contents so agents can route work without repeatedly scanning the whole vault.
- **Built-in Obsidian Secrets** — API keys are managed through Obsidian's native Secret Storage, so they persist with your vault instead of a custom encrypted file. Keys are edited from a dedicated settings modal, and keyed cloud providers remain available whenever their secrets are present.
- **Local-first options** — Pi, Ollama, LM Studio, custom OpenAI-compatible endpoints, local embeddings, and deterministic fallback retrieval support private or disconnected workflows.
- **Human control at mutation boundaries** — an absolute write gate wraps every capability, so no agent can touch a file without your explicit click. Approval cards show target paths and syntax-colored diffs, an append-only log records every decision, and you may delegate write authority with a global Auto write toggle while keeping chosen folders permanently click-gated.
- **Zero-cost intelligence** — the four dashboard cards, the calendar, and the vault doorway are computed entirely from Obsidian's own metadata cache. They populate instantly and cost no API tokens, reserving model spend for actual reasoning.
- **A hub, not another chat box** — dates, tasks, notes, folders, tags, Bases views, and workflows are all reachable and actionable from one responsive grid, so recording and finding information never means hunting through folders.

## Contents

- [The six core principles](#the-six-core-principles)
- [Feature overview](#feature-overview)
- [Architecture](#architecture)
- [Installation](#installation)
- [First-run onboarding](#first-run-onboarding)
- [Configuration](#configuration)
- [Everyday usage](#everyday-usage)
- [Write gate and approvals](#write-gate-and-approvals)
- [Workflows and Bases](#workflows-and-bases)
- [Voice and automation](#voice-and-automation)
- [Privacy and security model](#privacy-and-security-model)
- [Development](#development)
- [Future improvements](#future-improvements-not-yet-implemented)
- [Quality, security, and release controls](#quality-security-and-release-controls)
- [Community and support](#community-and-support)
- [License and attribution](#license-and-attribution)

## The six core principles

Every feature in Command Center answers to one of six principles. They are design constraints, not slogans: each one names the code that enforces it, so a claim in this README can be checked against the implementation.

### 1. Absolute write-gate authority

**No agent writes to your vault without your explicit approval.**

Implemented in `src/security/WriteGate.ts`. `gateTools()` wraps every capability handed to a model so authorization happens *inside* the tool's `execute` path — a forgotten check at a call site cannot bypass it, because there is no ungated route to a tool. `getGatedTools()` is the only sanctioned way to obtain capabilities. Mutations surface as proposals with target paths and diffs; protected paths override even the global Auto write toggle, matched prefix-exactly so `Vault/Private` never captures `Vault/PrivateNotes`. Every decision — approved, rejected, timed out, or auto-approved — lands in an append-only log on the dashboard. Dashboard task edits abort if the target line changed while awaiting approval, and success is reported only after the write completes.

### 2. Zero-cost intelligence

**Situational awareness must never cost a token.**

Implemented in `src/intelligence/VaultDataBridge.ts`, following Dataview's model: read only Obsidian's `metadataCache` and `cachedRead`, never a model. It powers the four “Happening now” cards, the calendar, and the vault doorway. One snapshot feeds every surface, in-flight scans are shared rather than duplicated, and results are bounded (25 captures, 200 tasks) so a large vault cannot stall the UI. Model spend is reserved for actual reasoning — dashboards are free.

### 3. Dynamic extensibility, Markdown-backed

**Your vault is the configuration. Extend the plugin by writing notes, not by editing settings JSON.**

Implemented in `src/ui/CommandDeck.ts`, `src/ui/CustomCards.ts`, and `src/connectors/ApiConnectorManager.ts`. Workflow files become deck buttons, and any note carrying `cc-card: true` becomes a dashboard card — discovered, not registered. Both hot-register on vault events with no Obsidian restart. New tools, MCP servers, and REST connectors join the same `CapabilityRegistry` at runtime. Connectors are strictly declarative: a validated method, path, and schema, never downloaded code.

### 4. Total system transparency

**You can always see what the system did, what it is about to do, and what it cost.**

Implemented across the ReAct monitor, the write-gate log, and the provenance line on every intelligence card (scan time plus “no tokens used”). Panels state their data source and say plainly when they are unconfigured or empty rather than rendering a misleading blank. Failures degrade visibly with the actual error text — no silent blanking, no frozen panel. Action blocks are stripped from visible chat, executed through real APIs, and confirmed back into model context, so the transcript reflects what actually happened rather than what was merely claimed.

### 5. Native Obsidian harmony

**Use what Obsidian already provides instead of reimplementing it.**

Writes go through `Vault.process`, which is atomic and compatible with native File Recovery. Tasks use standard Markdown checkboxes with inline fields, so Dataview, Tasks, Kanban, and Bases keep working on whatever Command Center produces. `.base` views render through Obsidian's own renderer; folders reveal in the native file explorer; tag searches hand off to the built-in global search; card bodies render via `MarkdownRenderer`, so embeds, callouts, and Dataview blocks work unchanged. Styling uses Obsidian theme variables throughout, so the plugin inherits your theme rather than fighting it.

### 6. Centralized operational hub

**One surface for recording, finding, deciding, and acting.**

The dashboard is a doorway, not a destination: dates, tasks, notes, folders, tags, Bases views, and workflows are all reachable and actionable from one responsive grid. The vault doorway jumps anywhere in the vault; the calendar creates and completes dated work; the embedded browser keeps documentation beside your notes, expandable inline or poppable into its own pane. Every panel is reorderable, resizable, and hideable per vault, collapsible in place with a header chevron, and each one states its purpose and next action so nothing needs to be guessed.

> [!NOTE]
> Principles 1 and 2 sometimes constrain features that would be easier to build otherwise — that is intentional. A dashboard that quietly spends tokens, or an agent that writes without asking, would be more convenient and less trustworthy.

## Feature overview

### Multi-Provider v2.0

Command Center exposes one dispatch layer across **13 providers**:

| Provider | Type | Notes |
|---|---|---|
| Pi Daemon | Local companion | Serialized Pi JSONL RPC; keyless at the plugin boundary |
| OpenAI | Cloud | GPT/o-series, vision, embeddings |
| Anthropic | Cloud | Claude, tools, prompt caching |
| Google Gemini | Cloud | Multimodal, long context, cached-content support |
| OpenRouter | Cloud gateway | Multi-model OpenAI-compatible routing |
| Ollama | Local | Local chat, keep-alive lifecycle controls, and optional bearer authentication |
| Groq | Cloud | Low-latency inference and transcription-compatible routing |
| DeepInfra | Cloud | Hosted open-weight models |
| Mistral AI | Cloud | Mistral, Codestral, and Voxtral families with native STT/TTS (/v1/audio/transcriptions, /v1/audio/speech). |
| Cohere | Cloud | Command models for RAG with native STT (/v2/audio/transcriptions). |
| LM Studio | Local | Dynamic native model resolution, resource-aware JIT loading, OpenAI-compatible inference, and optional bearer authentication |
| xAI (Grok) | Cloud | Grok models with vision, tools, native STT (/v1/stt), and TTS (/v1/tts). |
| Custom Endpoint | Local or remote | User-defined OpenAI-compatible service with optional bearer authentication |

Routing classifies work as `coding`, `vision`, `reading`, `reasoning`, or `fast`. Capability checks prevent invalid model selection; optional exponential moving averages optimize initial routes for **latency**, **cost**, or a **balanced** objective. Recovery remains reliability-first: authentication and invalid-request failures fail or fall through immediately, while rate limits, network errors, timeouts, and server errors use isolated circuit breakers, bounded backoff, and a configurable multi-tier fallback chain.

Additional provider capabilities include:

- Background model discovery with persistent catalogs and static-registry fallback — live models auto-fetch from each enabled provider's `/models` endpoint on startup, covering chat, STT, and TTS model resolution
- Anthropic prompt caching and Gemini cached-content bookkeeping
- Multimodal image preprocessing for vault attachments and Canvas file nodes
- Structured-output repair only at model-authored JSON boundaries
- Local model pre-warm, TTL/keep-alive, best-effort eviction, and auto-download of missing models
- LM Studio model download via `POST /api/v1/models/download` with progress tracking
- Dynamic LM Studio model resolution through `/api/v1/models`: reuse a loaded primary LLM or select the smallest downloaded non-draft conversational model, excluding embedding and speculative draft models
- Optional secure-vault bearer tokens for LM Studio Require Authentication, authenticated Ollama proxies, and custom OpenAI-compatible endpoints; unauthenticated local operation remains supported
- Cloud-bound payload scrubbing of local-only lifecycle fields

### Multi-Agent ReAct engine

The ReAct runtime follows an **Orchestrator → Worker → Observation → Correction** loop:

1. The orchestrator reasons about the objective and selects one or more workers.
2. Independent workers are planned in parallel and transported safely over serialized Pi RPC.
3. Observations return to the orchestrator with evaluation scorecards.
4. Validation detects incomplete, circular, hedged, conflicting, or error-heavy output.
5. The loop corrects, re-routes, or synthesizes a final answer.

Built-in worker profiles cover orchestration, retrieval, summarization, and structural editing. ReAct-capable profiles (`react-orchestrator`, `react-analyst`) extend these with iterative reason-act-observe loops. Five standard agent roles—**Orchestrator**, **Triage**, **Indexer**, **Health**, and **System Architect**—bind each operational responsibility to a compute tier and least-privilege tool ceiling, and the runtime can create constrained custom roles without granting tools outside the parent worker's ceiling.

<details><summary>Role vocabulary (three layers)</summary>

The codebase uses three distinct, layered vocabularies — they are intentionally not collapsed, because each keys a different table:

- **`WorkerProfileName`** (`src/types.ts`) — the 4 static prompt+token configs in `src/workers/`: `orchestrator`, `retriever`, `summarizer`, `editor`. Smallest and most stable.
- **`AgentWorkerProfile`** (`src/execution/ExecutionRouter.ts`) — a superset adding `react-orchestrator` and `react-analyst`, the ReAct-capable profiles that have no static prompt entry but declare an execution modality (text/embeddings/…).
- **`StandardAgentRole`** (`src/engine/AgentTypes.ts`) — the 5 operational roles above; each maps to a compute tier + a worker profile + a `TaskType` via `AGENT_TAXONOMY`. `Task.workerRole` reuses this union.

The `pi-daemon` string is a sentinel, not a profile: command-palette local tasks set `workerProfile: 'pi-daemon'` to route directly to the local Pi daemon via `router.routeDirect`.

</details>

Operational safeguards include:

- Same-cycle target conflict detection and normalized FIFO file locks
- Circuit breakers, retry/backoff, timeout recovery, deadlock detection, and safe-state rollback
- Four-dimension evaluation: completeness, relevance, specificity, and correctness
- Cooperative **Debug / Step Mode** that pauses only at safe cycle boundaries
- A fixed 50-row ReAct monitor with All, Actions & corrections, and Errors filters
- Full-fidelity session replay and Markdown audit export

### Hybrid Vault RAG and persistent memory

Command Center can ground model calls in vault content without rebuilding the index on every query:

- Markdown is chunked into semantic 300–500-word units aligned to headings, paragraphs, and sentences.
- Chunk metadata retains path, H1/H2 hierarchy, normalized wikilinks, and inclusive line ranges.
- Path + mtime + size keys skip unchanged reads and embeddings.
- BM25 lexical ranking and cosine semantic ranking are merged through weighted reciprocal rank fusion (RRF).
- **GraphRAG** layers on top of hybrid retrieval: a seed BM25+semantic search, then a 1–2-hop expansion across Obsidian's native wikilink/backlink graph (`metadataCache.resolvedLinks`, the same data the Graph view uses), re-ranking seeds and connected-neighbor chunks with a graph-boosted score that rewards hub notes (MOCs). It degrades to plain hybrid retrieval when the vault has no links. Agents can request it explicitly via the `graphSearchVault` tool.
- **Optional reranker**: a dedicated rerank model can re-score retrieved chunks after fusion. Configure it under Settings → Command Center → Features: API mode calls a native rerank endpoint (Cohere `rerank-*`, Jina `jina-reranker-*`, Voyage `rerank-*` — all discovered automatically from each provider's live model list); LLM mode asks any chat model to score candidates; None keeps the built-in RRF/graph scoring.
- Folder scopes constrain retrieval, and cited snippets remain inside a hard prompt budget.
- Unavailable embedding services degrade to deterministic local term-frequency vectors.

Persistent agent memory stores facts, preferences, entities, and session summaries in vault-native state. Semantic duplicate updates, thematic session hubs, threshold-aware pruning, and bounded prompt injection keep memory useful without allowing it to grow without control.

### Metacognitive Partner and semantic memory

Command Center acts as a **Metacognitive Partner**: it helps users examine and negotiate how their own system works rather than grading it against a generic productivity framework. Discovery follows two deliberate stages:

1. **Contextual baseline** — one focused Socratic question at a time establishes goals, constraints, working context, preferred cognitive style, and the user's subjective definition of success and efficiency.
2. **Topographical negotiation** — only after that baseline exists does Command Center introduce read-only vault observations. Patterns are treated as hypotheses; intentional exceptions and useful friction are preserved, and automation, semantic linking, or multi-agent synthesis are offered as optional capability expansions with explicit tradeoffs.

The metacognition layer builds supporting local context without reorganizing or rewriting user notes:

- `TopographySweep` uses Obsidian's `TAbstractFile`, `TFile`, `TFolder`, `MetadataCache`, and `getAllTags` APIs to map folders, tag frequencies, links, and hub/MOC candidates.
- The sweep runs silently and cooperatively, excludes `.obsidian` and `.trash`, and writes only `.obsidian/plugins/command-center/vault_topography.json`.
- **Logic Discovery onboarding** is consent-led and treats topology as neutral evidence requiring user confirmation. Confirmed preferences and the transcript are stored in `user_logic_profile.json`.
- Header-aware Markdown chunking preserves `##`/`###` boundaries, source lines, frontmatter tags/aliases, and outbound `[[wikilinks]]`.
- The semantic database schema separates documents, chunks, and vectors. With an injected desktop SQLite-VSS driver, document replacement is transactional and nearest-neighbor search is persisted locally; the distributed build otherwise uses a process-lifetime in-memory index.
- Dialectic RAG requests only the `embeddings` modality through the Native Auto-Router and Python execution boundary. The shipped Python worker is a secure transport stub and reports that no embedding backend is configured; an integrated backend must return normalized, dimension-validated vectors before they can be stored.

### Native workflows and Bases queues

Workflows are vault-native rather than hidden in a remote service:

- Parse Markdown frontmatter or JSON Canvas graphs into validated DAGs
- **Generate workflows as Markdown (`.md`) or JSON (`.json`)**, with the directory and format fully configurable under **Paths & Appearance**; the onboarding interview writes generated assets to your chosen locations
- Collect typed text, dropdown, and toggle inputs in native Obsidian modals
- Execute independent steps in parallel topological tiers
- Evaluate constrained conditions over inputs and earlier step results—without `eval`
- Interpolate `{{inputs.*}}` and `{{steps.*.result}}`
- Route each step through a provider or Pi policy
- Export Markdown workflows to deterministic, executable Canvas layouts

The **Command Center Queue** integrates with Obsidian Bases. It consumes native evaluated results, preserves filters/formulas/sorts/limits, excludes terminal notes, supports selection and bounded concurrency, and writes `agent_status`, score, and timestamp fields through `processFrontMatter()` so active Bases views refresh in real time.

### Daily operations and stationary indexes

The interview becomes the source of truth for daily operations:

- Morning capacity evaluation, inbox proposals, and daily-note assembly
- Midday text or voice updates under a stable log heading
- Evening review with explicit complete, rollover, discard, or leave decisions
- Optional **Silent Daily Startup** that assembles and opens the note while leaving inbox mutations unapproved
- Collision-safe inbox move/archive/extract/delete proposals
- Frog/aging audits and configurable capacity rules
- Protected `_index.md` manifests maintained from direct-child scans

Stationary indexes contain purpose, scope, summary, and status metadata. Compact purpose headers allow routing to the correct folder before deeper retrieval, reducing full-vault reads and prompt waste.

### Dashboard Logic Discovery

The full-page **Command Center Dashboard** is the single operational interface for Socratic vault discovery, onboarding, agent monitoring, queue control, approvals, and daily operations. Discovery is a dashboard mode—not a separate deck, pane, or modal. It begins with a contextual baseline before introducing read-only `TopographySweep` evidence. Topology remains supporting evidence and is never promoted into a rule without user confirmation.

Logic Discovery uses bounded generation and disables model reasoning where supported so the dashboard presents one concise visible question at a time. With LM Studio enabled, Command Center discovers native catalog state through `/api/v1/models`, prefers an already loaded primary conversational model, or JIT-loads the smallest suitable downloaded model before calling `/v1/chat/completions`.

Open **Command Center** from the ribbon or run **Command Center: Start Setup / Onboarding Interview**. Both routes use the same full-page dashboard.

### MCP (Model Context Protocol) tool discovery

Command Center now supports the [Model Context Protocol](https://modelcontextprotocol.io/) for discovering and executing external tools from MCP servers. Add MCP server URLs in settings to make their tools available to the LLM during inference:

- **JSON-RPC 2.0 transport** over HTTP/SSE
- **Dynamic tool discovery** via `tools/list` — tools are wrapped as `ToolDefinition`s
- **Error isolation** — one MCP server failing doesn't affect others
- **LM Studio MCP** — LM Studio can be configured as an MCP host at `/api/v1/mcp`

### Normalized execution and Shadow-Clone diagnostics

Standard and Python-backed agent work crosses a mandatory execution boundary:

- `NativeAutoRouter` reads the shipped `model_matrix.json` and applies the global 1–10 quality/cost depth to text, image, audio, video, and embedding intents.
- Orchestrator, summarizer, editor, retrieval, and ReAct worker profiles declare an explicit modality before provider/model resolution.
- Python workers use isolated JSON-RPC 2.0 subprocesses over stdin/stdout with `shell: false`, bounded output, cancellation, timeouts, cleanup, and circuit breaking. Credentials are never placed in argv or environment variables.
- `DataNormalizer` is the trust boundary for provider responses, Python results, intermediate observations, and multi-agent merges. It sanitizes tracebacks, stderr, malformed JSON, control characters, and oversized output before UI or vault use.
- Locked or failed keyed routes retain local-first behavior through provider usability checks and circuit-breaker fallback.

Run **Command Center: Run Shadow-Clone Diagnostics** from the command palette to verify credential-memory wiping, current slider/matrix routing, fail-safe local routing, and Python-output sanitization. The harness uses in-memory fixtures and prints a sanitized report to the developer console; it does not modify user notes.

### OpenRouter web search

When enabled in settings, Command Center includes a server-side web search tool in requests routed through OpenRouter. The model can invoke `web_search_call` to pull live information from the web, with results and citations returned directly in the response. Controlled by the `webSearchEnabled` setting toggle.

### Native chat and context

The right-sidebar chat supports **Quick**, **ReAct**, and **Workflow** modes with:

- Provider/model status and streamed Markdown responses
- Bounded multi-turn history
- Active editor selection, `@Note`, `@path`, and `.base` context
- Dismissible active/recent-note suggestion pills
- Inline collapsible ReAct traces
- Dashboard handoff for approval/rejection of destructive tools
- Tail-aware auto-scroll and lifecycle-safe cancellation
- **Message actions**: copy to clipboard, delete, and read-aloud buttons with SVG icons
- **Code block copy**: hover-revealed copy button on every rendered code block
- **Blinking streaming cursor** (`▊`) on pending assistant messages
- **Hover-revealed action bar**: timestamp, copy, delete, and read-aloud fade in on bubble hover
- **Scroll-to-bottom button**: appears when chat history is scrolled up
- **New conversation** and **Markdown export** with tagged frontmatter

### Capability Registry — unified agent tool-calling

Command Center now includes a **Capability Registry** — a central, discoverable surface for every instrument the agent can invoke. Instead of the orchestrator pre-selecting which tools to use, the model can autonomously reason about which capability serves each task:

- **Unified registry**: Vault tools (read, write, search, list), web search, MCP-discovered tools, and agent worker profiles all register in one place.
- **User-configurable**: Each capability can be enabled or disabled from Settings, grouped by category (Search, File Operations, Media, Time, Memory, System, MCP, Agent).
- **Autonomous mode**: The model can decide to call a tool on its own, or only when the user explicitly requests it via `@`-command aliases.
- **Alias-aware**: Capabilities expose `@`-command aliases (e.g., `@vault`, `@websearch`, `@composer`, `@memory`) so users can invoke tools explicitly.
- **Execution modes**: `always` (always included in context), `autonomous` (model may decide), `explicit` (only on user request).
- **Confirmation policies**: `never`, `on-threshold`, or `always` for destructive operations.
- **Event-driven UI**: The registry emits events when capabilities are registered, enabled, or disabled — the Settings UI and dashboard widgets react in real time.
- **System prompt injection**: `describeEnabled()` produces a compact inventory of available capabilities for the model's context window.

### Project Mode — isolated AI workspaces

Projects are focused AI workspaces with isolated chat history, per-project model configuration, and scoped context sources:

- **Vault-native storage**: Each project is a `.md` file under `.command-center/projects/` with YAML frontmatter — no hidden databases or external services.
- **Per-project model**: Override the global provider/model for a specific project.
- **Custom system prompt**: Assign a system prompt to shape the agent's behavior for that project.
- **File scoping**: Inclusion and exclusion patterns control which notes are visible to the project's agent.
- **Web and YouTube context**: Pre-load web page URLs and YouTube video transcripts as always-available context.
- **Isolated chat history**: Conversations in one project never bleed into another.
- **Archiving**: Archive projects to hide them from the active list while preserving data.
- **Usage tracking**: Automatic last-used timestamps and conversation counts for sorting.

### Inline Composer — surgical text editing with diff preview

The composer provides a three-stage fuzzy matching engine for precise text replacement:

1. **Exact match** — after line-ending normalization (CRLF → LF)
2. **Fuzzy match** — NFKC normalization, smart quotes, special dashes, non-breaking spaces
3. **Trimmed match** — retry after stripping trailing newlines

Additional capabilities:

- **BOM handling**: UTF-8 BOM is preserved through edit cycles.
- **LCS-based diff**: Longest-common-subsequence diff computation with line-level granularity.
- **Multi-operation editing**: `applyOperations()` applies a sequence of insert, update, replace, and delete operations in order.
- **Diff statistics**: Additions, deletions, and unchanged line counts for progress reporting.

### @-Mention Typeahead — inline vault references

The typeahead engine provides real-time suggestions as you type `@` in the editor:

- **Multi-source**: Searches notes, folders, tags, and capabilities simultaneously.
- **Categorized results**: Results grouped by source type with clear labels and descriptions.
- **Keyboard navigation**: Arrow keys, Enter/Tab to select, Escape to dismiss.
- **Vault caching**: 30-second TTL cache prevents repeated vault scans.
- **Capability aliases**: `@vault`, `@websearch`, `@composer`, `@memory` resolve to their corresponding capabilities.
- **Wikilink insertion**: Selected notes are inserted as `[[wikilink]]` references.

### User-Managed System Prompts

System prompts are stored as vault-native Markdown files with YAML frontmatter:

- **CRUD management**: Create, edit, delete, and browse prompts from the vault.
- **Variable substitution**: `{{vault}}`, `{{date}}`, `{{time}}`, `{{user}}`, `{{style}}`, `{{memory}}` are resolved at render time.
- **Custom resolvers**: Override variable resolution per-project or per-chat-mode.
- **Default prompt**: A sensible default prompt is created on first launch.
- **Category filtering**: Organize prompts by category for quick access.

### User Memory Manager — explicit "remember this"

Builds on the persistent agent memory store to provide user-facing memory operations:

- **Explicit memory**: `remember()` processes natural-language "remember that" commands.
- **Auto-extraction**: `extractFromTurn()` detects "I prefer", "I am", "remember that" patterns in conversation turns.
- **Profile building**: `buildProfile()` aggregates stored facts into a structured `UserMemoryProfile` with name, style, expertise, and goals.
- **Contextual recall**: `recall()` searches memories by relevance to a query and returns formatted Markdown.
- **System prompt injection**: `injectMemoryPrompt()` produces a bounded memory context block for the model.

## Architecture

```text
Obsidian desktop
├── Command Center dashboard
│   ├── task queue, status, history, and frame-batched streaming
│   └── fixed-pool ReAct monitor, replay, export, and debug stepping
├── Right-sidebar chat
│   ├── Quick → ConversationManager → ProviderDispatcher
│   ├── ReAct → PiAgentDaemon → Orchestrator/Workers/Tools
│   └── Workflow → WorkflowEngine → provider or Pi routes
├── Interview-derived operations
│   ├── ConfigManager + generated style guide
│   ├── FolderIndexer → protected _index.md manifests
│   └── DailyEngine + InboxTriager + CapacityEngine
├── Metacognition and knowledge layer
│   ├── TopographySweep + dashboard LogicDiscovery → localized topology/profile JSON
│   ├── ChunkingEngine → H2/H3 chunks + tags/aliases/wikilinks
│   ├── DialecticRAG → normalized embedding ingestion → memory / injected SQLite-VSS
│   ├── HybridRetriever → BM25 + embeddings + weighted RRF
│   └── AgentMemoryStore/ReActMemoryBank → bounded persistent memory
├── Workflow layer
│   ├── Markdown/Canvas parser → validated DAG tiers
│   ├── Bases queue → bounded target batches
│   └── frontmatter state sync → live Bases refresh
├── Execution layer
│   ├── NativeAutoRouter → model_matrix.json + global depth 1–10
│   ├── ExecutionRouter → explicit worker modalities + secure credentials
│   ├── PythonWorkerTransport → bounded JSON-RPC subprocesses
│   └── DataNormalizer → sanitized results, observations, and merges
└── Provider layer
    ├── ModelRouter/ProviderDispatcher → capability, fallback, isolated circuits
    ├── cloud adapters → OpenAI, Anthropic, Gemini, etc.
    └── local adapters → Pi, Ollama, LM Studio, custom endpoint
```

### Important boundaries

- **Obsidian-native I/O:** vault files are read and changed through Obsidian APIs wherever possible.
- **Shared write coordination:** UI, CLI, daily services, indexers, workflows, and tools use one normalized per-vault lock namespace.
- **Serialized Pi transport:** Pi events do not identify an originating prompt, so one active RPC prompt is correlated through `agent_end` and `agent_settled`.
- **Raw-byte framing:** JSONL is split on byte `0x0A` before UTF-8 decoding, preserving split code points, CRLF, U+2028/U+2029, bursts, and final unterminated frames.
- **Bounded UI work:** model deltas and trace events are coalesced with `requestAnimationFrame`; trace history and visible rows are capped.

## Installation

### Requirements

- Obsidian **1.13.0 or newer**
- Desktop Obsidian (the plugin is desktop-only)
- A provider configured in Command Center settings
- Optional: Node.js 20+ and Pi 0.83.0+ for local Pi/ReAct execution

### Manual installation from a GitHub release

1. Download the release assets or the packaged `command-center` directory.
2. Create this folder inside your vault:

   ```text
   <your-vault>/.obsidian/plugins/command-center/
   ```

3. Copy the plugin assets from `release/command-center/`:

   ```text
   command-center/
   ├── main.js
   ├── manifest.json
   └── styles.css
   ```

   Repository-level [`LICENSE`](LICENSE) and [`ATTRIBUTIONS.md`](ATTRIBUTIONS.md) remain published alongside the source and GitHub release documentation.

4. Restart Obsidian or reload community plugins.
5. Open **Settings → Community plugins** and enable **Command Center**.
6. Run **Command Center: Start Setup / Onboarding Interview** from the command palette.

### Optional Pi installation

Pi powers local palette tasks and the full multi-agent ReAct path. Install it separately:

```bash
npm install -g @earendil-works/pi-coding-agent
pi --version
```

Command Center auto-detects common global npm locations. On Windows it resolves `pi.cmd` to Pi's JavaScript CLI and launches it with the real Node executable to avoid Electron/Node wrapper issues. You can override the detected path in **Settings → Command Center → Core Configuration**.

> Pi is an external MIT-licensed companion and is not bundled into this plugin.

## First-run onboarding

Launch onboarding in the full-page dashboard from either the Command Center ribbon action or **Command Center: Start Setup / Onboarding Interview**. Discovery, confirmation, and synthesis stay in the central workspace instead of opening a separate setup modal.

The six configuration phases are:

1. **Topology** — inboxes, daily notes, managed folders, and vault structure
2. **Life map** — domains, projects, time horizons, and completion definitions
3. **Capacity** — tracked metrics and rules that scale daily commitments
4. **Triage** — move, archive, extraction, deletion, and aging policies
5. **Focus** — priority caps, frog rules, quick wins, and task conventions
6. **Style** — writing voice, agent persona, vocabulary, layouts, and reflections

A confirmation/synthesis stage then previews 2–4 templates and 2–3 workflows. Nothing is generated until you explicitly select and approve it. The interview proactively references the vault topology it already scanned, so the first questions are grounded in what was actually found — it does not defer topology to a later step.

The interview is **persistent**: close the dashboard or restart Obsidian mid-interview and it resumes exactly where you left off, including any pending synthesis and connector approvals. Progress is cleared only when the interview completes or you run the reset command.

The interview writes validated assets under your configured paths (`.command-center/` by default), including:

```text
.command-center/
├── config.json
├── style-guide.md
├── templates/
└── workflows/
```

These are local runtime files and must not be published with the plugin. The repository includes a non-secret reference at [`docs/config.example.json`](docs/config.example.json).

### Onboarding security rule

Do **not** enter API keys, passwords, tokens, URLs, hosts, ports, or endpoint details into the interview. Secret-like input is rejected locally. Configure provider credentials and endpoints only in **Settings → Command Center**.

To start over, run **Command Center: Reset / Re-Initialize Vault Configuration**. Generated configuration and style files are moved through Obsidian's trash flow before onboarding restarts.

## Configuration

Open **Settings → Command Center**. The settings UI is organized into seven sections.

### 1. Core Configuration

Configure the active profile, token limits, Pi path, daemon startup, memory limits, Base batch concurrency, and Silent Daily Startup. Pi detection and status diagnostics are available here.

### 2. Accessibility & Speech

Configure text-to-speech enablement, speaking voice, speaking rate, speech-to-text enablement, transcription provider preferences, and automatic read-aloud behavior here. Chat and voice recording use the same speech settings.

**Speech-to-text models** are per-provider (STT model IDs are not portable across providers — `openai/gpt-4o-mini-transcribe` is an OpenRouter routing slug, `grok-stt` is xAI, `whisper-1` is OpenAI). Set the slug each provider accepts in the per-provider model fields; a blank entry uses the provider's built-in default.

**Text-to-speech** can use the browser's built-in speech engine (default) or route through any configured provider's `/audio/speech` (or xAI `/v1/tts`) endpoint for higher-quality voices. Pick the engine in **Text-to-speech engine**; set a per-provider TTS model and voice id when using a provider engine. Every engine listed in the dropdown is actually wired through its provider — DeepInfra, Groq, Custom, LM Studio, and Ollama route through their own endpoints rather than silently falling back to browser TTS.

### 3. Provider Credentials

Each provider has a collapsible card for enablement, endpoint configuration, health checks, and model refresh. API keys are not exposed through ordinary settings fields.

Select **Manage API Keys** to open the built-in secrets editor. Provider secrets are stored in Obsidian Secret Storage under the Command Center namespace, so they persist with your vault instead of a custom encrypted file. Existing secrets can be replaced or removed, but they are not revealed back into the UI.

Authentication metadata distinguishes **required**, **optional**, and **unsupported** credentials. LM Studio's Require Authentication token, authenticated Ollama proxies, and custom OpenAI-compatible bearer tokens all use Obsidian Secret Storage for persistence without making a key mandatory for ordinary local operation. Tokens are applied consistently to inference, streaming, model discovery, health checks, transcription, and local model lifecycle requests.

Credentials are resolved only at request time. Provider secrets stay in Obsidian's secret store, while interviews, generated workflows, CLI/URI arguments, subprocess argv/environment, logs, and repository examples continue to exclude credentials.

### 4. Task Routing Matrix

Assign a provider/model pair to each task class:

| Task class | Typical use |
|---|---|
| `coding` | Code generation, refactoring, technical edits |
| `vision` | Image and Canvas attachment analysis |
| `reading` | Long documents, synthesis, extraction |
| `reasoning` | Planning, analysis, orchestration |
| `fast` | Classification and low-latency transforms |

Live-discovered models appear with a network indicator. If discovery fails, the static registry remains available.

### 5. Fallback Pipeline

Enable or disable fallback, then add, remove, and reorder providers. Permanent request/schema errors fail fast; transient failures use backoff and reliability-ranked alternatives without allowing cost optimization to weaken recovery.

### 6. Health Dashboard

Review provider state, test one provider, refresh all providers, and inspect actionable errors such as a missing Pi binary or unreachable local endpoint.

### 7. Paths & Appearance

Control where generated assets land in your vault and how time is displayed:

- **Workflow directory** — where generated workflow files are written.
- **Workflow format** — `.md` (Markdown with YAML frontmatter, human-readable) or `.json`. The onboarding interview honors this choice.
- **Template directory** — where generated templates are written.
- **Profile path** — where the onboarding profile is written.
- **Migrate now** — move existing workflows/templates/profile to the new configured locations through Obsidian's trash flow.
- **Time format** — System (detected), 12-hour, or 24-hour. Applied to the clock, the daily schedule, and future time displays.
- **Clock widget** — toggle seconds, toggle the date, pick a date verbosity (long / short / numeric), and set an optional label.

Paths are validated and sanitized: emoji and pictographs are stripped, so generated folders never carry icon characters. The plugin can also update these paths programmatically via `updateAssetPaths()` (used by the onboarding interview), with optional file migration.

## Everyday usage

### Dashboard

Open Command Center from the ribbon or command palette. Every panel carries a one-line description of what it shows and what to do with it, so nothing needs to be guessed.

**Happening now — four zero-token intelligence cards**

Computed from Obsidian's metadata cache only; no model calls, no token spend. The four cards can be reordered and individually shown or hidden under **Settings → Command Center → Dashboard**.

| Card | What it shows | What to do |
|---|---|---|
| Daily intelligence | Today's note, its sections, tracked metrics, and any capacity rule that tripped | Click to open today's note |
| Capture | Notes you dropped in but have not filed | Open one to process it, or ask for triage |
| Action items | Open (and optionally completed) tasks vault-wide, in user-configurable Kanban lanes | Click a row to jump to that exact line |
| Workspaces | Managed folders with live note counts, freshness, and index state, plus nested `.base` views | Click to open a folder index or Bases view |

The **Action items** card is fully configurable — think Kanban. Under **Settings → Command Center → Dashboard → Action items — Kanban lanes** you define the lanes (columns): a label, a deterministic filter (`overdue`, `due today`, `scheduled`, `undated`, `done`, or `all tasks`), and a hide-when-empty flag. Lanes render in your chosen order, empty lanes can stay visible as placeholders, and a `done` lane surfaces completed work only when you add one. The defaults (Overdue / Due today / Scheduled / Undated) match the previous hard-coded board.

**Clock** — a live, zero-token clock respecting your time-format preference (System / 12h / 24h). Customize it under **Paths & Appearance**: toggle seconds, toggle the date, pick a date verbosity (long / short / numeric), and set an optional label.

**Today's schedule** — a zero-cost "today by time" view built only from Obsidian's metadata cache. It surfaces tasks due today, parses inline time tags (`⏰ HH:MM` and `[time:: HH:MM]`), sorts timed entries before untimed ones, and click-throughs to the source note. No model calls, no token spend.

**Calendar** — a month grid marking which days have notes and how much work is scheduled. Click a date to open or create its daily note, tick tasks complete, reschedule them, delete them, or add new dated tasks. Every write is a proposal that passes the write gate first.

**Vault doorway** — one filter box across note titles, folders, tags, canvases, and `.base` views, ranked by prefix, word-boundary, then substring match. Press Enter to open the top hit. Left empty it lists your most recently edited notes. Folders reveal in the native file explorer; tags hand off to Obsidian's own global search.

**Command deck** — a vertical rail built from your vault's workflow files (`.md`, `.canvas`, and generated `.json`). Labels, descriptions, and icons come from native frontmatter, and new workflows hot-register without an Obsidian restart.

**Browser** — a real embedded web view for documentation, API references, and research. Use it inline, expand it to fill the dashboard for close reading, or pop it out into its own pane. Bare hosts and `localhost:3000` resolve as addresses, free text becomes a search, and non-web schemes (`javascript:`, `data:`, `file:`) are refused. Hidden by default — enable it in **Customize dashboard**.

When Obsidian's core **Web viewer** is enabled, the panel offers to hand the current address to it, so browsing uses the history, favicons, ad blocking, and search engine you already configured in Obsidian rather than a parallel set of the plugin's own. Detection is guarded and falls back to the plugin's own view if the core viewer is off or refuses (`src/ui/native-webviewer.ts`).

On desktop this uses Electron's `<webview>`, the same mechanism as Obsidian's own Web viewer, so it browses the open web normally — including sites such as GitHub, MDN, Google, and Stack Overflow that send `X-Frame-Options` and would refuse to load in a plain iframe. Browsing state lives in its own isolated partition, separate from Obsidian's session. An **Open externally** button hands the current page to your system browser, which is the better route for logins, downloads, and anything needing a password manager.

The widget and the full-pane view are the same component, so behavior and fixes never diverge between them. **Open browser** reuses an existing browser leaf rather than opening a new split each time.

> [!NOTE]
> Where `<webview>` is unavailable, the panel degrades to a sandboxed iframe and says so in the panel. In that limited mode only sites that permit framing will load; most major sites will not. Command Center is desktop-only, so this is an edge case rather than the normal path.

> [!IMPORTANT]
> This is a convenience reader, not a replacement for your browser. Sign-in flows are the weak spot: Google's login pages actively resist embedded browsers, and password managers and passkeys will not be available. Use **Open externally** for anything involving credentials — which is also the safer habit.

### Custom cards

Any note in your vault becomes a dashboard card by adding `cc-card: true` to its frontmatter. There is no registry and no settings form: create the note and the card appears, delete it and the card is gone. Cards are reorderable alongside built-in widgets.

#### Dashboard views

Three panels offer alternative presentations you can switch between from the “Customize dashboard” editor or Settings → Dashboard:
- **Clock** — *Digital* (time, date, label) or *Minimal* (time only).
- **Calendar** — *Month* (full grid), *Week* (a 7-day row anchored to the selected day; prev/next step by a week), or *Agenda* (a forward list of the next two weeks of scheduled tasks).
- **Happening now / Action items** — *Kanban* (lanes, the default), *List* (a flat, due-sorted list), or *Compact* (count chips only for a small footprint).

The active view is saved per panel and survives layout migrations. Adding a view to another widget later is a one-line change to the descriptor registry in `src/ui/widget-descriptors.ts`.

```markdown
---
cc-card: true
cc-card-title: Morning review
cc-card-hint: What I committed to today
cc-card-icon: sunrise
cc-card-order: 1
---

## Focus

- [ ] Draft the quarterly summary
- [ ] Reply to the vendor thread

![[Active projects.base]]
```

| Key | Purpose |
|---|---|
| `cc-card` | Required. `true` marks the note as a dashboard card. |
| `cc-card-title` | Display name; falls back to `name`, `title`, then the filename. |
| `cc-card-hint` | One-line description shown under the title. |
| `cc-card-icon` | Obsidian icon id. |
| `cc-card-order` | Sort order relative to other cards. |

Card bodies render through Obsidian's own Markdown renderer, so embedded `.base` views, Dataview blocks, callouts, images, and transclusions all work. Checkbox lines become **interactive rows**: ticking one writes back to the source note through the write gate, and the arrow button jumps to that exact line. Checkboxes inside fenced code blocks stay as code samples rather than becoming buttons.

**Also on the dashboard**

- Embedded Socratic discovery and onboarding, entirely optional
- Mutation approvals with target paths, diffs, live gate posture, and an append-only decision log
- Orchestrator chat with capability-aware tool calling
- Daemon Start / Stop / Restart controls
- Pending, running, completed, and failed queue counts
- Provider-normalized orchestrator output and per-task live output
- Task history, ReAct filters, debug stepping, and session export
- Daily-cycle controls and consolidated silent-start summaries
- Obsidian's built-in browser, opened in a split pane for documentation and research
- Per-vault widget ordering, sizing, collapse/visibility controls, and responsive layout persistence
- Live clock widget (time-format aware, customizable) and a zero-cost today-by-time schedule widget
- Review-before-send dictation plus opt-in audio cues, speech-to-text, and AI read-aloud

### Chat panel

Run **Command Center: Open Chat Panel** and choose:

- **Quick** for provider-routed conversational work
- **ReAct** for orchestrated multi-agent execution
- **Workflow** to run a Markdown, Canvas, or Base-backed workflow

Use `@Note Name`, `@folder/note.md`, an active editor selection, or a `.base` reference to attach vault context. Suggested recent/active notes appear as dismissible pills; only retained pills are sent.

### Local task

Open a Markdown note and run **Execute agent task on current note**. This command explicitly routes through the local Pi daemon and starts it automatically when possible.

## Write gate and approvals

The write gate is the boundary between the model and your vault. It is not advisory: every capability handed to an agent is wrapped so the gate runs *inside* the tool's execution path. A missed check at a call site cannot bypass it.

```text
Capability wants to write
  → gate describes the change as a proposal
  → proposal appears in Mutation approvals
  → you click Approve
  → only then does the write occur
```

**Defaults and controls**

| Setting | Default | Effect |
|---|---|---|
| Auto write (global bypass) | Off | Off: every mutation waits for your click. On: approved capabilities write immediately. |
| Protected paths | Empty | Vault-relative folders that always require an explicit click, even when Auto write is on. |

Protected-path matching is prefix-exact, so `Vault/Private` never accidentally captures `Vault/PrivateNotes`. Paths are yours to define; the plugin assumes no folder names.

**Guarantees**

- Read-only capabilities never prompt.
- A capability reporting no mutation for its arguments never prompts.
- Rejection, timeout, and failure all leave files untouched.
- Dashboard task edits abort if the underlying line changed while awaiting approval.
- Writes use `Vault.process`, so they are atomic and compatible with native File Recovery.
- Every decision — approved, rejected, timed out, or auto-approved — is recorded in the on-dashboard log.
- Success is reported only after the write actually completes.

## Workflows and Bases

### Markdown workflow concepts

A workflow defines typed inputs and steps. Every synthesized step declares an assigned agent, required compute tier, fallback policy, and action type. Dependencies form a DAG; unknown dependencies and cycles are rejected before execution.

Conceptual example:

```yaml
---
workflow:
  name: Review incoming note
inputs:
  tone:
    type: dropdown
    options: [concise, detailed]
steps:
  - id: inspect
    assigned_agent: researcher
    required_tier: tier1_local
    fallback_policy: configured
    action_type: read
    prompt: "Inspect {{inputs.targetPath}} using a {{inputs.tone}} style."
  - id: summarize
    dependsOn: [inspect]
    assigned_agent: writer
    required_tier: tier2_reasoning
    fallback_policy: configured
    action_type: write
    prompt: "Summarize: {{steps.inspect.result}}"
---
```

The exact accepted shape is validated by the native parser and may include input defaults, conditions, provider/Pi routing, and output metadata.

### Canvas workflows

Open a Markdown workflow and run **Export Active Workflow to Canvas**. Parallel steps share a tier column, dependencies become directed edges, and executable step metadata is retained in text nodes.

### Bases queue execution

A standalone `.base` file can reference a workflow. Open it and run **Execute Workflow on Current Base Queue**. Choose concurrency from 1–10 and an optional partial-run limit. Command Center:

1. Resolves Obsidian's evaluated Base entries
2. Excludes completed/failed notes
3. Runs bounded independent target contexts
4. Awaits frontmatter updates between tiers
5. Refreshes and re-queries membership before continuing

This allows a Base to function as a live, self-draining agent queue.

## Voice and automation

### Voice input

The chat microphone and **Command Center: Quick Voice Prompt** use browser-native `MediaRecorder`:

- In-memory audio assembly
- Live timer and level meter (chat, voice prompt modal, and dashboard dictate button)
- Deterministic microphone-track cleanup
- OpenAI-compatible multipart transcription (per-provider model resolution — see below)
- Retry only for transient network/408/429/5xx failures
- **Mic button disabled** when no STT provider is configured, with tooltip feedback
- Spoken `@` mentions and active-selection context resolution
- **Contextual delivery** — the Quick Voice Prompt routes transcribed text by focus: into the active note at the cursor when a note is in focus, or into the chat input field (for review before send) when the chat panel is in focus or no note editor is active

The transcription fallback chain tries each enabled STT-capable provider in order (LM Studio, Ollama, Groq, OpenAI, DeepInfra, Mistral, OpenRouter, xAI, Cohere, Custom). Each provider uses its **own** model slug — set per-provider in **Settings → Accessibility & Speech**, or leave blank for the built-in default (`whisper-1` for OpenAI, `grok-stt` for xAI, `whisper-large-v3` for Groq, `openai/whisper-large-v3-turbo` for DeepInfra, `voxtral-mini-latest` for Mistral, `openai/whisper-large-v3` for OpenRouter, `cohere-transcribe-03-2026` for Cohere). A global model is no longer broadcast to every provider, so a foreign slug can no longer break a provider it wasn't meant for.

Audio is sent only to the transcription endpoint configured in your local settings. Review that provider's privacy policy before use.

### Text-to-speech

Spoken output defaults to the browser's built-in `speechSynthesis` engine. When **Text-to-speech engine** is set to a provider (or **Auto**), Command Center routes the text through that provider's TTS endpoint instead:

- **xAI**: `POST /v1/tts` (native, model `grok-tts`)
- **OpenAI**: `POST /v1/audio/speech` (model `gpt-4o-mini-tts`)
- **OpenRouter**: `POST /api/v1/audio/speech` (routed slugs like `openai/tts-1`)
- **Mistral**: `POST /v1/audio/speech` (Voxtral TTS)

The returned audio plays through a hidden `<audio>` element. If the provider request fails, Command Center falls back to the browser engine so spoken output is never silently dropped. Set a per-provider TTS model and voice id (e.g. `alloy`, `nova`, `coral`) in **Settings → Accessibility & Speech**.

### Native Obsidian CLI

On Obsidian versions exposing native CLI registration:

```text
command-center:morning
command-center:workflow
command-center:indexes
```

These handlers invoke service layers directly without opening views. They return structured JSON and use non-zero failure semantics. Morning automation assembles the configured note but never auto-approves inbox mutations.

Example shape:

```bash
obsidian command-center:morning --metrics '{"available_minutes":120}'
obsidian command-center:workflow --path '.command-center/workflows/example.md' --inputs '{}'
obsidian command-center:indexes
```

Consult your installed Obsidian CLI's command syntax because host invocation details may vary by version.

### URI fallback

For hosts without native CLI registration:

```text
obsidian://command-center?operation=morning
obsidian://command-center?operation=indexes
```

The URI and CLI boundaries reject credential arguments, unsafe vault paths, malformed/oversized JSON, and any action that requires onboarding-derived config (`morning`, `indexes`) before the interview is complete. Workflow execution via URI/CLI does not require onboarding.

## Privacy and security model

Command Center is local software, but it uses the network when you select a cloud model or transcription provider, refresh a remote model catalog, or connect to a network-hosted custom endpoint. Supported remote services include OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, DeepInfra, Mistral AI, and Cohere; requests are used only to provide the model, embedding, discovery, or transcription feature you invoke.

The desktop-only plugin also accesses files outside the vault in two explicit cases: it launches the separately installed Pi CLI as a child process, and it may read image attachments referenced by absolute paths so they can be sent to your selected vision provider. Ordinary note, configuration, memory, workflow, and index operations use Obsidian's vault APIs.

No client-side telemetry or advertising is included. Command Center does not self-update; installation and updates are handled by Obsidian and GitHub releases.

### Data that may be sent to a model

Depending on the mode and context you approve:

- Your prompt and bounded conversation history
- Selected note text or resolved `@` attachments
- Retrieved and cited vault snippets
- Relevant persistent memory entries
- Images explicitly referenced by the prompt
- Workflow inputs and prior step results

Use local Pi/Ollama/LM Studio/custom endpoints when content must remain on your network, and verify those services independently.

### Local safeguards

- Secrets are entered through Obsidian's built-in Secret Storage UI from the Command Center settings tab.
- Provider secrets persist in Obsidian Secret Storage under the `command-center` namespace.
- Existing secrets are managed in place: replace them, remove them, or leave them unchanged.
- Interview, config generation, CLI/URI arguments, subprocess argv/environment, and examples prohibit credentials.
- Tool paths reject traversal, absolute paths, NUL bytes, and unsafe characters.
- Existing-note overwrites and bulk/destructive operations can require explicit approval.
- Shared FIFO locks coordinate all mutation paths.
- Prompt context, memory, traces, histories, Python subprocess output, and UI rows are bounded.
- All Python JSON-RPC responses, stderr, tracebacks, malformed output, and multi-agent merges pass through `DataNormalizer`.
- `.gitignore` excludes runtime config, memory, audit traces, topology, generated assets, logs, environment files, and release/build outputs.
- `scripts/sanitize-repo.mjs` scans repository and release content for common secrets, private keys, absolute local paths, private IPs, NULs, and tracked runtime state.

### Repository sanitization

Run before committing or publishing:

```bash
npm run sanitize          # tracked + untracked public files
npm run sanitize:staged   # staged Git blobs; suitable for pre-commit
npm run sanitize:release  # repository plus current build/release assets
```

`npm run package` automatically performs the release scan after packaging. CI and release workflows also run the sanitizer.

## Development

### Obsidian plugin development baseline

This repository follows the official Obsidian plugin documentation for lifecycle, workspace, settings, commands, modals, events, vault access, and submission requirements. When changing code, prefer Obsidian-native APIs over custom replacements, clean up event handlers on unload, and keep desktop-only code paths explicit where the plugin depends on them.

### Prerequisites

- Node.js 20, 22, or 24
- npm
- A desktop Obsidian vault for manual integration testing

### Setup

```bash
git clone https://github.com/scrunchds/Command-Center.git
cd command-center
npm ci
npm run dev
```

`npm run dev` starts esbuild watch mode. Reload Obsidian after bundle changes.

### Commands

| Command | Purpose |
|---|---|
| `npm run typecheck` | Strict TypeScript check (including security, metacognition, execution, and diagnostic layers) |
| `npm run lint` | Zero-warning ESLint gate |
| `npm run test` | 242 core + 153 ReAct + 22 provider = 417 total |
| `npm run benchmark` | Produce the standardized 10-metric report |
| `npm run benchmark:check` | Enforce the 25% core regression threshold |
| `npm run sanitize` | Scan public repository files for PII/secrets/runtime data |
| `npm run sanitize:staged` | Scan staged blobs for pre-commit use |
| `npm run build` | Typecheck and build minified production JS/CSS |
| `npm run package` | Build, create a clean release folder, and sanitize it |
| `npx obsidian-plugin-validator .` | Run community-submission manifest and source checks |

### Release output

`npm run package` recreates `release/command-center/` from scratch and permits exactly:

```text
main.js
manifest.json
styles.css
```

License and attribution documents remain at repository level. Restricting the installable directory to Obsidian's three production files prevents stale development or documentation files from leaking into the plugin package.

## Future improvements (not yet implemented)

### Chat conversation management — delete and rename
- The chat view now supports switching between conversations via a dropdown selector.
- A future change could add the ability to delete or rename conversations from the selector.

### Image paste support in chat
- The chat view now shows a notice when images are pasted. A future change could save pasted images to the vault and attach them as multimodal context.

### Dashboard layout customization in the onboarding interview
- The dashboard layout is configurable from the "Customize dashboard" button: every panel can be reordered, shown or hidden, collapsed or expanded, resized to a compact/standard/expanded size, and (for the Clock, Calendar, and Action items panels) switched between alternative views. Layout is computed in `src/ui/layout-model.ts` and persisted as a per-vault `dashboardLayout` setting.
- A future enhancement could add a dashboard layout phase to the onboarding interview (e.g. extending the "style" phase, or adding a new phase after "confirmation").
- This would require:
  1. Adding `dashboardLayout` to the `OnboardingConfig` type in `src/onboarding/OnboardingTypes.ts`
  2. Updating the interview system prompt in `src/onboarding/InterviewEngine.ts` to ask about widget preferences
  3. Applying the interview-derived layout after interview completion in `src/main.ts`

The `OnboardingConfig` already has a `style.dailyNoteLayout` field, so a `style.dashboardLayout` field would follow the same pattern.

### Dashboard telemetry health summary
- The dashboard now shows provider icons with green/red readiness dots. A future change could show live health check status (connected/error) next to each icon.
- The four telemetry cards (Route, Depth, Pi daemon, Secrets) are now clickable. Route opens **Settings → Command Center → Provider Credentials**, Depth opens the **Metacognitive Depth** section, Pi daemon scrolls the dashboard to the daemon panel, and Secrets opens the credential vault — so the operator can jump straight from a status to the setting that controls it.
- The Command deck is now collapsible like every other widget, with the same inline header chevron.
- The four header buttons (Export workflow to canvas, Customize dashboard, Open browser, Open secrets) now carry icons and the primary action (Customize dashboard) uses the `mod-cta` accent so it reads at a glance.

### Voice Prompt Modal — candidate-less mic guard
- The voice prompt modal now shows a warning when no transcription providers are configured. A future change could disable the mic button entirely, matching the chat view behavior.

## Quality, security, and release controls

The test suite currently contains **417 tests**:

- **242 core tests** — build integrity, parsers, byte-safe RPC framing, subprocess integration, task queue, recovery, provider fallback, capability registry, user memory, system prompts, project manager, composer fuzzy matching, @-mention engine, fallback pipeline, and STT/TTS adapters
- **153 ReAct and subsystem tests** — roles, evaluation, traces, workflows, Bases, chat context, action cards, audio, JIT lifecycle, RAG, memory, CLI, locks, and stress scenarios
- **22 provider tests** — XAI provider, OpenRouter model metadata, transcription candidates, and model matrix integration

CI runs on Windows, macOS, and Linux across Node 20, 22, and 24 with:

1. Repository sanitization
2. Typecheck
3. Zero-warning lint
4. Full tests
5. Standardized benchmarks
6. 25% performance-regression gate
7. Production package validation
8. Clean release-surface verification

Release automation repeats the validation, builds a clean three-file plugin package, attests artifact provenance with **Sigstore attestations**, verifies each published asset cryptographically, and creates a GitHub release. The package metadata and manifest version are currently `1.11.1`, with Obsidian 1.13.0 as the minimum supported app version.

The local community-plugin validator currently passes with **0 errors**.

## Troubleshooting

### Pi cannot be found

Run:

```bash
pi --version
npm install -g @earendil-works/pi-coding-agent
```

Then use **Settings → Command Center → Core** → *Pi harness path* and click **🔍 Detect** (or type a custom path). Detection is non-blocking; the button shows **⏳ Detecting…** while it runs and reports **⚠️ Not found** if the binary is still missing. Missing-binary errors fail fast rather than entering a retry loop.

### A local provider is unavailable

- Confirm Ollama or LM Studio is running.
- Verify the base URL in the provider card.
- Click **Refresh Models**, then run the provider health check.
- Ensure the selected route references a model reported by the local server.

### Command Center says the vault is uninitialized

Onboarding is optional: chat, workflows, and task execution work without it, falling back to a neutral default style guide. Only the daily-note and index operations (`morning`, `indexes`) require the interview-derived config. If you see an "uninitialized" error from one of those, run **Command Center: Start setup / onboarding interview** and complete confirmation/synthesis so both `.command-center/config.json` and `.command-center/style-guide.md` validate.

### A workflow does not run

Check that:

- The active file is Markdown or Canvas and contains workflow metadata.
- Step IDs are unique.
- Every dependency exists and the graph is acyclic.
- Required inputs are supplied.
- Provider/Pi routes are enabled and healthy.
- A Base file references a valid workflow path.

### A destructive tool is paused

Open the Command Center dashboard, inspect the Mutation approvals card's target list and diff preview, then choose **Approve & apply** or **Reject**. Closing the dashboard rejects pending confirmations safely.

### “All transcription providers failed … model does not exist”

STT model IDs are **per-provider**. The error `The model 'openai/gpt-4o-mini-transcribe' does not exist` means a slug meant for one provider (here, OpenRouter routing) was sent to another (e.g. xAI). Fix it in **Settings → Accessibility & Speech → Per-provider speech-to-text models**: set the slug each provider actually accepts, or leave the field blank to use that provider's built-in default (`grok-stt` for xAI, `whisper-1` for OpenAI, etc.). The global **Speech-to-text model** field is no longer broadcast to every provider — it only applies to providers that have no built-in default.

### “All transcription providers failed … no speech detected”

The provider processed the audio successfully but returned an empty transcript (near-silent input, background noise, or a Whisper silence-hallucination artifact that was stripped). Speak closer to the microphone, or switch the **Speech-to-text provider** to one with a higher-quality STT model. Recording shorter than 500 ms is treated as an accidental mic tap and never sent.

### Release assets and artifact attestations

Every published release asset (`main.js`, `styles.css`, `manifest.json`) carries a **Sigstore build-provenance attestation** generated by the automated Release workflow, so you can cryptographically verify that a file was built from this repository's source. Verify any downloaded asset with the GitHub CLI:

```bash
gh release download <tag> --repo scrunchds/Command-Center --pattern main.js --dir /tmp/cc
gh attestation verify /tmp/cc/main.js --repo scrunchds/Command-Center
```

A successful verification prints the attestation and exits `0`; a missing attestation returns `HTTP 404: Not Found … /attestations/sha256:…`. To tell a properly attested release from an unsigned one at a glance, check the release author: workflow-built releases are authored by `github-actions[bot]`, while a release authored by `scrunchds` was published manually and **will not carry attestations**. Releases must be published only by the automated `Release` workflow — if that workflow fails (for example, on a transient GitHub hosted-runner capacity error), re-run it until it is green rather than publishing manually, because a manual `gh release create` bypasses the `actions/attest` step entirely. The 1.9.0 release shipped without attestations for exactly this reason; 1.9.1 and later are cut through the workflow and are verifiable.

## Future implementation

The following features have infrastructure stubs and are ready for implementation when needed:

### Video generation (OpenRouter)

Command Center includes static URL builders for OpenRouter's video generation API:
- `POST /api/v1/videos` — submit a video generation request
- `GET /api/v1/videos/{id}` — poll generation status
- `GET /api/v1/videos/{id}/download` — download generated video
- Models are discovered dynamically through `/api/v1/models/user` when they become available
- Vault media ingestion stubs (video MIME types, `isVideoFile()`) are ready in `image-utils.ts`

### Image generation (OpenRouter)

Image generation models are registered in the OpenRouter provider (openai/gpt-5-image, google/gemini-3.1-flash-image, etc.) and the `getImageGenerationUrl()` helper returns `POST /api/v1/images/generations`.

### xAI Realtime API

xAI's realtime API (`GET /v1/realtime` WebSocket) supports voice-in/voice-out and function calling. The `XAIProvider` class (`src/providers/xai.ts`) implements chat completions plus native **STT** (`POST /v1/stt`) and **TTS** (`POST /v1/tts`, `GET /v1/tts/voices`). TTS is now wired into the spoken-output pipeline via `TtsAdapter` (see **Text-to-speech** above); the WebSocket realtime transport remains a future addition.

### OpenRouter Responses API

The newer `POST /api/v1/responses` format is a future migration target alongside the existing chat completions endpoint. Adopting it would enable streaming reasoning tokens, server-side tools (web search, code interpreter, MCP), and compaction; no Responses endpoint is wired up today.

## Community and support

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing changes or opening a pull request.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md) in all project spaces.
- Use [GitHub Discussions](https://github.com/scrunchds/Command-Center/discussions) for questions and community support; see [SUPPORT.md](SUPPORT.md).
- Report vulnerabilities privately according to [SECURITY.md](SECURITY.md)—never in a public issue.

## Donations and developer support

Command Center is free and MIT-licensed. If it improves your workflow and you would like to thank the developer, you can make an optional donation:

<p align="center">
  <a href="https://buymeacoffee.com/DustinS"><strong>☕ Buy Dustin a coffee</strong></a>
</p>

The same link is available as a branded Buy Me a Coffee button in the support card at the bottom of **Settings → Command Center**. Donations are optional, do not unlock features, and are not required for support or updates.

## License and attribution

Command Center is released under the [MIT License](LICENSE).

Third-party projects remain under their respective licenses. See [ATTRIBUTIONS.md](ATTRIBUTIONS.md) for the audited dependency inventory and distribution boundaries, including:

- [Obsidian API](https://github.com/obsidianmd/obsidian-api) — MIT; host API/types, not bundled as Obsidian itself
- [esbuild](https://github.com/evanw/esbuild) — MIT; build tooling
- [Pi coding agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) — MIT; optional external RPC companion
- TypeScript, ESLint, CodeMirror/Lezer, Node.js, Electron, and other development/host components

The lockfile audit found no GPL-family, SSPL, BUSL, or undeclared package licenses. Repository sanitization, credential-boundary checks, clean-room packaging, and provenance attestation are part of the publication workflow.

“Obsidian” is a trademark of Dynalist Inc. Command Center is an independent community plugin and is not endorsed by Dynalist Inc. or the Pi maintainers.
