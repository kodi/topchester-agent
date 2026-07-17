# OpenTUI migration plan

Status: complete; implementation and final `mise run local-ci` verification passed

Created: 2026-07-17

Branch: `feat/opentui-migration`

Topchester baseline: `622fa1d5fda041730354eef8d5960a3d273af56e`

OpenCode reference baseline: `0bc9a28b5eeac8f85e7e16e53cadb33498a02bbb`

## Summary

Topchester is ready for an OpenTUI migration, with one important qualification: this is not a dependency swap. The agent runtime, event stream, configuration, tools, and most session behavior are already separated well enough to keep. The current `TopchesterTuiShell` and `ChatLayout`, however, combine application orchestration, terminal lifecycle, input routing, local UI state, ANSI rendering, and framework-specific component behavior. Those responsibilities need to be separated before the old renderer can be removed safely.

The migration should therefore be staged around a framework-neutral TUI controller and transcript model. The existing pi-tui renderer remains functional while the neutral boundary is extracted. A new OpenTUI Solid renderer is then added behind a development-only switch, brought to behavior parity, made the default, and finally followed by removal of pi-tui.

The plan recommends Bun as Topchester's interactive runtime because the repository currently targets Node 24, while OpenTUI's native renderer requires either Bun or Node 26.4 with experimental FFI. Bun `1.3` is already declared in `.mise.toml` on this branch, and the current CLI successfully parses `--version` and `--help` under the resolved Bun `1.3.2`. That is encouraging but not enough to prove production compatibility. Packaging, runtime dependencies, native binaries, terminal cleanup, and split-footer scrollback are blocking proofs in Slice 0.

## Readiness decision

Decision: **conditional pass**.

Implementation is possible without rewriting the agent engine. Begin only with the feasibility slice, and do not start the component port unless every blocking gate in that slice passes.

| Criterion                                                | Result              | Evidence                                                                                                     | Required action                                                                            |
| -------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Agent loop is independent of the renderer                | Pass                | `AgentRuntime` exposes a typed streaming API and `AgentRuntimeEvent` union under `src/agent/`                | Keep the runtime contract unchanged during the renderer migration                          |
| Configuration and model selection are independent        | Pass                | `src/app/context.ts` and runtime overrides are outside `src/tui/`                                            | Adapt existing actions; do not move config ownership into Solid state                      |
| Session storage is independent                           | Partial             | Storage is separate, but `src/session/store.ts` imports `ChatMessage` and helpers from `src/tui/messages.ts` | Introduce a renderer-neutral transcript type before adding OpenTUI components              |
| CLI and TUI share clean application helpers              | Partial             | `src/cli/run.ts` imports payload and startup-message helpers from `src/tui/`                                 | Move shared mapping and startup-status logic to application/session modules                |
| TUI behavior has regression coverage                     | Pass, with coupling | `test/tui.render.test.ts` covers most visible behavior but reaches into shell internals and pi-tui output    | Preserve the cases, then split them into controller and OpenTUI renderer tests             |
| Current TUI is presentation-only                         | No                  | `src/tui/shell.ts` and `src/tui/layout.ts` own orchestration, input, and rendering                           | Extract a controller and explicit view state before deleting pi-tui                        |
| Bun can start the current CLI                            | Initial pass        | `mise exec -- bun src/bin.ts --version` and `--help` work with Bun 1.3.2                                     | Prove full commands, build, packed install, subprocesses, and terminal behavior in Slice 0 |
| OpenTUI can preserve native terminal scrollback          | Unknown, blocking   | OpenTUI `split-footer` is the closest match to the current inline renderer                                   | Build a narrow proof covering append, resize, session restore, and shutdown                |
| Published npm package can run with OpenTUI native assets | Unknown, blocking   | Current package is built by `vp pack` and package smoke executes it with Node                                | Produce and execute a packed Bun-targeted artifact in Slice 0                              |

### Why the existing boundaries are good enough

The main data flow is already close to the target shape:

```text
commands/config/session
        |
        v
   AgentRuntime
        |
        v
AgentRuntimeEvent stream
        |
        v
current TUI shell/layout
```

The first three layers do not need a framework rewrite. The missing seam is between runtime events and the renderer. Today the shell maps events, mutates layout state, performs persistence, manages queues, and opens dialogs directly. The target adds one reusable layer at that seam:

```text
commands/config/session
        |
        v
   AgentRuntime
        |
        v
AgentRuntimeEvent stream
        |
        v
TuiController + TranscriptEntry + TuiViewState
        |
        +------------------+
        |                  |
        v                  v
pi-tui adapter       OpenTUI Solid adapter
(temporary)          (target)
```

This creates a migration path with a working fallback, while keeping the new controller useful after pi-tui is gone.

## Current implementation findings

### Size and responsibility concentration

At the baseline commit, `src/tui/` is roughly 5,174 lines. Its two largest files contain most of the migration risk:

| File                      |  Approximate size | Current responsibilities                                                                                                                                                    |
| ------------------------- | ----------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/tui/shell.ts`        |       1,496 lines | terminal lifecycle, runtime calls, event streaming, persistence, queue/steer, slash routing, session operations, bash approval, model/provider/skills flows, and KB refresh |
| `src/tui/layout.ts`       |       1,370 lines | thread rendering, prompt editing, history, suggestions, task plan, modal state, paste handling, focus/input routing, and viewport behavior                                  |
| `src/tui/messages.ts`     |         479 lines | renderer-neutral message variants mixed with ANSI and pi-tui rendering                                                                                                      |
| `test/tui.render.test.ts` | about 4,600 lines | valuable behavior coverage, but coupled to private shell/layout details and current ANSI output                                                                             |

The size alone is not the problem. The issue is that state ownership and renderer ownership are not explicit. Recreating the same shape with Solid components would only move the monolith.

### Existing modules worth preserving

The following code already has useful, mostly framework-neutral behavior and should be adapted rather than rewritten:

- `src/agent/events.ts` and `src/agent/runtime/` for the typed runtime boundary.
- `src/app/context.ts` for loaded configuration and runtime overrides.
- `src/session/` for session events, persistence, fork, restore, and replay semantics after its TUI type imports are removed.
- File mention parsing and providers.
- Prompt history behavior.
- Model-picker filtering and display formatting.
- Skills overlay actions and formatting rules.
- Session persistence payload mapping in `src/tui/session-persistence.ts`, moved to a neutral location.
- Reasoning buffering rules, including the distinction between visible reasoning and persisted session content.

### Coupling that must be removed

Before an OpenTUI renderer becomes authoritative:

1. `src/session/store.ts` must no longer import `ChatMessage`, `hookStatusMessage`, or `toolCallMessage` from `src/tui/messages.ts`.
2. `src/cli/run.ts` must no longer import `slashCommandToSessionPayload` or `chatMessageToSessionPayload` from `src/tui/shell.ts`.
3. `src/cli/run.ts` must no longer import startup-thread rendering from `src/tui/status.ts`.
4. Session replay must return neutral transcript entries or session events, not a pi-tui-oriented message type.
5. ANSI generation in `status.ts`, `markdown.ts`, `diff.ts`, `text.ts`, and `mention-styles.ts` must remain in the old adapter until equivalent structured props exist for OpenTUI.
6. Tests must stop treating private shell methods as the primary application interface.

## Behavior that must not change during the migration

This project should treat the first OpenTUI release as a renderer migration, not a TUI redesign. The following behavior is the compatibility contract:

- Keep the normal terminal screen and native scrollback; do not switch to an alternate-screen dashboard.
- Keep mouse reporting disabled initially so terminal-native selection and scrolling continue to work.
- Preserve the chat thread, pinned task plan, prompt, busy/reasoning state, queue count, model/effort label, and KB status.
- Preserve Enter to submit, Shift+Enter for a newline, prompt history, paste behavior, slash suggestions, and `@file` completion.
- Keep the prompt editable while a response is running.
- Preserve normal queued messages, `/queue`, `/steer`, and queue cleanup when changing sessions.
- Preserve two-stage Ctrl-C exit, Escape cancellation/dismissal, and existing input-priority rules.
- Preserve tool-call status, diffs, Markdown, subagent messages, transient hook statuses, and task-plan updates.
- Keep streamed reasoning visible after the answer when enabled, but do not add it to persisted session history.
- Preserve model, provider, effort, skills, bash approval, new-session, fork, and restore flows.
- Preserve periodic KB refresh and non-TTY/static command behavior.

Any deliberate UX improvement should be a follow-up change with its own tests. This keeps parity failures distinguishable from design changes.

## OpenTUI and OpenCode findings

### OpenTUI constraints that shape the plan

- OpenTUI's portable APIs can load in Node, but its native renderer currently needs Bun or Node 26.4 with `--experimental-ffi`. Topchester targets Node 24 today, so Bun is the lower-risk runtime target for this migration. See [OpenTUI Getting Started](https://opentui.com/docs/getting-started/).
- The Solid binding uses `jsx: "preserve"`, `jsxImportSource: "@opentui/solid"`, and a Solid Bun plugin for production builds. See [OpenTUI Solid binding](https://opentui.com/docs/bindings/solid/).
- `split-footer` keeps an updateable footer below append-only terminal output and is the closest match to Topchester's current inline mode. See [OpenTUI renderer modes](https://opentui.com/docs/core-concepts/renderer/).
- Renderer destruction restores terminal state and must be guaranteed through normal exit, errors, and signals. See [OpenTUI lifecycle](https://opentui.com/docs/core-concepts/lifecycle/).
- OpenTUI has an in-memory renderer with frame, styled-span, input, and resize support. It should replace ANSI snapshots as the primary renderer test surface. See [OpenTUI testing](https://opentui.com/docs/core-concepts/testing/).
- The built-in textarea, scrollbox, Markdown, and diff renderables cover useful primitives, but they should be wrapped behind Topchester-owned semantic components. See [textarea](https://opentui.com/docs/components/textarea/), [scrollbox](https://opentui.com/docs/components/scrollbox/), [Markdown](https://opentui.com/docs/components/markdown/), and [diff](https://opentui.com/docs/components/diff/).

All OpenTUI packages selected in Slice 0 must use the same exact version. Do not use caret ranges for pre-1.0 renderer and native-package dependencies.

### Useful patterns in the local OpenCode checkout

OpenCode is an implementation reference, not a source to transplant wholesale. Its current checkout pins `@opentui/core`, `@opentui/keymap`, and `@opentui/solid` to the same exact version and demonstrates several boundaries worth adopting:

- `packages/opencode/src/cli/cmd/run/runtime.lifecycle.ts` centralizes renderer configuration and cleanup.
- `packages/opencode/src/cli/cmd/run/footer.ts` makes an explicit boundary between append-only scrollback and the reactive footer.
- `packages/opencode/src/cli/cmd/run/scrollback.surface.ts` and `scrollback.writer.tsx` keep transcript commits separate from footer repaints.
- `packages/tui/src/context/helper.tsx` provides small, required contexts instead of one global optional state bag.
- `packages/tui/src/ui/dialog.tsx` owns a modal stack, focus capture, and focus restoration.
- `packages/tui/src/context/theme.tsx` maps terminal capabilities into semantic theme values.
- OpenCode's renderer tests use Bun and `@opentui/core/testing`.

Topchester should copy those concepts, not OpenCode's scale. It does not need OpenCode's client/server SDK context tree, Effect-based architecture, plugin system, or multi-thousand-line route and prompt components. Topchester is in-process and can keep a much smaller controller and component hierarchy.

## Decisions for the target implementation

### 1. Use OpenTUI Solid

Use these packages, pinned to the exact version proven in Slice 0:

- `@opentui/core`
- `@opentui/solid`
- `solid-js`
- `@opentui/keymap` if the spike confirms it simplifies semantic actions and modal priority without duplicating current key handling

Solid signals map naturally to streamed runtime state, OpenTUI provides a first-party binding and test helper, and the local OpenCode checkout provides a maintained example. Topchester does not currently have a React dependency to preserve.

### 2. Use Bun for the interactive and published CLI if Slice 0 passes

Keep pnpm as the repository package manager unless a later change has a separate reason to replace it. Runtime and package manager are independent decisions.

The preferred outcome is one Bun-targeted CLI rather than a Node launcher that spawns a second Bun process. A hybrid launcher would preserve Node for noninteractive commands, but it would also introduce process handoff, signal forwarding, environment, exit-code, and installation complexity. Use that fallback only if a concrete Node-only incompatibility is found and cannot reasonably be fixed.

The migration must audit:

- the `#!/usr/bin/env node` shebang in `src/bin.ts`;
- the current `engines.node` and package metadata;
- `process.execPath` assumptions, including package-content checks and self-update/re-exec paths;
- subprocess, PTY, signal, and stdin/stdout behavior;
- CI setup, caching, and release jobs;
- npm global installation documentation;
- native optional packages included in the npm tarball.

