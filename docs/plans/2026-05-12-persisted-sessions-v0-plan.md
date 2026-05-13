# Persisted Sessions V0 Plan

## Summary

Persist chat sessions as project-local event logs under `.agents/topchester/sessions/`.

The simplest V0 is:

- create one session directory when `topchester` starts;
- append important chat/runtime events to `events.jsonl`;
- keep a small `metadata.json` beside it for listing and resume;
- resume only when the user explicitly asks with a CLI flag.

This matches the current docs and keeps session data next to the project it came from.

## Current Code Findings

Chat state is currently in memory only.

- `src/tui/layout.ts`
  - Owns the active `messages: ChatMessage[]`.
  - Adds user rows before sending the message.
  - Builds model-facing history with `getConversationTurns()`.
- `src/tui/messages.ts`
  - Defines visible chat rows: `system`, `user`, `agent`, and `modal`.
- `src/tui/shell.ts`
  - Creates the startup message list.
  - Wires TUI input to runtime calls.
  - Applies `AgentRuntimeEvent[]` back into the chat thread.
- `src/agent/runtime.ts`
  - Owns the model call flow.
  - Returns typed runtime events but does not persist them.
- `src/agent/events.ts`
  - Defines durable-looking runtime events: `message`, `status`, `tool_call`, `knowledge_status`, and `choice`.
- `src/tui/runtime-events.ts`
  - Converts runtime events into visible chat messages.
- `src/app/paths.ts`
  - Already defines `.agents/topchester/sessions/` through `getTopchesterSessionsPath(workspaceRoot)`.
- `src/knowledge/init.ts`
  - Already creates `.agents/topchester/sessions/`.

The existing docs already point the same way:

- `docs/SESSIONS.md` says sessions should be project-local, append-only JSONL, and not global for V0.
- `docs/ARCHITECTURE.md` says sessions are part of the runtime state layer and should append important events to `.agents/topchester/sessions/<session-id>/events.jsonl`.
- `docs/KNOWLEDGE.md` says active work should use a session overlay so dirty-but-known changes are not invisible to the KB.

## Recommendation

Use `.agents/topchester/sessions/`, not the global config folder.

Reason:

- sessions are tied to one workspace, one KB state, one working tree, one set of tool calls, and one model config;
- session logs may contain source snippets, command output, and user instructions, so they should stay local and ignored;
- `.agents/topchester/sessions/` already exists in paths and init flow;
- global config should stay for user settings like model/provider config.

A future global recent-session index can point to project sessions, but it should not own the session data.

## On-Disk Layout

```text
.agents/topchester/sessions/
  0198f13c-8f3a-7c6a-9b2d-3a8f3e0c2d11/
    metadata.json
    events.jsonl
```

`events.jsonl` is the source of truth.

`metadata.json` is a small helper for listing and quick resume checks.

## Session ID

Use UUIDv7 for session IDs.

```text
0198f13c-8f3a-7c6a-9b2d-3a8f3e0c2d11
```

UUIDv7 is time-ordered, widely recognizable, and avoids inventing a custom ID format. If Node does not expose UUIDv7 directly, implement a small local helper or use a tiny dependency; keep the stored ID as plain lowercase UUID text.

## Metadata Shape

```json
{
  "version": 1,
  "sessionId": "0198f13c-8f3a-7c6a-9b2d-3a8f3e0c2d11",
  "workspaceRoot": "/Users/kodi/data/personal/topchester-agent",
  "createdAt": "2026-05-12T18:04:55.000Z",
  "updatedAt": "2026-05-12T18:12:10.000Z",
  "lastEventId": 24,
  "title": "Add persisted sessions",
  "modelLabel": "openai/gpt-5.1 [openrouter]"
}
```

V0 can derive `title` from the first user message, clipped to one line. It is okay if `title` is missing.

## Event Shape

Each line in `events.jsonl` is one JSON object.

Common fields:

```json
{
  "version": 1,
  "id": 1,
  "ts": "2026-05-12T18:04:55.000Z",
  "kind": "message"
}
```

