# Mini-Bench Harness Plan

## Summary

Build a small Topchester-owned benchmark harness that answers whether the agent loop, tools, Docker integration, hidden verification, and iteration behavior are working before using large external benchmarks such as Terminal-Bench or DeepSWE.

The target for V0 is a deterministic local mini-bench harness proven by one intentionally trivial TypeScript task: `task-000-basic-ts-transform`. This task should be junior-level arrays/objects/strings work that any useful coding agent and model can solve. The point is to validate the harness, Docker boundary, Topchester invocation, hidden verifier behavior, and reports before adding harder benchmark tasks.

The eventual suite can grow to 20 curated tasks, but those tasks are explicitly deferred. Each task must have an agent-visible workspace and prompt, while its verifier remains outside the agent-visible filesystem. The harness should be lightweight enough for a single local run, while still preserving the important benchmark contract: the agent must solve the task behavior, not inspect tests and fabricate outputs.

This plan started as design-only. Implementation has begun with the V0 `task-000-basic-ts-transform` harness path.

## Decisions

- Create a Topchester-specific `mini-bench` rather than relying on a small sample from third-party benchmarks.
- Use `task-000-basic-ts-transform` as the first and only V0 task.
- Make `task-000-basic-ts-transform` deliberately easy: basic TypeScript, arrays, objects, strings, no services, no tricky algorithms, no hidden domain knowledge.
- Defer the 20 harder tasks until after the harness is proven.
- Keep verifiers hidden from the agent by default.
- Store task prompts and public task assets separately from verifier code.
- Run each task in a clean copied workspace, not directly in the task template.
- Use Docker Compose for repeatable local execution. V0 should not require Postgres, but the structure should leave room for later DB tasks.
- Optimize for single-machine local iteration before adding CI, dashboards, or leaderboard features.
- Grade by verifier behavior and artifacts, not by final prose.
- Make reports useful for harness debugging: include agent logs, tool-call summaries, stdout/stderr tails, verifier output, timing, and changed files.
- Disable lifecycle hooks in benchmark configs. User hooks are useful for interactive sessions, but they add unrelated latency and can turn a solved benchmark task into a shutdown timeout.
- Run live agent attempts inside the Docker agent container using the published npm package by default. The host checkout runtime is only for explicit local development via `MINI_BENCH_TOPCHESTER_RUNTIME=host`.

## Scope

Included:

- Planning the mini-bench repository layout.
- Planning where task prompts, seed workspaces, bootstrap code, hidden verifiers, and reports should live.
- Planning the Docker/Compose boundary.
- Planning how the runner invokes Topchester and verifies tasks.
- Planning `task-000-basic-ts-transform` as the harness proving task.
- Recording the 20-task catalog only as a deferred backlog.
- Planning implementation slices for the harness and task authoring.

Out of scope for this plan:

- Implementing the 20 harder tasks.
- Adding CI or scheduled benchmark runs.
- Supporting arbitrary third-party benchmark formats.
- Building a public leaderboard.
- Measuring model quality beyond local smoke/regression usefulness.

## Current State

Recent Terminal-Bench and DeepSWE experiments exposed several problems:

- A failed reward can mean the task is too hard, the model is weak, the benchmark harness is wrong, the agent prompt is wrong, or the task was never realistic for a smoke test.
- Large benchmarks include many hard or intentionally adversarial tasks, so selecting one or two tasks does not prove the agent harness is healthy.
- Hidden verifiers are still necessary. If the agent can see verifier code or exact expected outputs, it may satisfy the verifier without solving the requested behavior.
- The harness needs to make analysis loops visible and encourage early implementation plus iteration from runtime/verifier feedback.

Local reference shape inspected:

- `/Users/kodi/data/invent-hill/pump-inc/tests/io-matrix` uses a lightweight TypeScript runner, scenario definitions, Docker Compose services, and verifier helpers.
- `/Users/kodi/data/invent-hill/pump-inc/tests/isolates` uses scenario folders with inputs/expected data and a runner around isolated execution.

