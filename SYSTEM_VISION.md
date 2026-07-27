# SYSTEM_VISION.md — Command-Center

> **Purpose:** This document is the permanent architectural roadmap and guardrail for the upgrade of the existing **Command-Center** Obsidian plugin into a metacognitive, multi-agent operating system. Every future coding session must consult this file before executing changes. It does not replace the existing `README.md`; it supersedes it as the authoritative forward-looking contract.

---

## 0. Provenance & Inheritance

Command-Center is not a rewrite from zero. It is a directed upgrade of the existing Command-Center codebase, which already provides:

- A **12-provider dispatch layer** (`ModelRouter`, `ProviderDispatcher`, `ProviderFactory`) with capability gating, enabled-toggle dispatch, auto-reach fallback, and provider-isolated circuit breakers.
- A **multi-agent ReAct engine** (`PiAgentDaemon`) with an Orchestrator → Worker → Observation → Correction loop, six roles, runtime custom personas, parallel worker planning over serialized Pi 0.82 RPC, four-dimension evaluation, cooperative debug stepping, and full-fidelity session audit export.
- A **hybrid vault RAG** layer (`HybridRetriever`, `EmbeddingAdapter`, `MarkdownChunker`) with BM25 + cosine weighted RRF, path+mtime+size incremental indexing, folder scopes, and hard prompt budgets.
- A **persistent memory** layer (`AgentMemoryStore`, `ReActMemoryBank`) with facts/preferences/entities, session summaries, deterministic topic hubs, and threshold-aware pruning.
- An **interview-driven configuration** system (`InterviewEngine`, `ConfigManager`, `TemplateGenerator`, `WorkflowGenerator`) that learns existing vault structure instead of imposing one.
- **Stationary folder indexing** (`FolderIndexer`, protected `_index.md` manifests) for token-efficient routing without full-vault scans.
- **Native workflows** (`WorkflowEngine`, Markdown + Canvas parsers, Bases-queue batches) with safe runtime conditions, topological tiers, and real-time agent-state frontmatter sync.
- A **native right-sidebar chat** (`CommandCenterChatView`) with Quick/ReAct/Workflow modes, context resolution, diff action cards, and lifecycle isolation.
- **Voice input** (`AudioRecorder`, `TranscriberAdapter`) with browser-native capture, multipart STT, and cancellation-safe media cleanup.
- **Headless automation** (`CommandCenterCommandBridge`) via native Obsidian CLI + `obsidian://` URI with structured JSON and shared per-App vault locks.
- A **raw-byte JSONL RPC transport** that preserves split UTF-8, CRLF, U+2028/U+2029, bursts, and unterminated final frames across arbitrary stream chunks.

These capabilities are the foundation. The upgrade reshapes their interaction model and adds the metacognitive, graph-aware, and shadow-clone layers described below. No existing passing behavior should regress during the upgrade; the 194-test suite and benchmark gate remain the safety net.

---

## 1. The Core Directives

These directives are non-negotiable constraints. Any code change that violates them is out of scope and must be rejected.

### 1.1 Conversational "Observation-Impact-Proposal" Framework

All agent-initiated communication with the user — whether rendered in the chat panel, the dashboard, a daily proposal, an inbox triage suggestion, a workflow input prompt, or a headless JSON log — must follow the **Observation → Impact → Proposal** shape:

1. **Observation** — a neutral statement of what the agent found or measured, grounded in vault content, memory, metrics, or tool output. No interpretation here.
2. **Impact** — a bounded statement of the consequence or urgency: what changes for the user or the vault if this is acted on or ignored. Explicitly tagged with severity (informational / capacity / at-risk / destructive).
3. **Proposal** — a concrete, reviewable action or set of mutually-exclusive options. Proposals that mutate vault files must route through the existing approval-card boundary with a collapsible, syntax-colored diff preview. No proposal is auto-applied unless the user has explicitly enabled an auto-approve scope, and even then destructive/bulk writes remain approval-gated.

