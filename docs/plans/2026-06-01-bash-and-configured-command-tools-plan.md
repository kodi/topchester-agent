# Bash Tool And Run Command Removal Plan

## Summary

Add a generic `bash` tool for real shell execution and delete the existing policy-gated `run_command` tool. Topchester is pre-alpha with zero users, so there is no compatibility requirement, no `run_command` alias, and no `run_configured_command` replacement.

The target model-facing command surface is:

- `bash`: generic shell command execution with approval/permission gates.
- `run_validator`: semantic verification tool for tests, lint, typecheck, build, check, format-check, and smoke.
- `inspect_command`: read-only orientation commands with a strict allowlist.

Any useful ideas from `run_command` should move into `bash` permissions only if they still fit the new shell model.

## Decision

Delete `run_command`.

Do not rename it to `run_configured_command`. The smaller tool surface is preferable because:

- `run_validator` already owns the important autonomous verification use case.
- `bash` should own one-off user terminal commands and shell syntax.
- Fewer command-like tools reduce model confusion.
- Pre-alpha status means we can delete config, tests, docs, and hook examples without preserving compatibility.

`tools.commands.allow`, `tools.commands.allowExact`, and `tools.commands.deny` should not survive as a separate configured-command policy unless a later slice explicitly repurposes them into bash permission config.

## Scope

Included:

- Add model-visible generic `bash`.
- Remove model-visible `run_command`.
- Remove the `run_command` tool implementation and stale prompts, labels, docs, tests, hooks, and smoke references.
- Decide whether any `tools.commands` config ideas become `bash` permission rules.
- Keep `run_validator` as the preferred verification surface.
- Keep `inspect_command` as read-only orientation, not a shell.

Out of scope for the first implementation:

- Persistent PTY sessions.
- Interactive stdin after process start.
- Full sandboxing.
- Windows/PowerShell parity beyond preserving practical current behavior.
- Replacing `run_validator` with shell execution.

## Current State

Topchester currently registers `run_command`, `run_validator`, and `inspect_command` in `src/agent/tools/registry.ts`.

`run_command` is implemented in `src/agent/tools/run-command.ts`. It accepts a command-shaped string, but policy rejects shell features such as pipes, redirects, command lists, background jobs, shell expansion, command substitution, subshells, command groups, globs, and multiline commands. It also blocks executables such as `bash`, `sh`, `git`, `curl`, `docker`, `kubectl`, `rm`, `ssh`, and `wget`.

`run_command` can currently run:

- validator-classified commands, though prompts say to prefer `run_validator`;
- commands configured under `tools.commands.allow` or `tools.commands.allowExact`;
- exact commands approved during the current session.

This design is intentionally not a shell. Once `bash` exists, keeping this separate configured command runner is not worth the model-confusion cost.

## Target Contracts

### `bash`

Purpose: run a real shell command for terminal work that needs shell syntax, one-off user-requested commands, package manager commands, git commands not covered by dedicated git tools, scripts, pipelines, redirects, or chaining.

Suggested args:

```ts
interface BashArgs {
  command: string;
  workdir?: string;
  timeout_ms?: number;
  description?: string;
}
```

Suggested behavior:

- Execute through the user's configured shell, defaulting to `/bin/bash` or the platform default.
- Resolve `workdir` inside the workspace by default.
- Capture stdout/stderr with bounded output and truncation metadata.
- Return exit code, duration, timeout, abort, and permission metadata.
- Mark `workspaceMayHaveChanged: true`.
- Require approval unless an exact/prefix permission already allows the command.
- Deny or require stronger confirmation for known destructive patterns.
- Prefer dedicated tools for file reads, file writes, search, edits, git add/commit, and validators.

### `run_validator`

Purpose: run strict verification commands after edits. This remains the preferred tool for tests, lint, typecheck, build, check, format-check, and smoke checks.

`bash` should not replace `run_validator` in prompts. Failed validator exits are useful evidence and should remain ordinary tool results.

### `inspect_command`

Purpose: quick read-only repo orientation. It should stay narrow and should not become shell execution.

## Cross-Slice Rules

