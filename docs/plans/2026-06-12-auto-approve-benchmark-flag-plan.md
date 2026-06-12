# Auto Approve Benchmark Flag Plan

## Summary

Add an explicit flag that lets benchmark and automation runs auto-allow user approval prompts. The target outcome is that a benchmark can run without stopping for interactive approval when the agent calls `bash` or future prompt-gated tools.

This plan exists because the behavior crosses runtime permission handling, TUI and headless CLI entrypoints, hooks, logs, JSON run output, docs, and tests. The implementation should not loosen hard safety policy by accident.

## Decisions

- Implement the feature as a runtime approval mode, not as another `tools.bash.allow` rule.
- Start with `bash`, because it is the current tool with a first-class user approval prompt.
- Design the runtime contract so future prompt-gated tools can use the same approval mode.
- Auto-approve should only bypass prompts that would otherwise ask the user. It must not bypass hard rejects such as deny rules, destructive command detection, invalid arguments, workspace boundary failures, or profile/tool-catalog denial.
- Keep `PermissionRequest` hooks in the path before an auto-allow decision. Hooks may still `block` or `stop`.
- Prefer a scary, explicit CLI flag for benchmark usage, such as `--dangerously-auto-approve`, over a quiet project config default.
- Do not persist auto-approved commands into `topchester.jsonc`.
- Log and expose auto-approval decisions in run JSON so benchmark artifacts show that prompts were bypassed.

## Scope

Included:

- A headless benchmark/automation flag for `topchester run`.
- A runtime option that represents approval behavior independently from the TUI callback.
- Auto-approval for bash commands that currently return `approvalRequired: true`.
- Hook payload metadata that marks permission prompts as auto-approved.
- JSON and plain run output that make auto-approval visible enough for debugging.
- Tests for runtime, CLI run, hooks, and bash policy integration.
- Docs updates for CLI automation and risk boundaries.

Out of scope for the first implementation:

- Making auto-approve a persisted project or user config setting.
- Auto-allowing hard policy rejections.
- Removing or weakening `tools.bash.deny`.
- Auto-approving TUI modals by default.
- Generalizing every possible future user prompt before another prompt-gated tool exists.
- Benchmark harness changes beyond exposing the flag that the harness can use.

## Current State

Relevant files and behavior:

- `src/agent/runtime/index.ts` owns `resolveBashApproval(...)`, which pre-validates bash calls, runs `PermissionRequest` hooks, asks `options.requestBashApproval`, and then passes approved exact commands into tool execution.
- `src/agent/tools/bash-policy.ts` distinguishes hard rejects from approval-required decisions. Unknown non-destructive commands return `approvalRequired: true`.
- `src/agent/tools/bash.ts` executes only after `validateBashPolicy(...)` returns an allowed decision.
- `src/tui/shell.ts` provides the interactive `requestBashApproval(...)` callback and shows the approval modal.
- `src/cli/run.ts` currently calls `runtime.submitMessageStream(...)` without `requestBashApproval`, so approval-required bash calls are returned as tool errors rather than interactively approved.
- `src/cli.ts` parses the global and `run` command flags.
- Existing docs describe `bash` as approval-gated and `topchester run` as the automation entrypoint.

KB entries consulted:

- `topchester-kb/l1-files/src/agent/runtime/index.ts.json`
- `topchester-kb/l1-files/src/cli/run.ts.json`
- `topchester-kb/l1-files/src/tui/shell.ts.json`
- `topchester-kb/l1-files/src/agent/tools/bash-policy.ts.json`

## Target Behavior

Normal behavior remains unchanged:

```text
topchester run "use bash to inspect node version"
  -> unknown bash command requires approval
  -> no interactive callback in headless run
  -> model receives a tool error
```

Benchmark behavior:

```text
topchester run --dangerously-auto-approve "use bash to inspect node version"
  -> unknown bash command requires approval
  -> PermissionRequest hooks run with auto-approval metadata
  -> if hooks do not block/stop, runtime treats the command as approved for this tool call
  -> bash executes without persisting an allow rule
```

Hard rejects remain hard rejects:

```text
topchester run --dangerously-auto-approve "run rm -rf ."
  -> bash policy rejects destructive-looking command
  -> no prompt exists to auto-approve
  -> command does not run
```

## Recommended Approach

Introduce a generic runtime approval mode:

```ts
type UserApprovalMode = "interactive" | "auto_allow";

interface AgentRuntimeSubmitMessageOptions {
  requestBashApproval?: (request: BashApprovalRequest) => Promise<BashApprovalDecision>;
  userApprovalMode?: UserApprovalMode;
}
```

`resolveBashApproval(...)` should stay the central bash approval gate in V0:

