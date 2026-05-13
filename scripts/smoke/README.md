# Topchester Smoke Tests

Smoke tests run curated prompts against clean `/tmp` workspaces and assert global logs plus final workspace state.

Run the deterministic fake API battery:

```sh
pnpm exec tsx scripts/smoke/run-smoke.ts --fake-api --trials 1
```

Run one live-model trial from a machine with model API keys:

```sh
pnpm exec tsx scripts/smoke/run-smoke.ts --trials 1 --model openrouter/qwen/qwen3-coder:free
```

Debug one scenario and keep its workspace:

```sh
pnpm exec tsx scripts/smoke/run-smoke.ts --scenario 05-edit-file --trials 1 --keep-workspaces
```

Validate scenario configs without running prompts:

```sh
pnpm exec tsx scripts/smoke/run-smoke.ts --dry-run
```

The runner writes `report.json`, `summary.md`, per-trial `events-*.jsonl`, `stdout.log`, `stderr.log`, and filtered `topchester.log` artifacts. It is local-only for V0; do not wire it into CI yet.

During a run, each completed trial prints one compact line:

```text
✓ 05-edit-file trial 1 passed (466ms)
× 02-read-summarize trial 1 summary.txt did not contain "user account notes" (409ms)
```

The final summary includes report paths, pass/fail totals, and total elapsed time.

Useful options:

- `--scenario <id>` runs one scenario.
- `--trials <n>` repeats each selected scenario.
- `--parallel <n>` limits concurrent trials.
- `--output <path>` chooses the report path.
- `--keep-workspaces` preserves `/tmp` workspaces for debugging.
