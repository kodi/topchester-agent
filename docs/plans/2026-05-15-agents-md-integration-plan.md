# AGENTS.md Integration Plan

## Summary

Add first-class `AGENTS.md` support to Topchester's coding-agent runtime.

The target outcome is that Topchester automatically loads project instruction files, gives the model clear scope and precedence rules, and protects file edits from happening before path-specific instructions are known. The implementation should fit Topchester's existing runtime, session, KB, and tool contracts instead of adding a separate memory system.

## Decisions

- Treat `AGENTS.md` as live runtime instruction context, not as KB-only documentation.
- Keep KB and AGENTS.md connected but separate: the KB may index `AGENTS.md`, while the agent runtime reads current instruction files directly before model turns and path-scoped tool work.
- Topchester workspace root is the instruction search root. Do not walk above it in V0.
- Load root-level instructions at session start and before each user turn.
- Load nested instructions lazily when a tool targets a file or directory under that nested scope.
- Order instruction content from least specific to most specific: workspace root first, deeper folders later.
- More deeply nested `AGENTS.md` content wins for conflicts inside its directory tree.
- Direct system, developer, and user instructions still outrank all `AGENTS.md` content.
- Support `AGENTS.override.md` as a local preferred file at the same directory level, matching this repo's current usage and Codex's local override behavior.
- Do not load `CLAUDE.md`, `.clinerules`, `.cursor/rules`, remote URLs, or global home-level instruction files by default in V0.
- Make compatibility fallbacks configurable later, not default behavior.
- Cap instruction bytes so a large project guide cannot crowd out the whole turn.
- Guard mutation of `AGENTS.md` and `AGENTS.override.md`: the model may edit those files only when the user's request explicitly asks for instruction-file changes.
- Keep user-visible status compact. A startup line such as `Project instructions: AGENTS.md` is enough; no footer slot is needed in V0.

## Scope

Included:

- A project-instruction resolver for `AGENTS.md` and `AGENTS.override.md`.
- Root-to-target scope discovery inside the Topchester workspace.
- Prompt formatting that explains source path, scope, precedence, and byte truncation.
- Runtime integration before each model turn.
- Tool integration for path-scoped instruction discovery before read/search/edit/write work.
- A safe retry path when a mutating tool targets a file whose nested instructions were not yet shown to the model.
- Session persistence for the instruction files loaded during a turn.
- Debug logging for discovered instruction sources and truncation.
- Tests for resolver behavior, runtime prompt injection, path-scoped tool behavior, session persistence, and docs examples.
- Docs updates in `docs/cli.md`, `docs/tui.md`, and `docs/config.md`.

Not included:

- Reading instruction files outside the workspace.
- Remote instruction URLs.
- A generic rules engine for Cline, Cursor, Windsurf, or Claude files.
- A UI to enable/disable individual instruction files.
- Global personal instruction files.
- Automatic generation of `AGENTS.md`.
- Treating `AGENTS.md` as a replacement for Topchester KB.

## Current State

Topchester currently builds one system prompt in `src/agent/prompts.ts`. It includes agent profile guidance, tool contracts, and model-facing workflow rules.

The runtime in `src/agent/runtime/index.ts` builds a conversation prompt, optionally prepends an L1 KB context pack, calls the model, executes tools, and appends tool results into the next model prompt. Hook context can also be appended to the turn prompt.

The tool layer in `src/agent/tools/*` is workspace-scoped. File tools include `read_file`, `list_files`, `grep`, `find_file`, `edit_file`, and `write_file`. Mutating tools already report KB session-overlay dirty state.

The session schema in `src/session/events.ts` persists messages, status events, tool calls, task plans, choices, KB status, and subagent lifecycle events. It does not yet persist model-visible instruction sources.

The KB docs in `docs/KNOWLEDGE.md` say the KB is the semantic backend of the agent, but live files still matter for task-critical facts. `AGENTS.md` should follow that same rule: current file contents win over stale compiled knowledge.

## Competitor Findings

Local checkouts were inspected as required by `AGENTS.override.md`.

### Codex

Relevant files:

- `~/data/github/codex/codex-rs/core/src/agents_md.rs`
- `~/data/github/codex/codex-rs/core/src/agents_md_tests.rs`
- `~/data/github/codex/codex-rs/core/hierarchical_agents_message.md`
- `~/data/github/codex/codex-rs/core/gpt_5_2_prompt.md`
- `~/data/github/codex/codex-rs/config/src/config_toml.rs`

Useful patterns:

- Uses a dedicated `AgentsMdManager`.
- Finds a project root using configured root markers and does not walk past it.
- Concatenates instruction files from project root to current working directory.
- Supports `AGENTS.override.md` before `AGENTS.md`.
- Has a byte budget for project docs.
- Can configure fallback filenames.
- Adds explicit model-facing guidance about scope, nested precedence, and direct prompt precedence.
- Tracks instruction source paths.

Topchester should copy the resolver boundary, root-to-cwd ordering, override support, byte limits, and scope/precedence wording. Topchester should not copy global home instruction loading in V0.

### OpenCode

Relevant files:

- `~/data/github/opencode/packages/opencode/src/session/instruction.ts`
- `~/data/github/opencode/packages/opencode/test/session/instruction.test.ts`
- `~/data/github/opencode/packages/opencode/test/tool/read.test.ts`
- `~/data/github/opencode/packages/opencode/src/session/prompt.ts`

Useful patterns:

- Loads global and project instruction files into the system prompt.
- Uses `AGENTS.md` first, then `CLAUDE.md`, then deprecated `CONTEXT.md`.
- Loads only the first matching project instruction filename family from ancestor lookup.
- Supports config-provided instruction files and remote URLs.
- When reading a file, walks upward from that file and attaches nearby nested instructions once per message.
- Avoids reattaching instructions already loaded by prior read metadata.
- Has focused tests for root instructions, nested instructions, direct reads of `AGENTS.md`, duplicate suppression, and global/project ordering.

Topchester should copy the lazy path-scoped loading and duplicate suppression. It should not default to `CLAUDE.md`, deprecated context files, or remote URLs.

### Cline

Relevant files:

- `~/data/github/cline/src/core/context/instructions/user-instructions/external-rules.ts`
- `~/data/github/cline/src/core/context/instructions/user-instructions/cline-rules.ts`
- `~/data/github/cline/src/core/prompts/responses.ts`
- `~/data/github/cline/src/core/storage/disk.ts`

Useful patterns:

- Has a broader rule system with `.clinerules`, `.cursor/rules`, `.windsurfrules`, and `AGENTS.md`.
- For `AGENTS.md`, only performs recursive discovery when a top-level `AGENTS.md` exists.
- Combines found files with path headings and tells the model to apply only the instructions relevant to the current task.
- Supports rule toggles and conditional rules for Cline-specific files.

Topchester should copy the explicit "apply only relevant scoped instructions" wording. It should not recursively scan the whole tree or add toggles in V0.

### Kilo Code

Relevant files:

- `~/data/github/kilocode/packages/kilo-docs/pages/customize/agents-md.md`
- `~/data/github/kilocode/packages/opencode/src/session/prompt/kimi.txt`
- `~/data/github/kilocode/packages/opencode/test/session/instruction.test.ts`

Useful patterns:

- Documents `AGENTS.md` as a portable project-level standard.
- Supports subdirectory `AGENTS.md` files with deeper precedence.
- Documents `AGENTS.md` and `AGENT.md` as supported filenames, with uppercase required.
- Treats `AGENTS.md` and `AGENT.md` as protected files that need explicit user approval before modification.
- Tells the model to update instruction files when it changes files or workflows those instructions describe.

Topchester should copy the protection rule and docs clarity. It should not add `AGENT.md` as a default fallback until users ask for that compatibility.

### Pi

Relevant files:

- `~/data/github/pi/packages/coding-agent/src/core/resource-loader.ts`
- `~/data/github/pi/packages/coding-agent/src/core/tools/read.ts`
- `~/data/github/pi/packages/coding-agent/src/cli/args.ts`

Useful patterns:

- Loads a global context file plus every ancestor `AGENTS.md` or `CLAUDE.md`.
- Uses `--no-context-files` to disable context-file discovery.
- Treats `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, and `CLAUDE.MD` as compact resource files in read output.

Topchester should copy the simple disable knob and ancestor ordering. It should not walk to filesystem root or load `CLAUDE.md` by default.

## Recommended Contract

### Resolver

Add a resolver module, likely `src/agent/instructions.ts`.

Core types:

```ts
interface ProjectInstructionSource {
  path: string;
  relativePath: string;
  scopePath: string;
  depth: number;
  bytes: number;
  truncated: boolean;
  content: string;
}

interface ProjectInstructionContext {
  sources: ProjectInstructionSource[];
  formatted: string;
  sourceKeys: string[];
  truncated: boolean;
}
```

Discovery rules:

- Candidate names per directory: `AGENTS.override.md`, then `AGENTS.md`.
- For each directory, pick at most one candidate.
- For the session root, walk from `workspaceRoot` to the current logical directory. In V0 that is usually `workspaceRoot`.
- For a tool target, walk from `workspaceRoot` to the target file's parent directory, or to the target directory for directory tools.
- Never follow a target outside `workspaceRoot`.
- Ignore empty files.
- Skip directories or unreadable files with a debug log and no user-visible crash.
- Preserve root-to-child order.

Formatting rules:

```text
# AGENTS.md instructions

Direct system, developer, and user instructions override these files.
For file work, apply every listed file whose scope contains the target path.
When two instruction files conflict, the deeper scope wins for files inside that deeper scope.

## AGENTS.md for .
Scope: .

<INSTRUCTIONS>
...
</INSTRUCTIONS>

## AGENTS.override.md for src
Scope: src

<INSTRUCTIONS>
...
</INSTRUCTIONS>
```

Byte limits:

- Default per-file limit: 32 KiB.
- Default total limit: 96 KiB.
- If truncated, include a short marker in the formatted context and log full metadata.

### Runtime Integration

Before each model call:

1. Build the normal system prompt with `getChatSystemPrompt`.
2. Resolve base project instructions for the workspace root.
3. Append formatted instructions to the system prompt, after built-in Topchester tool/runtime rules.
4. Build the normal user prompt with conversation, KB context, and hook context.

This keeps AGENTS.md in model-visible instructions, while KB context stays in the user prompt where it currently lives.

For subagents:

- Child runtimes inherit the same resolver behavior.
- Child session metadata should record its own loaded instruction sources because a child task may target a different path.

### Tool Integration

File and directory tools should call the resolver with their target path.

Read/search tools:

- `read_file`, `list_files`, `grep`, and `find_file` may include newly relevant instruction context in the tool result metadata/content when the target path enters a nested scope not already shown this turn.
- Do not attach duplicate instructions repeatedly in the same assistant message or tool loop.
- Do not auto-attach an instruction file when the model is directly reading that exact instruction file; the file content itself is the result.

Mutation tools:

- `edit_file` and `write_file` must resolve target-path instructions before mutation.
- If there are newly relevant nested instructions not already shown to the model, do not mutate yet. Return a tool result that includes the new instructions and says to retry the edit after applying them.
- If the target path is `AGENTS.md` or `AGENTS.override.md`, require explicit user intent in the current task. Without that, return a guarded tool result and do not mutate.
- On success, existing KB dirty-state behavior remains unchanged.

### Session And Logging

Add a persisted event or metadata shape that records instruction sources loaded for a turn:

```json
{
  "kind": "instruction_context",
  "sources": [
    {
      "path": "AGENTS.md",
      "scopePath": ".",
      "bytes": 2048,
      "truncated": false
    }
  ]
}
```

This event should not store full instruction content. The session log should record enough to explain what affected the turn without duplicating project files.

Debug logs should include:

- source paths
- scopes
- byte counts
- truncation
- whether context was base startup context or path-scoped tool context

Trace logs may include the formatted instruction block if current logging conventions allow model prompt trace payloads.

### Config

Add config only after the default behavior is stable.

Suggested future shape:

```yaml
instructions:
  enabled: true
  files:
    - AGENTS.override.md
    - AGENTS.md
  fallbackFiles: []
  maxBytesPerFile: 32768
  maxTotalBytes: 98304
