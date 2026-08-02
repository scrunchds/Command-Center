# Command Center for Obsidian

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-1.13%2B-7C3AED?logo=obsidian)](https://obsidian.md/)
[![Node.js](https://img.shields.io/badge/Node.js-20%20%7C%2022%20%7C%2024-339933?logo=node.js&logoColor=white)](package.json)
[![Tests](https://img.shields.io/badge/tests-254%20passing-brightgreen)](#quality-security-and-release-controls)
[![Attestations](https://img.shields.io/badge/attestations-Sigstore-blue?logo=sigstore)](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds)
[![Desktop only](https://img.shields.io/badge/platform-desktop--only-informational)](manifest.json)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-Support%20development-FFDD00?logo=buymeacoffee&logoColor=000)](https://buymeacoffee.com/DustinS)

**Command Center is a personal operational OS for Obsidian — a local-first AI multi-agent orchestrator that transforms your vault into an intelligent workspace.** It combines interview-driven onboarding, a 12-provider model routing layer, a local Pi ReAct engine with Orchestrator–Worker loops, hybrid vault RAG (BM25 + semantic retrieval), persistent agent memory, native Markdown/Canvas workflows with Bases queue integration, voice input/dictation/live transcription, a daily operations engine, and headless automation — all without imposing a productivity framework on your notes.

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
- **Human control at mutation boundaries** — destructive and bulk changes pause on approval cards with collapsible, syntax-colored diff previews.

## Contents

- [Feature overview](#feature-overview)
- [Architecture](#architecture)
- [Installation](#installation)
- [First-run onboarding](#first-run-onboarding)
- [Configuration](#configuration)
- [Everyday usage](#everyday-usage)
- [Workflows and Bases](#workflows-and-bases)
- [Voice and automation](#voice-and-automation)
- [Privacy and security model](#privacy-and-security-model)
- [Development](#development)
- [Quality, security, and release controls](#quality-security-and-release-controls)
- [Community and support](#community-and-support)
- [License and attribution](#license-and-attribution)

## Feature overview

### Multi-Provider v2.0

Command Center exposes one dispatch layer across **12 providers**:

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
| Mistral AI | Cloud | Mistral and Codestral families |
| Cohere | Cloud | Command models for retrieval-heavy work |
| LM Studio | Local | Dynamic native model resolution, resource-aware JIT loading, OpenAI-compatible inference, and optional bearer authentication |
| Custom Endpoint | Local or remote | User-defined OpenAI-compatible service with optional bearer authentication |

Routing classifies work as `coding`, `vision`, `reading`, `reasoning`, or `fast`. Capability checks prevent invalid model selection; optional exponential moving averages optimize initial routes for **latency**, **cost**, or a **balanced** objective. Recovery remains reliability-first: authentication and invalid-request failures fail or fall through immediately, while rate limits, network errors, timeouts, and server errors use isolated circuit breakers, bounded backoff, and a configurable multi-tier fallback chain.

Additional provider capabilities include:

- Background model discovery with persistent catalogs and static-registry fallback
- Anthropic prompt caching and Gemini cached-content bookkeeping
- Multimodal image preprocessing for vault attachments and Canvas file nodes
- Structured-output repair only at model-authored JSON boundaries
- Local model pre-warm, TTL/keep-alive, and best-effort eviction
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

Built-in worker profiles cover orchestration, retrieval, summarization, and structural editing. Six reusable roles—Researcher, Analyst, Writer, Reviewer, Planner, and Fact-Checker—apply least-privilege tool policies. The runtime can create constrained custom roles for operational responsibilities such as **Triage**, **Indexer**, **Health**, or **System Architect** without granting tools outside the parent worker's ceiling.

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

### Normalized execution and Shadow-Clone diagnostics

Standard and Python-backed agent work crosses a mandatory execution boundary:

- `NativeAutoRouter` reads the shipped `model_matrix.json` and applies the global 1–10 quality/cost depth to text, image, audio, video, and embedding intents.
- Orchestrator, summarizer, editor, retrieval, and ReAct worker profiles declare an explicit modality before provider/model resolution.
- Python workers use isolated JSON-RPC 2.0 subprocesses over stdin/stdout with `shell: false`, bounded output, cancellation, timeouts, cleanup, and circuit breaking. Credentials are never placed in argv or environment variables.
- `DataNormalizer` is the trust boundary for provider responses, Python results, intermediate observations, and multi-agent merges. It sanitizes tracebacks, stderr, malformed JSON, control characters, and oversized output before UI or vault use.
- Locked or failed keyed routes retain local-first behavior through provider usability checks and circuit-breaker fallback.

Run **Command Center: Run Shadow-Clone Diagnostics** from the command palette to verify credential-memory wiping, current slider/matrix routing, fail-safe local routing, and Python-output sanitization. The harness uses in-memory fixtures and prints a sanitized report to the developer console; it does not modify user notes.

### Native chat and context

The right-sidebar chat supports **Quick**, **ReAct**, and **Workflow** modes with:

- Provider/model status and streamed Markdown responses
- Bounded multi-turn history
- Active editor selection, `@Note`, `@path`, and `.base` context
- Dismissible active/recent-note suggestion pills
- Inline collapsible ReAct traces
- Dashboard handoff for approval/rejection of destructive tools
- Tail-aware auto-scroll and lifecycle-safe cancellation

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

A confirmation/synthesis stage then previews 2–4 templates and 2–3 workflows. Nothing is generated until you explicitly select and approve it.

The interview writes validated assets under `.command-center/`, including:

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

Open **Settings → Command Center**. The settings UI is organized into six sections.

### 1. Core Configuration

Configure the active profile, token limits, Pi path, daemon startup, memory limits, Base batch concurrency, and Silent Daily Startup. Pi detection and status diagnostics are available here.

### 2. Accessibility & Speech

Configure text-to-speech enablement, speaking voice, speaking rate, speech-to-text enablement, transcription provider preferences, and automatic read-aloud behavior here. Chat and voice recording use the same speech settings.

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

## Everyday usage

### Dashboard

Open Command Center from the ribbon or command palette. The dashboard includes:

- Embedded Socratic discovery and onboarding
- Daemon Start / Stop / Restart controls
- Pending, running, completed, and failed queue counts
- Provider-normalized orchestrator output and per-task live output
- Task history, ReAct filters, debug stepping, and session export
- Dashboard-owned approval cards for destructive or bulk mutations
- Daily-cycle controls and consolidated silent-start summaries
- Per-vault widget ordering, sizing, collapse/visibility controls, and responsive layout persistence
- Review-before-send dictation plus opt-in audio cues, speech-to-text, and AI read-aloud

### Chat panel

Run **Command Center: Open Chat Panel** and choose:

- **Quick** for provider-routed conversational work
- **ReAct** for orchestrated multi-agent execution
- **Workflow** to run a Markdown, Canvas, or Base-backed workflow

Use `@Note Name`, `@folder/note.md`, an active editor selection, or a `.base` reference to attach vault context. Suggested recent/active notes appear as dismissible pills; only retained pills are sent.

### Local task

Open a Markdown note and run **Execute agent task on current note**. This command explicitly routes through the local Pi daemon and starts it automatically when possible.

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
- Live timer and level meter
- Deterministic microphone-track cleanup
- OpenAI-compatible multipart transcription
- Retry only for transient network/408/429/5xx failures
- Spoken `@` mentions and active-selection context resolution

Audio is sent only to the transcription endpoint configured in your local settings. Review that provider's privacy policy before use.

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

The URI and CLI boundaries reject credential arguments, unsafe vault paths, malformed/oversized JSON, and execution before onboarding is complete.

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
| `npm run test` | 103 core + 151 ReAct/workflow/UI/service tests |
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

## Quality, security, and release controls

The test suite currently contains **254 tests**:

- **44 core tests** — build integrity, parsers, byte-safe RPC framing, subprocess integration, task queue, recovery, and provider fallback
- **151 ReAct and subsystem tests** — roles, evaluation, traces, workflows, Bases, chat context, action cards, audio, JIT lifecycle, RAG, memory, CLI, locks, and stress scenarios

CI runs on Windows, macOS, and Linux across Node 20, 22, and 24 with:

1. Repository sanitization
2. Typecheck
3. Zero-warning lint
4. Full tests
5. Standardized benchmarks
6. 25% performance-regression gate
7. Production package validation
8. Clean release-surface verification

Release automation repeats the validation, builds a clean three-file plugin package, attests artifact provenance with **Sigstore attestations**, verifies each published asset cryptographically, and creates a GitHub release. The package metadata and manifest version are currently `1.1.18`, with Obsidian 1.13.0 as the minimum supported app version.

The local community-plugin validator currently passes with **0 errors**.

## Troubleshooting

### Pi cannot be found

Run:

```bash
pi --version
npm install -g @earendil-works/pi-coding-agent
```

Then use **Settings → Command Center → Core Configuration** to auto-detect Pi or select the executable path. Missing-binary errors fail fast rather than entering a retry loop.

### A local provider is unavailable

- Confirm Ollama or LM Studio is running.
- Verify the base URL in the provider card.
- Click **Refresh Models**, then run the provider health check.
- Ensure the selected route references a model reported by the local server.

### Command Center says the vault is uninitialized

Run **Command Center: Start Setup / Onboarding Interview** and complete confirmation/synthesis. Both `.command-center/config.json` and `.command-center/style-guide.md` must validate before operational services start.

### A workflow does not run

Check that:

- The active file is Markdown or Canvas and contains workflow metadata.
- Step IDs are unique.
- Every dependency exists and the graph is acyclic.
- Required inputs are supplied.
- Provider/Pi routes are enabled and healthy.
- A Base file references a valid workflow path.

### A destructive tool is paused

Open the Command Center dashboard, inspect the Mutation Approval card's target list and diff preview, then choose **Approve & Apply** or **Reject**. Closing the dashboard rejects pending confirmations safely.

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
