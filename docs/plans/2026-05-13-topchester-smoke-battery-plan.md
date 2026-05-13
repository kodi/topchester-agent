# Topchester Smoke Battery Plan

## Summary

Add a reproducible smoke-test battery for Topchester that can run once a day against a real model and answer one product-health question:

```text
Can Topchester still start, use its core tools, update files, track KB state, persist sessions, and finish normal tasks?
```

This is not a performance benchmark. It should not primarily measure speed, token use, or model quality. It should verify that the agent harness, prompts, runtime loop, tools, KB commands, session storage, and CLI execution path still work together.

The target shape is a small set of curated scenarios with clean workspaces, explicit prompts, expected tool calls, expected file outputs, and JSON/Markdown reports.

## Decisions

- Build a Topchester-specific smoke battery instead of copying a generic prompt benchmark.
- Add a non-interactive `topchester run <prompt>` command before adding an RPC server.
- Do not use `-c <prompt>` for prompt execution because `-c, --config <path>` already means config path.
- Keep `topchester` as the interactive TUI entrypoint.
- Make `topchester run` exercise the same `TopchesterAgentRuntime` used by the TUI.
- Add machine-readable output for smoke assertions, likely `topchester run --json <prompt>`.
- Keep the scenario runner outside normal unit tests. It may call real models and should be manually invoked for V0.
- Use fake-model tests for deterministic protocol/runtime coverage, and live smoke scenarios for end-to-end confidence.
- Grade live smoke tests by artifacts and event traces, not exact final prose.
- For V0, run smoke tests locally only. Do not add CI or scheduled workflow integration yet.
- Put trial workspaces under `/tmp` and copy a small scenario template into each trial before running.
- Assert tool behavior from the global Topchester log, not only from session events, because session events may intentionally omit internal details.
- Add a fake API path from the start so deterministic smoke runs can verify tool calls without a real model key.
- Let `topchester run /kb status` and similar slash-command prompts execute through the same slash-command dispatcher used by the TUI.

## Scope

Included:

- Non-interactive prompt execution entrypoint.
- Scenario format for smoke tests.
- Scenario runner that creates clean trial workspaces.
- First smoke battery covering KB, tool routing, edits, sessions, and status behavior.
- JSON report and Markdown summary output.
- Local fake API and live model run commands.

Not included:

- SWE-bench-style large external benchmarks.
- Performance measurements beyond basic duration in reports.
- Exact transcript snapshots for live model output.
- A long-running RPC server as the first implementation step.
- Browser/TUI visual automation.
- Cross-provider leaderboard work.

## Competitor Findings

Local competitor checkouts were inspected as requested by `AGENTS.md`.

### Cline

Relevant files:

- `/Users/kodi/data/github/cline/evals/smoke-tests/run-smoke-tests.ts`
- `/Users/kodi/data/github/cline/evals/smoke-tests/scenarios/*/config.json`
- `/Users/kodi/data/github/cline/cli/src/index.ts`

Cline has the closest pattern to this plan. Its smoke runner loads JSON scenarios, creates clean trial workspaces, copies optional templates, runs the CLI with an explicit model, checks expected files and content, repeats trials, calculates pass/flaky/fail metrics, and writes JSON plus Markdown reports.

Its CLI exposes `cline task <prompt>` with useful automation flags:

- `-y, --yolo` for auto-approval.
- `-t, --timeout <seconds>`.
- `-m, --model <model>`.
- `-c, --cwd <path>`.
- `--json`.

Useful lesson: add a direct non-interactive task command and let the smoke runner drive it as a subprocess.

### OpenCode

Relevant files:

- `/Users/kodi/data/github/opencode/packages/opencode/src/cli/cmd/run.ts`
- `/Users/kodi/data/github/opencode/packages/opencode/src/cli/cmd/serve.ts`
- `/Users/kodi/data/github/opencode/packages/llm/test/recorded-scenarios.ts`

OpenCode exposes `opencode run [message..]` for non-interactive prompt execution. It also has `opencode serve` for a headless server. The run command supports JSON event output, model selection, session continuation, attach-to-server, files, command execution, and interactive mode.

