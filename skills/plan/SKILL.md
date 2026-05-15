---
name: plan
description: Split larger work into ordered, verifiable implementation slices.
---

# Plan

## When to Use

Use when work is risky, cross-cutting, phased, or too large for one clean implementation pass.

## Procedure

1. State the target outcome and the decisions already made.
2. Separate scope, out-of-scope work, and behavior that must be preserved.
3. Split implementation into ordered slices with a goal, dependency boundary, expected output, and verification.
4. Keep each slice independently reviewable and able to leave the repo in a useful state.
5. Update the plan as findings change later slices.

## Verification

Each slice should name the smallest useful check, and the full plan should name the final confidence pass.