Useful lessons:

- Keep a small runner with commands like `run`, `list`, `up`, `down`, and `clean`.
- Treat Compose service startup and readiness as runner-owned behavior.
- Keep scenario metadata typed and explicit.
- Keep verifier logic centralized enough to share helpers, but allow task-specific checks when needed.

## Recommended Repository Shape

Suggested root:

```text
bench/mini-bench/
  README.md
  package.json
  tsconfig.json
  docker-compose.yaml
  Dockerfile.agent
  Dockerfile.runner
  src/
    runner.ts
    cli.ts
    config.ts
    docker.ts
    topchester.ts
    task-loader.ts
    workspace.ts
    report.ts
    verify.ts
    types.ts
    verifiers/
      assertions.ts
      fs.ts
      http.ts
      sqlite.ts
      postgres.ts
      process.ts
  tasks/
    task-000-basic-ts-transform/
      task.yaml
      prompt.md
      workspace/
        package.json
        src/
        README.md
      bootstrap/
      verifier/
        verify.ts
        fixtures/
  reports/
    .gitkeep
```

The exact names can change during implementation, but the important boundary should not:

- `prompt.md` is benchmark-owned input passed to the agent. It is not hidden, but it should not contain verifier internals.
- `workspace/` is the only task content copied into the agent's working directory.
- `bootstrap/` is runner-owned setup for creating databases, fixtures, env files, and local services. It is not visible unless deliberately copied into the workspace.
- `verifier/` is host/runner-only and must not be mounted into the agent container.
- `reports/` is generated output and should be ignored except for optional `.gitkeep`.

## Agent-Visible Versus Hidden Boundary

Agent-visible:

- The copied task workspace.
- The user-facing task prompt.
- Public README or TODO files intentionally present in the workspace.
- Runtime feedback from commands the agent runs.
- Verifier summary after a failed attempt, if the harness supports iterative verifier feedback.

Hidden from agent:

- Verifier source code.
- Exact expected outputs unless they are part of the public prompt.
- Reference snapshots, golden responses, or private fixtures.
- Harness metadata that marks specific assertions.
- Runner internals and scoring code.

This should be enforced by filesystem and Docker boundaries, not just prompt instructions.

Recommended runtime layout:

```text
host repo:
  bench/mini-bench/tasks/<task-id>/verifier     # hidden
  bench/mini-bench/tasks/<task-id>/workspace    # copied

runner container or host process:
  /bench                                      # full harness, including verifiers
  /runs/<run-id>/<task-id>/workspace          # mutable task copy

agent container:
  /workspace                                  # only mutable task copy
  /tmp                                       # scratch
```

The agent container should not receive:

- the benchmark repo root,
- the task `verifier/` directory,
- Docker socket access,
- host paths containing hidden fixtures.

## Docker And Service Model

Use Docker Compose with a small fixed set of services:

- `agent`: the container where Topchester runs against `/workspace`.
- `runner`: optional controller container for fully containerized runs.
- `postgres`: future service for DB tasks, not required for V0.
- `http-fixture`: future deterministic upstream HTTP service for API tasks, not required for V0.

V0 can start as a host-runner that uses Docker Compose for services and `docker exec`/`docker compose run` for the agent. A later fully containerized runner can reuse the same task contract.

The runner owns:

- building images,
- starting/stopping services,
- readiness checks,
- copying task workspaces into `/runs`,
- invoking Topchester,
- enforcing timeout,
- running hidden verifiers,
- collecting reports,
- cleanup.

The agent owns only:

- reading and editing the task workspace,
- running allowed commands inside the agent container,
- producing the requested implementation/artifacts.

## Task Metadata

The V0 task should have a `task.yaml` with public metadata and runner metadata:

```yaml
id: task-000-basic-ts-transform
name: Basic TypeScript Transform
category: typescript
difficulty: trivial
prompt: prompt.md
workspace: workspace
bootstrap:
  script: null
services: []
verifier:
  command: pnpm exec tsx verifier/verify.ts
timeoutMs: 180000
agent:
  cwd: /workspace
  profile: mini-bench
expected:
  changedFiles:
    - src/summary.ts
```