Its lower-level LLM tests define small golden scenarios for text, tool-call, and tool-loop behavior.

Useful lesson: start with `run` as the simple automation path, then add a server/RPC path only when external clients need it.

### Codex

Relevant files:

- `/Users/kodi/data/github/codex/codex-rs/exec/src/cli.rs`
- `/Users/kodi/data/github/codex/codex-rs/app-server/src/`
- `/Users/kodi/data/github/codex/codex-rs/core/tests/common/test_codex.rs`
- `/Users/kodi/data/github/codex/codex-rs/core/tests/suite/tools.rs`

Codex exposes `codex exec [PROMPT]` for non-interactive execution and has an app-server/RPC surface for richer clients. Its tests lean heavily on mock response servers, fake SSE streams, captured request bodies, and snapshots. This makes protocol and tool availability deterministic.

Useful lesson: use non-interactive CLI for real smoke tests, and use mocked-model tests for exact tool/protocol contracts.

### Pi

Relevant files:

- `/Users/kodi/data/github/pi/packages/agent/test/e2e.test.ts`

Pi uses a faux provider for deterministic agent-loop tests. It covers basic prompt response, tool execution, abort, lifecycle events, multi-turn context, and thinking blocks.

Useful lesson: Topchester should also have fake-model tests for the runtime loop. Live smoke tests should not carry all correctness burden.

### Kilo Code

Relevant files:

- `/Users/kodi/data/github/kilocode/packages/opencode/src/cli/cmd/run.ts`
- `/Users/kodi/data/github/kilocode/packages/opencode/src/cli/cmd/serve.ts`
- `/Users/kodi/data/github/kilocode/.github/workflows/smoke-test.yml`

Kilo follows the OpenCode shape: non-interactive run command, server command, and broad CLI/TUI/tool tests.

Useful lesson: keep the smoke suite runnable from CI using the packaged CLI path, not only in-process test helpers.

## Recommended Execution Shape

### Add `topchester run <prompt>`

Suggested CLI:

```sh
topchester run "Edit greeting.txt and change Hello to Goodbye."
topchester run --workspace /tmp/scenario --model openrouter/qwen/qwen3-coder:free --json "Run /kb status"
topchester run --workspace /tmp/scenario --timeout 120000 --output-json .agents/topchester/smoke/events.jsonl "Summarize data.txt"
```

Suggested options:

- `--workspace <path>` uses the existing global option.
- `--config <path>` uses the existing global option.
- `--model <model>` optionally overrides `agent.primary` for this run.
- `--timeout <ms>` bounds the whole run.
- `--json` writes event JSONL to stdout.
- `--output-json <path>` writes event JSONL to a file.
- `--resume <session>` may be supported later, but V0 can start fresh per run.

`topchester run` should:

1. Resolve app context like the TUI.
2. Create or attach a project-local session.
3. Run startup checks enough to emit KB status.
4. Submit one prompt to `TopchesterAgentRuntime.submitMessage(...)`.
5. Stream or collect runtime events.
6. Persist session events using the same session store as the TUI.
7. Exit non-zero on runtime failure, timeout, or scenario-level command failure.

### Do Not Start With RPC

An RPC server would be useful later for IDE clients, external dashboards, or long-lived automation, but it is too much surface for the first smoke battery.

Reasons:

- Smoke scenarios need one prompt, one clean workspace, one result.
- Subprocess CLI execution tests packaging, config loading, session storage, logging, and command-line behavior.
- A server introduces lifecycle, auth, ports, concurrency, and cleanup issues before they are needed.

Add RPC later if:

- the runner needs multiple prompts in one long-lived process,
- external clients need to observe live events,
- TUI and CLI need to share a daemon,
- or test runtime cost becomes dominated by process startup.

## Scenario Shape

Initial scenario JSON:

