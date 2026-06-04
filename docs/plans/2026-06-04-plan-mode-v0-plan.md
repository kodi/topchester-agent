# Plan Mode V0 Plan

## Summary

Add V0 support for an interactive TUI Plan mode where the agent can inspect and plan but cannot modify the workspace.

The target behavior is:

- `Shift+Tab` toggles the interactive session between `Build` and `Plan`
- Plan mode is visible in the prompt/status area
- Plan mode changes the runtime system prompt so the model understands it is in a read-only planning phase
- Plan mode is enforced by the runtime tool catalog and permission layer, not only by prompt text
- Build mode preserves today's normal Topchester behavior

This plan exists because the feature crosses TUI key handling, visible mode state, runtime prompt construction, tool permission filtering, MCP exposure, session behavior, and docs.

## Competitor Notes

Local competitor checkouts inspected on 2026-06-04:

- OpenCode has a first-class `plan` agent alongside `build`. Its TUI defaults `agent_cycle` to `tab` and `agent_cycle_reverse` to `shift+tab`.
- OpenCode's Plan mode prompt is a strong read-only system reminder: no file edits, no system changes, and shell commands may only inspect.
- OpenCode models the transition back to implementation through a plan handoff tool (`plan_exit`) that asks whether to switch to the build agent.
- OpenCode's handoff creates a synthetic Build-agent user message that says the plan has been approved and implementation can begin.
- OpenCode's config keeps `plan` and `build` as agent entries with distinct permissions.
- Topchester already has a smaller equivalent foundation: `AgentProfile`, `ToolPermissionView`, profile-filtered tool catalogs, a read-only tool list for the Explore subagent, and visible `plan_todo` state.

## Decisions

- V0 should implement Plan mode as a session-level execution mode, not a new multi-agent/profile system.
- Runtime enforcement is required. Prompt-only Plan mode is not sufficient.
- Plan mode should deny all workspace mutation tools and approval-gated shell execution.
- Plan mode should deny dynamic MCP tools in V0, because Topchester cannot reliably classify external MCP tools as read-only yet.
- Plan mode should allow `plan_todo`, read/search tools, git read tools, skills read tools, and the read-only `inspect_command` tool.
- Plan mode should allow the existing `task` tool only if child subagents inherit the same read-only restriction. If this complicates V0, deny `task` in Plan mode and revisit after the core mode is stable.
- Build mode should remain the default for new and restored sessions unless persisted mode is explicitly added later.
- Do not make Plan mode a global config default in V0.
- Do not add a model-callable `plan_exit` tool in V0. The user can press `Shift+Tab` to return to Build mode.
- V0 should still include an explicit implementation handoff path so an approved plan can be implemented in the same session or after resume/fork.
- The handoff should be represented as normal persisted conversation context, not only a transient TUI notice.
- When switching from Plan to Build after approval, the next Build turn should receive a clear "the plan is approved; implement it" instruction without requiring the user to restate the whole plan.
- Do not let queued follow-up or steering messages bypass the active mode. Each turn should use the mode active when that turn starts.
- Slash commands that mutate configuration or sessions should remain shell-level commands and be evaluated separately from runtime Plan mode. V0 should at least prevent confusing mode changes during active modals or busy turns.

## Scope

Included:

- TUI `Shift+Tab` mode toggle between Build and Plan.
- Visible current mode in the prompt/status line.
- Runtime submit options or shell-owned runtime state that carries the active mode into each user turn.
- System prompt additions for Plan mode and Build mode re-entry.
- Tool permission filtering for Plan mode.
- Tests proving mutating tools are absent from Plan mode model requests.
- Tests proving a rejected/hidden mutating tool call cannot execute in Plan mode.
- Tests proving `Shift+Tab` toggles visible mode in `ChatLayout`.
- A minimal approved-plan handoff for continuing implementation in the same session and after session resume/fork.
- Docs updates for Plan mode behavior and limitations.

Out of scope for V0:

- Persisting the current mode across process restarts.
- Per-project default mode config.
- Dedicated plan files generated automatically by the agent.
- UI for editing/reviewing a plan before switching modes.
- Multi-step plan approval workflow or OpenCode-style model-callable `plan_exit`.
- Fine-grained MCP read-only classification.
- Plan mode for non-interactive `topchester run`.
- Separate model assignment for Plan mode.

## Current State

Relevant Topchester behavior:

- `src/tui/layout.ts` owns prompt editing, input handling, rendering, and status/footer output.
- `src/tui/keys.ts` already wraps common key recognition and has `isTabKey()`, but no Shift+Tab helper.
- `src/tui/shell.ts` owns session lifecycle, slash-command routing, queued/steering messages, and calls `runtime.submitMessageStream()`.
- `src/tui/status.ts` formats the footer/status line from folder, model, status, and KB status.
- `src/agent/profiles.ts` defines `AgentProfile`, `ToolPermissionView`, `PRIMARY_AGENT_PROFILE`, and a `READ_ONLY_TOOLS` list used by the Explore subagent.
- `src/agent/tools/registry.ts` identifies all static tools and includes mutating tool metadata through each tool definition.
- `src/agent/tools/catalog.ts` constructs a profile-filtered tool catalog and only exposes dynamic MCP tools to the primary allow-by-default profile.
- `src/agent/runtime/index.ts` builds the per-turn system prompt, permission view, MCP manager, tool catalog, and model request.
- `src/agent/prompts.ts` builds the main system prompt and already accepts profile and permission options.
- `plan_todo` is already a visible planning tool and should remain available in Plan mode.

## Recommended Approach

Keep Plan mode as a small explicit runtime mode:

```text
TUI mode state
  - owns current mode label: build | plan
  - handles Shift+Tab
  - displays the mode
  - passes the active mode when a turn starts

Runtime mode options
  - receives mode for a single turn
  - adjusts system prompt
  - builds a mode-specific ToolPermissionView
  - omits dynamic MCP tools in plan mode

Handoff state
  - records that the user approved the latest plan
  - persists a small user-visible/model-visible handoff marker
  - prepends a one-shot Build-mode continuation instruction when implementation starts
```

This keeps the normal runtime profile model intact and avoids introducing OpenCode's full plan/build agent architecture before Topchester needs it.

## Implementation Handoff

V0 needs a handoff because Plan mode intentionally prevents implementation. The minimal contract should work in two paths:

- Same session: user reviews the plan, presses `Shift+Tab` to switch to Build, then submits "implement it" or another concise approval prompt.
- Resumed/forked session: user resumes or forks the planning session so the approved plan remains in conversation context, switches to Build if needed, then asks for implementation.

Recommended V0 behavior:

- Plan-mode prompt should instruct the agent to finish mature plans with an `Implementation handoff` section when the user asks for a plan or when the agent believes the plan is ready for review.
- The handoff section should include: target outcome, agreed decisions, ordered slices, files likely to change, verification, and open questions.
- When the user toggles from Plan to Build, the TUI should show and persist a compact model-visible user message such as: `Plan approved. Continue in Build mode and implement the latest plan from this conversation.`
- The synthetic approval message should only be added when switching Plan -> Build, not Build -> Plan.
- If the user switches back to Plan, no implementation approval marker should be added.
- If the user resumes/forks a session, the persisted approval marker and prior assistant handoff should be enough context for the Build turn.

This is intentionally smaller than OpenCode's `plan_exit`: the user owns the mode switch, and Topchester only records the approved-plan handoff clearly enough for the next Build turn.

## Plan Mode Permission Shape

Preferred V0 static read-only tools:

- `plan_todo`
- `read_file`
- `list_files`
- `grep`
- `find_file`
- `git_status`
- `git_diff`
- `git_log`
- `inspect_command`
- `skills_list`
- `skill_view`

Mutating or risky tools to deny:

- `edit_file`
- `write_file`
- `git_add`
- `git_commit`
- `run_validator`
- `bash`
- dynamic MCP tools

`task` has two viable V0 choices:

- Safer default: deny `task` in Plan mode.
- More useful default: allow `task`, but force every child runtime to inherit the Plan mode permission view so subagents are also read-only.