The runner may read all fields. The agent should only receive the prompt and workspace. Do not copy `task.yaml` into `/workspace` unless the agent-visible subset is explicitly generated.

## Prompt Contract

Prompts should be concise and task-like:

- Describe the requested behavior.
- Name the command the user expects to work, when appropriate.
- State public constraints such as no network, no changing package manager, or compatibility requirements.
- Avoid exact verifier assertions.
- Avoid hidden fixture names unless the task is explicitly about those files.

Example shape:

````markdown
You are in a tiny TypeScript project. Implement the user summary behavior described in README.md.

The expected command is:

```sh
pnpm test
```

Keep the implementation general. Do not hard-code the sample users.
````

Benchmark-mode system guidance can separately tell the agent to make an honest early implementation and iterate from runtime/verifier feedback.

## Verifier Contract

Each verifier should:

- run outside the agent-visible workspace boundary,
- create or reset any hidden fixtures it needs,
- invoke public commands from the workspace whenever possible,
- check behavior through black-box outputs, HTTP calls, DB queries, or file artifacts,
- emit structured JSON with `passed`, `score`, `assertions`, and failure summaries,
- avoid leaking full golden outputs in failure text,
- use deterministic timeouts and random seeds.

Verifier result shape:

```json
{
  "passed": false,
  "score": 0,
  "assertions": [
    {
      "name": "migrates nested legacy config",
      "passed": false,
      "message": "Nested legacy config was not migrated correctly."
    }
  ]
}
```

Failure summaries can be passed back to the agent only if the harness is running in iterative mode. Even then, summaries should describe behavior gaps, not reveal hidden expected payloads verbatim.

## Runner Commands

Suggested local commands:

```sh
node bench/mini-bench/src/cli.ts list
node bench/mini-bench/src/cli.ts verify-fixtures
node bench/mini-bench/src/cli.ts run --task task-000-basic-ts-transform --no-agent --candidate good
node bench/mini-bench/src/cli.ts run --task task-000-basic-ts-transform --config bench/mini-bench/config/openrouter-gpt-5.4-mini.jsonc
node bench/mini-bench/src/cli.ts up
node bench/mini-bench/src/cli.ts down
node bench/mini-bench/src/cli.ts clean
```

For repo-local ergonomics, expose these through `mise` once the commands stabilize:

```sh
mise run mini-bench-list
mise run mini-bench-one task-000-basic-ts-transform
mise run mini-bench-all
```

## Execution Flow

Per task:

1. Load task metadata.
2. Create a new run id and workspace copy.
3. Start required Compose services.
4. Run task bootstrap outside the agent-visible boundary.
5. Start Topchester in the agent container with:
   - `/workspace` as cwd,
   - benchmark profile,
   - hidden verifier paths absent,
   - configured model/provider,
   - timeout and auto-approval flags suitable for the benchmark.
6. Stream and persist Topchester events/logs.
7. Stop the agent when it finishes or times out.
8. Run the hidden verifier from the runner boundary.
9. Collect changed files, git diff, stdout/stderr tails, tool-call counts, verifier JSON, duration, token/cost metadata when available.
10. Write per-task report and aggregate report.
11. Clean services according to the chosen mode.

## Iterative Verifier Feedback

V0 can run the verifier once after the agent finishes, matching most external benchmark behavior.

V1 should support optional iterative mode:

```text
agent attempt -> hidden verifier -> summarized failure feedback -> agent retry -> final verifier
```

Guardrails:

- Limit retry count.
- Do not expose verifier source.
- Do not expose exact golden outputs unless public.
- Prefix verifier feedback as behavioral feedback, not as test code.
- Preserve all attempts in the report.

This mode is useful for Topchester development because it tests whether the agent can improve from validation feedback without needing hidden files.

## V0 Task

### `task-000-basic-ts-transform`

