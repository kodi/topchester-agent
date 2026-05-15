# Architecture

Status: Draft

## Product Direction

Topchester is a specific terminal-native TUI coding agent.

It should feel familiar to users of `opencode`, `codex`, and `claude` CLI: install a command, move into a project directory, type the command, chat with a coding agent, inspect tool output, review diffs, and continue working in the terminal.

The differentiator is not the chat UI. The differentiator is that Topchester is bundled with, and tightly coupled to, a repository knowledge base.

Topchester should not behave like a generic chatbot dropped into a repo. A real coding session starts by compiling project knowledge, then the agent uses that knowledge as its semantic backend for answering, planning, editing, drift detection, and post-task updates.

## Core Product Invariant

Agent and KB are one system.

The KB is not optional memory, a side index, or a nice-to-have search database. It is part of the agent runtime contract.

In normal coding-agent mode:

- Topchester must know which workspace it is operating in.
- Topchester must know whether that workspace has a current canonical KB directory.
- Topchester must check KB drift before relying on project knowledge.
- Topchester must retrieve context from the KB during reasoning and implementation.
- Topchester must write KB updates back after meaningful source changes.
- Topchester should warn clearly when the KB is stale, even though V0 starts in non-strict warning mode.

If no KB exists for a code project, Topchester should compile one before entering the normal coding loop. If the current directory does not look like a code project, Topchester should warn the user instead of silently starting a generic chat session.

## Runtime Decision

Topchester V0 should be a TypeScript/Node.js CLI application.

Rationale:

- The first target repositories are TypeScript/JavaScript projects.
- The chosen TUI foundation, `@earendil-works/pi-tui`, is a TypeScript package for Node.js.
- Pi's coding-agent packages are TypeScript/Node packages with Node engine constraints.
- npm gives the expected install path for users who already install terminal coding agents globally.
- The current local environment has Node and npm available.

Local verification on this machine:

- `node`: v24.10.0
- `npm`: 11.6.1
- `npx`: 11.6.1
- `pnpm`: 9.12.1

OpenCode comparison:

- OpenCode is distributed through an npm-style CLI command.
- Its current source tree is TypeScript-oriented and uses Bun for development/building.
- Its published CLI bin is a Node shim (`#!/usr/bin/env node`) that resolves and launches a platform-specific native `opencode` binary.
- Therefore, the useful lesson is the installation and command shape: an npm-installable CLI with optional platform-specific binaries later.
- Topchester V0 should start simpler: Node/TypeScript runtime, npm package, `topchester` bin. If startup/performance/packaging later require it, we can add OpenCode-style platform binary packages.

## Install and Invocation Workflow

Target user workflow:

```text
# install
curl -fsSL https://topchester.com/install | sh
# or
npm install -g topchester

# use
cd /path/to/project
topchester
```

The default `topchester` command should be the interactive TUI coding agent.

Additional CLI commands should exist for explicit KB workflows:

```text
topchester kb compile     # full Knowledge Compiler pipeline
topchester kb scan        # deterministic inventory scan only
topchester kb status      # drift and freshness status
topchester kb explain     # explain what the KB knows about the project
```

The interactive TUI may expose the same KB compile flow as a wizard, especially on first project open.

## First-Run Project Flow

When the user runs `topchester` in a directory, startup should follow this shape:

1. Resolve workspace root.
   - Prefer Git root if present.
   - Otherwise use the current directory.
   - V0 may also detect package/workspace roots from `package.json`, lockfiles, and `tsconfig.json`.

2. Detect whether this is probably a code project.
   - Positive signals: `.git/`, `package.json`, `tsconfig.json`, source directories, lockfiles, test configs, framework configs.
   - Weak or negative signals: only personal documents, images, random files, no source/config metadata.

3. If the directory does not look like a code project, warn.
   - Example: `This does not look like a code project. Did you mean to run Topchester from another directory?`
   - The user may choose another directory, continue in limited mode, or exit.

