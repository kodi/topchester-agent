# Architecture

Status: Current

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

Topchester is a TypeScript CLI whose supported runtime is Bun `>=1.3`.

Rationale:

- OpenTUI's native renderer has a direct, supported Bun path.
- Bun runs the interactive CLI, noninteractive commands, the production bundle, and packed-artifact smoke tests.
- pnpm remains the repository package manager; choosing Bun as the runtime does not require changing package managers.
- npm remains a supported distribution channel. The installed `topchester` bin uses `#!/usr/bin/env bun`.
- Node 24 remains a contributor tool for existing repository scripts, but it is not the packaged CLI runtime.

The repository pins Bun 1.3, Node 24, and pnpm 11 through mise. Bun builds and runs the shipped CLI. Node and pnpm remain contributor tooling for repository scripts, tests, and package management.

OpenCode comparison:

- OpenCode is distributed through an npm-style CLI command.
- Its current source tree uses Bun and OpenTUI.
- Topchester adopts the smaller relevant boundaries: explicit renderer lifecycle, append-only scrollback, a reactive footer, required contexts, semantic themes, and a shared dialog system.
- Topchester remains an in-process agent and does not copy OpenCode's client/server or Effect architecture.
- Standalone platform binaries remain a separate future distribution project.

## Install and Invocation Workflow

Target user workflow:

```text
# install
curl -fsSL https://topchester.com/install | sh
# or
npm install -g topchester-ai

# use
cd /path/to/project
topchester
```

The default `topchester` command should be the interactive TUI coding agent.

Additional CLI commands should exist for explicit KB workflows:

```text
topchester kb sync --full # full Knowledge Compiler pipeline
topchester kb sync        # incremental Knowledge Compiler pipeline
topchester kb scan        # deterministic inventory scan only
topchester kb status      # drift and freshness status
topchester kb explain     # explain what the KB knows about the project
```

The interactive TUI may expose the same KB sync flow as a wizard, especially on first project open.

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

The interactive UI uses exact, mutually compatible OpenTUI packages:

- `@opentui/core@0.4.4`
- `@opentui/solid@0.4.4`
- `solid-js@1.9.12`

The production renderer uses `screenMode: "split-footer"`, captured external stdout, no mouse reporting, and non-clearing shutdown. Stable transcript entries append once to native scrollback; the composer, suggestions, task plan, busy state, status, and dialogs repaint only in the footer.

OpenTUI is a rendering dependency, not the application architecture. `src/chat/controller.ts` owns runtime/session behavior and exposes semantic snapshots/actions. `src/chat/transcript.ts` owns renderer-neutral entries and persistence eligibility. Components under `src/tui/opentui/` own layout, theme, focus, and keyboard translation only.

## Agent Strategy

Topchester keeps its own KB-aware runtime rather than coupling application behavior to a UI framework or another coding agent. Competitor checkouts remain useful implementation references, but the runtime, controller, transcript model, tools, and session log are Topchester-owned boundaries.

## High-Level Architecture

Topchester should be organized around these responsibilities:

1. CLI entrypoint
   - Owns `topchester`, `topchester kb sync`, `topchester kb scan`, and related commands.
   - Handles install-time/runtime checks, config discovery, workspace root resolution, and command dispatch.

2. Chat controller and OpenTUI renderer
   - The framework-neutral controller owns runtime reduction, session operations, queue/steer/cancel, choices, model/provider/effort, skills, KB polling, and disposal.
   - OpenTUI Solid components own rendering, keyboard translation, focus, layout, overlays, status, and terminal interaction.
   - `TranscriptWriter` is the sole stable-scrollback commit boundary; `LiveFooter` is the sole repaintable region.

3. Workspace detector
   - Identifies the project root and project type.
   - Warns if the user appears to be in a non-code directory.
   - Finds the canonical KB directory and `.agents/topchester-kb-cache/`.
   - Computes initial project metadata for the Knowledge Compiler.

4. Knowledge Compiler
   - Compiles a repository into the canonical KB.
   - Includes inventory scanning, structural TypeScript/JavaScript intelligence, L1 file entries, L2 module discovery, L3 feature discovery, graph building, validation, and drift reporting.
   - Exposes explicit sync/scan/status operations to the CLI and TUI.

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
   - Is implemented as a Topchester-owned runtime so the KB contract stays explicit and independent of the UI framework.

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

## Agent Profiles And Tool Permissions

Runtime turns execute under an agent profile. The primary profile uses the normal
model slot and can see the full registered tool set. Subagent profiles can add
prompt instructions, choose a model slot, and narrow the tool set.

Tool permissions are enforced twice:

- prompt/model schema filtering hides denied tools from the model-facing tool list;
- execution-time checks reject denied tools even if a model emits one anyway.

Permission composition is monotonic for subagents: a child profile can reduce
the parent permission view, but parent-denied tools remain denied and cannot be
reintroduced by the child profile.

The `task` tool is the first subagent entrypoint. It creates a real child
session, runs the delegated prompt under a subagent profile, forwards child
runtime events to the parent stream, and returns one bounded result to the
parent model.

Tool definitions can opt into parallel scheduling with metadata:

- `parallelSafe` marks tools that may run alongside other safe tools.
- `mutatesWorkspace` and `requiresExclusiveWorkspace` keep write, Git mutation, command, and unknown tools sequential by default.
- `resourceKeys(args)` gives future schedulers a stable conflict key, such as a file path or Git scope.

Only explicitly read-only tools are marked parallel-safe initially. Unknown or
unmarked tools remain sequential.

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

- Runtime: TypeScript on Bun `>=1.3`.
- Command: `topchester` for the interactive agent.
- Install shape: curl installer and npm global package.
- TUI foundation: OpenTUI Solid in append-only split-footer mode.
- UI boundary: renderer-neutral controller and transcript model, with no application logic in components.
- Agent strategy: Topchester-owned KB-aware runtime.
- Canonical KB path: `topchester-kb/` by default, overrideable with `TOPCHESTER_KB_DIR`.
- Generated cache path: `.agents/topchester-kb-cache/`.
- KB API: local HTTP JSON-RPC core with MCP adapter on top.
- Knowledge Compiler CLI: `topchester kb sync`, `topchester kb sync --full`, and `topchester kb scan`.
- Drift posture: warning-first / non-strict mode initially.

## Open Questions

- What should limited mode allow when the user opens a non-code directory?
- What exact prompts/status copy should the first-run KB wizard use?
- Should a future release add standalone platform binaries, while keeping the npm package as the canonical installation path?
- Which post-migration UI improvements should be introduced separately from renderer parity?
