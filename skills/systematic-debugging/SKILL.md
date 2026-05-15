---
name: systematic-debugging
description: Debug failures by finding evidence and root cause before changing code.
---

# Systematic Debugging

## When to Use

Use when something fails, flakes, regresses, or behaves differently between environments.

## Procedure

1. Reproduce or inspect the exact failure output, log, artifact, or trace the user provided.
2. Identify the smallest failing contract before editing code.
3. Compare expected and actual behavior at the boundary where they first differ.
4. Make one focused fix that addresses the root cause.
5. Rerun the narrow failing check before broad verification.

## Verification

Record the failing command or artifact inspected, the focused check that now passes, and any broader gate still needed.