Purpose: prove the harness, hidden verifier boundary, Docker execution, Topchester invocation, and reporting with a task that should be solvable by any competent coding agent.

Suggested public task:

- The workspace is a tiny TypeScript package.
- It exposes a function such as `summarizeUsers(users: User[]): UserSummary`.
- The implementation needs only junior-level operations:
  - filter invalid/inactive records,
  - normalize names or email domains,
  - count by role,
  - sort a few strings,
  - compute simple totals,
  - return a plain object.
- Public tests or examples can cover the obvious cases.
- Hidden verifier fixtures check edge cases such as empty arrays, duplicate names, mixed casing, missing optional fields, and stable sort order.

This task should not require:

- HTTP servers.
- SQLite or Postgres.
- Docker services beyond the agent container.
- Complex algorithms.
- Large files.
- Reading many source files.
- Multi-step debugging.

Passing this task does not prove model quality. Failing this task is a strong signal that the harness, agent invocation, tool permissions, prompt, or basic coding loop is broken.

## Deferred 20-Task Catalog

These tasks are the future suite. They should not be implemented as part of the first harness-proof plan.

### TypeScript Code Tasks

1. `ts-001-json-schema-migrator`: Convert legacy JSON config files into a new schema while preserving unknown fields and reporting invalid records.
2. `ts-002-dependency-graph-planner`: Compute task/package execution order, detect cycles, and emit useful diagnostics.
3. `ts-003-streaming-log-aggregator`: Process large NDJSON logs with streaming APIs and produce grouped session summaries.
4. `ts-004-markdown-section-updater`: Update generated Markdown sections while preserving hand-written surrounding content.
5. `ts-005-rules-engine-debugger`: Complete a small rules engine with priority, fallback, and explanation output.

### HTTP/API Tasks

6. `api-001-todo-state-machine`: Implement valid state transitions and invalid-transition errors for a todo API.
7. `api-002-idempotent-webhook-receiver`: Validate signatures, reject replays, and process duplicate webhook deliveries safely.
8. `api-003-pagination-filtering-sorting`: Implement stable list pagination with filters and sorting.
9. `api-004-rate-limited-token-service`: Implement token issuance/validation and per-client rate limits.
10. `api-005-file-upload-manifest`: Accept multipart uploads, validate files, and expose a manifest endpoint.

### SQLite/Postgres Tasks

11. `db-001-sqlite-ledger-balances`: Implement double-entry ledger writes and balance queries.
12. `db-002-sqlite-migration-runner`: Implement migration discovery, checksums, and rollback on failed migrations.
13. `db-003-postgres-job-queue`: Implement concurrent-safe job claim, complete, retry, and visibility timeout behavior.
14. `db-004-postgres-analytics-rollup`: Build idempotent daily aggregates from raw events, including late-arriving data.
15. `db-005-postgres-search-api`: Implement a SQL-backed search API with ranking, filters, and injection safety.

### Agent Workflow/System Tasks

16. `agent-001-fix-broken-test-suite`: Fix a small repo with multiple failing tests across several files.
17. `agent-002-cli-config-precedence`: Implement config precedence across defaults, project config, env vars, and CLI flags.
18. `agent-003-cache-invalidation`: Fix stale reads in a cache layer after writes and deletes.
19. `agent-004-plugin-loader`: Implement plugin discovery, manifest validation, disabled plugins, and deterministic errors.
20. `agent-005-repo-wide-safe-rename`: Rename an internal API across a small repo while preserving documented compatibility behavior.

## Cross-Slice Rules

- Hidden verifier directories must never be mounted into the agent container.
- Task workspaces must be copied before each run; never mutate templates directly.
- Every task must have one public expected command or behavior path.
- Every task verifier must be deterministic and runnable without an LLM.
- Each task should be solvable by a strong coding agent in a single local run.
- Avoid tasks whose difficulty depends on obscure domain trivia.
- Prefer black-box behavior checks over brittle exact source checks.
- Reports should capture enough data to distinguish agent failure from harness failure.
- The harness should fail closed when setup, verifier, or Docker service startup fails.
- Do not add hidden network dependencies.

