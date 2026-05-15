# Run Command And Validator Tool Plan

## Summary

Implement first-class command verification for Topchester's coding-agent loop.

The target outcome is that the agent can edit code, run the narrow test/lint/typecheck/build command that proves the edit, use the output to continue fixing issues, and report the final verification result without asking the user to run the command outside Topchester.

This plan follows the first item in `docs/plans/2026-05-13-alpha-tool-gap-analysis-plan.md`: add `run_command` / `run_validator`, keep `inspect_command` read-only, and make verification visible in the TUI.

## Decisions

- Ship `run_validator` before broad `run_command`.
- Implement command execution in TypeScript application code with direct process spawning, not through the user's shell.
- Accept shell-shaped command strings for model usability, but parse and classify them before execution.
- Reject shell features that require a real shell in V0: redirects, heredocs, command substitution, variables, globs, background jobs, functions, aliases, and multiline scripts.
- Treat non-zero validator exit codes as normal tool results, not tool execution errors. Failed tests are evidence the agent should use.
- Use a strict built-in command policy for V0 instead of a human approval flow.
- Do not use the existing `choice` modal as a fake approval system. It submits a new user message; it does not resume the same blocked tool call.
- Add a real approval slice later if broader command execution needs same-turn user approval.
- Keep `inspect_command` as a read-only orientation tool. Do not loosen it to run tests, builds, installs, scripts, or project commands.
- Prefer `run_validator` for test/lint/typecheck/build/check/smoke commands even when `run_command` exists.
- Do not add PTY support, persistent terminals, long-running dev servers, package installs, network commands, Docker, deploys, or destructive commands in the first implementation.

## Scope

Included:

- Shared bounded process runner with workspace-scoped `cwd`, timeout, abort, process-tree cleanup, output truncation, and stdout/stderr capture.
- `run_validator` model tool for common verification commands.
- `run_command` model tool only for commands allowed by strict policy or project config.
- Command parser/policy that classifies validator commands and rejects risky or unknown commands.
- Package manager detection for `pnpm`, `npm`, `yarn`, and `bun`.
- Package-script validation against `package.json` near the selected `workdir`.
- Structured result metadata: command, cwd, exit code, duration, timeout, truncation, stdout, stderr, and policy decision.
- Runtime prompt formatting and compact TUI labels.
- Logging that records command metadata at debug level and full output only at trace level.
- Tests for parser policy, process execution, timeout, truncation, non-zero exit handling, prompt guidance, runtime formatting, and TUI rendering.
- CLI/TUI docs updates.
- A fake-API smoke scenario that proves the agent can run a validator through the real `topchester run` loop.

Not included:

- A general shell.
- Interactive commands or PTY/persistent terminal sessions.
- Human approval UI for command execution.
- Installing dependencies.
- Network fetch/search.
- Docker/Kubernetes/process manager commands.
- File deletion, moving, chmod, or broad mutation through shell commands.
- Streaming stdout into the TUI while the command is still running.
- Automatic KB sync after commands.

## Current State

Topchester currently exposes these relevant tools:

- `read_file`, `list_files`, `grep`, and `find_file` for workspace inspection.
- `edit_file` and `write_file` for workspace text mutations with KB/session-overlay dirty state.
- `git_status`, `git_diff`, `git_log`, `git_add`, and `git_commit` for structured Git workflows.
- `inspect_command` for a small allowlisted set of read-only discovery commands.
- `plan_todo` for visible session task plans.
- `task` for child-agent exploration.

Important implementation surfaces:

- `src/agent/tools/types.ts` defines `ToolContext`, `ToolResult`, and `ToolDefinition`.
- `src/agent/tools/registry.ts` registers model-visible tools and feeds prompt lines.
- `src/agent/tools/executor.ts` runs tools and logs tool metadata.
- `src/agent/tools/inspect-command.ts` already has process spawning, timeout cleanup, output truncation, and stderr/stdout formatting.
- `src/agent/tools/inspect-command-policy.ts` already has a strict parser/policy shape for read-only command snippets.
- `src/agent/runtime.ts` runs the tool loop, formats tool results into the next model prompt, and formats compact TUI labels.
- `src/agent/prompts.ts` tells the model to use dedicated tools and says `inspect_command` is not a shell.
- `src/agent/profiles.ts` controls which tools are available in primary and subagent profiles. Read-only subagents should not get command execution by default.
- `src/tui/runtime-events.ts` and `src/tui/messages.ts` render tool rows.
- `src/session/runtime-payloads.ts` persists tool-call events but not full tool-result output.
- `src/config/index.ts` supports layered `topchester.jsonc` config with `models` and `ignore.paths`, but no command policy yet.
- `docs/cli.md` and `docs/tui.md` list the current agent tool behavior.

