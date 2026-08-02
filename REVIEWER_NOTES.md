# Command Center — Community Plugin Review Notes

## Summary

Command Center is a local-first AI multi-agent orchestrator for Obsidian. Its core agent path runs the Pi ReAct engine as a local subprocess and coordinates task planning, tool use, workflows, retrieval, and note updates from inside the desktop application.

The permissions flagged by the validator are required for these documented desktop features. They are not used for telemetry, advertising, fingerprinting, or arbitrary background command execution. Where Obsidian provides an appropriate API, the plugin uses it: ordinary vault reads and mutations use the Vault and FileManager APIs, and non-streaming HTTP requests use Obsidian `requestUrl`.

## Architecture Overview

The plugin launches the user-installed Pi CLI in RPC mode and communicates with it over a serialized JSONL stdin/stdout channel. Pi supplies the isolated local execution boundary for the multi-agent ReAct loop; Command Center supplies the Obsidian UI, permission-constrained tools, approval gates, vault retrieval, workflows, and audit trail.

This local execution option allows users to keep orchestration and supported local-model inference on their own machine instead of requiring a hosted orchestration service. Direct desktop capabilities are therefore necessary to locate and launch the local runtime and to index user-selected vault content.

Command Center also supports optional remote model providers. Those connections occur only when a user explicitly enables and configures a provider and invokes a feature routed to it. Relevant prompt/context data must then be sent to that selected provider to fulfill the request; the plugin does not silently send vault data to an undisclosed service.

## Security Flag Justifications

- **`child_process` — local daemon execution**
  - Used strictly to locate, launch, monitor, and stop the user-installed Pi CLI as a local RPC daemon.
  - The daemon is started with fixed RPC arguments and the vault as its working directory. Communication occurs through piped stdin/stdout using JSONL framing.
  - Vault text and model output are not interpolated into shell command strings. Agent content cannot select an arbitrary command line.
  - The executable path is either explicitly configured or discovered from known npm/PATH locations and validated before launch.
  - `execSync` is limited to fixed executable-discovery commands such as `where pi`, `which pi`, and npm path discovery; it does not execute vault-authored or model-authored commands.
  - Process output, cancellation, failure handling, and intentional shutdown are managed by the plugin. The subprocess exists only to provide the documented local Pi/ReAct functionality.

- **Node.js `fs` — executable validation and explicitly referenced images**
  - Direct `fs` access has two narrow uses:
    1. checking candidate Pi/Node executable files during local daemon discovery and launch; and
    2. reading bytes for an image or Canvas attachment explicitly referenced in a multimodal task after resolving and validating its path and file type.
  - Normal note reads, writes, renames, frontmatter updates, indexes, memory, configuration, and caches use Obsidian's Vault/FileManager APIs rather than unrestricted filesystem calls.
  - The plugin does not use `fs` for general background crawling of the host filesystem, local-model directories, browser data, or unrelated user files, and it does not use direct `fs` writes for vault mutations.

- **`os` / system identity category — environment and path resolution only**
  - The reviewed behavior concerns platform and environment-directory information such as `process.platform`, `PATH`, `APPDATA`, `LOCALAPPDATA`, and `HOME`. These values are needed to locate npm-installed Pi and Node executables across Windows, macOS, and Linux.
  - This information is used locally for compatibility and path resolution only.
  - Hostname, username, hardware identifiers, or environment paths are not collected to identify a user, are not used to build a fingerprint, and are not transmitted as telemetry.

- **Full vault enumeration — hybrid RAG, indexing, and vault workflows**
  - The plugin enumerates vault files through Obsidian APIs to implement its core vault-aware features: hybrid BM25/embedding retrieval, note and attachment resolution, stationary folder indexes, Base queues, memory retrieval, workflow targeting, and change tracking.
  - Enumeration does not mean every note is sent to a model. Retrieval builds a local index and selects bounded, relevant context. Folder scopes and task context further restrict candidate content where configured.
  - Incremental indexing keys entries by path, modification time, and size so unchanged notes are not repeatedly read or embedded.
  - Remote disclosure occurs only when the user invokes a model-backed operation and has selected/configured a remote provider; only the context assembled for that request is submitted. Local-provider routes can keep model inference local.

- **Clipboard access — explicit credential copy action only**
  - Clipboard access is write-only and occurs only after the user clicks the visible **Copy Key** button on a configured provider credential card.
  - The plugin does not read the system clipboard, monitor clipboard changes, or expose clipboard contents to agents or workflows.
  - Agents cannot independently invoke clipboard operations. No background clipboard access occurs.

## Opt-In, Network, and Telemetry Assurance

- Command Center contains no analytics, advertising, tracking SDK, or telemetry pipeline.
- No vault content, prompts, credentials, hostname/environment identity, clipboard data, or daemon output is sent to the plugin author or to an unauthorized third party.
- The local Pi subprocess is launched solely for the documented agent features and is stopped and cleaned up through the plugin lifecycle.
- Provider credentials and custom endpoints are configured by the user. Network requests are made only to the provider or endpoint required by the feature the user invokes, including explicit health checks and model-catalog refreshes.
- A remote AI request necessarily sends its assembled prompt and bounded context to the provider selected by the user. Users who require local-only processing can configure local Pi/model routes instead of cloud providers.
- Destructive or bulk agent actions are constrained by tool policies, normalized vault paths, file-level locks, timeouts, and explicit approval UI where required.

## Reviewer-Focused Safeguards

- Local daemon arguments are fixed; model/vault content is not evaluated as shell syntax.
- Agent prompts are serialized over RPC rather than passed on a command line.
- Ordinary vault access remains on Obsidian APIs.
- Direct filesystem reads are narrow, validated, and feature-driven.
- Vault retrieval applies bounded context budgets and least-privilege agent tool policies.
- Clipboard behavior is user-initiated and write-only.
- Non-streaming provider and catalog calls use Obsidian `requestUrl`. The remaining direct `fetch` path is limited to completion streaming because token-by-token SSE handling requires a `ReadableStream` response body.
- Runtime memory, generated configuration, and audit data remain in the vault's documented Command Center locations and are excluded from published repository artifacts.

## Requested Review Consideration

These capabilities are broader than those of a conventional note-formatting plugin, but they are intrinsic to a local-first desktop agent orchestrator. Removing subprocess management would remove the local Pi execution architecture; removing vault enumeration would prevent retrieval and vault-wide workflow features; and removing the narrow filesystem/environment checks would make reliable local-runtime and multimodal support impractical across supported desktop platforms.

We respectfully request manual review of these permissions in the context of the bounded uses and safeguards described above.

## Obsidian documentation baseline

When changing the plugin, follow the official Obsidian documentation for:

- plugin lifecycle (`onload` / `onunload`)
- Vault, FileManager, and MetadataCache usage
- Workspace / WorkspaceLeaf / view management
- Commands, modals, ribbon actions, status bar, and settings UI
- event registration and disposal
- submission requirements and plugin guidelines
- mobile constraints, even for desktop-only code paths when relevant

Prefer Obsidian-native APIs and workspace/leaf management over custom substitutes whenever the official platform provides the capability.