- `run_command` must disappear from the model contract.
- Do not add a `run_command` alias.
- Do not add `run_configured_command`.
- Keep `run_validator` preferred for verification.
- Keep `inspect_command` read-only.
- `bash` needs its own permission model; do not reuse the existing no-shell command policy as-is.
- Deny rules must win over allow rules.
- Non-zero exits from `bash` should be ordinary tool results, not tool execution errors.
- Tool result formatting must make command, cwd, exit code, timeout, and truncation visible.
- Any command execution path should clear or invalidate stale file-read assumptions because the workspace may have changed.
- Approval UX must not rely on model self-certification such as a `requires_approval` boolean.

## Implementation Shape

Delete the configured no-shell command runner:

- remove `src/agent/tools/run-command.ts`;
- remove or heavily simplify `src/agent/tools/command-policy.ts` if it is no longer needed by `run_validator`;
- remove `run_command` registry, prompt, runtime, TUI, hook, config, doc, and test references;
- remove `tools.commands` config unless a bash permission slice deliberately replaces it.

Add `bash` as a new tool:

- create `src/agent/tools/bash.ts`;
- add a separate shell execution helper if `process-runner.ts` is too argv-oriented;
- execute a command string through the configured/default shell;
- capture bounded output with timeout and abort cleanup;
- add `bash` permission logic in a separate module, likely `src/agent/tools/bash-policy.ts`;
- move only useful concepts from `run_command` into bash permissions, such as exact approvals, deny-before-allow behavior, and persisted project rules.

## Files To Change

Likely files:

- `src/agent/tools/registry.ts`
- delete `src/agent/tools/run-command.ts`
- delete or repurpose `src/agent/tools/command-policy.ts`
- `src/agent/tools/process-runner.ts`
- new `src/agent/tools/bash.ts`
- new `src/agent/tools/bash-policy.ts`
- `src/agent/tools/executor.ts`
- `src/agent/prompts.ts`
- `src/agent/profiles.ts`
- `src/agent/runtime.ts`
- `src/tui/messages.ts`
- `src/tui/runtime-events.ts`
- `src/tui/shell-helpers.ts`
- `src/config/index.ts`
- `docs/MODEL_CONFIG.md`
- `docs/cli.md`
- `docs/tui.md`
- `docs/hooks.md`
- `test/tools.test.ts`
- delete or rewrite `test/run-command-tool.test.ts`
- new `test/bash-tool.test.ts`
- `test/commands.test.ts`
- `test/config.test.ts`
- `test/tui.render.test.ts`
- `test/hooks.test.ts`
- relevant smoke scenarios under `scripts/smoke/scenarios/`

## Slices

### Slice 1: Remove `run_command`

Status: `[x]` Done

Goal: Delete the configured command runner from the model-visible contract.

Why here: The new `bash` tool needs a clean namespace. Removing `run_command` first prevents accidental prompt overlap.

This slice should implement:

- Remove `run_command` from the registry and prompts.
- Delete or disable `src/agent/tools/run-command.ts`.
- Remove runtime/TUI/log formatting branches for `run_command`.
- Remove hook matcher examples that target `run_command`.
- Remove or update tests that parse, render, approve, or execute `run_command`.
- Remove `tools.commands` config references unless a later bash-permission slice immediately replaces them.

Expected output:

- `run_command` is not shown to the model.
- Stale `run_command` calls are invalid tool calls, not silently routed elsewhere.
- The repo has no ambiguous generic command-runner name.

Verification:

```sh
pnpm test test/tools.test.ts test/commands.test.ts test/tui.render.test.ts test/hooks.test.ts test/config.test.ts
```

Completed in this slice:

- Removed `run_command` from the registry, exports, runtime formatting, prompts, TUI approval flow, current docs, and tests.
- Deleted `src/agent/tools/run-command.ts`.
- Replaced `tools.commands` config with the bash permission namespace used by later slices.

Verified:

```sh
pnpm test test/bash-tool.test.ts test/tools.test.ts test/commands.test.ts test/tui.render.test.ts test/hooks.test.ts test/config.test.ts test/logging.test.ts
```

Dependencies: none.

### Slice 2: Bash Tool V0 Execution

Status: `[x]` Done

Goal: Add a real `bash` tool that can execute shell command strings with bounded output and workspace-aware execution.

Why here: After `run_command` is gone, `bash` can own actual shell semantics without competing with the old no-shell runner.

This slice should implement:

- Add `bash` args schema: `command`, `workdir`, `timeout_ms`, optional `description`.
- Resolve `workdir` inside the workspace.
- Execute through the configured/default shell.
- Capture stdout/stderr, exit code, duration, timeout, abort, and truncation.
- Kill process groups on timeout/abort where supported.
- Mark `workspaceMayHaveChanged: true`.
- Add focused tests for simple commands, shell syntax, non-zero exits, timeout, abort, missing shell, output truncation, and workspace cwd rejection.

Expected output:

- `bash` can run commands such as `printf hi | wc -c`.
- Non-zero shell exits return structured results.
- Long-running commands time out safely.

Verification:

```sh
pnpm test test/bash-tool.test.ts test/tools.test.ts test/tui.render.test.ts
```

Completed in this slice:

- Added `src/agent/tools/bash.ts` with `command`, `workdir`, `timeout_ms`, and `description` args.
- Executes through the configured/default shell, resolves cwd inside the workspace, captures bounded output, preserves non-zero exits as tool results, and marks `workspaceMayHaveChanged: true`.
- Added tests for shell syntax, non-zero exits, missing executable behavior through the shared runner, workspace cwd rejection, timeout behavior through process runner coverage, and output metadata.

Verified:

```sh
pnpm test test/bash-tool.test.ts test/tools.test.ts test/tui.render.test.ts
```

Dependencies: Slice 1.

### Slice 3: Bash Approval And Permission Rules

Status: `[x]` Done

Goal: Gate `bash` execution with explicit user approval and reusable permission rules.

Why here: A generic shell is too broad to ship as always-on execution. The approval contract must be explicit and testable.

This slice should implement:

- Add session-only approval for exact bash commands.
- Add persisted approval shape if product decision is ready.
- Add deny rules that win over allow rules.
- Generate exact and prefix approval candidates for common commands.
- Require approval for unknown commands.
- Add targeted warnings or stronger confirmation for destructive-looking commands.
- Consider moving `tools.commands.allowExact` and `tools.commands.deny` ideas into the new bash permission shape, not as a separate command tool.
- Ensure model prompts say `bash` is approval-gated and not a substitute for dedicated tools.

Expected output:

- First unapproved `bash` command pauses for approval.
- Approved exact commands resume in the same tool call.
- Denied commands return a clear cancellation/error result.
- Permission decisions are visible in metadata/logs without leaking full output into debug logs.

Verification:

```sh
pnpm test test/commands.test.ts test/bash-tool.test.ts test/tui.render.test.ts test/logging.test.ts test/config.test.ts
```

Completed in this slice:

- Added `src/agent/tools/bash-policy.ts`.
- Added exact session approval, persisted exact repo approval under `tools.bash.allowExact`, prefix allow rules under `tools.bash.allow`, deny-before-allow behavior, approval candidates, and destructive-looking command rejection.
- Renamed the interactive approval path to bash approval and updated `PermissionRequest` hook payloads.

Verified:

```sh
pnpm test test/commands.test.ts test/bash-tool.test.ts test/tui.render.test.ts test/logging.test.ts test/config.test.ts
```

Dependencies: Slice 2.

### Slice 4: Prompt, Profiles, And Tool Selection

Status: `[x]` Done

Goal: Make model behavior predictable with `bash`, `run_validator`, and `inspect_command`.

Why here: The shell tool is powerful; the prompt must keep the model on safer specialized tools when they fit.

This slice should implement:

- Primary prompt guidance:
  - use `run_validator` for verification;
  - use `bash` for arbitrary shell work;
  - use `inspect_command` only for read-only orientation;
  - do not mention `run_command`.
- Profile decisions for subagents and read-only modes.
- Runtime formatting that clearly identifies `bash`.
- Smoke prompt fixtures proving the model is shown the intended examples.

Expected output:

- Tool descriptions do not overlap semantically.
- Read-only subagents do not gain broad `bash` unless explicitly intended.
- TUI labels make shell execution visible and distinct.

Verification:

```sh
pnpm test test/tools.test.ts test/commands.test.ts test/tui.render.test.ts
```

Completed in this slice:

- Updated primary prompt guidance to prefer `run_validator` for verification, use `bash` for arbitrary shell work, keep `inspect_command` read-only, and remove `run_command`.
- Denied `bash` to subagent profiles by default.
- Updated TUI/runtime labels and tool result formatting for `bash`.