Current constraints:

- Tool rows are emitted after ordinary tool completion. Long-running validators will show the normal busy state until the result row appears.
- Existing modal choices are one-way UI actions. They are useful for "continue or abort" prompts, but not enough for a blocked tool waiting on approval.
- Command execution can change files even when the intended use is validation. V0 should not mark command side effects as dirty-known edits because it does not know exactly what changed.

## Competitor Findings

Local checkouts were inspected as required by `AGENTS.override.md`.

### Codex

Relevant files:

- `/Users/kodi/data/github/codex/codex-rs/core/src/tools/handlers/shell_spec.rs`
- `/Users/kodi/data/github/codex/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs`
- `/Users/kodi/data/github/codex/codex-rs/shell-command/src/command_safety/is_safe_command.rs`

Useful patterns:

- Exposes command execution as a first-class tool with `cmd`, `workdir`, timeout/yield controls, output truncation, and optional approval fields.
- Has a known-safe command classifier for conservative auto-approval.
- Supports command arrays and shell-shaped input, but routes risky permissions through an explicit approval/sandbox policy.
- Treats approval parameters as a real protocol surface, not model self-certification.

Topchester should copy the structured metadata and explicit policy split, but should not start with a full shell or sandbox override system.

### OpenCode

Relevant files:

- `/Users/kodi/data/github/opencode/packages/opencode/src/tool/shell.ts`
- `/Users/kodi/data/github/opencode/packages/opencode/src/tool/shell/shell.txt`
- `/Users/kodi/data/github/opencode/packages/opencode/src/permission/index.ts`

Useful patterns:

- Uses a broad shell tool for terminal operations like git, package managers, and Docker.
- Uses tree-sitter parsing to scan paths and permission patterns before execution.
- Uses a permission bus with pending requests and replies.
- Explicitly tells the model not to use shell for file read/write/search when specialized tools exist.
- Captures timeout, output truncation, and metadata.

Topchester should copy the "use specialized tools first" guidance and pending-request concept, but not the broad default shell surface.

### Cline

Relevant files:

- `/Users/kodi/data/github/cline/src/core/prompts/system-prompt/tools/execute_command.ts`
- `/Users/kodi/data/github/cline/src/core/permissions/CommandPermissionController.ts`
- `/Users/kodi/data/github/cline/src/core/permissions/types.ts`

Useful patterns:

- Exposes `execute_command` with a required `requires_approval` field.
- Validates chained command segments separately.
- Has allow/deny command patterns and blocks redirects unless configured.
- Blocks command-substitution and shell-operator tricks when they could bypass permissions.

Topchester should copy segment-level validation and config-backed deny behavior, but should not trust a model-provided `requires_approval` flag as the only safety gate.

### Pi

Relevant files:

- `/Users/kodi/data/github/pi/packages/coding-agent/src/core/tools/bash.ts`
- `/Users/kodi/data/github/pi/packages/coding-agent/src/core/bash-executor.ts`
- `/Users/kodi/data/github/pi/packages/coding-agent/src/core/agent-session.ts`
- `/Users/kodi/data/github/pi/packages/coding-agent/src/core/tools/index.ts`

Useful patterns:

- Has bash as one of the default coding tools next to read/edit/write.
- Uses an abortable command executor, process-tree cleanup, rolling output buffer, truncation, and optional full-output storage.
- Records command execution as its own session message type.

Topchester should copy the abort/output discipline. It should not add full-output persistence in V0 unless the UI needs it, because Topchester currently keeps session logs compact.

### Kilo Code

Relevant files:

- `/Users/kodi/data/github/kilocode/packages/opencode/src/tool/bash.ts`
- `/Users/kodi/data/github/kilocode/packages/opencode/src/permission/index.ts`

Useful patterns:

- OpenCode-derived broad bash tool with stronger session/hard-rule permission handling.
- Keeps command permission decisions as structured data and supports saved/session approvals.

Topchester should treat this as evidence that durable command permissions matter, but keep the first implementation smaller and stricter.