This framework replaces ad-hoc prose responses. Existing chat modes (Quick / ReAct / Workflow) and daily-cycle prompts are refactored to emit OIP envelopes; headless JSON logs carry the same three fields. The framework is enforced at the response-rendering boundary, not by prompting alone, so malformed model output is normalized before reaching the user.

### 1.2 Topography Sweep — Never Force a Rigid Hierarchy

On any new or newly-onboarded vault, the system must run a **Topography Sweep** before proposing any structural change. The sweep:

- Walks the vault graph through Obsidian APIs (no raw `fs` for ordinary note reads), respecting `.obsidian` and `.trash` exclusions.
- Records existing folder structure, note density, link topology, tag distribution, and frontmatter field prevalence — without judging them.
- Identifies candidate inboxes, daily-note locations, managed folders, and stationary index targets by **observation**, never by assumption.
- Feeds the **Logic Discovery Loop** (Phase 2) so the interview and any generated templates/workflows conform to structures the user already maintains.

The system must **never** require PARA, GTD, Johnny.Decimal, Zettelkasten, a numbered folder taxonomy, a fixed note schema, or any other external methodology. If the user has no discernible structure, the system proposes — it does not impose. Existing protected `_index.md` manifests remain additive descriptions of what is there, not prescriptions of what should be there.

### 1.3 Data Normalizer Middleware

All external tool data — Pi RPC tool results, Python worker output, provider model completions, transcription responses, embedding payloads, and any future external integration — must route through a single **Data Normalizer** middleware layer before it is allowed to touch a markdown file, the memory store, the trace collector, or any frontmatter field. The Normalizer:

- Validates and coerces structured payloads against typed schemas before they reach vault-mutating tools.
- Strips or quarantines unstructured error text, stack traces, leaked credentials, and non-markdown-safe byte sequences so they cannot pollute note content.
- Converts free-text tool output into the OIP framework shape before rendering.
- Enforces the existing hard prompt budgets and bounded context caps at the ingestion boundary, not downstream.
- Never silently swallows transport corruption: wire-protocol frames (SSE/JSONL/RPC) continue to use strict `JSON.parse` semantics; only model-authored structured output and tool result bodies pass through repair.

The Normalizer is the single chokepoint between "the outside" and "the vault." No code path may write vault content from raw external data without transiting it.

### 1.4 Air-Gapped Credential Collection

API keys and all sensitive credentials (provider keys, base URLs containing tokens, transcription endpoints, custom endpoint secrets) must be collected **only** through native Obsidian UI modals and the existing password-masked provider settings cards. Specifically:

- Credentials are **never** accepted via chat input, interview prompts, workflow inputs, CLI arguments, URI parameters, generated config templates, or example files.
- The existing local rejection of secret-like input during onboarding is retained and extended to the Topography Sweep and any new interview phase.
- Credentials remain resolved lazily at request time from plugin settings; they do not persist in memory, memory notes, audit exports, traces, or logs.
- The repository sanitizer continues to fail on detected secrets, private keys, absolute local paths, private IPs, and tracked runtime state.

This directive is the security spine of the system and admits no exceptions for convenience.

### 1.5 Native Auto-Router & Preserved Fallback

The system must preserve the user's existing selectable fallback hierarchy (Local → Cloud) exactly as it exists in the current `ProviderDispatcher` / `ModelRouter` dispatch path, including the enabled-toggle gating, auto-reach safety nets, provider-isolated circuit breakers, and reliability-first backoff. This foundational logic must **not** be overwritten by the upgrade. What is added is a native decision-making matrix that operates *within* that preserved hierarchy:

- The plugin operates completely autonomously. It must **never** delegate execution decisions to a third-party cloud router (such as OpenRouter's auto-routing, or any upstream model-chooser endpoint). Cloud gateways may be used only as dumb model endpoints, never as decision-makers.
- The native auto-router combines the `task_type` flag (Directive 1.7) with the 1–10 Quality-Cost slider value (Directive 1.6) and the `model_matrix.json` mapping (Directive 1.8) to select a concrete model, then hands that selection to the existing dispatch layer.
- If configured APIs are unreachable — transient or permanent — the system must seamlessly drop to its local-only safety net (Pi daemon, Ollama, LM Studio, custom local endpoint) without surfacing the failure as a hard error to the user, exactly as the current `listUsable()` keyless-local-first ordering guarantees.
- Cost/latency optimization never weakens recovery: once a request fails, the slider's influence is suspended and the existing reliability-ranked fallback takes over, as today.

### 1.6 The 1-10 Quality-Cost Slider

The Settings UI will feature a global **Quality-Cost slider** strictly limited to a **1 to 10** integer scale. The bound is deliberate:

- It prevents mathematical bloat and tuning-parameter proliferation that plagues continuous or multi-axis cost functions.
- It maps cleanly to discrete model capability tiers so the native auto-router can resolve a concrete model per modality without floating-point comparison.
- 1 denotes cheapest/fastest acceptable tier; 10 denotes highest-capability tier available across the user's configured providers for that modality. The slider does not itself select a model — it selects a *tier*, which `model_matrix.json` resolves to a model.
- The slider is a single global default that may be overridden per-workflow and per-task payload; no per-modality secondary sliders are introduced, to preserve the bounded UI surface.

### 1.7 Strict Taxonomy Flagging

Workflows and agents must pass a `task_type` intent flag with their payloads. This flag **MUST** strictly be one of the eight established OpenRouter modalities, and no other value is accepted:

1. `Text`
2. `Image`
3. `Embeddings`
4. `Audio`
5. `Video`
6. `Re-Rank`
7. `Speech`
8. `Transcription`

The system determines the complexity of the task (e.g., heavy reasoning vs. basic text formatting) purely by combining this strict category flag with the 1–10 Quality-Cost slider value. There is no separate free-text "complexity" field, no second taxonomy, and no ad-hoc heuristic dimension. Unknown or missing flags are rejected at the Data Normalizer boundary (Directive 1.3) and returned as an actionable OIP observation rather than silently defaulted. The existing `TaskType` classification (`coding` / `vision` / `reading` / `reasoning` / `fast`) is retained as an internal routing hint only; it does not replace the strict modality flag on outbound payloads.

### 1.8 The Local Configuration Matrix (model_matrix.json)

The 1–10 tier mapping for specific models must **not** be hardcoded into the TypeScript source. The plugin must read from a local `model_matrix.json` file located in the plugin root directory. This file:

- Categorizes the user's preferred models by the eight modalities from Directive 1.7.
- Assigns each model a 1–10 rating per modality, so the auto-router can resolve `(task_type, slider_value) → concrete_model_id` at request time.
- Is editable by the user without recompiling the codebase, allowing dynamic routing-preference updates.
- Is validated against a strict schema at load time; a missing, malformed, or schema-violating matrix must fail closed to the existing static registry and route through the preserved fallback hierarchy rather than silently mis-routing.
- Is itself subject to Directive 1.4: it contains model IDs and tier numbers only, never API keys, base URLs with tokens, or any other credential. The repository sanitizer treats any secret-like content in this file as a failure.

A model_matrix.json change is a hot configuration update: the plugin reloads the matrix and re-resolves routes without an Obsidian restart, mirroring the existing lazy-credential-resolution discipline.

---

## 2. The Iterative Roadmap

Each phase is a deliverable boundary. A phase is complete only when the existing 194-test suite passes, the benchmark gate stays green, typecheck and zero-warning lint are clean, the repository sanitizer is clean, and the phase's own new tests pass. No phase may regress an earlier phase.

### Phase 1 — Security & Core Setup

- Audit and harden the existing credential path against Directive 1.4; confirm no chat/interview/CLI/URI/workflow path can accept a secret.
- Scaffold the **Svelte Triptych** UI shell: a three-pane layout (Left: topography/context, Center: OIP conversation, Right: proposal/audit) replacing the single dashboard + chat split without losing existing monitor, replay, and export capabilities.
- Introduce the OIP envelope type and the response-rendering normalizer that enforces Directive 1.1 at the boundary.
- Establish the Data Normalizer middleware interface (Directive 1.3) as an empty contract wired into all existing tool-result and provider-response ingestion paths; behavior is filled in later phases.
- Keep Pi 0.82 RPC, raw-byte framing, and serialized transport intact.

### Phase 2 — Vault Ingestion Protocol

- Implement the **Topography Sweep** (Directive 1.2) as a bounded, cancelable, progress-reporting operation that writes a private topology artifact under `.command-center/` (never into user-visible notes without approval).
- Run the **Logic Discovery Loop**: iterate between sweep observations and the existing interview engine so topology findings refine the questions, and answers refine candidate inboxes, daily locations, managed folders, and stationary index targets.
- Refactor `FolderIndexer` so `_index.md` manifests are derived from sweep output and remain descriptive, never prescriptive.
- Extend the Data Normalizer to validate topology artifacts and protect them from malformed external input.

### Phase 3 — The Metacognitive Brain

- Add a **graph-aware SQLite-VSS** semantic index layered over the existing `HybridRetriever`: vault links, folder topology, tag graphs, and citation edges become first-class vectors alongside chunk embeddings.
- Re-chunk markdown into graph-aware semantic units that carry H1/H2 hierarchy, normalized wikilinks, and inclusive line metadata (inheriting the current chunker's boundaries), plus outbound/inbound link and backlink context.
- Implement metacognitive self-evaluation: the existing four-dimension scorer is augmented with a graph-grounded relevance signal so the orchestrator can detect when an answer ignores a strongly-linked neighborhood.
- Persist the index locally in a `.command-center/` database; keep the existing path+mtime+size incremental invalidation so unchanged notes are never re-indexed.
- Route retrieval results through the Data Normalizer before they enter prompts.

### Phase 4 — Execution Router

- Integrate existing Python workers (and any future local compute workers) behind the **Execution Router**, which selects among Pi RPC, provider dispatch, and Python workers based on task type, capability, locality, and the existing reliability-first fallback policy.
- Wire all worker output through the Data Normalizer (Directive 1.3) so Python stdout/stderr, exception text, and partial results cannot pollute notes or memory.
- Extend the OIP framework so router decisions are observable: the user sees which executor was chosen and why, with the existing trace collector capturing router events as first-class audit entries.
- Preserve provider-isolated circuit breakers, enabled-toggle gating, and auto-reach safety nets; the router is a selector over executors, not a replacement for the dispatch layer.

### Phase 5 — Shadow-Clone Testing Environment

- Stand up a **Shadow-Clone** environment: an isolated copy of the vault's structure (not necessarily full content) where proposals execute against a quarantined mirror before touching the real vault.
- Every destructive or bulk proposal runs in shadow first; the OIP card surfaces a side-by-side of shadow impact vs. intended impact, and the user approves the real mutation only after reviewing the shadow result.
- The shadow environment reuses the shared per-App lock registry so shadow and real writes never race.
- Teardown is deterministic and cancellation-safe, mirroring the existing lifecycle-isolation discipline (no orphaned promises, no leaked file handles, no retained view references).

---

## 3. Invariants Preserved Across All Phases

- Obsidian-native I/O for ordinary note, config, memory, workflow, and index operations; raw `fs` remains limited to the explicitly documented exceptions (Pi child process launch, image attachment reads).
- Serialized Pi 0.82 RPC transport with raw-byte JSONL framing.
- Shared normalized per-vault FIFO lock namespace for all mutation paths.
- Bounded UI work via `requestAnimationFrame`; bounded trace history and visible rows.
- Local-first options (Pi, Ollama, LM Studio, custom endpoints) remain first-class; local-only setups must keep working without manual routing configuration.
- No client-side telemetry, no self-update, no bundled advertising.
- The shipped plugin package remains exactly `main.js`, `manifest.json`, `styles.css`.

---

PRIME DIRECTIVE FOR AI WORKER: For all future coding sessions, the user will provide small, granular prompts. Before executing any code, I must verify that the requested changes align with the constraints and roadmap outlined in this document.