```

V0 can hardcode the default candidate names and limits, plus an environment escape hatch for tests if needed. A CLI flag such as `--no-project-instructions` can mirror Pi's `--no-context-files` later.

## Cross-Slice Rules

- Keep `AGENTS.md` live and current; do not rely on stale KB summaries for instructions.
- Do not expose full home paths in docs or user-facing output.
- Keep `inspect_command` unrelated to instruction discovery.
- Keep startup and footer UI quiet; instruction status should not crowd out model and KB state.
- Do not add support for non-AGENTS rule ecosystems unless a later slice explicitly chooses that compatibility.
- Prefer resolver tests before runtime/tool changes.

## Implementation Slices

### Slice 1: Resolver And Formatting

Status: `[ ]` Not started

Goal: Add a standalone resolver with deterministic discovery and formatting.

Why here: Runtime and tools need one shared source of truth before any prompt behavior changes.

This slice should implement:

- `src/agent/instructions.ts`
- workspace containment checks
- candidate filename precedence
- root-to-target ordering
- empty/unreadable file handling
- byte budgets and truncation markers
- formatted prompt block
- focused resolver tests

Expected output:

- A resolver callable from runtime and tools.
- Unit coverage for root, nested, override, empty, unreadable, outside-workspace, and truncation cases.

Verification:

- `pnpm test test/agent-instructions.test.ts`

Dependencies:

- None.

### Slice 2: Base Runtime Prompt Injection

Status: `[ ]` Not started

Goal: Include workspace-root instruction context in normal agent turns.

Why here: This gives the common `AGENTS.md` behavior before path-specific edge cases.

This slice should implement:

- runtime call to resolver before model generation
- appending formatted instructions to the system prompt
- debug logging of loaded instruction source metadata
- a compact startup system message when root instructions are present
- tests that assert model prompts include root instructions and omit them when absent

Expected output:

- Root `AGENTS.md` and `AGENTS.override.md` affect normal TUI and `topchester run` turns.

Verification:

- `pnpm test test/agent-runtime.test.ts`
- `pnpm test test/logging.test.ts`

Dependencies:

- Slice 1.

### Slice 3: Path-Scoped Tool Context

Status: `[ ]` Not started

Goal: Teach file tools to surface nested instruction files exactly when they become relevant.

Why here: Nested instructions are the part most likely to cause behavioral mistakes if missed.

This slice should implement:

- resolver calls from `read_file`, `list_files`, `grep`, `find_file`, `edit_file`, and `write_file`
- duplicate suppression within one tool loop
- read/search tool result metadata for loaded instruction paths
- mutation guard that returns newly relevant instructions before editing
- direct-read exception for reading `AGENTS.md` itself
- tests for nested read, nested edit retry, duplicate suppression, and direct instruction-file reads

Expected output:

- The model sees nested instructions before it can change scoped files.

Verification:

- `pnpm test test/tools.test.ts`
- `pnpm test test/agent-runtime.test.ts`

Dependencies:

- Slices 1 and 2.

### Slice 4: Instruction-File Mutation Guard

Status: `[ ]` Not started

Goal: Prevent accidental edits to files that control future agent behavior.

Why here: Once the resolver is live, instruction files become a higher-risk mutation target.

This slice should implement:

- explicit-intent check for `AGENTS.md` and `AGENTS.override.md` writes
- clear guarded tool result when intent is missing
- docs text that explains how to ask Topchester to update project instructions
- tests for allowed and rejected instruction-file edits

Expected output:

- Topchester can update instruction files when asked, but does not silently rewrite them during unrelated tasks.

Verification:

- `pnpm test test/tools.test.ts`

Dependencies:

- Slice 3.

### Slice 5: Session Persistence And Resume

Status: `[ ]` Not started

Goal: Record which instruction files affected a turn without storing full contents.

Why here: The runtime behavior should be auditable and resumable before broad smoke coverage.

This slice should implement:

- `instruction_context` session payload schema
- persistence from TUI and `topchester run`
- resume behavior that reloads current instruction file contents rather than trusting old contents
- tests for session event writing and older-session compatibility

Expected output:

- Session logs explain instruction source usage while still respecting live file contents on later turns.

Verification:

- `pnpm test test/session.test.ts`
- `pnpm test test/tui.session.test.ts`

Dependencies:

- Slices 2 and 3.

### Slice 6: Docs And Smoke Coverage

Status: `[ ]` Not started

Goal: Make the feature understandable and cover it in the fake-API smoke suite.

Why here: The model-facing behavior is subtle enough that docs and smoke tests should lock the contract.

This slice should implement:

- `docs/cli.md` update for project instruction loading
- `docs/tui.md` update for startup instruction status and guarded edits
- `docs/config.md` note that config knobs are not in V0 unless Slice 7 is taken
- one fake-API smoke scenario where root `AGENTS.md` changes the agent's answer
- one smoke scenario where nested `AGENTS.md` must be applied before a scoped edit

Expected output:

- User docs and smoke coverage match the runtime behavior.

Verification:

- `pnpm test`
- `pnpm exec tsx scripts/smoke/run-smoke.ts --fake-api --trials 1`

Dependencies:

- Slices 1 through 5.

### Slice 7: Configurable Compatibility Knobs

Status: `[ ]` Not started

Goal: Add config only if defaults prove too rigid.

Why here: It is optional; the default standard should ship first.

This slice should implement:

- `instructions.enabled`
- configurable filename list
- fallback filename list
- byte limits
- CLI/TUI docs for the knobs
- tests for config layering

Expected output:

- Teams can opt into `AGENT.md`, `CLAUDE.md`, or other instruction filenames without Topchester loading them by default.

Verification:

- `pnpm test test/config.test.ts`
- `pnpm test test/agent-instructions.test.ts`

Dependencies:

- Slices 1 through 6.

## Testing Plan

Focused unit tests:

- resolver root and nested discovery
- `AGENTS.override.md` precedence over `AGENTS.md`
- root-to-child ordering
- outside-workspace rejection
- byte truncation
- empty file skip
- direct instruction-file read exception
- duplicate suppression

Runtime tests:

- system prompt contains root instructions
- prompt omits absent instructions
- nested edit is guarded until nested instructions have been shown
- subagent runtime uses the same resolver
- model prompt trace logs include source metadata

Session tests:

- instruction source event writes metadata only
- older sessions still load
- resume reloads live instruction files

Docs and smoke:

- `docs/cli.md`, `docs/tui.md`, and `docs/config.md` describe the visible behavior
- fake-API smoke covers root instruction loading and nested edit guarding

## Files To Add

- `src/agent/instructions.ts`
- `test/agent-instructions.test.ts`
- smoke scenarios under `scripts/smoke/scenarios/`

## Files To Change

- `src/agent/runtime/index.ts`
- `src/agent/prompts.ts`
- `src/agent/tools/types.ts`
- `src/agent/tools/executor.ts`
- `src/agent/tools/read-file.ts`
- `src/agent/tools/list-files.ts`
- `src/agent/tools/grep.ts`
- `src/agent/tools/find-file.ts`
- `src/agent/tools/edit-file.ts`
- `src/agent/tools/write-file.ts`
- `src/session/events.ts`
- `src/session/runtime-payloads.ts`
- `src/tui/status.ts`
- `docs/cli.md`
- `docs/tui.md`
- `docs/config.md`

## Open Questions

- Should `AGENTS.override.md` be documented as a supported user-facing feature, or kept as an advanced/local convention?
- Should root instruction status be a startup system message only, or also appear in `topchester run --json` startup events?
- Should mutation guards inspect only the latest user message, or the full current user task text after session resume?
- Should `AGENTS.md` changes automatically mark KB context as high priority for the next turn?
- Should Slice 7 add `--no-project-instructions`, or should config be enough?

## Next Slice

Start with Slice 1. Build the resolver and tests without changing model prompts yet.