## Files To Add

Likely files once implementation begins:

- `bench/mini-bench/README.md`
- `bench/mini-bench/package.json`
- `bench/mini-bench/tsconfig.json`
- `bench/mini-bench/docker-compose.yaml`
- `bench/mini-bench/Dockerfile.agent`
- `bench/mini-bench/Dockerfile.runner`
- `bench/mini-bench/src/**/*.ts`
- `bench/mini-bench/tasks/task-000-basic-ts-transform/task.yaml`
- `bench/mini-bench/tasks/task-000-basic-ts-transform/prompt.md`
- `bench/mini-bench/tasks/task-000-basic-ts-transform/workspace/**`
- `bench/mini-bench/tasks/task-000-basic-ts-transform/bootstrap/**`
- `bench/mini-bench/tasks/task-000-basic-ts-transform/verifier/**`
- `bench/mini-bench/reports/.gitkeep`

Likely files to change:

- `mise.toml` for ergonomic commands.
- `package.json` only if the repo root should expose mini-bench commands.
- `docs/benchmarking.md` or similar docs after the harness exists.

## Slices

### Slice 1: Finalize Harness Contract

Status: `[x]` Done

Goal: Turn this plan into an agreed task and verifier contract before code exists.

Why here: The hidden-verifier boundary and task layout are the hardest parts to change later.

This slice should implement:

- Review the proposed directory layout.
- Decide host-runner versus runner-container for V0.
- Decide whether the agent receives a generated public `task.json` or only prompt text.
- Decide whether iterative verifier feedback exists in V0 or waits for V1.
- Decide report fields required for debugging Topchester benchmark behavior.

Expected output:

- Updated plan with final decisions.
- No runtime code.

Verification:

```sh
test -f docs/plans/2026-06-17-mini-bench-harness-plan.md
```

Completed notes:

- V0 is scoped to `task-000-basic-ts-transform`.
- The deferred 20-task suite stays as backlog context only.
- The V0 runner uses a host-runner shape and plain Node for local harness execution.
- The agent receives prompt text and the copied workspace, not verifier files or `task.yaml`.
- V0 uses one final hidden verifier run; iterative feedback is deferred.

Dependencies: none.

### Slice 2: Skeleton Runner And Compose Boundary

Status: `[x]` Done

Goal: Add the minimal runnable harness shell around `task-000-basic-ts-transform`.

Why here: This proves Docker, workspace copying, service startup, timeouts, and reports before task complexity hides harness bugs.

This slice should implement:

- `bench/mini-bench` package scaffold.
- Docker Compose with the agent service only for V0.
- Runner commands: `list`, `run --task`, `up`, `down`, `clean`.
- Workspace copy into a per-run directory.
- `task-000-basic-ts-transform` task folder with prompt, tiny workspace, and hidden verifier stub.
- JSON report output.

Expected output:

- `task-000-basic-ts-transform` can run end to end and produce a report.
- Agent-visible container does not include verifier paths.

Verification:

```sh
node bench/mini-bench/src/cli.ts list
node bench/mini-bench/src/cli.ts run --task task-000-basic-ts-transform --no-agent --candidate good
```

Completed notes:

- Added `bench/mini-bench` package scaffold, runner CLI, Dockerfiles, and `docker-compose.yaml`.
- Added `list`, `run`, `verify-fixtures`, `up`, `down`, and `clean` commands.
- Added workspace copy into per-run report directories.
- Added JSON and Markdown per-run reports.
- Verification passed with `node bench/mini-bench/src/cli.ts list`.
- Verification passed with `node bench/mini-bench/src/cli.ts run --task task-000-basic-ts-transform --no-agent --candidate good`.
- Verification passed with `pnpm --dir bench/mini-bench run run --task task-000-basic-ts-transform --no-agent --candidate good`.
- Verification passed with `node bench/mini-bench/src/cli.ts up` and `node bench/mini-bench/src/cli.ts down`.