```json
{
  "id": "05-edit-file",
  "name": "Edit file",
  "description": "Checks read_file plus edit_file on an existing file.",
  "prompt": "Edit greeting.txt and change Hello to Goodbye.",
  "template": "fixtures/edit-file",
  "timeoutMs": 120000,
  "models": ["agent.primary"],
  "requiredToolCalls": ["read_file", "edit_file"],
  "forbiddenToolCalls": ["inspect_command"],
  "expectedFiles": ["greeting.txt"],
  "expectedContent": [
    {
      "file": "greeting.txt",
      "contains": "Goodbye"
    }
  ],
  "expectedKb": {
    "statusAfter": "needs_sync"
  }
}
```

Field meanings:

- `id` is stable and used in report paths.
- `prompt` is the exact user prompt to send.
- `template` points to seed files copied into each trial workspace.
- `timeoutMs` bounds the trial.
- `models` can override the default run matrix for a scenario.
- `requiredToolCalls` asserts event trace coverage.
- `forbiddenToolCalls` catches tool-routing mistakes.
- `expectedFiles` asserts artifacts exist.
- `expectedContent` asserts low-variance content.
- `expectedKb` asserts Topchester-specific KB state when relevant.

## Assertion Strategy

Assertions should use three sources of truth:

1. The global Topchester log for full internal runtime and tool behavior.
2. The structured event trace from `topchester run --json` for user-facing run output.
3. The final files in the trial workspace.

Do not assert exact assistant prose unless the scenario is specifically testing a short stable answer. Live model output will vary. Prefer assertions that prove the harness worked:

- command exited with code `0`;
- required tool calls happened;
- forbidden tool calls did not happen;
- tool calls happened in a sensible order when order matters;
- expected files were created or changed;
- expected content exists in those files;
- KB status events match the scenario expectation;
- session files were written when persistence matters;
- no runtime error, timeout, or unhandled rejection appeared in stderr or trace events.

### Global Log Assertions

Use the global Topchester log as the main source for runtime and tool assertions. Session events are useful, but they are a product artifact and may not include every internal step. The global log should be the audit trail for smoke tests.

The runner should isolate each trial with a unique `runId` and include that id in all relevant log lines. Assertions should filter the global log by `runId` before checking behavior.

Useful global-log assertions:

- run started with the expected workspace path;
- startup KB check ran when expected;
- model request used the expected model or fake API endpoint;
- required tool calls happened;
- forbidden tool calls did not happen;
- tool call results succeeded;
- slash commands routed through the command dispatcher;
- session persistence completed;
- no internal error was logged for that run id.

### Event Trace Assertions

`topchester run --json` should emit JSONL events that are stable enough for automation. The runner should normalize them into a per-trial trace and assert against event types and payload fields, not terminal rendering.

Useful event assertions:

- `tool_call.started` includes the tool name and call id.
- `tool_call.finished` includes the same call id and success or failure.
- `knowledge_status` includes the KB state used by the status bar and chat status message.
- `assistant_message.finished` or equivalent marks the final answer.
- `session.persisted` or equivalent proves the run wrote session state.

The first version does not need a perfect event schema. It needs enough stable fields to assert "the agent used the right surface and finished cleanly."

### Workspace Assertions

Each trial should run in a fresh workspace:

1. Create a new temp directory for the trial.
2. Copy the scenario template into it.
3. Run a small bootstrap step if the scenario needs generated fixture files.
4. Run `topchester run --workspace <trial> ...`.
5. Assert final file state.
6. Delete the workspace by default, unless `--keep-workspaces` is set.

This clean-per-trial rule is important. It keeps retries honest, prevents generated files from hiding bugs, and makes reports reproducible.

Workspace assertions should be plain and durable:

- file exists;
- file does not exist;
- file contains text;
- file does not contain text;
- file matches a small regex;
- JSON file has a field value;
- command output artifact contains expected text.

Avoid brittle assertions such as exact full-file equality unless the scenario owns the entire file and the expected output is short.

### Trace Logs

Trace logs are the right place to assert tool behavior. They are also the right debugging artifact when a live model fails.

Each trial should save:

- filtered global log lines for the trial `runId`;
- `events.jsonl` from `topchester run --json`;
- `stdout.log`;
- `stderr.log`;
- final workspace snapshot or path when `--keep-workspaces` is used;
- scenario config used for the run;
- resolved model and timeout settings.

The report should summarize failures in plain terms, for example:

```text
05-edit-file trial 2 failed: expected tool edit_file was not called.
05-edit-file trial 3 failed: greeting.txt did not contain Goodbye.
```

This is better than only saying "model failed" because it tells us whether the failure is runtime, tool routing, KB state, or artifact quality.

## Fake API

Fake API support should be available from the first implementation slice. It should be a small OpenAI-compatible local server or in-process provider that returns scripted model responses.

Use it for reproducible tool-call tests:

- one response that asks for `read_file`;
- one response that asks for `edit_file`;
- one response that runs a multi-step tool loop;
- one response that triggers a slash-command scenario;
- one response that returns final assistant text after tool results.

The fake API should make assertions strict:

- exact requested model;
- exact request count;
- expected tool schemas present;
- expected tool result messages returned to the model;
- expected final run status.

This gives us deterministic local runs for the harness itself. Live model smoke tests still matter, but they should sit on top of the fake API path, not replace it.

## First Smoke Battery

### `01-kb-init-status`

Prompt:

```text
Run /kb init for this project.
```

Expected:

- KB folders exist.
- Session event log exists.
- Runtime emits a KB status event.
- Final status is ready.

### `02-read-summarize`

Prompt:

```text
Read data.txt and create summary.txt with one sentence about what it contains.
```

Expected:

- `read_file` is used.
- `summary.txt` exists.
- `summary.txt` contains a stable fixture word, such as `user`.

### `03-find-then-read`

Prompt:

```text
Find the file whose name includes runtime notes, read it, and tell me the configured port.
```

Expected:

- `find_file` is used.
- `read_file` is used after a path is found.
- Final answer or created artifact includes the fixture port.

### `04-grep-path-discipline`

Prompt:

```text
Search for FEATURE_FLAG and report the file that defines it. Do not assume paths mentioned inside file contents exist.
```

Expected:

- `grep` is used.
- If grep output contains a fake path inside matched content, the agent does not edit or read that fake path unless confirmed by `find_file` or `read_file`.

### `05-edit-file`

Prompt:

```text
Edit greeting.txt and change Hello to Goodbye.
```

Expected:

- `read_file` is used.
- `edit_file` is used.
- `greeting.txt` contains `Goodbye`.

### `06-multi-edit`

Prompt:

```text
In config.txt, set debug to true and retries to 3.
```

Expected:

- `read_file` is used.
- `edit_file` is used.
- `config.txt` contains both final values.

### `07-inspect-command`

Prompt:

```text
Orient yourself in this repo and list the top-level docs files.
```

Expected:

- `inspect_command` may be used.
- If used, it runs only safe read-only commands.
- Output or artifact mentions the expected docs files.

### `08-kb-sync-after-edit`

Prompt:

```text
Change src/value.ts so value is 2, then sync project knowledge.
```

Expected:

- `edit_file` is used.
- `/kb sync` or equivalent runtime path is used.
- `/kb status` reports clean or the event trace shows zero non-clean files.

### `09-session-resume`

This can be a two-step scenario:

1. Run prompt: `Remember that this scenario code is alpha-seven.`
2. Resume the session and run prompt: `What scenario code did I give you?`

Expected:

- Same session log is reused.
- Final answer contains `alpha-seven`.

### `10-no-kb-startup-guidance`

Prompt:

```text
What should I do before using project knowledge here?
```

Expected:

- Startup KB status event reports missing or empty KB.
- Chat status message includes guidance to run `/kb init`, `/kb compile`, `/kb sync`, or `/kb status`.

## Runner Shape

Suggested command:

```sh
pnpm exec tsx scripts/smoke/run-smoke.ts --trials 3 --model openrouter/qwen/qwen3-coder:free
```

Suggested options:

- `--scenario <id>` runs one scenario.
- `--trials <n>` defaults to 1 for local runs. Use 3 when checking live-model flakiness.
- `--model <id>` overrides the model matrix.
- `--parallel <n>` runs scenarios concurrently with a limit.
- `--output <path>` writes report JSON.
- `--keep-workspaces` preserves trial folders for debugging.

Per trial:

1. Create a clean temp workspace.
2. Copy scenario template files.
3. Run the scenario bootstrap step if one is configured.
4. Run `topchester run --workspace <trial> --json <prompt>`.
5. Capture stdout, stderr, exit code, event JSONL, filtered global log lines, session files, and final workspace state.
6. Apply scenario assertions.
7. Write `trial-N/stdout.log`, `trial-N/stderr.log`, `trial-N/events.jsonl`, and `trial-N/topchester.log`.
8. Delete the trial workspace unless `--keep-workspaces` is set.

Report:

- `report.json` with every scenario/model/trial result.
- `summary.md` for local summaries.
- `latest` symlink or stable copy for local debugging.

## Files to Add

Likely files:

- `scripts/smoke/run-smoke.ts`
- `scripts/smoke/scenarios/<id>/config.json`
- `scripts/smoke/scenarios/<id>/template/...`
- `scripts/smoke/README.md`
- `scripts/smoke/fake-api.ts` or equivalent test helper
- Optional later: `scripts/smoke/docker-compose.yml`

## Files to Change

Likely files:

- `src/cli.ts` for `topchester run`.
- `src/agent/runtime.ts` only if a better one-shot runtime boundary is needed.
- `src/session/store.ts` only if CLI-run session persistence needs a small helper.
- `docs/cli.md` for the new command.
- `docs/tui.md` only if interactive behavior changes, which is not expected for V0.
- `package.json` for a smoke script.

## Slice Plan

### Slice 1: Non-Interactive Runtime Command

Status: `[ ]` Not started

Goal: Add `topchester run <prompt>` as the automation entrypoint.

Why here: The smoke runner needs a stable command to execute before scenario files matter.

This slice should implement:

- CLI command parsing for `topchester run <prompt>`.
- Direct slash-command routing for prompts like `topchester run /kb status`.
- One-shot runtime execution through `TopchesterAgentRuntime`.
- Plain output and `--json` event output.
- Per-run `runId` included in global log lines.
- Timeout handling.
- Session persistence.

Expected output:

- `topchester run "hello"` sends one prompt and exits.
- `topchester run --json "hello"` emits machine-readable events.
- `topchester run /kb status` runs the command dispatcher without requiring a model call.

Verification:

```sh
pnpm test test/cli.integration.test.ts test/commands.test.ts
pnpm typecheck
```

Dependencies: none.

### Slice 2: Scenario Format and Loader

Status: `[ ]` Not started

Goal: Add scenario config schema, fixture copying, and assertion helpers.

Why here: This establishes the contract before adding the full scenario set.

This slice should implement:

- `scripts/smoke/run-smoke.ts` skeleton.
- Scenario JSON validation.
- Clean trial workspace creation.
- Template copying.
- Optional per-scenario bootstrap command.
- Global log filtering by `runId`.
- File/content/tool-call assertions.
- Fake API startup for deterministic local runs.

Expected output:

- One local sample scenario can run against the fake API with strict tool-call assertions.

Verification:

```sh
pnpm exec tsx scripts/smoke/run-smoke.ts --scenario 05-edit-file --trials 1 --dry-run
```

Dependencies: Slice 1 for real execution, but loader work can begin independently.

### Slice 3: First Scenario Battery

Status: `[ ]` Not started

Goal: Add the first ten scenarios listed in this plan.

Why here: The runner is only useful when it covers the core product contracts.

This slice should implement:

- Scenario config files.
- Template workspaces.
- Expected output assertions.
- Required and forbidden tool-call assertions.
- KB state assertions where needed.

Expected output:

- A one-trial local smoke run exercises all major Topchester tool and KB paths.

Verification:

```sh
pnpm exec tsx scripts/smoke/run-smoke.ts --trials 1
```

Dependencies: Slices 1 and 2.

### Slice 4: Reports and Local Run Command

Status: `[ ]` Not started

Goal: Make smoke results useful for local runs.

Why here: Local runs need concise status, durable artifacts, and enough logs to debug failures before any CI or scheduled workflow is added.

This slice should implement:

- `report.json`.
- `summary.md`.
- Per-trial logs.
- Optional latest symlink or stable output path.
- Documented local commands for fake API and live model runs.

Expected output:

- A local run writes artifacts and fails only on real failed scenarios.

Verification:

```sh
pnpm exec tsx scripts/smoke/run-smoke.ts --trials 1 --output /tmp/topchester-smoke-report.json
```

Dependencies: Slice 3.

### Slice 5: Deterministic Fake-Model Companion Tests

Status: `[ ]` Not started

Goal: Add fake-model tests for exact tool-loop and event-shape contracts.

Why here: Live smoke tests are noisy. Exact behavior should be locked down with deterministic tests.

This slice should implement:

- Fake model gateway scriptable responses.
- Tests for tool call parsing, multi-tool loop, KB status events, edit events, and JSON output.
- Snapshot-like assertions for event JSONL shape where stable.

Expected output:

- Core runtime contracts fail fast in PR checks without model access.

Verification:

```sh
pnpm test test/commands.test.ts test/cli.integration.test.ts
pnpm check
```

Dependencies: Slice 1.

## Testing Plan

Use two levels of testing:

- PR-level deterministic tests with fake model output.
- Local smoke runs with the fake API.
- Local live smoke runs with real model calls from a developer machine that has API keys.

The live suite should initially be allowed to mark scenarios as flaky if at least one of three trials passes, but the report must surface the flakiness. Once prompts and assertions stabilize, raise the bar for critical scenarios.

## Local Run Shape

Fake API run:

```sh
pnpm exec tsx scripts/smoke/run-smoke.ts --fake-api --trials 1
```

Live model run:

```sh
pnpm exec tsx scripts/smoke/run-smoke.ts --trials 1 --model openrouter/qwen/qwen3-coder:free
```

Focused debug run:

```sh
pnpm exec tsx scripts/smoke/run-smoke.ts --scenario 05-edit-file --trials 1 --keep-workspaces
```

The runner should print the report path and kept workspace path when `--keep-workspaces` is set.

## Docker Compose

Docker Compose is useful, but it should not be required for V0.

Worth doing later:

- a compose service for the fake API;
- a compose service that runs the smoke runner against the fake API;
- mounted source checkout;
- `/tmp`-backed scenario workspaces inside the container;
- automatic container cleanup after the run.

Do not start there. The first version should run directly on the developer machine because that is where local API keys, package manager cache, and the current checkout already live.

Add Compose once the fake API path works. It will be valuable for fully reproducible tool-call checks, but it adds image build, volume, UID, package-cache, and host-path details that can slow down the first useful version.

## Resolved Questions

1. `topchester run` should run startup KB checks by default.
2. `topchester run /kb status` should route through the slash-command dispatcher.
3. Tool and runtime assertions should inspect the filtered global log first, then event JSONL and final workspace state.
4. Smoke workspaces should live under `/tmp`.
5. V0 should not include CI or scheduled workflow integration.

## Open Questions

1. Which one model should be the first live local default?
2. Should `topchester run` expose `--skip-startup-checks` later for narrow automation?
3. Should Compose become a supported V1 path or stay a convenience wrapper around the local runner?

## Final Verification

When all slices are done:

```sh
pnpm check
pnpm exec tsx scripts/smoke/run-smoke.ts --fake-api --trials 1
pnpm exec tsx scripts/smoke/run-smoke.ts --trials 1
pnpm exec tsx scripts/smoke/run-smoke.ts --trials 3 --scenario 05-edit-file
```

The smoke suite is ready when a clean checkout can run the full fake API battery locally, and a developer machine with API keys can run the one-trial live battery with artifacts.