## Recommended Contract

### `run_validator`

Use this for tests, lint, typecheck, build, format checks, smoke checks, and package-defined verification scripts.

Suggested tool call:

```json
{
  "tool": "run_validator",
  "args": {
    "command": "pnpm test test/tools.test.ts",
    "validator": "test",
    "workdir": ".",
    "timeout_ms": 120000
  }
}
```

Suggested args:

```ts
interface RunValidatorArgs {
  command: string;
  validator?: "test" | "lint" | "typecheck" | "format_check" | "build" | "check" | "smoke";
  workdir?: string;
  timeout_ms?: number;
}
```

Default `timeout_ms`: `120000`.

Maximum `timeout_ms`: `600000`.

The `validator` field is optional model help. Policy should infer the kind from the command and fail if an explicitly provided kind conflicts with the command.

Allowed V0 examples:

```sh
pnpm test
pnpm test test/tools.test.ts
pnpm test -- test/tools.test.ts
pnpm typecheck
pnpm lint
pnpm build
pnpm check
pnpm run format:check
pnpm run smoke -- --fake-api --trials 1
npm test
npm test -- test/tools.test.ts
npm run lint
npm run typecheck
npm run build
yarn test
yarn test test/tools.test.ts
yarn run lint
yarn run typecheck
bun test
bun test test/tools.test.ts
bun run lint
bun run typecheck
```

Rejected V0 examples:

```sh
pnpm install
npm publish
pnpm format
curl https://example.com
docker compose up
rm -rf dist
bash -lc "pnpm test"
pnpm test && git status
```

### `run_command`

Use this for non-validator project commands only when the command policy allows them. The model prompt should still prefer dedicated tools for reads, edits, Git, and validators.

Suggested tool call:

```json
{
  "tool": "run_command",
  "args": {
    "command": "node scripts/check-fixtures.mjs",
    "workdir": ".",
    "timeout_ms": 30000
  }
}
```

Suggested args:

```ts
interface RunCommandArgs {
  command: string;
  workdir?: string;
  timeout_ms?: number;
}
```

Default `timeout_ms`: `30000`.

Maximum `timeout_ms`: `300000`.

V0 should allow only:

- Commands classified as validators, although the prompt should prefer `run_validator`.
- Project-local commands explicitly allowed by `topchester.jsonc` command policy.

Everything else should fail with a clear policy reason.

### Result Shape

Both tools should return the same base result shape:

```ts
interface CommandToolResult<Name extends "run_validator" | "run_command"> extends ToolResult<Name> {
  command: string;
  cwd: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
  policy: {
    allowed: true;
    reason: string;
    kind: "validator" | "configured_command";
    commands: string[];
  };
}
```

Suggested model-facing content:

```text
stdout:
...

stderr:
...

metadata:
command: pnpm test test/tools.test.ts
cwd: .
exit_code: 1
duration_ms: 2184
timed_out: false
truncated: false
policy: validator test command
```

Non-zero exit codes should not throw. Policy rejection, invalid workdir, spawn failure, missing executable, timeout mechanics failure, or malformed command should throw a normal tool error.

## Command Policy

Add a policy module rather than spreading command checks across tools.

Suggested file:

- `src/agent/tools/command-policy.ts`

Responsibilities:

- Parse command strings using a small safe grammar.
- Reject unsupported shell syntax early.
- Resolve `workdir` inside the workspace.
- Find the nearest `package.json` at or above `workdir` but not above the workspace root.
- Detect package manager from `packageManager`, lockfiles, and command prefix.
- Validate package scripts against the discovered `package.json`.
- Classify commands by policy kind and validator kind.
- Return a normalized direct-spawn plan: executable, args, display command, cwd, timeout, and policy metadata.

Policy should not execute anything.

### Package Manager Support

The implementation must not be pnpm-only. V0 should support `pnpm`, `npm`, `yarn`, and `bun` as first-class package-manager prefixes.

Detection should use:

- `package.json` `packageManager`, such as `pnpm@11.0.8`, `npm@10.9.0`, `yarn@4.12.0`, or `bun@1.3.0`.
- Lockfiles: `pnpm-lock.yaml`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `bun.lock`, and `bun.lockb`.
- The explicit command prefix when the model/user already chose one.

Policy should validate the script name against `package.json` regardless of package manager. For example, all of these are script-backed validator forms when the matching script exists:

```sh
pnpm test
pnpm run test
npm test
npm run test
yarn test
yarn run test
bun run test
```

Argument handling should preserve the package-manager conventions:

- `pnpm <script> ...` and `pnpm run <script> ...` may pass script args after the script name, and `--` should be preserved when present.
- `npm run <script> -- ...` and `npm test -- ...` should preserve args after `--`.
- `yarn <script> ...` and `yarn run <script> ...` should preserve args after the script name.
- `bun test ...` is a built-in validator command; `bun run <script> ...` is script-backed and should be validated against `package.json`.

The policy should not require projects to use the same package manager as Topchester's own checkout. If a project has no clear package-manager signal, explicit `npm`, `pnpm`, `yarn`, or `bun` commands are still valid when the requested script exists and the command is otherwise safe.

### Parser Rules

Start from the existing `inspect_command` parser behavior, but keep validator commands simpler:

- Allow one simple command with words and quoted words.
- Reject pipelines and command lists in `run_validator`.
- Reject redirects, heredocs, command substitution, variables, globs, background jobs, multiline scripts, subshells, and functions.
- Reject `cd`; use `workdir`.
- Reject executable paths outside the workspace unless they are discovered from PATH by executable name.

`run_command` may later allow command lists only if every segment is separately classified and the output semantics are clear. Do not add that in the first working slice.

### Validator Classification

V0 should recognize these categories:

- `test`: `test`, `test:*`, `vitest`, `jest`, `mocha`, `node --test`
- `lint`: `lint`, `lint:*`, `eslint`, `oxlint`, `biome lint`
- `typecheck`: `typecheck`, `type:check`, `tsc --noEmit`, `tsgo --noEmit`
- `format_check`: `format:check`, `format-check`, `prettier --check`, `oxfmt --check`, `biome format --check`
- `build`: `build`, `build:*`
- `check`: `check`, `ci`, `verify`
- `smoke`: `smoke`, `smoke:*`

Policy should prefer package scripts over guessing binaries. For example, `pnpm check` is allowed when `package.json` has a `check` script, even if that script chains multiple checks internally.

### Project Config

Add a command-policy section only when `run_command` is implemented.

Suggested config shape:

```jsonc
{
  "tools": {
    "commands": {
      "allow": ["node scripts/check-fixtures.mjs", "pnpm exec tsx scripts/dev/inspect-config.ts"],
      "deny": ["pnpm publish", "npm publish", "rm *"],
    },
  },
}
```

Rules:

- Deny wins over allow.
- Patterns match normalized command display strings, not raw shell text.
- Patterns should be command-prefix style, not filesystem ignore patterns.
- Do not let config rules approve workspace escapes in `workdir`.
- Do not add saved "always allow" approvals in this plan.

## Process Runner

Add a shared runner so `inspect_command`, `run_validator`, and `run_command` do not each grow their own process lifecycle code.

Suggested file:

- `src/agent/tools/process-runner.ts`

Responsibilities:

- Spawn direct executable plus args.
- Never invoke a shell by default.
- Resolve executable through `PATH`.
- Set `cwd` to a real path inside the workspace.
- Use `stdio: ["ignore", "pipe", "pipe"]`.
- Pass `PAGER=cat`, `GIT_PAGER=cat`, and `LESS=-F -X`.
- For `run_validator`, set `CI=1` and `NO_COLOR=1` unless the user config later opts out.
- Capture stdout and stderr separately.
- Strip unsafe control characters.
- Bound output by bytes and lines.
- Kill the process group on timeout or abort.
- Return `exitCode`, `durationMs`, `timedOut`, `truncated`, `stdout`, and `stderr`.

Keep `inspect_command` behavior unchanged when migrating it onto the shared runner. Its tests are the compatibility contract.

## Runtime And TUI Behavior

Prompt guidance:

- Tell the model to use `run_validator` after code edits when a relevant test/check exists.
- Tell the model that `run_validator` is for tests, lint, typecheck, build, check, and smoke scripts.
- Tell the model that failed validators are useful evidence and it should inspect the output before retrying.
- Tell the model not to use `inspect_command` for validators.
- Tell the model not to use `run_command` for file reads, file writes, Git inspection, or validation when a better tool exists.
- Tell the model not to run installs, deploys, network commands, destructive commands, or interactive commands.

TUI labels:

```text
run_validator: pnpm test test/tools.test.ts (exit 0, 2.1s)
run_validator: pnpm test (exit 1, 4.8s)
run_validator: pnpm check (timed out, 120.0s)
run_command: node scripts/check-fixtures.mjs (exit 0, 0.7s)
```

Model-facing result formatting should include stdout and stderr. The compact TUI row should not print full command output in the thread in V0.

`topchester run --json` should include the tool-call event as it does for other tools. Do not add full stdout/stderr to session events unless a later UI needs durable result inspection.

## KB And Dirty State

Command execution may change files. The tool should not pretend those changes are dirty-known agent edits.

V0 behavior:

- `run_validator` and `run_command` do not record file mutation events in the session overlay.
- The result may include `workspaceMayHaveChanged: true` for build/check/smoke/run_command categories.
- Prompt guidance should tell the model to inspect `git_status` after commands that may write files or after any surprising validator output.
- KB status remains content-aware through existing `/kb status` and startup checks. Do not auto-run `/kb sync` after validators.

Future behavior:

- Add a pre/post workspace snapshot if command side effects become common enough to need automatic dirty detection.
- Consider a cheap Git-status diff around command execution for Git workspaces, but do not block the first implementation on it.

## Files to Add

- `src/agent/tools/process-runner.ts`
- `src/agent/tools/command-policy.ts`
- `src/agent/tools/run-validator.ts`
- `src/agent/tools/run-command.ts`
- `test/run-command-tool.test.ts`
- `scripts/smoke/scenarios/17-run-validator/config.json`
- `scripts/smoke/scenarios/17-run-validator/template/package.json`

## Files to Change

- `src/agent/tools.ts`
- `src/agent/tools/registry.ts`
- `src/agent/tools/executor.ts`
- `src/agent/tools/inspect-command.ts`
- `src/agent/tools/inspect-command-policy.ts` if parser helpers are shared
- `src/agent/tools/inspect-command-parser.ts` if parser helpers are shared
- `src/agent/tools/types.ts` if shared command result typing needs widening
- `src/agent/profiles.ts`
- `src/agent/prompts.ts`
- `src/agent/runtime.ts`
- `src/tui/runtime-events.ts` only if labels need extra result summaries
- `src/tui/messages.ts` only if command rows need special styling
- `src/session/events.ts` only if full command result events are added later
- `src/session/runtime-payloads.ts` only if full command result events are added later
- `src/config/index.ts`
- `test/tools.test.ts`
- `test/commands.test.ts`
- `test/tui.render.test.ts`
- `test/logging.test.ts`
- `test/config.test.ts`
- `scripts/smoke/fake-api.ts`
- `docs/cli.md`
- `docs/tui.md`
- `docs/plans/kb-implementation-checklist.md`

## Cross-Slice Rules

- Keep `inspect_command` read-only.
- Keep command execution workspace-scoped.
- Do not run commands through the user's shell in V0.
- Do not trust model-provided approval flags.
- Treat non-zero validator exits as evidence, not runtime failure.
- Do not log stdout/stderr at debug level.
- Do not persist full command output in session logs in V0.
- Keep read-only subagents from using `run_validator` or `run_command` by default.
- Prefer repo-standard tests and package scripts over invented command guesses.
- Keep docs updated in the same implementation change that exposes a new user-visible tool.

## Slices

### Slice 1: Shared Process Runner

Status: `[x]` Completed

Completed in Slice 1:

- Added `src/agent/tools/process-runner.ts` with direct spawn, PATH lookup, workspace cwd resolution, env overrides, timeout, abort, process-group cleanup, bounded output capture, and control-character stripping.
- Migrated `inspect_command` to the shared runner while keeping its public result shape and warning strings unchanged.
- Added focused runner coverage in `test/inspect-command-tool.test.ts`.

Verification:

```sh
pnpm test test/inspect-command-tool.test.ts test/tools.test.ts
```

Goal: Add a reusable process runner and prove it matches the current `inspect_command` execution behavior.

Why here: `run_validator` needs timeout, abort, truncation, stdout/stderr, and process cleanup. That should be hardened before policy and model prompt changes make commands visible.

This slice should implement:

- Add `src/agent/tools/process-runner.ts`.
- Support direct spawn, PATH lookup, workspace cwd, environment overrides, timeout, abort signal, process-group cleanup, output capture, truncation, and control-character stripping.
- Migrate `inspect_command` onto the shared runner only if the migration stays small.
- Keep `inspect_command` result shape and warnings unchanged.

