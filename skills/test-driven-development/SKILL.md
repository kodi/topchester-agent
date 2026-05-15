---
name: test-driven-development
description: Add or tighten tests before implementing a behavior change.
---

# Test-Driven Development

## When to Use

Use when changing behavior, fixing a bug, or adding a contract that can be tested locally.

## Procedure

1. Locate the existing test style and the closest coverage for the behavior.
2. Add the smallest failing test that describes the desired behavior.
3. Run the focused test and confirm it fails for the expected reason when practical.
4. Implement the smallest production change that satisfies the test.
5. Rerun the focused test, then the broader relevant check.

## Verification

Keep the final test command in the handoff and note any test that could not be run.