Standalone executables were explicitly deferred from migration Slices 0-10. The distribution follow-up in Slices 11-15 below now implements that separate project. See [OpenTUI standalone executables](https://opentui.com/docs/reference/standalone-executables/).

### 3. Preserve the inline scrollback model with `split-footer`

Use `screenMode: "split-footer"`, keep mouse input off, capture external stdout where appropriate, disable OpenTUI's default Ctrl-C behavior, and leave the user's scrollback visible on shutdown.

The core ownership rule is:

```text
committed transcript entry -> append once to terminal scrollback
live/editable/transient UI  -> repaint only inside the footer
```

An assistant response being streamed may be rendered in the footer. Once complete, its stable transcript representation is appended once to scrollback and removed from the live region. Busy animation, transient hooks, autocomplete, dialogs, and the composer never enter scrollback. Visible reasoning follows the existing product rule: it may become a display-only committed entry, but it does not become persisted model context.

Session restore, new session, and fork are the hardest part of this mode. Slice 0 must determine whether OpenTUI can safely replace saved split-footer lines for a replay without erasing unrelated terminal history. If exact replay cannot meet that requirement, the accepted V0 behavior must be chosen explicitly before implementation. Options, in preference order, are:

1. rebuild only Topchester-owned saved lines while preserving earlier terminal history;
2. append a clear session boundary and replay the selected session below it;
3. use a full-screen mode only for the session picker, never for the main chat;
4. stop the migration and evaluate a different rendering boundary.

Do not silently clear the whole terminal or introduce alternate-screen behavior to make the spike pass.

### 4. Add a framework-neutral controller, not a second shell

The controller owns application behavior and exposes snapshots/actions. It must not import Solid or OpenTUI.

Conceptual API:

```ts
interface TuiController {
  getSnapshot(): TuiViewState;
  subscribe(listener: () => void): () => void;
  submit(input: ComposerSubmission): Promise<void>;
  cancel(): Promise<void>;
  choose(action: TuiAction): Promise<void>;
  dispose(): Promise<void>;
}
```

`TuiViewState` should contain stable semantic data, not rendered strings:

- current session identity and transcript entries;
- live assistant/reasoning buffers;
- agent, model, effort, and KB status;
- task-plan items;
- running/busy/cancel state;
- queued-message count;
- active dialog route and its typed options;
- notices/toasts;
- active suggestion source and semantic suggestion items where controller-owned.

The controller owns:

- runtime event reduction;
- session persistence and replay coordination;
- submit, queue, steer, and cancellation semantics;
- session new/fork/restore;
- model/provider/effort and skills actions;
- KB polling and cleanup;
- permission/choice requests;
- lifecycle cancellation and disposal.

The renderer owns:

- terminal creation and destruction;
- layout, colors, focus, and responsive sizing;
- composer edit buffer, cursor, selection, and paste preview;
- translating raw keyboard/paste events into semantic actions;
- local animation frames;
- scrollback commits and footer painting.

### 5. Use semantic components and theme tokens

Do not wrap every OpenTUI `box` or `text`. Create a Topchester component only when it owns a repeated product behavior, semantic style, focus rule, or renderer workaround.

Recommended semantic theme slots:

- foreground: `text`, `muted`, `emphasis`;
- surfaces: `background`, `surface`, `overlay`, `selection`;
- interaction: `accent`, `focus`, `model`;
- state: `success`, `warning`, `error`, `info`;
- diff: `added`, `removed`, `context`;
- syntax theme derived from the same terminal-aware palette.

Every state must remain understandable without color. Add `NO_COLOR` coverage and avoid raw color literals in domain components.

## Target file and component shape

Names may shift during implementation, but responsibility boundaries should remain stable.

```text
src/
  chat/
    transcript.ts                 renderer-neutral transcript model
    transcript-from-runtime.ts    runtime event -> transcript mapping
  app/
    tui-controller.ts             orchestration and view-state store
    tui-controller-events.ts      reducer and typed internal events
  session/
    transcript-replay.ts          session events -> neutral transcript
    message-payload.ts            transcript/slash -> persisted payload
  tui/
    opentui/
      main.tsx                    renderer entry and guaranteed cleanup
      app.tsx                     provider and root composition
      controller-context.tsx      required controller/store context
      theme/
        tokens.ts
        provider.tsx
      scrollback/
        writer.tsx
        entry.tsx
      footer/
        live-footer.tsx
        composer.tsx
        suggestion-list.tsx
        task-plan.tsx
        status-bar.tsx
        busy-line.tsx
      messages/
        user-message.tsx
        assistant-message.tsx
        reasoning-block.tsx
        tool-activity.tsx
        diff-block.tsx
        system-notice.tsx
        subagent-activity.tsx
      dialogs/
        dialog-host.tsx
        choice-dialog.tsx
        bash-approval-dialog.tsx
        session-picker.tsx
        selection-dialog.tsx
        skills-dialog.tsx
      input/
        actions.ts
        keymap.ts
        priority.ts
      testing/
        render.tsx
        fixtures.ts
    pi/                             temporary adapter during migration
```

### Reusable component inventory

| Component                   | Purpose                                                 | State ownership                        | Important contract                                                 |
| --------------------------- | ------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| `TopchesterApp`             | Compose providers, transcript writer, and live footer   | none beyond renderer lifecycle         | No agent/session logic                                             |
| `TranscriptWriter`          | Append stable entries once in split-footer mode         | last committed transcript cursor       | Idempotent commits; replay is explicit                             |
| `ThreadEntry`               | Dispatch semantic transcript variants                   | none                                   | Exhaustive variant handling                                        |
| `AssistantMessage`          | Render Markdown/streamed answer consistently            | live content passed as props           | Stable streaming prefix; no session writes                         |
| `ReasoningBlock`            | Render muted multi-line reasoning                       | expanded/visible flag if needed        | Display-only persistence semantics                                 |
| `ToolActivity`              | Tool title, state, output summary                       | optional local disclosure              | Never encode tool state only through color                         |
| `DiffBlock`                 | Structured unified/split diff                           | display mode                           | Use OpenTUI diff primitive behind Topchester props                 |
| `LiveFooter`                | Own all repaintable content                             | composition only                       | Fixed boundary between scrollback and live UI                      |
| `Composer`                  | Multi-line edit, cursor, selection, paste               | local edit state                       | Emits semantic submission; controller does not mutate cursor state |
| `SuggestionList`            | Shared list for slash/file/model/session/skills choices | selected index or controlled props     | Clamp height; expose selection and empty state                     |
| `TaskPlan`                  | Show pinned plan with semantic statuses                 | none                                   | Cap rows and preserve current ordering                             |
| `StatusBar`                 | Model/effort/KB/queue/session hints                     | none                                   | Responsive truncation, not hidden critical state                   |
| `BusyLine`                  | Spinner and live reasoning/status                       | animation frame locally                | Animation never blocks input or event reduction                    |
| `DialogHost`                | Modal stack and focus restoration                       | modal stack/focus handles              | Trap focus; Escape closes topmost allowed dialog                   |
| `SelectionDialog`           | Generic model/provider/effort/skills choices            | filter/selection locally or controlled | Reuse one tested navigation model                                  |
| `SessionPicker`             | Search and choose sessions                              | query/selection                        | Returns a semantic session action only                             |
| `BashApprovalDialog`        | Explicit command approval                               | controller request                     | Deny/cancel path is always reachable                               |
| `ToastHost` or `NoticeLine` | Transient non-blocking feedback                         | expiry timer in controller or host     | Important errors cannot disappear before they are readable         |

The OpenTUI Solid binding does not currently expose every constructable renderable as an intrinsic element. In particular, the textarea may need a `TextareaRenderable` reference or a small adapter. Keep that workaround inside `Composer` rather than leaking it into controller state.

## Cross-slice implementation rules

1. Keep `mise run check`, `mise run test`, and relevant repo tasks green at the end of every slice.
2. Do not change agent runtime semantics merely to make rendering easier.
3. Do not persist renderer-only entries such as busy animation, transient hook status, or streamed reasoning.
4. Keep current user-visible behavior as the reference until the default renderer flips.
5. Keep every new domain type independent of Solid, OpenTUI, pi-tui, and ANSI helpers.
6. Centralize terminal creation/destruction. Always destroy the renderer in `finally` and cover `SIGINT`, `SIGTERM`, `SIGHUP`, exceptions, and normal return.
7. Make dialogs keyboard-first, trap focus, restore prior focus, and show context-sensitive key hints.
8. Verify at 80x24, 120x40, and 200x60. The feasibility spike should establish any true minimum size rather than guessing one in advance.
9. Keep mouse reporting disabled for V0 and test native selection/scrolling manually.
10. Test both characters and styled spans. A stripped-text assertion cannot catch muted reasoning, focus, or diff-style regressions.
11. Pin all OpenTUI packages exactly and update them together.
12. Keep the temporary renderer switch development-only and delete it in cleanup.

## Implementation slices

### Slice 0: Prove runtime, build, package, and split-footer feasibility

Status: [x] Done

Goal: answer the blocking questions with the smallest disposable OpenTUI program before restructuring production code.

Why first: a failed native build or unusable scrollback model would invalidate the proposed implementation path. No broad refactor should depend on an unproven renderer/runtime combination.

Steps:

1. Add exact, mutually compatible versions of `@opentui/core`, `@opentui/solid`, `solid-js`, and optionally `@opentui/keymap` to a spike branch or isolated package entry.
2. Add the minimum Solid compiler settings without changing the production entrypoint.
3. Create a temporary renderer that uses `screenMode: "split-footer"`, `useMouse: false`, custom Ctrl-C handling, captured external output, and non-clearing shutdown.
4. Render a multi-line transcript followed by a live footer containing a textarea, status line, task plan, suggestion list, and modal.
5. Stream Markdown and reasoning updates into the live region, then commit the completed entry to scrollback exactly once.
6. Simulate tool output written to stdout while the footer is active and confirm it cannot corrupt the layout.
7. Resize between narrow, normal, and wide terminal dimensions while streaming and while a modal is open.
8. Prototype new-session and restore behavior. Determine exactly what OpenTUI's saved-line reset/replay APIs clear and whether earlier terminal history survives.
9. Exercise two-stage Ctrl-C, Escape, `SIGTERM`, `SIGHUP`, an uncaught render error, and normal exit. Inspect the terminal afterward for cursor, raw mode, mouse, and screen corruption.
10. Run representative existing CLI paths under Bun: help/version, a noninteractive prompt, config loading, session persistence, KB source/search commands, tool subprocesses, and any self-update/re-exec code.
11. Build the actual CLI shape with `Bun.build` and `@opentui/solid/bun-plugin`, keeping output compatible with the package's `bin` entry.
12. Run `npm pack` or the existing package-content task, install the tarball in an isolated prefix, and execute the packed CLI with Bun.
13. Inspect the tarball for the required OpenTUI native packages and verify the supported development platform from the packed artifact.
14. Record the chosen exact package versions, build command, runtime requirement, and accepted session-replay behavior in this plan's decision log.
15. Delete spike-only code or promote it into the renderer foundation only after all gates pass.

Verified progress (2026-07-17):

- Pinned `@opentui/core` and `@opentui/solid` to `0.4.4`, with their exact peer `solid-js` `1.9.12`. `@opentui/keymap` is intentionally not installed; the focused-textarea experiment confirmed that Topchester needs its own semantic priority router before deciding whether the additional package helps.
- Added the official Solid compiler/preload settings plus repo-local `opentui-spike`, `opentui-spike-test`, `opentui-spike-build`, and `opentui-spike-package` mise tasks.
- The test renderer covers 80x24, 120x40, and 200x60; textarea submission; delayed Escape parsing; modal priority; per-line muted reasoning spans; and idempotent scrollback identity. `mise run opentui-spike-test` passes.
- The native fixture uses `screenMode: "split-footer"`, `externalOutputMode: "capture-stdout"`, `clearOnShutdown: false`, `useMouse: false`, custom Ctrl-C handling, and no OpenTUI-owned exit signals. Captured stdout remained ordered above the footer, and no alternate-screen sequence was used.
- Stable output is committed through an identity-aware writer. Repeating the same identity produces one scrollback commit. Live assistant/reasoning content remains in the footer until the stable commit.
- Session restore/new-session behavior is accepted as append-only: write a visible session boundary and replay the selected transcript beneath it. Do not call `resetSplitFooterForReplay({ clearSavedLines: true })`, because current OpenTUI documentation states that it clears the visible viewport and saved terminal lines.
- Real PTY runs passed normal return, intentional post-mount failure, `SIGTERM`, `SIGHUP`, and two-stage Ctrl-C. Cleanup output restores the cursor and disables bracketed paste. The fixture also passed through a nested `/usr/bin/script` PTY. Zellij could not complete its terminal-capability handshake inside the automated tool PTY, so a real multiplexer check remains in the Slice 8 manual matrix rather than being claimed here.
- `Bun.build` with `@opentui/solid/bun-plugin` produces both the native fixture and a production-shaped CLI. The proof found and fixed a duplicate-shebang failure by using a Bun entry wrapper, which is the shape to promote when the production shebang changes.
- `mise run opentui-spike-package` builds, packs, installs the tarball into an isolated npm prefix, confirms `@opentui/core-darwin-arm64`, and runs both the Bun CLI and native OpenTUI fixture from that installation. The proof also found and fixed package-root discovery preferring a prefix-level `package.json` over the installed Topchester package.
- Bun-backed smoke scenarios `20-bash`, `09-session-resume`, and `21-product-knowledge-no-project-kb` pass. Together they cover config loading, a noninteractive prompt, tool subprocesses, session persistence/resume, and built-in KB retrieval. Self-update detection now prefers the package install path over Bun's runtime path.
- Repository verification passed: `mise run check` (195 typed/linted files), `mise run test` (35 files, 754 tests), and `mise run package-check` (55 package files).
- Go decision: proceed to Slice 1. The spike sources remain until their proven lifecycle/build/package logic is promoted in Slice 4.

Expected output:

- A reproducible spike command under `mise`.
- A written runtime/build decision.
- A passing packed-artifact proof.
- A terminal-behavior note for split-footer, resize, replay, and shutdown.
- A go/no-go decision for Slice 1.

Verification:

- Run the spike through a repo-local `mise` task.
- Run current checks and tests unchanged.
- Record manual observations in at least the default local terminal and one different terminal or multiplexer available on the machine.
- Confirm the terminal accepts normal typing, selection, scrolling, and commands immediately after every exit path.

Blocking exit gate:

- Bun runs representative Topchester commands without semantic regressions.
- The production-shaped build and npm tarball execute successfully.
- Native packages are present and load from the packed install.
- Split-footer preserves ordinary terminal history and does not duplicate committed entries.
- A documented restore/new-session behavior is acceptable.
- Renderer cleanup is reliable on all tested exit paths.

Stop condition: if any gate cannot be met without clearing unrelated terminal history, changing the main UI to alternate-screen mode, or introducing fragile packaging, stop before Slice 1 and evaluate either Node 26.4 FFI, a separate Bun TUI binary, or a different renderer.

Dependencies: none.

### Slice 1: Freeze the current behavior contract and reorganize tests

Status: [x] Done

Goal: make the existing behavior suite a readable migration checklist before moving ownership.

Steps:

1. Inventory every behavior in `docs/features/tui.md` and map it to an existing test or a missing case.
2. Split `test/tui.render.test.ts` by behavior: messages, composer, suggestions, dialogs, sessions, runtime events, persistence, and lifecycle.
3. Keep pi-tui rendering assertions unchanged during the move so test reorganization does not mask behavior changes.
4. Add missing tests for two-stage Ctrl-C, signal cleanup boundaries, queue cleanup on session change, display-only reasoning, non-TTY behavior, and input priority while a dialog is open.
5. Add renderer-neutral fixtures for runtime events, transcripts, task plans, session replay, choices, and tool calls.
6. Document the parity checklist in the test directory or this plan and link each requirement to its test file.

Verified progress (2026-07-17):

- Split the 4,620-line `test/tui.render.test.ts` into seven focused suites for messages, composer/suggestions, dialogs, sessions, runtime state, persistence, and queue behavior. The split preserves all 145 original TUI cases without blanket lint exemptions.
- Added `test/TUI_BEHAVIOR_CONTRACT.md`, mapping the documented TUI and migration-preservation requirements to exact baseline tests. Real-renderer concerns such as signal cleanup, native selection, and multiplexer behavior are explicit PTY/manual gates rather than claims based on stripped ANSI output.
- Added `test/tui.behavior.fixtures.ts`, a renderer-independent fixture surface for runtime events, persisted transcript rows, task plans, session replay, choices, tool calls, and display-only reasoning.
- Strengthened session tests so `/new`, `/fork`, and selected `/restore` prove pending follow-ups are dropped; `/new` also proves pending steering is drained; canceling `/restore` proves the queue is retained.
- Made the non-TTY/static path explicit in the startup/session test. Existing focused cases already cover two-stage Ctrl-C, modal input priority, and reasoning remaining visible but unpersisted.
- Verification passed: `mise run check`; `mise run test` (41 files, 754 tests). No production behavior changed in this slice.

Expected output: focused tests that describe product behavior instead of one large renderer file.

Verification: current `mise` checks and tests pass with no production behavior change.

Exit gate: every preserved behavior has an automated test where practical or an explicit manual test entry.

Dependencies: Slice 0 go decision.

### Slice 2: Extract renderer-neutral transcript and persistence models

Status: [x] Done

Goal: remove TUI imports from session storage and CLI application logic.

Steps:

1. Define an exhaustive `TranscriptEntry` union in a neutral module. Include user, assistant, reasoning-display, status/notice, hook, tool, diff, subagent, choice, and task-plan-related variants only where they belong in the thread.
2. Separate persisted entries from display-only entries at the type or mapper boundary. Do not rely on each renderer remembering what to omit.
3. Move runtime-event-to-transcript mapping out of `src/tui/runtime-events.ts` into the neutral chat/application layer.
4. Move `chatMessageToSessionPayload` and slash-command payload mapping out of TUI files.
5. Change session rehydration to return neutral entries or neutral session events.
6. Move startup status/message construction out of `src/tui/status.ts`; renderers should receive semantic startup entries.
7. Adapt the existing pi-tui renderer to render `TranscriptEntry` without behavior changes.
8. Add compile-time exhaustive switches and tests for every transcript variant.
9. Add an import-boundary test that rejects imports from `src/tui/` inside `src/session/`, `src/agent/`, and non-TUI CLI application modules.

Verified progress (2026-07-17):

- Added `src/chat/` with an exhaustive semantic `TranscriptEntry` union for system, user, assistant, startup, reasoning, tool, hook, choice, permission, subagent, and knowledge-status entries. Every entry declares `persistence: "session" | "display"`; reasoning, transient hooks, display-only subagent rows, and knowledge status cannot be converted to session payloads.
- Moved runtime-event-to-transcript reduction into `src/chat/runtime-events.ts` and startup summary construction into `src/chat/startup.ts`. These modules have no pi-tui, OpenTUI, Solid, TUI, or ANSI dependencies.
- Added `src/session/transcript-payloads.ts` for exhaustive transcript/session and slash-command mapping. Structured startup data round-trips through session metadata while retaining a plain-text fallback.
- Changed `rehydrateSession` to return neutral `transcript` entries. `src/session/` no longer imports TUI messages, and `src/cli/run.ts` now consumes neutral startup/transcript/session helpers directly.
- Added `src/tui/transcript-adapter.ts` as the one-way compatibility adapter to existing pi-tui `ChatMessage` values. Runtime rendering, startup rendering, fork, restore, resume, non-TTY rendering, and persistence still pass the complete pi-tui behavior suite.
- Extracted pi-only knowledge status formatting from startup/status construction, keeping semantic construction and ANSI presentation separate.
- Added exhaustive neutral mapping, display-only exclusion, structured startup round-trip, and pi adapter tests in `test/transcript.test.ts`.
- Added `test/import-boundaries.test.ts`, which rejects TUI imports from `src/session/`, `src/agent/`, and `src/cli/run.ts`, and renderer/ANSI dependencies in `src/chat/`.
- Verification passed: `mise run check`; `mise run test` (43 files, 760 tests); `git diff --check`; direct source scans found no forbidden imports.

Expected output: session, CLI, and runtime mapping can be tested without pi-tui or ANSI.

Verification:

- Unit-test runtime event mapping and session replay.
- Round-trip representative persisted sessions.
- Verify reasoning and transient status are visible but excluded from persistence.
- Run the full existing pi-tui behavior suite.

Exit gate: `src/session/` and shared CLI logic have no imports from `src/tui/`.

Dependencies: Slice 1 fixtures.

### Slice 3: Extract the framework-neutral TUI controller

Status: [x] Done

Goal: move application orchestration out of `TopchesterTuiShell` while the old UI still renders it.

Steps:

1. Define `TuiViewState`, semantic dialog routes, suggestion item types, and controller actions.
2. Implement a small subscription store with deterministic snapshots. Avoid putting mutable renderer instances in the state.
3. Move runtime event consumption and reduction from `shell.ts` into the controller.
4. Move submission, cancellation, queue, and steer behavior into controller actions.
5. Move session new/fork/restore and persistence ordering into the controller.
6. Move model/provider/effort, skills, choice, and bash-approval application flows into typed controller actions.
7. Move KB refresh scheduling into the controller and make timer disposal explicit.
8. Keep prompt cursor/edit-buffer state in `ChatLayout`; submit only a semantic composer payload to the controller.
9. Build a thin pi-tui adapter that subscribes to snapshots and sends semantic actions back.
10. Replace private-shell-method tests with controller tests for orchestration and ordering.
11. Add race tests for session switches during streaming, queued messages, cancellation, permission prompts, and disposal.
12. Shrink `TopchesterTuiShell` to terminal/renderer construction plus adapter wiring.

Verified progress (2026-07-17):

- Added `src/chat/controller.ts`, `controller-state.ts`, `controller-helpers.ts`, and `controller-busy.ts`. The controller exposes deterministic semantic snapshots plus submit, command, choose, dismiss, session, cancellation, and disposal actions without importing either renderer.
- Moved runtime reduction, persistence ordering, queue/steer behavior, new/fork/restore, provider/model/effort, skills, bash approval, runtime choice, task-plan, hooks, and KB polling behind that controller boundary.
- Encoded renderer state in `TuiViewState`: session epoch/identity, semantic transcript, live buffers, task plan, status/model/KB/queue state, notices, choices, and session picker data. No renderer instance or cursor object enters the snapshot.
- Replaced private-shell testing with 12 controller cases covering startup persistence, display-only reasoning, FIFO queue/steering fallback, session-switch cancellation, managed and runtime choices, explicit cancel, bash approval, model/effort overrides, new/fork/restore, skills/task-plan/hooks/KB, and disposal aborts.
- The production renderer now constructs the controller and only translates snapshots/input. The legacy `TopchesterTuiShell` was removed after the OpenTUI path passed parity checks.

Expected output: all application behavior can run against a fake view subscriber with no terminal.

Verification:

- Deterministic controller unit tests with a fake runtime, fake clock, and in-memory session store.
- Existing pi-tui renderer tests remain green.
- Explicit disposal test proves no KB timer, event task, or active request survives shutdown.

Exit gate: the pi-tui shell owns renderer lifecycle only; runtime and session behavior lives in the controller.

Dependencies: Slice 2 neutral models.

### Slice 4: Establish the OpenTUI renderer foundation

Status: [x] Done

Goal: add a production-shaped OpenTUI Solid root with lifecycle, theme, input actions, and tests, but no full feature parity yet.

Steps:

1. Promote the proven Bun/Solid build configuration from Slice 0 into the main build.
2. Add a renderer entry that constructs OpenTUI once, sets split-footer options, and destroys it in `finally`.
3. Add explicit handling for normal return, two-stage Ctrl-C, `SIGTERM`, `SIGHUP`, and render failures.
4. Create required Solid contexts for controller snapshot/actions, theme, and input routing. Throw on missing providers.
5. Define semantic input actions and a single priority router: top modal, active suggestions, composer, then global actions.
6. Add semantic theme tokens with dark, light, reduced-color, and `NO_COLOR` behavior.
7. Add the base `TopchesterApp`, `TranscriptWriter`, and `LiveFooter` regions.
8. Add an OpenTUI test helper using `createTestRenderer` or Solid `testRender` with deterministic dimensions and input.
9. Add lifecycle, resize, focus, and semantic-color tests before message components proliferate.
10. Expose this renderer only through a development switch such as `TOPCHESTER_TUI_RENDERER=opentui`; keep pi-tui as the default.

Verified progress (2026-07-17):

- Promoted the Bun/Solid spike into `scripts/build.ts`, `bunfig.toml`, the TypeScript/Vite configuration, and the production `src/tui/opentui/renderer.tsx` entry.
- The renderer is created once with split-footer, captured stdout, mouse disabled, non-clearing shutdown, Topchester-owned Ctrl-C, and no OpenTUI-owned signal exits. Controller, renderer, syntax resources, timers, and listeners are released from one `finally` path.
- Added required controller/theme contexts, semantic dark/light/`NO_COLOR` themes, a Topchester syntax style, a single keyboard-priority surface, `TopchesterApp`, `TranscriptWriter`, and `LiveFooter`.
- The Bun renderer tests exercise semantic color state, resize, keyboard/paste input, focus, and a forced Solid-mount exception. The exception test proves renderer destruction and signal-listener removal.
- The temporary dual-renderer switch was intentionally skipped at cutover: this disposable feature branch is the rollback boundary, and carrying two production paths would have added no release safety before either path shipped from this branch. The decision is recorded below.

Expected output: a minimal OpenTUI app displays a fixture snapshot and exits cleanly from the real Topchester entrypoint.

Verification:

- Capture characters and styled spans at 80x24, 120x40, and 200x60.
- Feed keyboard, paste, and resize events through the test renderer.
- Test dark/light/`NO_COLOR` tokens and focus visibility.
- Run the packed artifact rather than only source execution.

Exit gate: the foundation is production-built, testable, and leaves the terminal clean.

Dependencies: Slices 0 and 3.

### Slice 5: Implement transcript and scrollback components

Status: [x] Done

Goal: render every stable thread entry through reusable semantic components and commit it to scrollback exactly once.

Steps:

1. Implement exhaustive `ThreadEntry` dispatch over `TranscriptEntry`.
2. Add user, assistant, system/notice, reasoning, hook, tool, diff, subagent, and choice result components.
3. Wrap OpenTUI Markdown and diff renderables behind Topchester props and theme tokens.
4. Preserve the current streamed-Markdown appearance and stable block prefix where the OpenTUI primitive supports it.
5. Preserve raw tool output, diff headers, truncation, and expanded/summary rules.
6. Ensure multi-line reasoning applies muted style to every physical line and remains display-only.
7. Implement `TranscriptWriter` with an entry identity/cursor so Solid recomputation never duplicates terminal output.
8. Add an explicit replay path for startup/restore using the behavior accepted in Slice 0.
9. Keep live, unfinished assistant output in the footer until its commit transition.
10. Add representative fixture stories for long Markdown, wide Unicode, wrapped code, nested lists, tool output, large diffs, and subagent events.

Verified progress (2026-07-17):

- Added exhaustive `ThreadEntry` rendering for startup/system, user, Markdown assistant, reasoning, hook, tool/diff, permission, subagent, choice, and knowledge-status entries. Components receive semantic props and do not import ANSI helpers.
- Wrapped OpenTUI Markdown and diff primitives behind `ThreadEntry`. OpenTUI `0.4.4` requires Markdown's streaming draw path for deterministic unhighlighted split-footer snapshots, so the wrapper keeps `streaming` enabled even for stable entries; the workaround is isolated and covered by a direct assistant render test.
- Added `TranscriptWriter` identity tracking. Repeated synchronization emits one stable commit, while a changed session epoch emits one visible session boundary and replays the selected transcript below it without clearing prior terminal lines.
- Renderer tests assert every transcript variant, Markdown content, wide Unicode, tool/diff output, knowledge guidance, session replay, and muted color on every physical reasoning row.

Expected output: a read-only session can be replayed and rendered with OpenTUI at behavior parity.

Verification:

- Frame and styled-span assertions for every transcript variant.
- Stream-to-commit test proves exactly one stable scrollback entry.
- Resize and Unicode-width tests.
- Session replay tests compare semantic content with the pi-tui baseline.

Exit gate: all stable thread content renders correctly without importing ANSI helpers.

Dependencies: Slice 4 foundation and Slice 2 transcript model.

### Slice 6: Implement the live footer, composer, suggestions, and status

Status: [x] Done

Goal: reproduce Topchester's everyday interactive loop in the repaintable footer.

Steps:

1. Implement `Composer` around the OpenTUI textarea renderable, keeping the adapter local if Solid lacks a direct intrinsic.
2. Port single-line and multi-line editing, Enter submit, Shift+Enter newline, cursor movement, selection, paste preview, and prompt history.
3. Implement a reusable `SuggestionList` and adapt slash commands and file mentions to it.
4. Preserve suggestion priority, filtering, keyboard navigation, dismissal, and replacement ranges.
5. Implement `TaskPlan` with capped height, current status symbols, and responsive truncation.
6. Implement `BusyLine` and live reasoning without blocking composer input or animations.
7. Implement `StatusBar` for model, effort, KB, queue, and session hints with semantic responsive priorities.
8. Make the footer height derived from content within tested bounds; keep the composer usable at narrow sizes.
9. Route keyboard input through semantic actions and preserve two-stage Ctrl-C and Escape behavior.
10. Verify normal submissions queue while busy and `/steer` follows the current semantics.

Verified progress (2026-07-17):

- Added a textarea-backed composer with Enter submit, Shift+Enter newline, cursor-aware history, exact large-paste placeholder expansion, and session-epoch resets. Composer edit/cursor state remains local to the renderer.
- Added reusable bounded suggestion, task-plan, status-bar, dialog, and list-window components. Slash and file-mention completion share one priority path while preserving their different replacement semantics.
- The live footer derives a bounded height from terminal dimensions and visible state, keeps the composer available while work is active, and guards footer-height writes to avoid reactive repaint feedback.
- Keyboard routing is modal/session picker, suggestion, composer, then global cancellation/interrupt. Controller tests separately prove FIFO queueing, steering fallback, explicit cancellation, and session-switch cleanup.
- Renderer coverage includes 80x24, 120x40, and 200x60; slash suggestions; modal-protected composer state; exact multi-line paste submission; history; and Ctrl-C routing.

Expected output: the primary chat loop works under OpenTUI without dialogs.

Verification:

- Mock keyboard and paste input with the OpenTUI test renderer.
- Controller tests verify queue/steer ordering separately from visual tests.
- Resize snapshots cover no suggestion, suggestions open, multi-line composer, task plan, and busy reasoning.
- Manual terminal test covers native selection and scrollback while typing.

Exit gate: a user can run a complete streamed turn, edit while busy, queue/steer, and continue without pi-tui behavior differences.

Dependencies: Slices 3 through 5.

### Slice 7: Implement dialogs, overlays, and focus management

Status: [x] Done

Goal: port every modal flow onto one reusable, predictable dialog system.

Steps:

1. Implement `DialogHost` with a typed modal stack, backdrop, focus trap, and prior-focus restoration.
2. Define one close policy per dialog: Escape, explicit cancel action, or non-dismissible while a critical action is pending.
3. Implement generic selection/filter components for model, provider, reasoning effort, and compatible skills flows.
4. Implement the session picker with search, new/fork/restore actions, and clear selection semantics.
5. Implement bash approval and runtime choice dialogs with explicit allow/deny/cancel paths.
6. Port skills activation/selection without moving skill application semantics into components.
7. Preserve modal input priority over suggestions and composer shortcuts.
8. Add context-sensitive key hints and a visible focus state that does not rely only on color.
9. Test nested or replaced dialogs even if the normal application opens only one; focus restoration should be a system property.
10. Add narrow-terminal behavior: width clamping, bounded list height, scrolling, and readable action buttons.

Verified progress (2026-07-17):

- Added a shared typed `ChoiceDialog` for provider, model, effort, skills, bash-approval, and runtime-choice actions, plus a bounded `SessionPicker` for restore flows.
- Dialog state remains controller-owned; selection and viewport state are renderer-local. Every acceptance/cancel path returns semantic values through `choose`, `dismissDialog`, `selectSession`, or `cancelSessionPicker`.
- Input is trapped above suggestions/composer, Escape reaches the appropriate cancel path, and composer focus is restored after the overlay closes. Narrow lists window around the selected item and show position counts.
- Bun renderer tests prove keyboard-only move/accept/cancel behavior, composer protection, focus restoration, list clamping, and a text marker for selected rows under `NO_COLOR`.

Expected output: all existing selection, permission, and session flows work through shared components.

Verification:

- Keyboard-only tests for open, filter, move, accept, cancel, and restore focus.
- Controller tests for the semantic result of every dialog.
- Frame tests at the three standard dimensions plus the minimum supported spike size.
- `NO_COLOR` test proves focus and selected rows remain distinguishable.

Exit gate: every current modal flow is accessible, cancellable where expected, and returns focus correctly.

Dependencies: Slice 6 input routing and Slice 3 controller actions.

### Slice 8: Complete integration behind the development renderer switch

Status: [x] Done

Goal: run the entire application with either renderer and close all behavior gaps before changing the default.

Steps:

1. Wire the OpenTUI renderer to the real controller in the normal CLI entrypoint.
2. Cover startup agent/KB checks, transient hook statuses, runtime instructions, task-plan updates, and subagent activity.
3. Exercise session persistence, new, fork, restore, and failure rollback using real temporary session files.
4. Verify queue cleanup and scrollback boundary behavior when the active session changes.
5. Verify model/provider/effort overrides remain session-scoped exactly as before.
6. Verify config errors, missing credentials, agent failures, tool failures, declined permissions, and cancellation paths.
7. Route external logs through the renderer-approved capture path so debug output cannot corrupt the footer.
8. Add an interactive PTY smoke test for startup, typing, one mocked streamed response, resize, Ctrl-C, and terminal restoration.
9. Run a side-by-side parity checklist against pi-tui and record intentional differences, if any.
10. Fix controller leaks revealed by dual rendering rather than adding OpenTUI-only orchestration.

Verified progress (2026-07-17):

- Wired the real CLI directly to `runOpenTui`; startup checks, task plans, hooks, subagents, knowledge status, choices, session operations, config/runtime overrides, and failures flow through the production controller.
- Added `test/TUI_BEHAVIOR_CONTRACT.md` as the maintained parity matrix. Controller, transcript, static, OpenTUI state, Bun renderer, import-boundary, and existing domain suites now provide the automated evidence instead of private pi-tui snapshots.
- Added `mise run opentui-pty-smoke`. It builds and packs the actual CLI, installs production dependencies into an isolated prefix, launches the installed bin under Bun in Expect, submits a two-chunk streamed response, resizes, opens/cancels a provider dialog, and exits through two-stage Ctrl-C.
- The PTY matrix additionally runs `SIGTERM` and `SIGHUP`, rejects alternate-screen entry, and asserts cursor restoration plus bracketed-paste shutdown. The Bun renderer suite separately forces an error during Solid mount and proves cleanup.
- Bun fake-API scenarios `20-bash`, `09-session-resume`, and `21-product-knowledge-no-project-kb` pass after the fake OpenAI-compatible endpoint was upgraded to deterministic SSE/tool-call streaming.
- The local Ghostty path and nested `script` PTY were exercised during feasibility. A second host terminal/multiplexer remains a release-environment manual check; it is not represented as automated evidence.

Expected output: the OpenTUI development path is feature-complete and used regularly before cutover.

Verification:

- Full unit, renderer, integration, and package suites.
- PTY smoke under Bun.
- Manual matrix across the locally available terminals/multiplexers, including SSH if available.
- Light/dark, `NO_COLOR`, narrow/normal/wide, long session, and long-running streamed response.

Exit gate: the parity checklist has no unresolved blocking difference and no application behavior exists only inside the pi-tui adapter.

Dependencies: Slices 4 through 7.

### Slice 9: Switch the default runtime and renderer

Status: [x] Done

Goal: make Bun plus OpenTUI the supported default while retaining a short, explicit rollback window.

Steps:

1. Update the CLI shebang/launcher and package metadata to the runtime shape proven in Slice 0.
2. Update `vp pack` or replace the build path with the proven Bun/Solid build while preserving declarations, sourcemaps, and package contents.
3. Update package-content checks so the packed executable is invoked with the supported runtime rather than `process.execPath` by assumption.
4. Add Bun setup and cache behavior to quality and release CI.
5. Run package smoke on every supported release platform before publishing.
6. Make OpenTUI the default; retain `TOPCHESTER_TUI_RENDERER=pi` only as a short-lived rollback mechanism on the migration branch or one prerelease.
7. Update architecture, TUI behavior, contributor setup, install, troubleshooting, and release documentation.
8. Call out the Bun runtime requirement and the difference between npm installation and runtime execution.
9. Publish a prerelease or run the repository's equivalent package validation before a stable release.
10. Monitor startup failures, terminal cleanup, native-package loading, and session replay during the rollback window.

Verified progress (2026-07-17):

- Changed the shipped bin to `#!/usr/bin/env bun`, declared Bun `>=1.3`, and made Bun the single source, smoke, build, and installed CLI runtime. Node 24 and pnpm 11 remain pinned contributor tools in mise.
- The production build uses `Bun.build` plus `@opentui/solid/bun-plugin`, externalizes npm dependencies so platform-native OpenTUI packages resolve from installation, preserves declarations/sourcemaps, and emits the `dist/bin.mjs` package bin.
- Package validation builds, packs, installs without a workspace `node_modules` symlink, confirms the matching `@opentui/core-<platform>-<arch>` package, rejects pi-tui, and runs installed `--version` plus built-in KB source/search commands under Bun.
- Quality and release workflows install mise/Bun and run the same local CI gate. A Linux/macOS/Windows package matrix checks platform-native installation before release.
- README, onboarding, quickstart, TUI behavior, and architecture documentation now agree on Bun, OpenTUI, the npm package name, source setup, and the controller/scrollback/footer ownership model.

Expected output: normal `topchester` launches the OpenTUI implementation from the packed npm artifact.

Verification:

- Clean-machine-style install from the tarball.
- All noninteractive commands still work.
- Interactive PTY smoke passes from the installed package.
- CI and release workflows do not depend on an undeclared global Bun.

Exit gate: the supported package and docs agree on the runtime, and the installed artifact passes the full release checklist.

Dependencies: Slice 8 parity sign-off.

### Slice 10: Remove pi-tui and migration scaffolding

Status: [x] Done

Goal: finish the migration instead of maintaining two UI systems indefinitely.

Steps:

1. Remove `@earendil-works/pi-tui` and all pi-only adapters.
2. Delete the development renderer switch and fallback paths.
3. Delete replaced ANSI renderers and old shell/layout code after confirming no neutral helpers remain inside them.
4. Move any genuinely reusable parsing or formatting helpers to neutral modules before deletion.
5. Remove old renderer snapshots and keep controller/OpenTUI tests organized by behavior.
6. Add an import-boundary check preventing new application logic from entering `src/tui/opentui/` components.
7. Re-run package inspection to ensure pi-tui and unused terminal dependencies are absent.
8. Update `docs/ARCHITECTURE.md` with the controller, transcript, scrollback, footer, and renderer ownership boundaries.
9. Close or extract follow-up issues for enhancements that were intentionally excluded.

Verified progress (2026-07-17):

- Removed `@earendil-works/pi-tui`, the old shell/layout/message/status/ANSI renderer modules, their renderer-coupled tests, the compatibility transcript adapter, and every temporary spike task/source.
- Kept reusable prompt history, model/skill formatting, file mentions, startup, transcript, and persistence logic in neutral `src/chat/`, `src/session/`, or existing shared modules.
- Import-boundary tests reject TUI imports from session/agent/shared CLI code, renderer dependencies from `src/chat/`, application/config/session imports from OpenTUI components, and any new pi-tui source import.
- Package inspection confirms no pi-tui dependency remains. `docs/ARCHITECTURE.md`, `docs/features/tui.md`, and `test/TUI_BEHAVIOR_CONTRACT.md` describe the shipped ownership and behavior.
- Verification before the final combined gate: `vp check --fix`; 38 Node test files with 626 tests; the production Bun renderer suite; isolated package validation; the packed PTY lifecycle matrix; and the three representative Bun smoke scenarios all pass.

Expected output: one renderer, one supported runtime path, and clear reusable boundaries.

Verification: full local CI, packed-artifact smoke, dependency/package inspection, PTY smoke, and documentation link checks.

Exit gate: no pi-tui imports or dual-renderer flags remain, and all parity gates pass on the final architecture.

Dependencies: a completed rollback window after Slice 9.

## Verification strategy

### Pure unit tests

Use the existing test runner for framework-neutral code:

- runtime event to transcript mapping;
- transcript persistence eligibility;
- session replay and payload round trips;
- controller reducers and action ordering;
- queue, steer, cancel, session-switch races;
- prompt history and file/slash suggestion logic;
- model/provider/effort and skills actions;
- lifecycle disposal with fake timers.

### OpenTUI renderer tests

Use `@opentui/core/testing` and the Solid test helper:

- capture text frames and styled spans;
- inject keypress, paste, and resize events;
- test focus and modal priority;
- assert stream-to-scrollback commit identity;
- test Unicode width, wrapping, Markdown, and diffs;
- test 80x24, 120x40, and 200x60;
- test dark, light, reduced-color, and `NO_COLOR` themes;
- avoid broad snapshots when a focused structural assertion explains the behavior better.

### PTY and manual terminal tests

The current CLI smoke runner is noninteractive, so it cannot prove terminal state or TUI input behavior. Add a dedicated PTY smoke surface under `mise` that covers:

1. launch from the packed artifact;
2. wait for a stable prompt marker;
3. type and submit a mocked deterministic prompt;
4. observe a streamed response and committed scrollback entry;
5. resize once;
6. open and cancel a dialog;
7. press Ctrl-C twice;
8. assert exit code and terminal restoration.

Manually check the terminals and multiplexers actually available to contributors. At minimum, cover two different terminal implementations and one multiplexer when available. Include native text selection, scrollback, long wrapped output, light/dark background, `NO_COLOR`, and SSH when available.

### Package and release tests

- Build through the same command used by release CI.
- Inspect the npm tarball contents and native packages.
- Install the tarball into an isolated prefix.
- Run `--version`, `--help`, noninteractive prompt/config commands, KB commands, and the PTY smoke from that install.
- Run supported-platform jobs before stable publication.
- Verify failure text when Bun is missing is actionable if npm installation cannot enforce it automatically.

## Final acceptance checklist

- [x] Slice 0 records a go decision and all blocking proofs.
- [x] No `src/session/`, `src/agent/`, or shared CLI application module imports from `src/tui/`.
- [x] The controller has no Solid, OpenTUI, pi-tui, or ANSI imports.
- [x] Stable transcript entries append to scrollback exactly once.
- [x] New/fork/restore behavior does not clear unrelated terminal history.
- [x] Queue, steer, cancel, model, effort, provider, skills, permissions, and KB behavior match the baseline.
- [x] Reasoning styling is covered at the styled-span level and reasoning remains display-only for persistence.
- [x] Composer, suggestions, and every dialog are fully keyboard operable.
- [x] Focus is trapped/restored for dialogs and visible without color.
- [x] Terminal cleanup passes normal, error, signal, and two-stage Ctrl-C paths.
- [x] Renderer tests pass at 80x24, 120x40, and 200x60.
- [x] Packed npm installation passes noninteractive and PTY smoke tests under the declared runtime.
- [x] CI, release workflows, package metadata, and installation docs all declare the same Bun requirement.
- [x] pi-tui, its adapter, the migration flag, and obsolete ANSI renderers are removed.
- [x] `docs/features/tui.md` and `docs/ARCHITECTURE.md` describe the shipped behavior and ownership boundaries.

## Risks and mitigations

| Risk                                                        | Impact                                                      | Mitigation                                                                                               |
| ----------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Split-footer cannot safely replace a restored transcript    | Session switching could erase or duplicate terminal history | Make it a Slice 0 gate; prefer append-only session boundaries over clearing unrelated history            |
| Bun exposes Node compatibility gaps                         | Non-TUI commands or subprocesses regress                    | Run representative commands and packed-artifact tests before restructuring; keep a documented no-go path |
| Native OpenTUI packages are omitted from npm output         | Installed CLI fails although source works                   | Inspect and run the tarball on supported platforms in CI                                                 |
| Solid migration recreates `shell.ts` as one large component | Reuse and testing goals are lost                            | Extract controller/transcript first; enforce import boundaries and small semantic components             |
| Input routing differs subtly                                | Escape, Ctrl-C, suggestions, or dialogs misbehave           | Define one semantic priority router and test each conflicting state                                      |
| Streaming causes duplicated scrollback                      | Terminal output becomes noisy or corrupt                    | Give every stable entry an identity and test the live-to-committed transition                            |
| ANSI-only tests miss styling regressions                    | Muted reasoning, focus, or diffs become unreadable          | Assert OpenTUI styled spans and `NO_COLOR`, not only stripped text                                       |
| Dual renderers live too long                                | Every behavior change doubles maintenance                   | Keep the switch development-only and make cleanup a required slice                                       |
| OpenTUI API changes during migration                        | Rework across components/build                              | Pin exact versions, update packages together, and isolate renderer workarounds                           |
| Scope expands into a redesign                               | Parity becomes hard to evaluate                             | Defer alternate layouts, mouse UX, theming UI, and new navigation patterns                               |

## Explicitly deferred follow-ups

These may be valuable after the migration but are not part of the parity release:

- standalone executables for each platform;
- mouse navigation or mouse wheel ownership;
- alternate-screen dashboard mode;
- split panes, tabs, or a new information architecture;
- user-selectable theme marketplace;
- command palette beyond current slash behavior;
- expanded/collapsible tool histories beyond current semantics;
- changing session persistence or agent runtime protocols;
- adopting OpenCode's client/server or Effect architecture.

## Standalone executable distribution follow-up

Status: active; local implementation and release workflow complete, native CI and registry publication pending

### Target outcome

Publish Topchester as platform-specific standalone executables so end users do not need Bun installed. Keep Bun as the source, build, and contributor runtime. Preserve the existing `npm install -g topchester-ai` command through a small launcher version that selects the executable matching the user's operating system, CPU, and Linux libc when applicable.

### Cross-slice rules

- Do not replace the current npm artifact until the standalone package passes the existing installed-package and PTY lifecycle contracts on every supported release platform.
- Keep the platform executable self-contained: Topchester version metadata, built-in skills, product knowledge, and OpenTUI native code must not depend on the source checkout or a system Bun installation.
- Generate platform-version metadata from one target matrix; do not maintain hand-written package lists in multiple workflows.
- Keep `topchester-ai` as the only npm registry package identity. Publish native artifacts as platform-tagged versions and reference them through local optional-dependency aliases.
- Treat Windows signing, macOS signing/notarization requirements, Linux glibc/musl selection, and x64 baseline CPU support as release decisions, not incidental build details.
- Keep the previously published Bun-backed npm version as the rollback point until the native selector has been exercised from the registry. The source root is private so `npm publish` cannot accidentally bypass the generated native package graph.

### Slice 11: Prove a self-contained executable on the current platform

Status: [x] Done

Goal: prove the existing Topchester CLI and OpenTUI renderer can execute without Bun on the user's `PATH` while preserving packaged product data.

Why here: a local executable proof isolates Bun compilation, OpenTUI native loading, embedded filesystem behavior, and Topchester package-root assumptions before adding a platform matrix or npm installer.

Implemented:

- Added `scripts/build-standalone.ts`, which uses Bun's `compile` build, the OpenTUI Solid plugin, bundled npm dependencies, and embedded `package.json`, built-in skills, and product-knowledge assets.
- Added compile-time package-root, version, and built-in-skill manifest values while preserving the existing npm-package fallbacks.
- Changed the read-only product-knowledge loader to use the checked manifest's exact L1 paths because Bun's embedded filesystem can read known assets but does not expose them through recursive directory enumeration.
- Added `scripts/package/check-standalone.ts` plus `mise run standalone-check`. The check launches the executable with `/usr/bin:/bin` as `PATH`, verifies the version, loads and searches embedded product knowledge, and lists embedded skills.
- Manually launched the compiled executable in a PTY with Bun absent from `PATH`; OpenTUI loaded its embedded Darwin ARM64 native library and rendered the composer successfully.

Expected output: `dist/standalone/topchester-<platform>-<arch>/bin/topchester[.exe]`.

Verification:

- `mise run standalone-check` passed on 2026-07-17 for Darwin ARM64.
- Resulting executable size: 67.4 MiB.
- Manual PTY startup and two-stage Ctrl-C cleanup passed on the same host.

Dependencies: completed OpenTUI migration Slices 0-10.

### Slice 12: Add the supported cross-platform target matrix

Status: [~] Implemented; native CI evidence pending

Goal: produce deterministic executables for the release platforms from one build description.

Why here: npm platform versions are only useful after each target can be built and smoke-tested independently.

This slice should implement:

- define the initial matrix for Darwin, Linux, and Windows across ARM64 and x64;
- decide and encode Linux glibc/musl variants and x64 baseline/AVX2 policy;
- install the required OpenTUI native packages for cross-compilation and set `OPENTUI_LIBC` correctly for Linux targets;
- emit target metadata next to each executable;
- run `--version` on native CI hosts and the full OpenTUI PTY lifecycle smoke on each supported OS family.

Expected output: one verified directory per supported target under `dist/standalone/`.

Verification: matrix build plus native-host version, embedded-resource, and PTY checks; cross-compiled artifacts alone are not sufficient.

Implemented:

- The initial release matrix is macOS ARM64/x64 and glibc Linux ARM64/x64. Windows and musl are follow-ups; x64 builds use Bun's baseline target.
- `scripts/standalone/targets.ts` is the single source for Bun targets, output directories, npm aliases and dist-tags, OpenTUI native packages, OS, CPU, and libc metadata.
- `scripts/standalone/install-target-dependencies.ts` installs only the four target-specific OpenTUI libraries in an isolated temporary package so Bun does not try to migrate the repository's pnpm `catalog:` dependencies.
- Cross-builds emit one executable and `target.json` per target. Linux compilation fixes `OPENTUI_LIBC` to glibc.
- Code-quality and release-preflight matrices run the isolated npm install and OpenTUI PTY lifecycle on native GitHub runners for all four targets.

Local verification:

- `mise run release-build` produced ARM64/x64 Mach-O executables and ARM64/x64 glibc ELF executables on 2026-07-17.
- Native execution is verified locally only for Darwin ARM64; the other three native jobs remain pending until GitHub Actions runs this branch.

Dependencies: Slice 11.

### Slice 13: Publish npm platform versions and a selector launcher

Status: [~] Implemented for npm; registry and alternate installer evidence pending

Goal: retain `npm install -g topchester-ai` while installing and invoking the correct standalone executable.

Why here: the public package layout depends on a stable, verified target matrix.

This slice should implement:

- generate platform-tagged `topchester-ai` versions such as `0.77.0-darwin-arm64` and `0.77.0-linux-x64` with npm `os`, `cpu`, and optional `libc` constraints;
- generate the stable `topchester-ai` launcher with exact `npm:` aliases from local platform names to those tagged versions;
- add an install-time selector that chooses and verifies the matching binary and reports an actionable error when install scripts or optional dependencies are disabled;
- preserve argument forwarding, signals, exit codes, self-update detection, and `topchester --version` through npm, pnpm, and Bun installs;
- install a locally packed launcher into isolated prefixes and prove that the final command runs with Bun absent from `PATH`.

Expected output: local npm tarballs for the stable launcher and every supported platform-tagged version, all using the `topchester-ai` registry identity.

Verification: isolated global-style installs with npm, pnpm, and Bun; `--version`, product knowledge, skills, noninteractive smoke, and PTY lifecycle checks from the installed command.

Implemented:

- `scripts/package/build-npm-release.ts` stages four constrained platform-tagged versions of `topchester-ai` and a small stable launcher whose optional dependencies alias local platform names to those exact versions.
- The launcher postinstall selects the current OS, CPU, and libc alias, copies the executable into the public npm bin path, verifies it, and leaves an actionable placeholder when install scripts are disabled.
- The root package is private; only generated directories under `dist/npm/` are publishable.
- Package validation locally packs and installs the generated launcher plus its Darwin ARM64 aliased dependency, then checks version, product knowledge, skills, and a Bun-free `PATH`.
- The production PTY smoke now launches that installed native executable directly and preserves the interaction, resize, Ctrl-C, signal, and terminal-cleanup contract.
- Compiled executable paths participate in npm, pnpm, and Bun self-update manager detection.

Local verification:

- `mise run package-check` passed for Darwin ARM64 on 2026-07-17 after the single-identity alias refactor. It packed `topchester-ai@0.76.0-darwin-arm64`, installed it through the `topchester-ai-darwin-arm64` local alias, and ran the CLI with Bun absent from `PATH`.
- `mise run opentui-pty-smoke` passed for the installed Darwin ARM64 npm launcher on 2026-07-17.
- pnpm and Bun global installation remain unverified and are not part of the first documented install contract.

Dependencies: Slice 12.

### Slice 14: Integrate release CI, provenance, and signing

Status: [~] npm release automation implemented; live publication pending

Goal: make platform artifacts and npm packages a single atomic, recoverable release.

Why here: release publication must not begin until the package graph and platform validation are stable.

This slice should implement:

- build and test platform executables before publishing any package;
- sign Windows executables and establish the macOS CLI signing/notarization policy;
- publish platform-tagged versions under target-specific dist-tags before the stable `topchester-ai` launcher, with npm provenance throughout;
- attach native archives and checksums to the GitHub release;
- fix the existing version-bump ordering, product-pack version synchronization, and hard-coded `0.76.0` package assertion before enabling publication;
- ensure partial publication can be retried without changing package contents.

Expected output: a prerelease workflow that publishes a complete target set or stops before the public stable launcher.

Verification: registry prerelease installed on clean Darwin, Linux, and Windows hosts, with artifact signatures/checksums verified.

Implemented:

- The publish workflow blocks on four native package and PTY preflight jobs.
- Version bumping now happens before product-knowledge synchronization and executable compilation, so the embedded product source matches the published version.
- The release job runs the extended repository checks, prepares target-native dependencies, cross-builds all four executables, and stages the generated npm graph.
- `scripts/package/publish-npm-release.ts` verifies that every artifact uses the `topchester-ai` identity, publishes platform-tagged versions before the stable launcher, uses npm provenance, and skips already-published exact versions so a partially completed job can be rerun.
- The workflow uses the existing `topchester-ai` trusted publisher and OIDC for every artifact. No `NPM_TOKEN` or new package bootstrap is required because platform binaries are versions of the existing package, not new registry package names.
- The release commit includes the regenerated versioned product-knowledge pack.

Local verification:

- `mise run release-build` staged the stable launcher plus Darwin ARM64/x64 and glibc Linux ARM64/x64 versions, all named `topchester-ai`, on 2026-07-17.
- Platform versions are `0.76.0-<target>` and publish under matching target dist-tags; the stable `0.76.0` launcher publishes last and is the only artifact that advances `latest`.
- Both modified workflow files parse as YAML, and the publish workflow contains no npm token environment variable.

Remaining:

- Exercise trusted publication against npm and install that registry version on all four native runners.
- Add checksums/GitHub release archives if direct binary downloads become a supported channel.
- Establish macOS signing/notarization policy before advertising signed direct-download binaries.

Dependencies: Slice 13 and release credentials/signing infrastructure.

### Slice 15: Cut over the supported install contract

Status: [~] Local contract cut over; stable registry evidence pending

Goal: make the standalone executable the supported npm-installed Topchester runtime.

Why here: documentation and removal of the Bun end-user requirement are only accurate after registry validation.

This slice should implement:

- change installation documentation from an end-user Bun requirement to the supported OS/CPU matrix;
- keep Bun documented for contributors and source execution;
- update self-update and diagnostics to report the selected native package and target;
- remove the Bun-script package fallback after the rollback window;
- run the full release checklist and publish the first stable standalone-backed version.

Expected output: `topchester` runs from npm without Bun installed on every documented platform.

Verification: clean-machine installation and the complete release smoke matrix against the stable npm version.

Implemented:

- README and getting-started documentation now describe Node/npm as the installer, Bun as contributor-only, and the initial macOS/glibc Linux ARM64/x64 support matrix.
- The generated npm package contains no Bun engine requirement and invokes the standalone executable.
- Source builds keep the Bun-targeted development artifact as a separate contributor path.

Remaining: publish and verify the first registry version before marking this slice done.

Dependencies: Slice 14 prerelease evidence.

### Distribution decisions and follow-ups

- Windows ARM64/x64 are follow-ups and are not exposed by the first launcher.
- Both macOS and Linux x64 executables use Bun baseline targets; no AVX2 selector is needed in the first package graph.
- Linux musl is a follow-up and gets an explicit unsupported-target error from postinstall.
- The already-published Bun-backed version is the rollback point. The next release replaces the `topchester-ai` artifact with the native selector rather than publishing a second Bun fallback from this source tree.

## Decision log

### 2026-07-17: initial exploration

- The migration passed the architecture readiness check conditionally.
- The typed runtime/event boundary will remain unchanged.
- OpenTUI Solid is the proposed binding.
- Bun is the proposed CLI runtime because the repository targets Node 24 and OpenTUI's Node native-renderer path currently requires Node 26.4 experimental FFI.
- Bun 1.3 is present in `.mise.toml`; the resolved 1.3.2 starts the current source CLI for help/version only.
- `split-footer` is the proposed rendering mode, pending the session replay and terminal-history proof.
- Local OpenCode is a source of lifecycle, scrollback/footer, dialog, theme, and testing patterns only.
- No implementation slice is marked complete; Slice 0 is the mandatory next step.

Future implementation work should append dated decisions and verified progress here rather than rewriting the original rationale.

### 2026-07-17: Slice 0 go decision

- Runtime: Bun `1.3.2` from mise is the supported development target for the migration.
- Packages: use exact `@opentui/core@0.4.4`, `@opentui/solid@0.4.4`, and `solid-js@1.9.12`; update the OpenTUI pair together.
- Build: use `Bun.build` targeting Bun with `@opentui/solid/bun-plugin` and external npm packages so platform-native dependencies resolve from the installed package.
- Package: require an actual isolated tarball install in addition to content inspection; a workspace `node_modules` symlink is not sufficient evidence for native packages or package-root behavior.
- Screen mode: use append-only `split-footer` with captured stdout, mouse disabled, and non-clearing shutdown.
- Replay: append a visible session boundary and replay below it; never use the destructive saved-line reset path.
- Lifecycle: Topchester owns Ctrl-C and signal policy, while every renderer path destroys in `finally`.
- Compatibility: the feasibility gate passed on the local macOS arm64/Ghostty PTY path and nested `script` PTY. Broader terminal, Zellij, SSH, and release-platform coverage stays mandatory before cutover.

### 2026-07-17: Slice 1 behavior freeze

- The 145 pi-tui behavior cases are now organized by product responsibility and remain the parity baseline until cutover.
- Renderer-independent fixtures are the shared semantic input for neutral-model, controller, and OpenTUI renderer tests; renderer-specific terminals remain separate.
- Terminal cleanup, native selection/scrollback, and multiplexer behavior stay explicit PTY/manual gates until the production OpenTUI lifecycle harness can prove them.

### 2026-07-17: Slice 2 neutral transcript boundary

- Session persistence eligibility is encoded on transcript entries rather than delegated to renderers. Display-only reasoning and transient state cannot produce a session payload.
- Session replay and shared noninteractive CLI logic consume semantic transcript entries. pi-tui converts them through a compatibility adapter at the renderer boundary.
- Structured startup data is persisted as a system-message fallback plus semantic metadata, so current and future renderers can render it without storing ANSI as the application model.

### 2026-07-17: production OpenTUI cutover

- The disposable feature branch is the rollback boundary. The implementation cut directly to OpenTUI once controller, renderer, package, and PTY proofs passed, then removed pi-tui and the temporary spikes instead of shipping a dual-renderer flag.
- Bun `>=1.3` was the packaged CLI runtime for the OpenTUI migration itself. The standalone distribution follow-up below supersedes that artifact with compiled executables while retaining Bun for source and contributor workflows.
- Stable output uses append-only split-footer commits. New, forked, and restored sessions append a visible boundary and replay below it; Topchester never invokes OpenTUI's destructive saved-line reset.
- Application behavior lives in `src/chat/`; OpenTUI components own presentation, local edit/focus state, and input translation. Import-boundary tests enforce both directions.
- OpenTUI `0.4.4` Markdown remains on its streaming draw path for stable entries because that is the only path that synchronously exposes unhighlighted content to split-footer snapshots. The workaround is local to `ThreadEntry` and has direct renderer coverage.
- Package and PTY validation use an isolated npm installation of the real tarball. The PTY gate covers streamed interaction, resize, dialog cancellation, two-stage Ctrl-C, `SIGTERM`, `SIGHUP`, alternate-screen rejection, cursor restoration, and bracketed-paste shutdown; the Bun renderer test covers a forced mount failure.
- Broader UI patterns—panes, tabs, mouse navigation, command palettes, and collapsible histories—remain follow-up product work. The migration provides reusable controller, transcript, theme, dialog, suggestion, composer, and lifecycle seams without changing the first-release interaction model.
- Final gate: `mise run local-ci` passed on 2026-07-17. It verified formatting for 456 files; lint/type checking for 208 files; 38 Node suites with 626 tests; the production Bun renderer; 32-source product-knowledge freshness; a 54-file isolated package with `@opentui/core-darwin-arm64`; and the packed OpenTUI PTY lifecycle smoke.

### 2026-07-17: standalone npm distribution implementation

- The first generated package matrix covers macOS and glibc Linux on ARM64/x64. x64 uses baseline Bun runtimes; Windows and musl remain explicit follow-ups.
- `topchester-ai` remains the only registry package identity. Native executables publish first as platform-tagged versions, and the stable launcher aliases the matching version through an exact optional dependency.
- Trusted publishing remains tokenless: the existing `topchester-ai` OIDC configuration authorizes every platform-tagged version and the stable launcher.
- End users on the documented npm path need Node/npm to install but do not need Bun to run Topchester. Bun remains the source and contributor runtime.
- The source root is private to prevent accidental publication of the former Bun-script artifact. The publish workflow is the only supported release path.
- Local Darwin ARM64 evidence covers isolated npm pack/install, Bun-free version/product-knowledge/skill commands, and the full OpenTUI PTY lifecycle. Four native GitHub Actions jobs are the remaining pre-publication evidence.

### 2026-07-17: single npm identity correction

- OpenCode's native npm release uses distinct platform package names hidden behind `opencode-ai`, but distinct registry identities are not required for platform selection.
- The adopted model follows Codex: publish native artifacts as platform-tagged versions of the existing `topchester-ai` package and reference them through `npm:` optional-dependency aliases in the stable launcher.
- This keeps the existing trusted-publisher boundary intact. `publish-npm.yml` uses Node 24 plus OIDC and intentionally has no `NODE_AUTH_TOKEN` or `NPM_TOKEN` fallback.
- `mise run local-ci-extended` passed after the refactor on 2026-07-17: formatting for 463 files, lint and type checking for 215 files, 38 test files with 627 tests, production OpenTUI, product-knowledge freshness, isolated native npm install, and the native npm PTY lifecycle.
- `mise run release-build` then staged all four executable targets and five npm artifact directories under the single `topchester-ai` identity.
