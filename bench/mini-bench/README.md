# Topchester Mini-Bench

Mini-bench is a local harness for validating that Topchester can run a small benchmark task in a clean workspace with hidden verifiers.

V0 intentionally contains one trivial task:

- `task-000-basic-ts-transform`

That task exists to prove the harness, not model quality. It is basic TypeScript arrays, objects, and strings.

The first non-trivial TypeScript task is also available:

- `ts-001-json-schema-migrator`
- `db-001-sqlite-ledger-balances`

## Commands

```sh
pnpm mini-bench:list
pnpm mini-bench:verify-fixtures
pnpm mini-bench run --task task-000-basic-ts-transform --no-agent --candidate good
pnpm mini-bench run --task task-000-basic-ts-transform --task ts-001-json-schema-migrator --task db-001-sqlite-ledger-balances
pnpm mini-bench run --task task-000-basic-ts-transform --config bench/mini-bench/config/openrouter-gpt-5.4-mini.jsonc
pnpm mini-bench clean
```

Multiple `--task` flags run sequentially in one process. Each task still writes its own per-task report. The overall command exits non-zero if any task fails.

Live agent runs default to the Docker `agent` service. The image installs Topchester from npm inside the container, so benchmark runs do not depend on the host checkout's `dist/`, `node_modules`, `HOME`, or user config.

The default npm spec is:

```sh
topchester-ai@latest
```

Pin a released package version with:

```sh
MINI_BENCH_TOPCHESTER_NPM_SPEC=topchester-ai@0.69.0 pnpm mini-bench run --task task-000-basic-ts-transform --config bench/mini-bench/config/openrouter-gpt-5.4-mini.jsonc
```

For local development against the current checkout, opt back into the host runtime:

```sh
MINI_BENCH_TOPCHESTER_RUNTIME=host pnpm mini-bench run --task task-000-basic-ts-transform --config bench/mini-bench/config/openrouter-gpt-5.4-mini.jsonc
```

Codex GPT 5.4 mini can be tried with:

```sh
pnpm mini-bench run --task task-000-basic-ts-transform --config bench/mini-bench/config/codex-gpt-5.4-mini.jsonc
```

That path requires a valid local Codex auth token. OpenRouter runs require `OPENROUTER_API_KEY`.

Benchmark configs should set `hooks.enabled: false`. Local user hooks are useful in interactive sessions, but they add latency and can convert a solved benchmark task into a timeout during shutdown.

Reports are written under `bench/mini-bench/reports/runs/`; generated reports are ignored by git. `bench/mini-bench/reports/latest-report.json` points at the most recent run.

For live Topchester runs, each per-task report also preserves Topchester's own run artifacts:

- `topchester-artifacts/sessions/<session-id>/events.jsonl`
- `topchester-artifacts/sessions/<session-id>/metadata.json`
- `topchester-artifacts/logs/topchester.log`

The report keeps stdout/stderr paths plus these copied `.agents/topchester` artifacts so agent behavior, hooks, model calls, tool calls, and timeout causes can be inspected after the run.

Agent reports include the requested `--output-json` event path and, when needed, an `eventsSourcePath` fallback to the session events under the copied workspace. This keeps tool-call summaries useful even when Topchester solves the task but is killed during post-run shutdown hooks before writing the requested output JSON.

Live agent runs also print and persist an event summary:

- total event count,
- event kinds,
- message counts by role,
- task-plan update count,
- todo update count,
- status event count,
- tool-call breakdown by tool name.

## V0 Result Semantics

V0 is single-shot:

```text
agent attempt -> final hidden verifier -> report
```

Iterative verifier feedback is intentionally deferred to V1. The runner does not support `--max-attempts` yet because accepting that flag without retry behavior would make benchmark results ambiguous.

Run status values:

- `passed`: the agent exited normally and the hidden verifier passed.
- `failed`: the agent exited normally, but setup or verification failed.
- `agent_timeout`: the agent process hit its timeout. The verifier may still run against files left behind, but the run is not considered clean.

## Visibility Boundary

The agent-visible workspace is copied from `tasks/<task>/workspace`.

The hidden verifier lives in `tasks/<task>/verifier` and must not be copied into the agent workspace or mounted into the agent container. The V0 verifier includes a sentinel check that fails if hidden verifier content leaks into the workspace.

Agent-visible:

- the copied workspace,
- the public prompt,
- public README and tests intentionally present in the workspace,
- command output produced inside the workspace.

Hidden from the agent:

- verifier source,
- private fixtures,
- exact hidden expected outputs,
- scoring logic,
- harness internals outside the copied workspace.

## Task Authoring Checklist

Every future task should include:

- `task.yaml` with id, category, difficulty, workspace, verifier command, services, timeout, and expected changed files.
- `prompt.md` with the public user-facing request.
- `workspace/` with only files the agent may inspect or edit.
- `verifier/verify.ts` that runs outside the agent-visible workspace.
- Known-good and known-bad fixtures under `verifier/fixtures/`.
- A deterministic verifier result with `passed`, `score`, and assertion summaries.
- A public command or behavior path the agent can use for local validation.

Verifier checks should be black-box when possible. Avoid brittle exact source matching unless the task is explicitly about source shape.

## Hidden Verifier Checklist

Before adding a task, confirm:

- `workspace/` does not contain verifier code, hidden fixtures, sentinels, or golden outputs.
- The verifier fails if hidden sentinel content appears in the copied workspace.
- Failure summaries describe behavior gaps without dumping private fixtures.
- Known-good passes and known-bad fails through `pnpm mini-bench:verify-fixtures`.
- Generated run directories are the only place mutable candidate work is written.

## Future Services

HTTP and DB tasks should be added after V0 is stable.

For HTTP tasks, the runner should own candidate server startup, port allocation, readiness checks, request timeouts, and cleanup. Verifiers should exercise public API behavior with HTTP requests rather than importing candidate internals.

For SQLite tasks, verifiers should create temp databases inside the run directory and reset them per assertion group.

For Postgres tasks, Compose should provide the service, while the runner owns readiness, per-task schema/database reset, and deterministic seed data. The agent should receive only connection details needed by the task, never hidden verifier SQL or expected rows.

## Maintenance

Non-LLM checks:

```sh
pnpm --dir bench/mini-bench run typecheck
pnpm mini-bench:list
pnpm mini-bench:verify-fixtures
```

Manual live model checks should stay separate from normal CI because they require credentials, network, and model latency.
