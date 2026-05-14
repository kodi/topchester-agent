# L1 search p75 optimization benchmark

Goal: reduce p75 latency by at least 25% for the requested L1 search benchmark query, running both fresh and shared modes with 100 trials.

Query:

```text
does status bar auto refresh as we
work?
```

Commands:

```sh
pnpm benchmark:l1-search -- --workspace-dir . --mode fresh --query "does status bar auto refresh as we
work?" --trials 100 --json --omit-context-pack

pnpm benchmark:l1-search -- --workspace-dir . --mode shared --query "does status bar auto refresh as we
work?" --trials 100 --json --omit-context-pack
```

## Baseline

Iteration 0, unchanged checkout:

| Mode   | p75 ms | mean ms | p50 ms | p99 ms | total ms | notes                                            |
| ------ | -----: | ------: | -----: | -----: | -------: | ------------------------------------------------ |
| fresh  |  19.34 |  18.397 | 18.552 | 23.923 | 1839.668 | Reloads and indexes 145 L1 entries on every run. |
| shared |   0.29 |   0.364 |  0.254 |  1.012 |   36.365 | One shared index, setup 28.757 ms.               |

Targets from this baseline:

| Mode   | 25% reduction target |
| ------ | -------------------: |
| fresh  |         <= 14.505 ms |
| shared |         <= 0.2175 ms |

## Iterations

### Iteration 1: Concurrent fresh L1 entry loading

Hypothesis: fresh mode is dominated by repeatedly loading 145 L1 JSON files. `loadL1FileEntries` currently reads and parses files one at a time after deterministic path sorting. Reading/parsing all sorted paths concurrently should reduce per-run wall time without changing result ordering or invalid-entry behavior.

Result:

| Mode   | p75 ms | mean ms | p50 ms | p99 ms | total ms | vs baseline p75 | notes                                                                                                                    |
| ------ | -----: | ------: | -----: | -----: | -------: | --------------: | ------------------------------------------------------------------------------------------------------------------------ |
| fresh  | 12.126 |  11.988 | 11.675 | 16.085 | 1198.802 |          -37.3% | Met the 25% target for fresh mode.                                                                                       |
| shared |  0.299 |   0.367 |  0.268 |   1.08 |   36.708 |           +3.1% | Shared measured query work did not improve; setup improved from 28.757 ms to 20.701 ms but setup is outside p75 latency. |

Assessment: better for fresh mode, worse/noisy for shared p75.

### Iteration 2: Prefix-match lookup for shared search

Hypothesis: shared mode spends most of its time in query scoring and prefix matching against the in-memory token map. Precomputing prefix-to-indexed-token lookups during index construction should avoid scanning every indexed token for each query token.

Result:

| Mode   | p75 ms | mean ms | p50 ms | p99 ms | total ms | vs baseline p75 | notes                                                                          |
| ------ | -----: | ------: | -----: | -----: | -------: | --------------: | ------------------------------------------------------------------------------ |
| shared |  0.241 |   0.315 |  0.204 |  1.098 |   31.481 |          -16.9% | Exact-preserving prefix lookup improved shared mode but missed the 25% target. |

Assessment: better for shared mode, but insufficient. A faster variant reached shared p75 0.211 ms, but changed `contextJsonBytes` from 24303 to 23635, so it was not accepted.

### Iteration 3: Precompute posting reason strings

Hypothesis: shared search repeatedly formats the same reason strings while scoring postings. Moving that formatting to index construction should reduce per-query work while preserving context output.

Result:

| Mode   | p75 ms | mean ms | p50 ms | p99 ms | total ms | vs baseline p75 | notes                                                                |
| ------ | -----: | ------: | -----: | -----: | -------: | --------------: | -------------------------------------------------------------------- |
| shared |   0.18 |   0.263 |  0.157 |  0.658 |   26.318 |          -37.9% | Met the 25% target for shared mode. `contextJsonBytes` stayed 24303. |
| fresh  | 12.565 |  12.206 | 11.901 | 15.772 | 1220.578 |          -35.0% | Still meets the 25% target for fresh mode with all changes combined. |

Assessment: accepted. Both benchmark modes meet the p75 target in the final measured state.
