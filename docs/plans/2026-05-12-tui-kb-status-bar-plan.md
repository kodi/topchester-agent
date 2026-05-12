# TUI KB Status Bar Plan

## Summary

Add a compact KB health segment to the existing TUI footer status line so users can always see whether the configured project KB path is ready, missing, or invalid.

Chosen behavior:

- Surface: existing footer status line.
- Signal: path health only, using existing `KnowledgeStatus`.
- Wording: `kb: ready`, `kb: missing`, or `kb: not-folder`.
- Refresh timing: startup check plus after `/kb init`, `/kb reset`, and `/kb compile`.
- Bad state behavior: visible footer warning only; preserve existing missing-KB modal.

## Decision

Implement v1 as a presentation/state plumbing change, not a manifest/drift feature.

The footer should remain compact:

```text
status: ready · folder: topchester-agent · model: gemini [...] · kb: ready
status: ready · folder: topchester-agent · model: gemini [...] · kb: missing
status: ready · folder: topchester-agent · model: gemini [...] · kb: not-folder
```

Do not read `manifest.json` in this slice. Do not show L1 counts, compiler version, stale state, drift, or cache health yet.

## Scope

This plan covers the first always-visible KB status indicator in the TUI. It does not implement drift detection, manifest validation, L1 counts, cache freshness, or strict KB enforcement.

## Current State

The TUI already renders a bottom status line through `formatStatusLine(...)`, and `ChatLayout` stores the current runtime status string. KB path health already exists in `getKnowledgeStatus(...)`, and startup already emits `knowledge_status` events plus the missing-KB modal.

The missing piece is persistent footer state: runtime KB status is shown as a chat/system message, but not retained in the footer.

## Implementation Shape

Keep the change close to the existing TUI state boundary:

- Convert `KnowledgeStatus` into a compact footer label in the TUI layer.
- Store that label on `ChatLayout` alongside the existing runtime status.
- Update the stored label when startup or slash-command runtime events report KB status.
- Keep existing chat messages and modal behavior intact.

## Slices

### Slice 1: Footer KB Status Contract

Status: `[x]` Complete

Goal: Define a small TUI-facing KB footer state.

Why here: The rendering contract should exist before wiring runtime events into it.

This slice should implement:

- Add a compact KB status formatter that maps `KnowledgeStatus` to `kb: ready`, `kb: missing`, or `kb: not-folder`.
- Extend `formatStatusLine(...)` to accept optional KB status text.
- Keep current output unchanged when no KB status is supplied.

Expected output:

- Existing status line callers continue working.
- Tests cover no-KB-field backward compatibility and all three KB footer labels.

Verification:

```sh
pnpm test test/tui.render.test.ts
pnpm typecheck
```

Dependencies: None.

### Slice 2: Runtime Event Plumbing

Status: `[x]` Complete

Goal: Persist KB status events into `ChatLayout` footer state.

Why here: The TUI already receives KB status events; this slice makes that status visible outside the chat transcript.

This slice should implement:

- Add `setKnowledgeStatus(...)` or equivalent to `ChatLayout`.
- When `TopchesterTuiShell.applyRuntimeEvents(...)` receives a `knowledge_status` event, update the footer KB state before or while rendering existing messages.
- Preserve the existing startup chat message and missing-KB modal.

Expected output:

- Startup TUI shows the compact KB footer segment after the KB check runs.
- Existing modal behavior remains unchanged.

Verification:

```sh
pnpm test test/tui.render.test.ts
```

Dependencies: Slice 1.

### Slice 3: Refresh After KB Commands

Status: `[ ]` Not started

Goal: Keep the footer accurate after KB-changing slash commands.

Why here: The footer is only useful if it changes after the commands that create, reset, compile, or inspect the KB.

This slice should implement:

- After `/kb init`, `/kb reset`, and `/kb compile`, refresh `getKnowledgeStatus(workspaceRoot)` and emit/apply a `knowledge_status` event.
- `/kb status` should also refresh the footer.
- Keep command response text unchanged unless tests need minor updates.

Expected output:

- Running `/kb init` can move footer from `kb: missing` to `kb: ready`.
- Running `/kb reset` can move footer from `kb: ready` to `kb: missing`.
- Running `/kb compile` preserves or refreshes the current KB footer state.

Verification:

```sh
pnpm test test/commands.test.ts test/tui.render.test.ts
```

Dependencies: Slice 2.

### Slice 4: Documentation and Final Check

Status: `[ ]` Not started

Goal: Record the TUI behavior and verify the full repo.

Why here: Docs and checklist updates should describe the behavior after implementation details are stable.

This slice should implement:

- Update `docs/cli.md` TUI section to mention the KB footer segment.
- If appropriate, check off or add the corresponding TUI Integration item in `docs/plans/kb-implementation-checklist.md`.
- Record completed slice notes, actual verification commands, and `Next Slice` in this plan doc.

Expected output:

- Docs describe the visible KB status footer.
- Plan progress is updated as a working handoff document.

Verification:

```sh
pnpm check
```

Dependencies: Slices 1-3.

## Cross-Slice Rules

- Keep v1 path-health only; do not read or validate `manifest.json`.
- Preserve the existing missing-KB modal and startup KB status message.
- Do not block normal chat in this plan.
- Keep narrow-terminal behavior on the existing truncation path.

## Testing Plan

Per-slice verification is listed above. Final verification should run:

```sh
pnpm check
```

Manual check after implementation:

- Start the TUI in a workspace with no KB and confirm the footer shows `kb: missing`.
- Run `/kb init` and confirm the footer changes to `kb: ready`.
- Run `/kb reset` and confirm the footer changes back to `kb: missing`.

## Working Notes

- 2026-05-12: Plan created. User chose footer segment, path health only, visible warning behavior, `kb: ready` wording, refresh after startup and KB commands, and `docs/plans/` as the plan location.
- 2026-05-12: Slice 1 complete. Added the optional KB footer status contract and compact formatter in the TUI layer. Verified with `pnpm test test/tui.render.test.ts` and `pnpm typecheck`.
- 2026-05-12: Slice 2 complete. `ChatLayout` stores the compact KB footer label and runtime `knowledge_status` events update it while still rendering the existing KB status message/modal. Verified with `pnpm test test/tui.render.test.ts`.

## Next Slice

Start Slice 3 by refreshing `getKnowledgeStatus(workspaceRoot)` after `/kb init`, `/kb reset`, `/kb compile`, and `/kb status`.