Dependencies: Slice 1.

### Slice 3: Hidden Verifier Enforcement

Status: `[x]` Done

Goal: Prove the agent cannot read verifier files or hidden fixtures.

Why here: This is the core anti-fabrication requirement.

This slice should implement:

- A harness self-test task whose verifier files contain a sentinel string.
- A runner check that the sentinel is absent from the agent workspace/container.
- A verifier that fails if the agent copied or emitted the sentinel.
- Documentation for the visibility boundary.

Expected output:

- Hidden verifier paths are absent from agent-visible mounts.
- The report records the visibility check.

Verification:

```sh
node bench/mini-bench/src/cli.ts run --task task-000-basic-ts-transform --no-agent --candidate good
```

Completed notes:

- Added hidden verifier sentinel `TOPCHESTER_MINI_BENCH_HIDDEN_VERIFIER_SENTINEL_v1`.
- The runner copies only `workspace/` into the run workspace.
- The hidden verifier fails before task assertions if the sentinel appears in the workspace.
- Verification output included `PASS hidden verifier files are not visible in workspace`.
- The same boundary assertion passed through `pnpm mini-bench:verify-fixtures`.

Dependencies: Slice 2.

### Slice 4: Complete `task-000-basic-ts-transform`

Status: `[x]` Done

Goal: Finish the intentionally easy TypeScript task end to end.

Why here: The first real task should validate the task authoring contract without HTTP, DB, or hard problem-solving noise.

This slice should implement:

- `task-000-basic-ts-transform` workspace.
- Public prompt and README.
- Hidden fixtures and real verifier.
- Known-good and known-bad candidate fixtures.
- Report assertions for changed files and command output.

Expected output:

- The task can be run repeatedly from a clean workspace.
- The verifier can fail a bad implementation and pass a correct one without using an LLM.
- A weak model should still have a fair chance to solve it if the harness and agent loop are healthy.

Verification:

```sh
node bench/mini-bench/src/cli.ts run --task task-000-basic-ts-transform --no-agent --candidate good
node bench/mini-bench/src/cli.ts run --task task-000-basic-ts-transform --no-agent --candidate bad
node bench/mini-bench/src/cli.ts verify-fixtures
```

Completed notes:

- Added public prompt, README, TypeScript workspace, public test, hidden verifier, and known-good/known-bad fixtures.
- Known-good fixture passes the hidden verifier.
- Known-bad fixture fails the hidden verifier.
- `node bench/mini-bench/src/cli.ts verify-fixtures` passed by confirming good passes and bad fails.
- `pnpm mini-bench:verify-fixtures` passed by confirming good passes and bad fails.

Dependencies: Slice 3.

### Slice 5: Topchester Integration For `task-000`

Status: `[x]` Done

Goal: Run real Topchester attempts through the harness on the trivial task.

Why here: The harness should prove the Topchester invocation path on a task whose coding difficulty should not dominate the result.

This slice should implement:

- Topchester invocation adapter.
- Benchmark profile/config for safe auto-approval and bounded tools.
- Event/log collection from `.agents`.
- Tool-call summary extraction.
- Timeout handling and cancellation.
- Final hidden verifier run after the agent exits.

Expected output:

- `task-000-basic-ts-transform` can run with a real model and produce a useful report whether it passes or fails.
- A failure on this task is treated primarily as harness/agent-loop evidence, not as proof the task is too hard.

Verification:

```sh
pnpm --dir bench/mini-bench run run --task task-000-basic-ts-transform --config bench/mini-bench/config/openrouter-gpt-5.4-mini.jsonc
```

Dependencies: Slice 4.

Completed notes:

- Added a Topchester invocation adapter that runs `topchester --workspace /workspace run --dangerously-auto-approve --json --output-json /run/topchester-events.jsonl` inside the Docker `agent` service by default.
- The Docker agent image installs `topchester-ai@latest` from npm by default, or a pinned npm spec from `MINI_BENCH_TOPCHESTER_NPM_SPEC`.
- Kept `MINI_BENCH_TOPCHESTER_RUNTIME=host` as an explicit development escape hatch for running the current checkout instead of the npm package.
- Added checked-in config files for Codex GPT 5.4 mini and OpenRouter GPT 5.4 mini.
- Added `hooks.enabled: false` to mini-bench configs so benchmark runs do not inherit user notification/logging hooks.
- Added report preservation for Topchester `.agents/topchester` session events, metadata, and debug logs.
- Verified a live OpenRouter GPT 5.4 mini run with `bench/mini-bench/config/openrouter-gpt-5.4-mini.jsonc`; it passed in 18.2s with `exitCode: 0` and `timedOut: false`.
- GPT 5.4 mini solved `task-000-basic-ts-transform`, changed `src/summary.ts`, ran `pnpm test`, and passed the hidden verifier.
- An earlier live run exposed the config-layer issue: Topchester produced the correct workspace result, but the process was later killed after an inherited user `Stop` hook stalled. Reports now surface `timedOut`, use session-event fallback when `--output-json` is not written, and benchmark configs disable hooks.
- Codex GPT 5.4 mini config was attempted, but the local Codex auth token refresh returned 401; that path needs auth refresh before it can be used.

### Slice 6: Reporting And Local Ergonomics

Status: `[x]` Done

Goal: Make `task-000` results easy to inspect after a local run.

Why here: The harness is only useful if a failed trivial task quickly identifies agent issue versus harness issue.

This slice should implement:

- Aggregate JSON report.
- Markdown summary report.
- Per-task run directory with prompt, public workspace diff, verifier result, Topchester event summary, stdout/stderr tails, and timing.
- `mise` commands.
- README usage docs.

Expected output:

- A failed `task-000` run can be debugged from report artifacts without re-running immediately.

Verification:

```sh
mise run mini-bench-one task-000-basic-ts-transform
```

Completed notes:

- Added aggregate latest report output, per-run `report.json`, and per-run `summary.md`.
- Added `bench/mini-bench/README.md`.
- Added `mise` tasks: `mini-bench-list`, `mini-bench-one`, and `mini-bench-verify-fixtures`.
- Verification passed with `mise run mini-bench-list`.
- Verification passed with `mise run mini-bench-verify-fixtures`; mise emitted a sandbox cache warning, but the task command succeeded.
- Verification passed with `pnpm --dir bench/mini-bench run typecheck`, which runs `tsc --noEmit -p tsconfig.json`.

Dependencies: Slice 5.

### Slice 7: Verifier Feedback Mode Decision

Status: `[x]` Done

Goal: Decide whether the harness should support iterative verifier feedback before adding harder tasks.

Why here: `task-000` gives a low-risk place to test feedback mechanics without exposing hidden verifier code.

This slice should implement:

- Decide whether V1 supports `agent attempt -> summarized verifier feedback -> retry`.
- If accepted later, add bounded retry support using `task-000`.
- Ensure feedback summaries do not leak verifier source or exact hidden golden outputs.
- Preserve all attempts in the report.

Expected output:

- The plan records whether harder future tasks will use single-shot verification or iterative hidden-verifier feedback.
- If implemented, retry behavior is proven only on `task-000`.

Verification:

```sh
test -f bench/mini-bench/README.md
```

Completed notes:

- V0 stays single-shot: `agent attempt -> final hidden verifier -> report`.
- Iterative hidden-verifier feedback is deferred to V1 because retry semantics would make early smoke results harder to compare against external benchmark behavior.
- The runner intentionally does not accept `--max-attempts` in V0.
- The README documents this decision and the current result semantics.

Dependencies: Slice 6.

### Slice 8: Deferred Suite Readiness Checklist

Status: `[x]` Done

Goal: Define the checklist that future task authors must satisfy before adding the 20 harder tasks.

Why here: The harder suite should reuse the proven harness contract rather than expanding scope before V0 is healthy.

This slice should implement:

- Task authoring checklist.
- Hidden verifier checklist.
- Known-good/known-bad fixture requirement.
- Difficulty calibration guidance.
- Report fields required for harder tasks.
- Service support requirements for future HTTP and DB tasks.

Expected output:

- Future tasks have a clear admission checklist, but none of the 20 harder tasks are implemented in this slice.

Verification:

```sh
test -f bench/mini-bench/README.md
```

Completed notes:

- Added task authoring and hidden verifier checklists to `bench/mini-bench/README.md`.
- Recorded known-good and known-bad fixture expectations.
- Documented report and verifier-result expectations for future tasks.

Dependencies: Slice 7.

### Slice 9: Future HTTP/API And DB Support Plan

Status: `[x]` Done

Goal: Plan service support for the deferred 20-task suite after `task-000` is passing.

Why here: HTTP, SQLite, and Postgres support should not block harness validation on the trivial task.

This slice should implement:

- Shared verifier helper design for starting candidate HTTP servers.
- Port allocation and timeout design.
- SQLite temp database helper design.
- Postgres service readiness and per-task schema reset design.
- SQL and HTTP assertion helper design.

Expected output:

- A follow-up implementation plan exists for service-backed tasks.

Verification:

```sh
test -f docs/plans/2026-06-17-mini-bench-harness-plan.md
```

Completed notes:

- Documented future HTTP server responsibilities: startup, readiness, port allocation, request timeouts, and cleanup.
- Documented SQLite temp database expectations.
- Documented Postgres Compose/readiness/reset expectations.
- Kept all HTTP/API/DB task implementation deferred until after V0 harness proof.

Dependencies: Slice 8.

### Slice 10: CI-Optional And Maintenance Hardening

Status: `[x]` Done

Goal: Make the mini-bench maintainable without making normal CI expensive.

Why here: The benchmark should stay useful over time without blocking normal development on model calls or Docker-heavy runs.

This slice should implement:

- Non-LLM verifier-only CI checks.
- Optional manual workflow for live model runs.
- Task authoring checklist.
- Versioned task metadata.
- Cleanup policy for generated reports.

Expected output:

- CI can prove task/verifier integrity without calling a model.
- Live model runs remain manual or explicitly scheduled.

Verification:

```sh
pnpm --dir bench/mini-bench run typecheck
pnpm --dir bench/mini-bench run verify-fixtures
```

Completed notes:

- Added non-LLM checks for task listing, syntax/type checking, and known-good/known-bad verifier fixtures.
- Added root `pnpm mini-bench:*` scripts and `mise` tasks for local ergonomics.
- Added `bench/mini-bench/reports/.gitignore` so generated run artifacts do not churn git status.
- Documented that live model checks are manual because they require credentials, network, and model latency.

Dependencies: Slice 9.

## Testing Plan

Per-slice verification is listed above.

Final verification after implementation should include:

```sh
node bench/mini-bench/src/cli.ts list
node bench/mini-bench/src/cli.ts verify-fixtures
node bench/mini-bench/src/cli.ts run --task task-000-basic-ts-transform --no-agent --candidate good
node bench/mini-bench/src/cli.ts run --task task-000-basic-ts-transform --no-agent --candidate bad
mise run mini-bench-list
mise run mini-bench-verify-fixtures
```

Live model verification should be separate:

```sh
node bench/mini-bench/src/cli.ts run --task task-000-basic-ts-transform --config bench/mini-bench/config/openrouter-gpt-5.4-mini.jsonc
```

## Open Questions

- V0 uses a host runner and Docker Compose-compatible service shape.
- V0 mimics external benchmarks with one final hidden verifier run; iterative feedback is deferred.
- Prompts live in `prompt.md`; workspaces may also include public README/tests when useful.
- Task metadata stays YAML for author readability, parsed by the minimal V0 loader.
- V0 supports Topchester only.
- Reports include JSON, Markdown summary, changed files, verifier assertions, stdout/stderr tails, event counts, tool-call summaries, timing, timeout state, and event source path.
- Generated reports are ignored; selected golden examples can be added later if they become useful.