Expected output:

- Shared runner exists and has focused tests.
- Existing `inspect_command` tests still pass.

Verification:

```sh
pnpm test test/inspect-command-tool.test.ts test/tools.test.ts
```

Dependencies:

- None.

### Slice 2: Command Policy And Validator Classification

Status: `[ ]` Not started

Goal: Add strict command parsing and classification without registering a new model tool yet.

Why here: The safety boundary should be testable before the agent can call it.

This slice should implement:

- Add `src/agent/tools/command-policy.ts`.
- Parse one simple command into executable plus args.
- Resolve `workdir` inside the workspace.
- Find package metadata for `workdir`.
- Detect package manager from command prefix, `packageManager`, and lockfiles.
- Classify validator commands.
- Reject installs, publish, network, shell wrappers, command chains, redirects, destructive commands, and unknown commands.
- Return normalized spawn plans with policy metadata.

Expected output:

- Policy accepts normal repo validators.
- Policy rejects risky commands with plain reasons.
- No model-visible behavior changes yet.

Verification:

```sh
pnpm test test/run-command-tool.test.ts
```

Dependencies:

- Slice 1.

### Slice 3: `run_validator` Tool

Status: `[ ]` Not started

Goal: Register and execute `run_validator` through the normal tool loop.

Why here: This closes the biggest alpha loop: edit, verify, use failures, retry.

This slice should implement:

- Add `src/agent/tools/run-validator.ts`.
- Register the tool in `src/agent/tools/registry.ts` and `src/agent/tools.ts`.
- Keep it unavailable to read-only subagents in `src/agent/profiles.ts`.
- Execute policy-approved validator plans through the shared process runner.
- Return full structured metadata and bounded stdout/stderr.
- Treat non-zero exit code as a successful tool result.
- Format model-facing results in `src/agent/runtime.ts`.
- Add compact labels with exit code and duration.
- Add debug/trace logging summaries in `src/agent/tools/executor.ts`.

Expected output:

- The agent can call `run_validator`.
- The next model step sees stdout/stderr and metadata.
- The TUI shows compact validator rows.

Verification:

```sh
pnpm test test/run-command-tool.test.ts test/tools.test.ts test/commands.test.ts test/tui.render.test.ts test/logging.test.ts
```

Dependencies:

- Slice 2.

### Slice 4: Prompt And Docs For Verification

Status: `[ ]` Not started

Goal: Teach the model and users that validation is now first-class.

Why here: A tool exists only when the model chooses it correctly and users can understand it.

This slice should implement:

- Update `src/agent/prompts.ts` with `run_validator` guidance.
- Tighten `inspect_command` guidance so it stays orientation-only.
- Update `docs/cli.md` and `docs/tui.md`.
- Update `docs/plans/kb-implementation-checklist.md` if that checklist still tracks tool progress.
- Add prompt tests that show the model is told to verify after edits when possible.

Expected output:

- Tool docs and prompt copy align.
- The model sees `run_validator` as the preferred verification path.

Verification:

```sh
pnpm test test/tools.test.ts test/commands.test.ts
```

Dependencies:

- Slice 3.

### Slice 5: Fake-API Smoke Scenario

Status: `[ ]` Not started

Goal: Add a smoke scenario proving `run_validator` works through `topchester run`.

Why here: Unit tests prove the tool. Smoke coverage proves the CLI/runtime/model-tool protocol still connects.

This slice should implement:

- Add `scripts/smoke/scenarios/17-run-validator/`.
- Include a small `package.json` fixture with a deterministic validator script.
- Update `scripts/smoke/fake-api.ts` so the fake model calls `run_validator` for this scenario and then answers from the result.
- Add scenario assertions for required tool call, final answer, and successful command output.

Expected output:

- Fake-API smoke can catch regressions in command tool registration, model result formatting, and CLI JSON event flow.

Verification:

```sh
pnpm exec tsx scripts/smoke/run-smoke.ts --fake-api --trials 1 --scenario 17-run-validator
```

Dependencies:

- Slice 4.

### Slice 6: `run_command` Policy Config

Status: `[ ]` Not started

Goal: Add config-backed command allow/deny rules before registering broader command execution.

Why here: `run_command` should not be a broad shell. A strict policy gives users a clear escape hatch without adding approval UI yet.

This slice should implement:

- Extend `src/config/index.ts` with `tools.commands.allow` and `tools.commands.deny`.
- Add merge semantics for command policy arrays.
- Add config tests for allow, deny, precedence, invalid patterns, and layered config.
- Add command-policy tests showing configured commands are allowed and denied commands win.
- Document the config shape.

Expected output:

- The repo has a validated command policy config.
- No broad command tool is visible yet.

Verification:

```sh
pnpm test test/config.test.ts test/run-command-tool.test.ts
```

Dependencies:

- Slice 2.

### Slice 7: `run_command` Tool

Status: `[ ]` Not started

Goal: Register `run_command` for strictly allowed project commands.

Why here: This gives Topchester a broader command runner without pretending unsafe commands are approved.

This slice should implement:

- Add `src/agent/tools/run-command.ts`.
- Register the tool in `src/agent/tools/registry.ts` and `src/agent/tools.ts`.
- Keep it unavailable to read-only subagents by default.
- Reuse the shared command policy and process runner.
- Allow validator-classified commands but tell the model to prefer `run_validator`.
- Allow config-approved commands.
- Reject unknown commands with a clear policy reason.
- Format model-facing results and compact TUI labels.
- Add logging summaries.

Expected output:

- `run_command` can run explicitly allowed project commands.
- It cannot run arbitrary shell snippets by default.

Verification:

```sh
pnpm test test/run-command-tool.test.ts test/tools.test.ts test/commands.test.ts test/tui.render.test.ts test/logging.test.ts
```

Dependencies:

- Slice 6.

### Slice 8: Approval Architecture Follow-Up

Status: `[ ]` Not started

Goal: Design and implement true same-turn command approval if alpha feedback shows strict policy is too limiting.

Why here: Approval is useful, but it needs a real runtime protocol. It should not be hidden inside `run_command` as a half-working modal.

This slice should implement:

- Add a runtime approval request/response channel separate from normal chat messages.
- Let a tool suspend while waiting for approval or denial.
- Render pending command approval in the TUI with command, cwd, risk reason, and short actions.
- Persist only the approval decision metadata, not full output.
- Add a CLI behavior for `topchester run` where approvals are denied by default unless an explicit non-interactive flag is added.
- Add tests for approval, denial, timeout/cancel, and resumed execution.

Expected output:

- Future risky command categories can request approval without breaking the tool loop.

Verification:

```sh
pnpm test test/commands.test.ts test/tui.render.test.ts test/session.test.ts
```

Dependencies:

- Slice 7.

## Testing Plan

Focused tests:

```sh
pnpm test test/run-command-tool.test.ts
pnpm test test/inspect-command-tool.test.ts test/run-command-tool.test.ts
pnpm test test/tools.test.ts test/commands.test.ts test/tui.render.test.ts test/logging.test.ts
pnpm test test/config.test.ts test/run-command-tool.test.ts
```

Final repo gate:

```sh
pnpm check
```

Smoke gate after Slice 5:

```sh
pnpm exec tsx scripts/smoke/run-smoke.ts --fake-api --trials 1 --scenario 17-run-validator
```

Do not run live-model smoke as part of the implementation unless the user explicitly asks for it.

## Open Questions

1. Should `run_validator` allow `build` by default even though builds often write `dist/`?
   - Recommended answer: yes, because builds are part of normal verification. Mark `workspaceMayHaveChanged: true` and tell the model to inspect Git state when needed.

2. Should `run_validator` set `CI=1`?
   - Recommended answer: yes for V0. It reduces watch-mode surprises. Keep this documented and add config only if users need to opt out.

3. Should command output be stored as a session event?
   - Recommended answer: no for V0. The model sees the output immediately and the final answer should summarize it. Add durable result storage only if users need to inspect old command output after resume.

4. Should `run_command` launch through the user's shell?
   - Recommended answer: no for V0. Use direct spawn plans. Shell support belongs behind a real approval/sandbox design.

5. Should `run_validator` support monorepos?
   - Recommended answer: yes in the simple nearest-`package.json` sense. Full workspace package graph support can come later.

## Future Work

- Live TUI command output streaming.
- Persistent terminal sessions and dev-server management.
- Human approvals with saved per-command prefixes.
- OS sandbox integration.
- Network and package-install approvals.
- Per-repo command policy explain command.
- Pre/post command workspace snapshots.
- Full-output artifact storage for long command logs.
