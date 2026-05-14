# Topchester Smoke Tests

Smoke tests run curated prompts against clean `/tmp` workspaces and assert global logs plus final workspace state.

Git scenarios initialize temporary repositories during setup instead of storing `.git` directories in fixtures. They configure a local test identity, create an initial commit when requested, and assert staged paths, unstaged paths, untracked paths, and latest-commit metadata after the run.

Run the deterministic fake API battery:

```sh
mise run smoke 1
```

Run one live-model trial from a machine with model API keys:

```sh
mise run smoke-live config/gemini.yaml 1 inclusionai/ring-2.6-1t:free
```

Debug one scenario and keep its workspace:

```sh
mise run smoke-scenario 05-edit-file 1
```

Validate scenario configs without running prompts:

```sh
pnpm exec tsx scripts/smoke/run-smoke.ts --dry-run
```

The runner writes `report.json`, `summary.md`, per-trial `events-*.jsonl`, `stdout.log`, `stderr.log`, and filtered `topchester.log` artifacts. It is local-only for V0; do not wire it into CI yet.

During a run, each completed trial prints one compact line:

```text
✓ 05-edit-file trial 1 passed [text-json] (466ms)
× 02-read-summarize trial 1 summary.txt did not contain "user account notes" [native-openai-compatible] (409ms)
```

The final summary includes report paths, pass/fail totals, and total elapsed time.

Each `report.json` trial and `summary.md` entry includes protocol metadata:

- `toolProtocol` — the last protocol path that produced a tool call, or the last model response protocol when no tools ran.
- `nativeToolCallCount` — native structured tool calls seen by the runtime.
- `textJsonToolCallCount` — text JSON tool calls parsed by the runtime.
- `textXmlToolCallCount` — XML-style text tool calls parsed by the runtime.
- `providerRejectedTools` — whether native tools were rejected and fallback was used.
- `fallbackReason` — the first recorded fallback reason, when present.

Useful options:

- `mise run smoke <trials>` runs the fake API battery.
- `mise run smoke-scenario <id> <trials>` runs one fake API scenario and keeps its workspace.
- `mise run smoke-live <config> <trials> <model> <timeout_ms>` runs the live-model battery.
- `--config <path>` passes an explicit Topchester config file to live-model runs.
- `--timeout <ms>` overrides each scenario prompt timeout.
- `--scenario <id>` runs one scenario; repeat it or pass comma-separated ids/prefixes to run a slice.
- `--trials <n>` repeats each selected scenario.
- `--parallel <n>` limits concurrent trials.
- `--output <path>` chooses the report path.
- `--tool-protocol <auto|native|text-json|text-xml>` forces a protocol for debugging.
- `--keep-workspaces` preserves `/tmp` workspaces for debugging.