4. If this is a new project and the canonical KB directory is missing, start the Knowledge Compiler.
   - Show progress in the TUI.
   - Write canonical committed KB files to `topchester-kb/` by default.
   - Write generated caches/indexes to `.agents/topchester-kb-cache/`.
   - Allow `TOPCHESTER_KB_DIR` to point at a non-default committed KB directory inside the workspace.
   - Use a wizard only for decisions that cannot be inferred safely.

5. After compile, enter normal agent mode.
   - The KB should become mostly invisible to the user.
   - The user interacts as with `opencode`, `codex`, or `claude` CLI.
   - Under the hood, every reasoning loop has KB access and drift awareness.

6. After implementation tasks, refresh the KB.
   - At minimum, refresh changed L1 file entries and mark related L2/L3 entries stale or updated.
   - Prefer incremental Knowledge Compiler runs where possible.
   - If the update is ambiguous or high-risk, surface a warning or review prompt.

## TUI Foundation

We will use the TUI package from the `earendil-works/pi` repository:

- Source: https://github.com/earendil-works/pi/tree/main/packages/tui
- Package: `@earendil-works/pi-tui`

This is the chosen foundation for the terminal UI layer unless explicitly replaced later.

Important observed properties:

- It is a TypeScript/Node package.
- It exposes component-style terminal UI primitives.
- It supports differential rendering, synchronized output, input/editor components, markdown rendering, overlays, selection lists, images, and terminal process handling.

## Pi Agent Strategy

Topchester should be Pi-inspired, but should not start as a fork of Pi's coding agent.

Recommended V0 approach:

1. Use `@earendil-works/pi-tui` for the TUI shell.
2. Build Topchester's own runtime boundaries around the mandatory KB contract.
3. Study Pi's coding-agent architecture for useful patterns: sessions, tools, prompts, auth, state, streaming, and terminal interaction.
4. Only embed or reuse `@earendil-works/pi-coding-agent` if we can enforce KB-first behavior cleanly at the runtime boundary.
5. Avoid modifying Pi internals unless a later spike proves that embedding/reuse is insufficient.

Why not fork or directly modify Pi first:

- The product invariant is different: Topchester's agent loop is inseparable from the KB.
- A fork creates upstream drift and maintenance risk.
- Deep modifications may make it harder to keep the architecture small and explicit.
- The Knowledge Compiler, KB service, drift model, and write-back loop need to be first-class runtime concepts, not bolted onto a generic agent as afterthoughts.

## OpenClaw / Pi Integration Research

OpenClaw provides a useful precedent for how to integrate Pi without forking it.

Observed from OpenClaw documentation/source:

- OpenClaw depends on Pi packages (`pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`).
- It embeds Pi through the SDK instead of spawning the `pi` CLI as a subprocess.
- Its documented integration imports `createAgentSession`, `DefaultResourceLoader`, `SessionManager`, and `SettingsManager` from `pi-coding-agent`.
- It creates an `AgentSession` programmatically, injects built-in/custom tools, overrides system prompt/context, subscribes to session events, and handles streaming/tool lifecycle callbacks itself.
- It also uses `pi-tui` directly for a local TUI mode.

Implication for Topchester:

- If we reuse Pi beyond the TUI, the safer model is OpenClaw-style SDK embedding, not subprocess wrapping and not a hard fork.
- The embedding seam must let Topchester inject KB context before model calls, route tool decisions through KB-aware policy, and update KB state after edits.
- If that seam is not strong enough, Topchester should keep its own agent runtime while still using `pi-tui`.

## High-Level Architecture

Topchester should be organized around these responsibilities:

1. CLI entrypoint
   - Owns `topchester`, `topchester kb compile`, `topchester kb scan`, and related commands.
   - Handles install-time/runtime checks, config discovery, workspace root resolution, and command dispatch.

2. TUI shell
   - Owns rendering, keyboard input, navigation, layout, overlays, status bars, and terminal interaction.
   - Built on `@earendil-works/pi-tui`.
   - Should not own the agent loop or KB semantics.

3. Workspace detector
   - Identifies the project root and project type.
   - Warns if the user appears to be in a non-code directory.
   - Finds the canonical KB directory and `.agents/topchester-kb-cache/`.
   - Computes initial project metadata for the Knowledge Compiler.

