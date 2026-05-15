# KB Session Overlay

Status: Draft

## Purpose

Topchester should support normal coding sessions where the working tree changes
while the canonical KB is temporarily behind.

This is not an error state. A coding agent spends most of its useful time between
the last clean KB sync and the next synchronized KB update.

## Core Invariant

Topchester may operate with a dirty KB during active work, but it must know which
knowledge is dirty, must not present stale derived knowledge as current, and must
provide a clear path to synchronize the canonical KB before the work is considered
complete.

Dirty is acceptable. Unknown dirty is not.

## Model

Topchester should reason from three layers:

```text
clean canonical KB
  + current working tree
  + session overlay
  = current agent understanding
```

The canonical KB remains the committed, reproducible project knowledge under
`topchester-kb/`.

The session overlay is runtime state for the current coding session. It tracks
what changed after the canonical KB was loaded or compiled.

## Overlay Responsibilities

The session overlay should track:

- changed files
- added files
- deleted files
- files changed by the agent
- files changed externally while the session is active
- affected L1 file entries
- suspect L2 modules
- suspect L3 features
- partial refreshes already performed during the session

The overlay does not replace the canonical KB. It tells the agent how to interpret
canonical KB entries in the presence of current working tree changes.

## Initial States

Use a small state vocabulary:

- `clean`: canonical KB matches the current working tree.
- `dirty_known`: Topchester knows which files changed.
- `dirty_external`: relevant files changed outside the current agent flow.
- `partially_refreshed`: some affected KB entries were updated, but derived
  modules or features may still be suspect.
- `needs_sync`: the current work should refresh canonical KB before it is done.
- `invalid`: KB schema, hash, or cache state is broken.

## Agent Behavior

During active implementation, Topchester should not try to force the canonical KB
back to green after every edit.

Instead, it should:

1. Load or compile a clean KB at project start.
2. Run scoped drift checks before relying on relevant KB context.
3. Mark files dirty in the session overlay as edits happen.
4. Prefer live file content and overlay facts over stale canonical summaries for
   touched areas.
5. Mark affected modules and features as suspect until refreshed.
6. Refresh incrementally at natural checkpoints.
7. Synchronize the canonical KB before the work is considered complete.

Natural checkpoints include a coherent edit batch, a passing test run, an explicit
user request, a commit, or PR handoff.

## Task-Time KB Use

The KB is the agent's working map. It is not a replacement for reading current
source files.

During a task, Topchester should use the KB to:

- find relevant features, modules, entrypoints, tests, docs, commands, and examples
- assemble compact context packs instead of rediscovering the repo from scratch
- identify local patterns and ownership boundaries
- estimate affected modules, features, tests, and follow-up work
- choose verification commands that match the touched area
- decide which KB entries need refresh after edits

Task-critical facts should be resolved against the current working tree before
the agent acts on them. If a touched area is dirty, live file content plus the
session overlay is more authoritative than canonical KB summaries.

A normal task loop should look like:

```text
user task
  -> KB search / context pack
  -> scoped drift check
  -> plan using KB graph + live files
  -> edit with session overlay
  -> verify using KB-suggested tests/commands
  -> refresh or mark KB dirty/suspect
```

Every KB result used by the agent should be provenance-aware:

```text
source: canonical_kb | session_overlay | live_file | mixed
drift: current | dirty_known | suspect | stale
evidence: file paths, node ids, hashes
```

## User Experience

The TUI should make dirty-but-known state feel normal:

```text
kb: dirty | known changes: 7 files | affected: auth, billing
```

It should reserve stronger warnings for unknown or risky states:

```text
kb: stale | unknown changes in relevant files
```

The agent should avoid repeating noisy warnings while the same known dirty state is
active. It should warn when the dirty state changes, when the user asks a question
that depends on suspect knowledge, or when the session reaches a synchronization
checkpoint.

## Open Questions

- Where should overlay state live: memory only, cache SQLite, or a small session
  file under `.agents/topchester/`?
- How much L1 refresh should happen automatically after edits?
- Should the agent block commits when `needs_sync` is unresolved?
- How should externally modified files be distinguished from agent-authored files?
