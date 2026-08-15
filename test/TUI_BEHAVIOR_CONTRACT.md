# TUI behavior contract

This is the regression checklist for the shipped OpenTUI renderer. Application behavior is tested at the framework-neutral controller boundary; terminal behavior is tested with OpenTUI's Bun renderer and a packed-artifact PTY smoke.

## Automated compatibility matrix

| Behavior                                                                                                 | Evidence                                                                                                  |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Non-TTY startup is semantic, ordered, and ANSI-free                                                      | `cli.integration.test.ts`, `static-view.test.ts`, `transcript.test.ts`                                    |
| Startup, status, task plan, model/effort, KB, queue, workspace, and session state                        | `tui-controller.test.ts`, `production-test.tsx`                                                           |
| User, assistant Markdown, reasoning, tool/diff, hook, approval, subagent, KB, and Unicode rows           | `production-test.tsx:testThreadEntryVariants`                                                             |
| Stable transcript rows commit exactly once                                                               | `production-test.tsx:testTranscriptWriter`                                                                |
| Restore/fork append a visible session boundary without clearing earlier terminal history                 | `tui-controller.test.ts`, `production-test.tsx:testTranscriptWriter`                                      |
| Enter submit, Shift+Enter newline, history, slash/file completion, and large-paste expansion             | `production-test.tsx:testAppSurface`, `opentui-state.test.ts`, file-mention tests                         |
| Composer stays editable while busy; queued preview and steering preserve FIFO/fallback behavior          | `tui-controller.test.ts`, `production-test.tsx`, `opentui-state.test.ts`                                  |
| Runtime choices and bash approvals return semantic results                                               | `tui-controller.test.ts`                                                                                  |
| Model, effort, provider, skills, new/fork/restore, task-plan, hook, and KB flows remain controller-owned | `tui-controller.test.ts`                                                                                  |
| Reasoning is muted on every physical row and remains display-only                                        | `production-test.tsx:testReasoningStyle`, `transcript.test.ts`, `tui-controller.test.ts`                  |
| Dialogs trap input, restore composer focus, clamp lists, and remain visible without color                | `production-test.tsx:testAppSurface`, `production-test.tsx:testNoColorSelection`, `opentui-state.test.ts` |
| 80x24, 120x40, and 200x60 layouts remain usable                                                          | `production-test.tsx:testAppSurface`                                                                      |
| Session switching cancels abandoned work and drains queued/steering state                                | `tui-controller.test.ts`                                                                                  |
| Controller disposal aborts work and clears lifecycle tasks                                               | `tui-controller.test.ts`                                                                                  |
| Components cannot import session/config/application orchestration; no pi-tui import remains              | `import-boundaries.test.ts`                                                                               |

## Packed PTY gate

`mise run opentui-pty-smoke` builds and packs the real CLI, installs the tarball with production dependencies, and then:

1. launches the installed CLI under Bun in a real pseudo-terminal;
2. waits for the composer and submits a deterministic prompt;
3. receives a two-chunk OpenAI-compatible SSE response;
4. resizes from 80x24 to 120x40;
5. opens and cancels the provider dialog;
6. exits through two-stage Ctrl-C;
7. repeats lifecycle shutdown through `SIGTERM` and `SIGHUP`;
8. rejects alternate-screen entry and verifies cursor restoration plus bracketed-paste shutdown.

The Bun renderer suite also forces an exception during Solid mount and proves the renderer is destroyed and all process signal listeners are removed.

The renderer uses `screenMode: "split-footer"`, `useMouse: false`, captured stdout, and `clearOnShutdown: false`, so native selection and scrollback remain terminal-owned. Manual release checks should still cover a second terminal implementation and an available multiplexer because automated PTY emulation cannot prove host-terminal selection UX.

## Ownership rule

Committed transcript entries append to native scrollback exactly once. The composer, suggestions, dialogs, busy state, queue count, and transient notices remain in the repaintable footer. Reasoning may be committed for display, but it never enters persisted model context.