V0 event kinds:

```json
{"version":1,"id":1,"ts":"2026-05-12T18:04:55.000Z","kind":"message","role":"system","text":"startup text"}
{"version":1,"id":2,"ts":"2026-05-12T18:05:01.000Z","kind":"message","role":"user","text":"hello"}
{"version":1,"id":3,"ts":"2026-05-12T18:05:03.000Z","kind":"message","role":"assistant","text":"Hi","meta":"model · 1.2 sec"}
{"version":1,"id":4,"ts":"2026-05-12T18:05:04.000Z","kind":"tool_call","label":"read_file: package.json","call":{"tool":"read_file","args":{"path":"package.json"}}}
{"version":1,"id":5,"ts":"2026-05-12T18:05:05.000Z","kind":"status","status":"ready"}
{"version":1,"id":6,"ts":"2026-05-12T18:05:06.000Z","kind":"knowledge_status","status":{"kbPath":"..."}}
{"version":1,"id":7,"ts":"2026-05-12T18:05:07.000Z","kind":"choice","tone":"warning","title":"No KB found","actions":[{"label":"Create KB now","value":"/kb init"}]}
```

Keep the stored events close to `AgentRuntimeEvent`, but include user messages too because user input is currently added in the TUI before runtime sees it.

## What To Persist In V0

Persist:

- startup system messages;
- user messages;
- assistant messages and metadata;
- visible system messages;
- tool calls and labels;
- KB status events;
- modal/choice events;
- final status changes like `ready`, `chat failed`, and `command failed`.

Do not persist:

- spinner rows;
- prompt text that was not submitted;
- scroll position;
- temporary notice lines like `press Ctrl-C again to exit.`;
- transient busy animation activity.

## Resume Behavior

Default `topchester` should start a new session.

Resume should be explicit:

```text
topchester --resume latest
topchester --resume 0198f13c-8f3a-7c6a-9b2d-3a8f3e0c2d11
```

V0 rules:

- `--resume latest` loads the newest session in the current workspace by `metadata.updatedAt`, falling back to folder name sort.
- `--resume <session-id>` loads that exact project-local session.
- If the session is missing or malformed, print a plain error and exit before opening the TUI.
- Resumed messages are rendered in the chat thread before new input is accepted.
- New events append to the same `events.jsonl`.
- Model-facing conversation is rebuilt from resumed user and assistant messages only, matching `ChatLayout.getConversationTurns()`.

Do not auto-resume by default in V0. It can surprise users and can send old context to the model by accident.

## Implementation Steps

### 1. Add session types and store

Add a small module, likely:

```text
src/session/store.ts
src/session/events.ts
```

Responsibilities:

- create session IDs;
- create session folders under `getTopchesterSessionsPath(workspaceRoot)`;
- write initial `metadata.json`;
- append one event per line to `events.jsonl`;
- update `metadata.json` after each append;
- load and validate an existing session;
- list sessions for `latest` resolution.

Use `zod` for event and metadata validation because the project already uses it.

### 2. Ensure the local session folder on startup

Normal `topchester` startup does not currently ensure all `.agents/topchester/` folders exist. `/kb init` creates them, and logging creates its log folder on demand, but a fresh project can still start the TUI without `.agents/topchester/sessions/`.

Add a small session-store startup step that ensures only the local session state needed for persistence:

```text
.agents/topchester/
.agents/topchester/sessions/
```

Do not auto-create the canonical `topchester-kb/` here. Keep KB creation behind `/kb init` or `topchester kb init` so startup does not silently create committed project knowledge folders.

### 3. Wire CLI options

Add a global option:

```text
--resume <session>
```

Accepted values:

- `latest`
- a session id

Because this changes CLI behavior, update `docs/cli.md` in the implementation change.

### 4. Pass session state through app context or shell options

Keep the runtime boundary boring:

- CLI resolves the workspace and resume option.
- TUI shell receives a session store/session handle.
- Runtime remains focused on agent events.

Suggested shape:

```ts
interface SessionHandle {
  id: string;
  append(event: SessionLogEvent): Promise<void>;
  loadMessages(): Promise<ChatMessage[]>;
}
```

The exact type can differ, but avoid making `ChatLayout` do file I/O.

### 5. Rehydrate chat messages

On startup:

1. If no resume option is provided, use current startup messages and create a fresh session.
2. If resume is provided, load `events.jsonl`.
3. Convert persisted events back into `ChatMessage[]`.
4. Create `ChatLayout` with those messages.
5. Continue appending to the same session.

When resuming, do not rerun old tool calls or old commands. Only replay the visible log.

### 6. Append new user input

User messages are added inside `ChatLayout` before callbacks run. For V0, append them in `TopchesterTuiShell.submitChatMessage(...)` and `submitSlashCommand(...)` before calling runtime.

This keeps `ChatLayout` free of disk writes.

### 7. Append runtime events

In `TopchesterTuiShell.applyRuntimeEvents(...)`, append each event before or after rendering it.

For V0, appending after successful rendering is fine. If append fails, show a system message like:

```text
Session save failed: <plain error>
```

Do not crash the agent after one failed append, but keep warning so the user knows the session is no longer safely saved.

### 8. Add tests

Add focused tests for:

- session id format;
- creating `metadata.json` and `events.jsonl`;
- appending valid events and updating `lastEventId`;
- reading JSONL and rejecting malformed lines with a clear error;
- resolving `latest`;
- rehydrating user/assistant/system/modal messages;
- rebuilding model-facing conversation from resumed user and assistant messages.
- ensuring `.agents/topchester/sessions/` on startup without creating `topchester-kb/`.

### 9. Keep room for KB session overlay

This V0 should not try to solve the full dirty-KB overlay.

But it should avoid blocking it:

- include `tool_call` events;
- keep event IDs stable;
- use versioned JSONL;
- keep enough event metadata to later add `tool_result`, file edit, and KB dirty/suspect events.

## Data Safety

- Do not commit `.agents/topchester/sessions/`.
- Keep sessions project-local by default.
- Treat session logs as potentially sensitive.
- Do not add global session storage in V0.
- If a future global index is added, store only small pointers like workspace path, session id, title, and updated time.

## Open Questions For Implementation

Each question includes the likely V0 answer. Custom answers are welcome before implementation starts.

1. Where should full session logs live?
   - Likely answer: `.agents/topchester/sessions/` inside the current workspace.
   - Custom answer:

2. Should `topchester` auto-resume the latest session by default?
   - Likely answer: no, start fresh unless the user passes `--resume`.
   - Custom answer:

3. What resume command shape should V0 use?
   - Likely answer: `topchester --resume latest` or `topchester --resume <session-id>`.
   - Custom answer:

4. Should resumed sessions append to the same log or fork into a new child session?
   - Likely answer: append to the same log for V0.
   - Custom answer:

5. Should startup system messages be persisted?
   - Likely answer: yes, persist visible startup context so replay matches what the user saw.
   - Custom answer:

6. How strict should session loading be when one JSONL line is bad?
   - Likely answer: fail the resume with a clear error instead of silently dropping data.
   - Custom answer:

7. Should slash command output be part of resumed model context?
   - Likely answer: no, show it in the UI but only user and assistant messages rebuild model-facing chat history.
   - Custom answer:

8. Should V0 include a `topchester sessions list` command?
   - Likely answer: no, use `--resume latest` and exact IDs first; add listing after the core store works.
   - Custom answer:

## Acceptance Criteria

- Starting `topchester` creates a new project-local session folder.
- Submitted user messages are appended to `events.jsonl`.
- Assistant/system/runtime events are appended to `events.jsonl`.
- `metadata.json` has correct `createdAt`, `updatedAt`, and `lastEventId`.
- `topchester --resume latest` restores the newest session for the current workspace.
- `topchester --resume <session-id>` restores that exact session.
- Resumed chat history is visible in the TUI.
- Resumed model context includes only user and assistant turns.
- Session save failures are visible to the user.
- Tests cover create, append, load, latest, and rehydrate behavior.