4. Knowledge Compiler
   - Compiles a repository into the canonical KB.
   - Includes inventory scanning, structural TypeScript/JavaScript intelligence, L1 file entries, L2 module discovery, L3 feature discovery, graph building, validation, and drift reporting.
   - Exposes explicit compile/scan/status operations to the CLI and TUI.

5. KB service
   - Serves the compiled KB to the agent runtime.
   - Core API is local HTTP JSON-RPC 2.0.
   - MCP is an adapter layer on top of the same service, not the internal source of truth.
   - Provides methods such as `kb.search`, `kb.getNode`, `kb.neighbors`, `kb.contextPack`, `kb.driftCheck`, and `kb.impact`.
   - Returns provenance and drift metadata so the runtime knows whether facts came from canonical KB, session overlay, live files, or mixed evidence.

6. Agent runtime
   - Owns the coding-agent loop: receive user intent, retrieve KB context, plan, call tools, observe results, update state, and produce user-visible responses.
   - Must be KB-aware by construction.
   - Should not have a normal coding path that bypasses the KB.
   - Uses the KB to orient, plan, estimate impact, and choose verification, while resolving task-critical facts against the current working tree.
   - May be implemented as Topchester-owned runtime, or later as a Pi SDK embedding if a spike proves the KB contract can be enforced cleanly.

7. Tool execution layer
   - Owns filesystem, shell, git, search, edit, test, package-manager, and future MCP/tool operations.
   - Exposes a narrow, auditable interface to the agent runtime.
   - Emits enough structured facts for the KB update loop.

8. Session and persistence layer
   - Stores sessions, user config, model/provider config, command history, task state, and local runtime state.
   - Tracks the KB session overlay for dirty-but-known work in progress.
   - Keeps canonical KB state in the committed KB directory and generated cache/index state in `.agents/topchester-kb-cache/`.
   - Keeps transient UI state separate from workspace/agent/KB state.

## Runtime Client Boundary

Topchester should not let the TUI grow into the agent engine.

The core runtime should expose a small command/event boundary:

```text
client command
  -> runtime command handler
  -> KB-aware agent loop
  -> typed runtime event stream
  -> TUI, CLI, GUI, IDE, or session log consumer
```

For chat turns, `submitMessageStream(...)` is the primary in-process contract:
clients consume an `AsyncIterable` of runtime events as the model and tools
progress. `submitMessage(...)` remains as a compatibility collector for callers
that still need the completed event array or the older callback shape.

Initial command types:

- submit a user message,
- run a slash command,
- check agent/model readiness,
- check KB status,
- cancel the active turn.

Initial event types:

- status changed,
- system or assistant message,
- tool call started,
- tool result received,
- KB status observed,
- user choice requested,
- turn finished or failed.

This is enough structure to keep rendering code out of the runtime and runtime policy out of rendering code. Stream consumers should persist or render events as they arrive; they should not own the agent loop.

Do not add a big global event bus in V0. A global bus can make small apps feel clean at first, but it hides ownership when every module can publish anything. Start with typed runtime events and explicit subscribers. The session event log should be the durable event stream; the in-process event path should stay narrow and boring.

If plugins, background jobs, or multiple clients need fan-out later, add a scoped event hub around the runtime/session boundary. Keep events named, versioned, and tied to the session log shape.

## Future GUI / IDE Path

The TUI should be only one client of the same KB-aware runtime.

Short term:

- TUI calls the runtime in-process.
- Runtime emits typed events.
- TUI maps those events to chat rows, modals, spinners, and status lines.
- Sessions append the same important events to `.agents/topchester/sessions/<session-id>/events.jsonl`.

Future local GUI:

- Run the same runtime behind a local app server.
- Prefer JSON-RPC 2.0 for command/response calls because the KB service already uses JSON-RPC.
- Use server-sent events, WebSocket notifications, or JSONL over stdio for streamed runtime events.
- Keep transport details outside the agent loop.

Future VS Code / IDE extension:

- Start by launching or connecting to a local Topchester runtime server for the workspace.
- Send editor context as explicit inputs: selected text, open file paths, file references, and requested approval mode.
- Render runtime events as IDE UI: chat, inline diffs, approvals, status, and KB warnings.
- Never let the extension bypass the project KB checks. It is a client, not a second engine.

The rough shape should be:

```text
TUI / GUI / IDE
  -> Topchester runtime API
  -> KB service + agent loop + tool layer
  -> runtime events
  -> session event log + active client
```

## Runtime Loop Sketch

A normal Topchester task should roughly follow this loop:

```text
user request
  -> TUI submits request to agent runtime
  -> runtime checks workspace and KB status
  -> runtime asks KB service for relevant context pack
  -> runtime runs scoped drift check for relevant files/modules/features
  -> runtime plans with KB graph, session overlay, and live files
  -> runtime chooses tool calls
  -> tool layer executes file/shell/git actions
  -> runtime observes results and diffs and updates session overlay
  -> runtime asks KB service / Knowledge Compiler for impact and drift
  -> runtime refreshes or marks affected KB nodes
  -> runtime responds with result, diffs, tests, and any KB warnings
```

The agent can still use direct file reads, search, and tests. The constraint is that those actions are coordinated with the KB, not independent of it. The KB chooses and explains context; the current working tree remains the authority for exact task-critical behavior.

## Initial Design Principles

- Terminal-first: the core experience should feel native in a terminal, not like a web app squeezed into a terminal.
- Specific over generic: avoid broad assistant features until the coding-agent workflow requires them.
- KB-first: compiled project knowledge is a runtime dependency for serious coding tasks.
- Invisible when healthy: after first compile, the KB should mostly disappear into the agent's normal workflow.
- Visible when stale: drift, missing KB entries, or low-confidence project understanding should be surfaced clearly.
- Clear separation of concerns: UI, runtime, tools, workspace detection, and KB service should be independently testable.
- Auditable actions: commands, file edits, git operations, and KB updates should be visible and reviewable.
- Fast feedback loops: the interface should make it easy to inspect plans, diffs, test output, agent decisions, and KB warnings.
- Plaintext canonical state: project knowledge belongs in committed files under `topchester-kb/` by default, not only in an opaque local database.

## Current Architecture Choices

Resolved for V0:

- Runtime: TypeScript/Node.js CLI.
- Command: `topchester` for the interactive agent.
- Install shape: curl installer and npm global package.
- TUI foundation: `@earendil-works/pi-tui`.
- Agent strategy: Pi-inspired, not Pi fork first.
- Possible Pi reuse: prefer OpenClaw-style SDK embedding if it can enforce KB-first semantics.
- Canonical KB path: `topchester-kb/` by default, overrideable with `TOPCHESTER_KB_DIR`.
- Generated cache path: `.agents/topchester-kb-cache/`.
- KB API: local HTTP JSON-RPC core with MCP adapter on top.
- Knowledge Compiler CLI: `topchester kb compile` and `topchester kb scan`.
- Drift posture: warning-first / non-strict mode initially.

## Open Questions

- Can Pi's `createAgentSession()` embedding seam enforce Topchester's KB-first runtime contract cleanly?
- Should V0 implement a Topchester-owned agent loop immediately, or run a short spike comparing own-runtime vs Pi SDK embedding?
- What exact state directory should Topchester use for user/session config outside project KB files?
- How much of OpenCode's platform-binary distribution model should be copied later?
- What should limited mode allow when the user opens a non-code directory?
- What exact prompts/status copy should the first-run KB wizard use?

## Near-Term Next Steps

1. Create a minimal TypeScript/Node CLI skeleton with a `topchester` bin.
2. Add workspace detection and a first-run project classification warning.
3. Add a minimal TUI shell using `@earendil-works/pi-tui`.
4. Add placeholder `topchester kb compile`, `topchester kb scan`, and `topchester kb status` commands.
5. Spike Pi SDK embedding versus Topchester-owned runtime, with the key test being whether KB-first context retrieval and KB write-back can be enforced.
6. Keep `docs/KNOWLEDGE.md` as the canonical KB architecture reference while runtime scaffolding starts.
