---
name: planning-slices
description: Use this skill when creating or updating planning documents for large changes, migrations, phased implementations, multi-PR work, risky refactors, staging validation, or any task that should be decomposed into ordered, reviewable slices with clear dependencies and verification.
---

# Planning Slices

Use this workflow when a change is too large, risky, or cross-cutting to handle as one undifferentiated implementation. The output should be a working plan that future agents can resume from, not a polished proposal.

## Core Idea

Plan large changes as ordered slices. Each slice should have a concrete goal, a dependency boundary, expected output, verification, and running findings. A good slice can become a focused PR, commit, or reviewable checkpoint, and should leave the repo in a better state even if later slices are delayed.

## When To Use

Use planning slices for:

- migrations and compatibility transitions
- multi-module or multi-service features
- runtime, API, deployment, or UI changes with hidden risk
- staging validation or rollout work
- refactors where one large PR would hide behavior changes
- any task where the next agent needs a reliable handoff record

Do not overbuild the plan for small, local edits. A compact checklist is enough when the scope is obvious and low risk.

## Plan Shape

Start with enough context that a future agent can continue without rediscovering the whole problem:

- `# Title`: name the feature, migration, or target state directly.
- `## Summary`: state the target outcome and why the plan exists.
- `## Decision` or `## Decisions`: record decisions already made.
- `## Scope`: say what is included and explicitly out of scope.
- `## Current State` or `## Behavior To Preserve`: capture the baseline.
- `## Recommended Approach` or `## Implementation Shape`: name the intended architecture.
- `## Data Flow`, `## Edge Cases`, and `## Testing Plan`: add when runtime or UI behavior changes.
- `## Files to Add` and `## Files to Change`: use when constraining implementation matters.
- `## Open Questions`: keep unresolved product or engineering judgment visible.

Not every plan needs every section. Deep migrations need stronger contract and risk tracking; compact product or UI work can use fewer sections.

## Slice Structure

Order slices from least dependent to most dependent. Earlier slices should harden a contract, prove a risky assumption, or create a foundation for later slices.

Each full slice should include:

- `Goal`: the concrete outcome of this slice.
- `Why here`: why this slice belongs at this point in the order.
- `This slice should implement`: the work items.
- `Expected output`: the files, behavior, or operational state produced.
- `Verification`: the smallest meaningful command or manual check.
- `Dependencies`: prior slices or external prerequisites.

For smaller plans, a lighter checklist is fine as long as the boundary stays crisp:

```markdown
### Slice 1: Deployment summary helper

Status: `[ ]` Not started

- add a small helper that parses deployment YAML
- keep failures non-throwing
- add focused tests
```

When tracking status in the plan, use:

- `[ ]` Not started
- `[-]` In progress
- `[x]` Done

## Slice Sizing

A slice is well-sized when it can be reviewed on its own and does not require later slices before tests pass.

Prefer slices that:

- touch one module or one contract boundary at a time
- add or harden tests before changing risky behavior
- keep deployment, runtime, API, and UI work separated where possible
- have a clear verification command
- produce a natural commit or small PR

Avoid slices that:

- mix refactor, behavior change, and rollout in one step
- require later slices before the repo is usable
- create a long-lived dual implementation without an explicit cleanup slice
- leave the next agent guessing what was learned

## Cross-Slice Rules

Use cross-slice rules when the same constraint applies everywhere, such as:

- preserve an existing runtime or API contract unless a limitation is proven
- keep the current user path unchanged until the replacement is validated
- treat a specific test suite as the black-box contract source
- remove legacy code after parity is proven

These rules keep slice-level choices aligned without repeating the same warning under every slice.

## Verification

Every plan should name verification at two levels:

- per-slice verification for the smallest useful check
- final verification for the broader confidence pass

Prefer repo-standard commands. Record the exact command that passed in the plan. If local verification is incomplete, state what remains unverified and where it must be checked, such as staging, production shadowing, or a specific manual workflow.

## Progress Updates

Treat the plan as the handoff record between sessions. When a slice finishes, update:

- the slice status
- completed work or findings for that slice
- implications for later slices when new information changes the plan
- verification with the actual command or manual check that passed
- the next slice so the next session starts in the right place

When a real follow-up appears outside the original core change, add a numbered follow-up slice such as `Slice 5.1` instead of burying it in notes.

## New Plan Checklist

When creating a new plan:

- use the repo's normal planning location and filename conventions
- write the target state before the implementation list
- capture decisions separately from open questions
- split the work into ordered slices
- give each slice a dependency boundary and verification step
- add a cleanup or docs slice when the work creates temporary state
- update the plan after each completed slice
- update relevant project docs when implementation changes project behavior