1. Parse and validate bash args.
2. Call `validateBashPolicy(...)`.
3. Return immediately for already-allowed commands or hard rejects.
4. For approval-required decisions, run `PermissionRequest` hooks.
5. If hooks block or stop, preserve current behavior.
6. If `userApprovalMode === "auto_allow"`, approve only this command for this tool call and emit/log auto-approval metadata.
7. Otherwise use `requestBashApproval(...)` when provided.
8. Otherwise preserve current headless behavior.

This keeps shell execution protected by the existing `bash` tool's second validation pass: the runtime supplies a one-call approved exact command, and `bash.ts` still validates it before execution.

## Cross-Slice Rules

- Auto-approve mode must never turn a hard rejection into an allowed execution.
- Deny rules win over auto-approve.
- Destructive pattern checks win over auto-approve.
- Workspace boundary checks win over auto-approve.
- Hooks still run before an auto-approved permission prompt and can block or stop.
- Auto-approved commands should be scoped to the current tool execution unless the implementation deliberately adds session scoping later.
- Auto-approval must be visible in logs and JSON run events.
- The model prompt should not tell the model that safety policy is disabled.
- Use exact command approval for bash. Do not generate prefix approvals from auto-approve.

## Files To Change

Likely files:

- `src/agent/runtime/index.ts`
- `src/cli/run.ts`
- `src/cli.ts`
- `src/agent/events.ts` or runtime event formatting if a new auto-approval event is added
- `src/session/runtime-payloads.ts` if the event should persist
- `src/tui/shell.ts` only if interactive global flag support is added
- `docs/cli.md`
- `docs/reference/cli.md`
- `docs/hooks.md`
- `docs/config.md`
- `test/commands.test.ts`
- `test/hooks.test.ts`
- `test/cli.integration.test.ts`
- `test/bash-tool.test.ts` only if policy helper behavior changes

## Slices

### Slice 1: Runtime Approval Mode Contract

Status: `[x]` Done

Goal: Add a runtime-level approval mode without changing default behavior.

Why here: The runtime owns the decision point where user approval is requested. A central mode avoids putting benchmark behavior inside the TUI or bash tool itself.

This slice should implement:

- Add `UserApprovalMode` or equivalent to runtime submit options.
- Default to current interactive behavior when the option is omitted.
- Teach `resolveBashApproval(...)` to auto-allow approval-required bash calls only when the mode is enabled.
- Keep the existing `requestBashApproval(...)` path unchanged.
- Add structured metadata for auto-approved decisions, either as an event or log fields.

Expected output:

- Runtime tests can enable auto-approval without constructing a TUI approval callback.
- Existing approval tests keep passing.
- Unknown bash commands can execute in auto-approve mode.
- Denied/destructive bash commands still fail.

Verification:

```sh
mise run local-ci
```

Completed notes:

- Added `UserApprovalMode = "interactive" | "auto_allow"` to runtime submit options.
- Auto-allow is handled in `resolveBashApproval(...)` after bash policy validation and `PermissionRequest` hooks.
- Auto-approved bash commands are added only to the current tool execution's exact-command approval list.
- Runtime coverage proves approval-required bash executes in auto-allow mode and destructive bash policy rejects are not auto-approved.

Dependencies: none.

### Slice 2: Hook And Observability Semantics

Status: `[x]` Done

Goal: Preserve hook behavior and make bypassed prompts auditable.

Why here: Benchmarks need unattended execution, but hooks are part of Topchester's permission request contract and should not silently disappear.

This slice should implement:

- Keep `PermissionRequest` hook execution before auto-approval.
- Add payload fields such as `approval_mode: "auto_allow"` and `auto_approved: true` when auto-approve will be used.
- Ensure hook `block` still returns a tool error and hook `stop` still ends the turn.
- Emit a runtime event or log entry for auto-approved permission requests.
- Include enough command/workdir/reason metadata in JSON run output for benchmark auditing without dumping sensitive command output twice.

Expected output:

- Hook tests prove `PermissionRequest` still fires under auto-approve mode.
- Hook block/stop behavior is unchanged.
- Benchmark JSON artifacts show when a prompt was auto-approved.

Verification:

```sh
mise run local-ci
```

Completed notes:

- `PermissionRequest` hooks still run before auto-approval.
- Auto-approval hook payloads include `approval_mode: "auto_allow"` and `auto_approved: true`.
- Hook `block` prevents auto-approved bash execution and returns a tool error.
- Runtime JSON/session output includes a `permission_auto_approved` event with command, workdir, reason, tool, call id, and approval mode.

Dependencies: Slice 1.

### Slice 3: `topchester run` Flag

Status: `[x]` Done

Goal: Expose the runtime mode through the headless automation command.