Verified:

```sh
pnpm test test/tools.test.ts test/commands.test.ts test/tui.render.test.ts
```

Dependencies: Slices 1-3.

### Slice 5: Config And Docs Cleanup

Status: `[x]` Done

Goal: Document the final command policy configuration and remove stale `run_command` references.

Why here: The docs and config examples currently describe `tools.commands` and `run_command`; those should not survive unchanged.

This slice should implement:

- Update `docs/MODEL_CONFIG.md`, `docs/cli.md`, `docs/tui.md`, and `docs/hooks.md`.
- Remove `run_command` examples.
- Document the final bash permission shape.
- Remove or replace `tools.commands` config docs and tests.
- Update hook docs for `bash` matchers.

Expected output:

- The docs describe the final pre-alpha command-tool contract.
- Config examples point to `bash` permissions and `run_validator`, not `run_command`.

Verification:

```sh
pnpm test test/config.test.ts test/hooks.test.ts
```

Completed in this slice:

- Updated `docs/MODEL_CONFIG.md`, `docs/cli.md`, `docs/tui.md`, `docs/config.md`, and `docs/hooks.md`.
- Replaced `tools.commands` docs and tests with `tools.bash`.
- Updated hook examples and matchers to `bash`.

Verified:

```sh
pnpm test test/config.test.ts test/hooks.test.ts
```

Dependencies: Slices 1 and 3.

### Slice 6: End-To-End Smoke Coverage

Status: `[x]` Done

Goal: Prove the full model/tool loop can use `bash` and still prefers `run_validator` for verification.

Why here: This is a behavior change in agent capability, not just a unit-tested helper.

This slice should implement:

- Add smoke scenario for approved `bash` usage.
- Add smoke scenario or fixture proving `run_validator` remains preferred for tests.
- Add smoke scenario proving stale `run_command` is absent from model-visible tools.

Expected output:

- `topchester run` can execute a bash command through the real runtime path.
- Approval and result feedback are visible to the model.
- The model can continue after a failed shell exit.

Verification:

```sh
pnpm test test/cli.integration.test.ts
pnpm run smoke -- --fake-api --scenario <new-bash-scenario>
```

Completed in this slice:

- Added `scripts/smoke/scenarios/20-bash`.
- Updated the fake API so the scenario fails if `run_command` is still visible in the model prompt and succeeds only through `bash`.
- Kept existing `17-run-validator` smoke coverage for validator preference.

Verified:

```sh
pnpm test test/cli.integration.test.ts
pnpm run smoke --fake-api --scenario 20-bash
```

Dependencies: Slices 1-5.

## Testing Plan

Per-slice verification is listed above. Final verification should include:

```sh
pnpm test
pnpm check
pnpm format
```

If `bash` touches smoke scenarios or CLI approval flow, also run the relevant fake-API smoke scenario through `topchester run`.

## Open Questions

Resolved in implementation:

1. Persisted bash approvals live under `tools.bash`.
2. V0 persists exact approvals only. Prefix permissions are config-supported but not written by the TUI approval action.
3. `bash` uses `tools.bash.shell` when configured, otherwise the user's `SHELL`, then `/bin/bash` or `cmd.exe`.
4. `bash` is not available to subagents by default.
5. Exact allow, prefix allow, deny-before-allow, and session approval ideas moved from `tools.commands` into bash permissions. The old no-shell configured command policy was not preserved.

## Running Findings

- 2026-06-01: User clarified Topchester has zero users and is pre-alpha, so compatibility should not shape the plan. `run_command` should not get an alias or transition window.
- 2026-06-01: Decision recorded: delete `run_command`; do not add `run_configured_command`; move useful hints to `bash` permissions only if needed.
- 2026-06-01: Implemented all slices. Final verification passed: `pnpm test`, `pnpm test test/cli.integration.test.ts`, `pnpm run smoke --fake-api --scenario 20-bash`, `pnpm run smoke --fake-api --scenario 17-run-validator`, and `mise run local-ci`. `mise run local-ci` still reports one pre-existing oxlint warning in `test/skills.test.ts`.

## Next Slice

None. All planned slices are implemented and verified.