Recommendation: deny `task` for the first implementation slice unless implementation proves inheritance is trivial and testable.

## Prompt Shape

Plan mode should add a short, direct system section after the normal Topchester identity and before tool use:

```text
Operational mode: Plan.
You are in a read-only planning phase. Inspect, reason, and produce a concise implementation plan.
Do not edit files, write files, stage or commit changes, run mutating commands, install dependencies, or alter configuration.
If the user asks you to implement while Plan mode is active, explain that Plan mode is read-only and provide the plan or ask them to switch to Build mode.
```

Build mode can either have no extra prompt or a one-line section:

```text
Operational mode: Build.
You may inspect, edit, run validators, and complete the requested repository work using the available tools.
```

The Build prompt addition is optional for V0. If included, keep it stable and low-noise.

## UI Behavior

- New sessions start in Build mode.
- Footer/status should show the current mode, for example `● ready · build · repo · model [provider]`.
- Pressing `Shift+Tab` while the prompt is focused toggles Build/Plan and shows a short temporary notice.
- The prompt footer or startup hint should mention `Shift+Tab mode` once the feature exists.
- Mode changes should be blocked or ignored while an approval modal/session picker is active, so modal navigation remains predictable.
- If an agent turn is currently running, mode changes should only affect the next turn. The currently running turn keeps the mode it started with.
- Queued follow-ups should use the mode active when each queued prompt starts, not when it was queued.

## Data Flow

Idle prompt in Build mode:

```text
Enter
  -> TUI submits message with active mode build
  -> runtime builds normal tool catalog
  -> model can request normal allowed tools
```

Idle prompt in Plan mode:

```text
Enter
  -> TUI submits message with active mode plan
  -> runtime adds read-only Plan prompt
  -> runtime builds Plan tool catalog
  -> model can only read/search/plan
```

Shift+Tab:

```text
Shift+Tab
  -> ChatLayout or TUI shell toggles mode state
  -> mode label and temporary notice update
  -> if switching Plan -> Build, persist an approved-plan handoff marker
  -> no model/runtime work starts until the next user submit
```

Approved handoff in same or resumed session:

```text
Plan mode turn produces implementation handoff
  -> user reviews plan
  -> user switches Plan -> Build
  -> shell persists "Plan approved..." marker
  -> next Build turn sees prior plan plus approval marker in conversation
  -> implementation starts with normal Build tools
```

## Files To Change

Likely changes:

- `src/tui/keys.ts`
- `src/tui/layout.ts`
- `src/tui/shell.ts`
- `src/tui/status.ts`
- `src/agent/profiles.ts`
- `src/agent/prompts.ts`
- `src/agent/runtime/index.ts`
- `src/agent/tools/catalog.ts`
- `src/tui/session-persistence.ts`
- `src/session/events.ts` if a distinct mode/handoff event is preferred over a synthetic message
- `docs/tui.md`
- `docs/features/tui.md`
- `test/tui.render.test.ts`
- `test/agent-runtime.test.ts`

Possible new files:

- `src/agent/modes.ts`
- `test/agent-plan-mode.test.ts`

## Cross-Slice Rules

- Prompt text is guidance; permissions are enforcement.
- Plan mode must not expose mutating tools in the model request.
- Plan mode must not expose dynamic MCP tools in V0.
- Build mode behavior should remain unchanged unless the test intentionally covers the new mode label.
- Keep the first implementation small enough that Plan mode can ship without plan approval workflows.
- Prefer reusing `AgentProfile`/`ToolPermissionView` over adding a second permission system.
- The handoff must be visible in persisted conversation context, not only in ephemeral UI state.
- Resuming or forking a planning session should preserve enough context to implement the approved plan.

## Slices

### Slice 1: Define Mode Contract

Status: `[ ]` Not started

Goal: Add a small shared type and mode permission contract without changing runtime behavior.

Why here: Later TUI and runtime work need one stable name for Build vs Plan and one reviewed list of Plan-mode tools.

This slice should implement:

- Add `AgentExecutionMode` or similar with `build` and `plan`.
- Add helpers for formatting mode labels.
- Move or expose a read-only Plan-mode tool list from `src/agent/profiles.ts`.
- Decide whether `task` is denied or inherited in Plan mode and encode that choice.

Expected output:

- A typed mode contract available to TUI and runtime modules.
- Focused tests for Plan-mode allowed/denied tool names.

Verification:

- `pnpm test test/agent-runtime.test.ts`
- Or a narrower new test file if the implementation creates one.

Dependencies:

- None.

### Slice 2: Runtime Enforcement

Status: `[ ]` Not started

Goal: Make `TopchesterAgentRuntime` build a read-only tool catalog for Plan-mode turns.

Why here: Safety should land before UI discoverability so no visible toggle can imply protection before enforcement exists.

This slice should implement:

- Add an execution mode option to `AgentRuntimeSubmitMessageOptions` or `TopchesterAgentRuntimeOptions`.
- Thread the active mode into system prompt construction.
- Construct a Plan-mode `ToolPermissionView` with default deny and the allowed Plan tools.
- Omit dynamic MCP tools while in Plan mode.
- Ensure parsed/rejected tool calls for denied mutating tools are handled as unavailable rather than executed.

Expected output:

- Plan-mode model requests include only read-only tool definitions.
- Mutating tool calls cannot execute in Plan mode even if a model emits text JSON/XML for them.
- Build-mode tool exposure remains unchanged.

Verification:

- `pnpm test test/agent-runtime.test.ts`
- Add focused assertions that `edit_file`, `write_file`, `bash`, `git_add`, `git_commit`, `run_validator`, and dynamic MCP tools are absent in Plan mode.

Dependencies:

- Slice 1.

### Slice 3: Plan Mode Prompting

Status: `[ ]` Not started

Goal: Add concise mode-specific prompt instructions.

Why here: After runtime enforcement exists, prompt text can improve model behavior without being the only safety mechanism.

This slice should implement:

- Extend `getChatSystemPrompt()` to accept execution mode.
- Add the read-only Plan mode system section.
- Optionally add a low-noise Build mode section.
- Ensure project instructions still appear and keep their existing precedence, while Plan mode's read-only rule remains explicit.

Expected output:

- Plan-mode system prompt clearly says read-only planning.
- Existing prompt tests remain stable or are intentionally updated.

Verification:

- `pnpm test test/agent-runtime.test.ts`
- Add a prompt assertion for the Plan-mode system section.

Dependencies:

- Slice 2.

### Slice 4: TUI Mode State and Shift+Tab

Status: `[ ]` Not started

Goal: Add visible Build/Plan state and a `Shift+Tab` toggle in the interactive TUI.

Why here: The user-facing control should land after the backend can enforce it.

This slice should implement:

- Add `isShiftTabKey()` in `src/tui/keys.ts`.
- Add current mode state and setter/getter behavior in `ChatLayout` or `TopchesterTuiShell`.
- Handle `Shift+Tab` before prompt editing, but after modal/session-picker handling.
- Render the mode in the footer/status line.
- Show a short temporary notice when the mode changes.

Expected output:

- Pressing `Shift+Tab` toggles the visible mode.
- The mode label is stable in rendered output.
- Ordinary `Tab` behavior for slash completion remains intact.

Verification:

- `pnpm test test/tui.render.test.ts test/tui.prompt-history.test.ts`
- Add focused render/input tests for Shift+Tab and status output.

Dependencies:

- Slice 3.

### Slice 5: Shell-to-Runtime Wiring

Status: `[ ]` Not started

Goal: Ensure each submitted turn runs with the TUI mode that is active when the turn starts.

Why here: The UI toggle is only meaningful once `TopchesterTuiShell` passes it into `submitMessageStream()`.

This slice should implement:

- Store current execution mode in `TopchesterTuiShell`.
- Pass the active mode into `runtime.submitMessageStream()` for chat turns.
- Ensure queued follow-ups use the mode active when they start.
- Ensure an active running turn is not silently changed mid-turn by a later toggle.
- Decide whether slash commands ignore mode or explicitly reject mutating slash commands in Plan mode.

Expected output:

- Build-mode turns behave as before.
- Plan-mode turns are read-only from the model's first request.
- Mode changes during a running turn only affect later turns.

Verification:

- `pnpm test test/tui.render.test.ts test/agent-runtime.test.ts`
- Add a shell/runtime fake test if existing tests can observe submit options.

Dependencies:

- Slice 4.

### Slice 6: Approved-Plan Handoff

Status: `[ ]` Not started

Goal: Make switching from Plan to Build create enough durable context for implementation to continue in the same, resumed, or forked session.

Why here: Handoff depends on working TUI mode state and shell-to-runtime wiring, but should land before docs describe the full user workflow.

This slice should implement:

- Add Plan-mode prompt guidance that mature plans should include an `Implementation handoff` section.
- When toggling Plan -> Build, add and persist a compact handoff marker that is visible to the model on the next turn.
- Ensure toggling Build -> Plan does not add an approval marker.
- Ensure repeated Plan -> Build toggles do not spam duplicate approval markers for the same plan unless the user has produced another Plan-mode turn.
- Ensure resumed/forked sessions include the handoff marker through existing session rehydration.
- Keep the marker wording short and direct, for example: `Plan approved. Continue in Build mode and implement the latest plan from this conversation.`

Expected output:

- Same-session Build turns can implement the approved plan without the user restating it.
- Resumed or forked sessions preserve the approved-plan handoff in conversation context.
- The handoff is not merely a temporary UI notice.

Verification:

- `pnpm test test/tui.render.test.ts test/session.test.ts`
- Add focused tests for Plan -> Build marker persistence and resume/fork rehydration.

Dependencies:

- Slice 5.

### Slice 7: Docs and Final Validation

Status: `[ ]` Not started

Goal: Document the V0 user contract and run the targeted validation set.

Why here: Plan mode is a user-facing safety feature; docs need to state exactly what is guaranteed and what is not.

This slice should implement:

- Update `docs/tui.md` with `Shift+Tab` mode switching.
- Update `docs/features/tui.md` if it lists prompt controls or modes.
- Note that Plan mode is read-only for Topchester tools and dynamic MCP tools are unavailable in V0.
- Note that Plan mode is not persisted and does not apply to non-interactive `topchester run`.
- Document the approved-plan handoff workflow: plan in Plan mode, review, switch to Build, then continue in the same/resumed/forked session.

Expected output:

- Docs match shipped V0 behavior.
- A reviewer can validate the end-to-end mode switch manually.

Verification:

- `pnpm test test/tui.render.test.ts test/tui.prompt-history.test.ts test/agent-runtime.test.ts`
- Manual smoke: start TUI, press `Shift+Tab`, confirm footer says Plan, ask for a plan, confirm no edit/write/bash tools are offered in logged model request or focused fake-runtime test, press `Shift+Tab` back to Build, and confirm the next turn has the approved-plan handoff context.

Dependencies:

- Slice 6.

## Testing Plan

Per-slice verification is listed above. Final validation should include:

- Unit test: Plan-mode permission helper allows only the intended static tools.
- Runtime test: Plan-mode model request omits mutating tools and dynamic MCP tools.
- Runtime test: a model-emitted mutating tool call in Plan mode is rejected/unavailable and does not alter files.
- Prompt test: Plan-mode system prompt contains the read-only planning instruction.
- TUI test: `Shift+Tab` toggles mode and the status line renders the current mode.
- TUI/session test: Plan -> Build creates one persisted handoff marker and resume/fork preserves it.
- TUI test: ordinary `Tab` still completes slash suggestions.
- Regression test: Build-mode model request still includes current tools.

## Open Questions

- Should `task` be allowed in Plan mode with inherited read-only permissions, or denied for the first V0?
- Should shell-level slash commands that mutate user config, such as `/model` or `/connect`, be blocked in Plan mode, or is Plan mode scoped strictly to agent runtime tools?
- Should Plan mode be persisted in session metadata later, or should every restore start in Build mode for safety and simplicity?
- Should the Plan -> Build handoff marker be a normal synthetic user message, a new session event rendered as model context, or a one-shot shell prepended instruction?