Why here: The benchmark needs a non-interactive entrypoint, and `topchester run` is already the automation surface.

This slice should implement:

- Add `--dangerously-auto-approve` to `topchester run`.
- Add a `dangerouslyAutoApprove?: boolean` field to `RunCommandOptions`.
- Pass `userApprovalMode: "auto_allow"` to `submitMessageStream(...)` when the flag is present.
- Include the flag state in `run.started` JSON metadata and logs.
- Keep slash commands unaffected unless they later call prompt-gated runtime tools.

Expected output:

- `topchester run --dangerously-auto-approve ...` can complete benchmark tasks that require bash approval.
- `topchester run ...` without the flag behaves exactly as before.
- CLI help names the risk clearly.

Verification:

```sh
mise run local-ci
```

Completed notes:

- Added `topchester run --dangerously-auto-approve`.
- Added `dangerouslyAutoApprove?: boolean` to run command options.
- `topchester run` passes `userApprovalMode: "auto_allow"` only when the flag is present.
- `run.started` JSON/log metadata records `dangerouslyAutoApprove`.
- CLI help exposes the flag with dangerous wording.

Dependencies: Slices 1 and 2.

### Slice 4: Optional Interactive Wiring

Status: `[x]` Done

Goal: Decide whether the global TUI also needs the flag.

Why here: The user asked for benchmark support, which likely uses `topchester run`; interactive support may be useful but increases blast radius.

This slice should implement only if needed:

- Accept a global `--dangerously-auto-approve` or `--dev auto-approve` flag for plain `topchester`.
- Surface the mode visibly in the TUI status or startup messages.
- Auto-approve prompt-gated tool calls without rendering approval modals.
- Keep modal behavior unchanged when the flag is absent.

Expected output:

- Interactive benchmark/manual sessions can run without approval modals when explicitly launched in auto-approve mode.
- Users can see that the session is in an unsafe approval mode.

Verification:

```sh
mise run local-ci
```

Completed notes:

- V0 keeps auto-approval headless-only. The benchmark requirement is satisfied through `topchester run`, and interactive TUI modal behavior stays unchanged.
- Runtime event rendering handles auto-approval events so the shared event union remains exhaustive.

Dependencies: Slices 1 and 2.

### Slice 5: Docs And Benchmark Notes

Status: `[x]` Done

Goal: Document how to use the flag and what it does not bypass.

Why here: The flag is intentionally dangerous and should not be mistaken for a normal config convenience.

This slice should implement:

- Update CLI docs and reference CLI docs with the new flag.
- Add a short benchmark note showing the intended command form.
- Document that hard policy rejects, deny rules, workspace boundaries, and hook blocks still apply.
- Document that auto-approved bash commands are not persisted to `topchester.jsonc`.

Expected output:

- Future benchmark work can use the flag without rediscovering behavior.
- Users understand that this is an explicit automation mode, not a project policy setting.

Verification:

```sh
mise run local-ci
```

Completed notes:

- Updated `docs/cli.md` and `docs/reference/cli.md` with the flag and benchmark command form.
- Updated bash permission/config docs to say auto-approval is runtime-only and not persisted to `topchester.jsonc`.
- Updated hook docs to describe auto-approval payload metadata.
- Documented that hard rejects, deny rules, workspace boundaries, and hook blocks still apply.

Dependencies: Slice 3, and Slice 4 if interactive wiring is included.

## Final Verification

Run the focused suites and the repo-standard checks after implementation:

```sh
mise run local-ci
```

For benchmark validation, run a temporary fixture with an unknown but non-destructive bash command through `topchester run --dangerously-auto-approve` and confirm:

- no interactive prompt appears;
- `PermissionRequest` hooks still run;
- the command executes;
- JSON output records the auto-approval mode;
- the same command without the flag still follows existing headless behavior.

Completed verification:

- Focused runtime, hook, CLI, and bash-policy suites passed after implementation.
- Temporary fake-API fixture with `topchester run --dangerously-auto-approve` ran an unknown non-destructive bash command without a config allow rule, emitted `permission_auto_approved`, and recorded `dangerouslyAutoApprove: true`.
- Matching fixture without the flag returned the existing headless bash approval error and emitted no `permission_auto_approved` event.
- `mise run local-ci` passed.

## Open Questions

- Should the final flag name be `--dangerously-auto-approve`, `--auto-approve`, or a hidden benchmark-only `--dev auto-approve` flag?
- Should auto-approved bash commands be valid only for the single tool call, or for the rest of the session?
- Should `topchester run` return a distinct exit code when an auto-approved prompt was blocked by a hook?
- Should auto-approval be available for plain interactive `topchester`, or should V0 keep it headless-only?
- What is the next prompt-gated tool after `bash`, and does it need a generic approval request type before implementation?
