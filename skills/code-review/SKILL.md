---
name: code-review
description: Review code for correctness, maintainability, security, and project fit.
---

# Code Review

## When to Use

Use when reviewing code before merge, after a risky change, or when the user asks for a review.

## Procedure

1. Inspect the diff and the surrounding code that gives it meaning.
2. Look first for bugs, regressions, missing tests, security issues, and broken contracts.
3. Check whether the change follows local style, naming, error handling, and dependency patterns.
4. Keep findings concrete with file and line references when possible.
5. Put findings before summaries. If there are no findings, say that clearly and mention remaining test gaps.

## Verification

Confirm the relevant tests, type checks, lint checks, or manual checks for the changed behavior.
