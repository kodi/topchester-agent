# Benchmarks

Benchmark scripts live here and are meant to be run from the repository root.

## L1 Search

`l1-search.ts` measures the same L1 context-pack work as:

```sh
topchester-dev --config config/gemini.jsonc kb context "does status bar auto refresh as we work?" --json
```

It calls the Topchester knowledge search code directly instead of shelling out to
the CLI.

Run it through the package script:

```sh
pnpm benchmark:l1-search -- --workspace-dir . --mode shared --query "does status bar auto refresh as we work?" --trials 20
```

JSON output:

```sh
pnpm benchmark:l1-search -- --workspace-dir . --mode fresh --query "does status bar auto refresh as we work?" --trials 20 --json
```

Compact JSON output without the full context pack:

```sh
pnpm benchmark:l1-search -- --workspace-dir . --mode fresh --query "does status bar auto refresh as we work?" --trials 20 --json --omit-context-pack
```

### Parameters

| Parameter             | Required | Values              | Description                                                                                    |
| --------------------- | -------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| `--workspace-dir`     | yes      | path                | Project directory that contains `topchester-kb`. Relative paths resolve from the current cwd.  |
| `--mode`              | yes      | `shared`, `fresh`   | `shared` loads one L1 in-memory index before measuring. `fresh` reloads and indexes each run.  |
| `--query`             | yes      | string              | Search query used to build the L1 context pack.                                                |
| `--trials`            | yes      | positive integer    | Number of measured benchmark runs.                                                             |
| `--limit`             | no       | positive integer    | Maximum relevant files in the context pack. Defaults to the normal KB context default.         |
| `--min-score`         | no       | non-negative number | Minimum L1 match score. Defaults to the normal KB context default.                             |
| `--full-l1`           | no       | flag                | Include full raw L1 entries in the measured JSON context pack.                                 |
| `--json`              | no       | flag                | Print a machine-readable benchmark summary and the last context pack.                          |
| `--omit-context-pack` | no       | flag                | With `--json`, omit the full `contextPack` payload and keep only benchmark stats plus summary. |

### Modes

`shared` mode is useful when you want to measure repeated query and context-pack
selection against an already-loaded L1 index. The output also reports the one-time
index setup time separately.

`fresh` mode is useful when you want CLI-like cost per call. Each measured run
loads L1 files, builds the in-memory index, searches, selects files, and serializes
the context pack.

### Output

Human output includes:

- indexed entry count
- invalid L1 entry count
- relevant file count
- context JSON byte size
- latency mean, p50, p75, p99
- relative margin of error
- throughput in operations per second
- the final context-pack summary

`--json` includes the same benchmark stats plus the final context pack after
empty containers are stripped, matching the CLI JSON shape. Add
`--omit-context-pack` when you want compact JSON that keeps the benchmark stats
and final summary without embedding the full `contextPack` object.
