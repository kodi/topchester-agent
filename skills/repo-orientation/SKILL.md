---
name: repo-orientation
description: Quickly map an unfamiliar repository before changing it.
---

# Repo Orientation

## When to Use

Use at the start of work in an unfamiliar codebase or when the request depends on local architecture.

## Procedure

1. Read the repo instructions first, including override files they name.
2. Inspect package scripts, tests, and the files closest to the requested change.
3. Search for existing examples before adding new patterns.
4. Identify the narrowest files and tests that prove the change.
5. Summarize only the context that affects the next action.

## Verification

Before editing, confirm the target module, nearby tests, and expected verification command.
