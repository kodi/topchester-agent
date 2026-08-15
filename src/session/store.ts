import { mkdir, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { uuidv7 } from "uuidv7";
import { ZodError } from "zod";
import {
  assistantTranscriptEntry,
  parseStartupTranscriptEntry,
  systemTranscriptEntry,
  userTranscriptEntry,
  type TranscriptEntry,
} from "../chat/index.js";
import { getTopchesterSessionsPath } from "../app/paths.js";
import { type HookEventName } from "../config/index.js";
import { emptyRuntimeConfigOverrides, type RuntimeConfigOverrides } from "../config/runtime.js";
import { type TaskPlanState } from "../agent/task-plan.js";
import { type ToolCall } from "../agent/tools.js";
import {
  SESSION_EVENT_VERSION,
  SESSION_METADATA_VERSION,
  sessionEventPayload,
  sessionEventSchema,
  sessionMetadataSchema,
  type SessionEvent,
  type SessionEventPayload,
  type SessionMetadata,
} from "./events.js";

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SESSION_TITLE_MAX_LENGTH = 72;

export interface SessionHandle {
  sessionId: string;
  sessionDir: string;
  metadataPath: string;
  eventsPath: string;
  metadata: SessionMetadata;
  /** Queues an ordered event without waiting for filesystem durability. */
  enqueue(payload: SessionEventPayload): SessionEvent | Promise<SessionEvent>;
  append(payload: SessionEventPayload): Promise<SessionEvent>;
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

/** Optional, test-only measurement seam. Normal session writes do not collect it. */
export interface SessionWriteProfile {
  sessionEvents: number;
  jsonlWriteBatches: number;
  metadataWrites: number;
  maximumPendingPersistenceDepth: number;
  flushes: number;
}

export interface LoadedSession {
  sessionId: string;
  sessionDir: string;
  metadata: SessionMetadata;
  events: SessionEvent[];
}

export interface LoadedSessionTree {
  session: LoadedSession;
  children: LoadedSessionTree[];
}

export interface SessionSummary {
  sessionId: string;
  updatedAt: string;
  createdAt: string;
  firstUserPrompt?: string;
  title?: string;
  forkedFromSessionId?: string;
}

export interface ListSessionSummariesOptions {
  excludeSessionId?: string;
  includeSubagents?: boolean;
  limit?: number;
}

export interface RehydratedSession {
  transcript: TranscriptEntry[];
  status?: string;
  taskPlan?: TaskPlanState;
  runtimeConfigOverrides: RuntimeConfigOverrides;
}

export interface CreateChildSessionOptions {
  parent: SessionHandle;
  parentToolCallId: string;
  agentProfileId?: string;
  title?: string;
  recordParentEvent?: boolean;
}

export interface ForkSessionOptions {
  title?: string;
}

export function generateSessionId(): string {
  return uuidv7();
}

export async function ensureSessionStorage(workspaceRoot: string): Promise<void> {
  await mkdir(getTopchesterSessionsPath(workspaceRoot), { recursive: true });
}

export async function createSession(
  workspaceRoot: string,
  options: { profile?: SessionWriteProfile } = {}
): Promise<SessionHandle> {
  const sessionId = generateSessionId();
  const sessionDir = join(getTopchesterSessionsPath(workspaceRoot), sessionId);
  const metadataPath = join(sessionDir, "metadata.json");
  const eventsPath = join(sessionDir, "events.jsonl");
  const createdAt = new Date().toISOString();
  const metadata: SessionMetadata = {
    version: SESSION_METADATA_VERSION,
    sessionId,
    rootSessionId: sessionId,
    source: "user",
    workspaceRoot,
    createdAt,
    updatedAt: createdAt,
    lastEventId: 0,
  };

  await mkdir(sessionDir, { recursive: true });
  await writeMetadata(metadataPath, metadata);
  await writeFile(eventsPath, "", { flag: "wx" });

  return buildHandle(sessionDir, metadata, options.profile);
}

export async function createChildSession(
  workspaceRoot: string,
  options: CreateChildSessionOptions
): Promise<SessionHandle> {
  validateSessionId(options.parent.sessionId);
  const sessionId = generateSessionId();
  const sessionDir = join(getTopchesterSessionsPath(workspaceRoot), sessionId);
  const metadataPath = join(sessionDir, "metadata.json");
  const eventsPath = join(sessionDir, "events.jsonl");
  const createdAt = new Date().toISOString();
  const metadata: SessionMetadata = {
    version: SESSION_METADATA_VERSION,
    sessionId,
    rootSessionId: options.parent.metadata.rootSessionId,
    parentSessionId: options.parent.sessionId,
    parentToolCallId: options.parentToolCallId,
    source: "subagent",
    ...(options.agentProfileId === undefined ? {} : { agentProfileId: options.agentProfileId }),
    ...(options.title === undefined ? {} : { title: options.title }),
    workspaceRoot,
    createdAt,
    updatedAt: createdAt,
    lastEventId: 0,
  };

  await mkdir(sessionDir, { recursive: true });
  await writeMetadata(metadataPath, metadata);
  await writeFile(eventsPath, "", { flag: "wx" });

  const child = buildHandle(sessionDir, metadata);
  if (options.recordParentEvent ?? true) {
    await options.parent.append(
      sessionEventPayload.subagentStarted(
        {
          sessionId: child.sessionId,
          parentSessionId: options.parent.sessionId,
          parentToolCallId: options.parentToolCallId,
        },
        {
          ...(options.agentProfileId === undefined ? {} : { agentProfileId: options.agentProfileId }),
          ...(options.title === undefined ? {} : { title: options.title }),
        }
      )
    );
  }

  return child;
}

export async function forkSession(
  workspaceRoot: string,
  sourceSessionIdOrLatest: string,
  options: ForkSessionOptions = {}
): Promise<SessionHandle> {
  const source = await loadSession(workspaceRoot, sourceSessionIdOrLatest);
  const copiedEvents = await readFile(join(source.sessionDir, "events.jsonl"), "utf8");
  const title = options.title ?? source.metadata.title ?? deriveSessionTitle(firstUserPrompt(source.events));
  const sessionsPath = getTopchesterSessionsPath(workspaceRoot);
  const createdAt = new Date().toISOString();

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const sessionId = generateSessionId();
    const sessionDir = join(sessionsPath, sessionId);
    const metadataPath = join(sessionDir, "metadata.json");
    const eventsPath = join(sessionDir, "events.jsonl");
    const metadata: SessionMetadata = {
      version: SESSION_METADATA_VERSION,
      sessionId,
      rootSessionId: sessionId,
      forkedFromSessionId: source.sessionId,
      forkedFromRootSessionId: source.metadata.rootSessionId,
      source: "user",
      ...(title === undefined ? {} : { title }),
      workspaceRoot,
      createdAt,
      updatedAt: createdAt,
      lastEventId: source.metadata.lastEventId,
    };

    try {
      await mkdir(sessionDir);
      await writeMetadata(metadataPath, metadata);
      await writeFile(eventsPath, copiedEvents, { flag: "wx" });

      return buildHandle(sessionDir, metadata);
    } catch (error) {
      if (isFileExistsError(error)) {
        continue;
      }
      await rm(sessionDir, { recursive: true, force: true });
      throw error;
    }
  }

  throw new Error("Could not create forked session after repeated session id collisions");
}

export async function loadSessionForAppend(workspaceRoot: string, sessionId: string): Promise<SessionHandle> {
  const loaded = await loadSession(workspaceRoot, sessionId);

  return buildHandle(loaded.sessionDir, loaded.metadata);
}

export async function loadSession(workspaceRoot: string, sessionIdOrLatest: string): Promise<LoadedSession> {
  const sessionId =
    sessionIdOrLatest === "latest" ? await resolveLatestSessionId(workspaceRoot) : validateSessionId(sessionIdOrLatest);
  const sessionDir = join(getTopchesterSessionsPath(workspaceRoot), sessionId);
  try {
    await stat(sessionDir);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      throw new Error("Session not found");
    }
    throw error;
  }
  const metadataPath = join(sessionDir, "metadata.json");
  const eventsPath = join(sessionDir, "events.jsonl");
  const metadata = await readMetadata(metadataPath);

  validateMetadataConsistency(metadata, sessionId, workspaceRoot, metadataPath);
  const events = await readEvents(eventsPath);
  validateEventConsistency(metadata, events, eventsPath);

  return { sessionId, sessionDir, metadata, events };
}

export async function listChildSessions(workspaceRoot: string, parentSessionId: string): Promise<LoadedSession[]> {
  validateSessionId(parentSessionId);
  const sessionsPath = getTopchesterSessionsPath(workspaceRoot);
  let entries: string[];
  try {
    entries = await readdir(sessionsPath);
  } catch {
    return [];
  }

  const children: LoadedSession[] = [];

  for (const entry of entries.filter((candidate) => SESSION_ID_PATTERN.test(candidate)).sort()) {
    const metadataPath = join(sessionsPath, entry, "metadata.json");
    let metadata: SessionMetadata;
    try {
      metadata = await readMetadata(metadataPath);
    } catch {
      continue;
    }

    if (metadata.parentSessionId !== parentSessionId) {
      continue;
    }

    children.push(await loadSession(workspaceRoot, entry));
  }

  return children.sort((left, right) => {
    const byCreatedAt = left.metadata.createdAt.localeCompare(right.metadata.createdAt);
    return byCreatedAt === 0 ? left.sessionId.localeCompare(right.sessionId) : byCreatedAt;
  });
}

export async function listSessionSummaries(
  workspaceRoot: string,
  options: ListSessionSummariesOptions = {}
): Promise<SessionSummary[]> {
  if (options.excludeSessionId !== undefined) {
    validateSessionId(options.excludeSessionId);
  }

  const sessionsPath = getTopchesterSessionsPath(workspaceRoot);
  let entries: string[];
  try {
    entries = await readdir(sessionsPath);
  } catch {
    return [];
  }

  const summaries: SessionSummary[] = [];
  for (const sessionId of entries.filter((entry) => SESSION_ID_PATTERN.test(entry)).sort()) {
    if (options.excludeSessionId === sessionId) {
      continue;
    }

    const sessionDir = join(sessionsPath, sessionId);
    const metadataPath = join(sessionDir, "metadata.json");
    const eventsPath = join(sessionDir, "events.jsonl");

    let metadata: SessionMetadata;
    let events: SessionEvent[];
    try {
      metadata = await readMetadata(metadataPath);
      validateMetadataConsistency(metadata, sessionId, workspaceRoot, metadataPath);
      if (metadata.source === "subagent" && options.includeSubagents !== true) {
        continue;
      }
      events = await readEvents(eventsPath);
      validateEventConsistency(metadata, events, eventsPath);
    } catch {
      continue;
    }

    const prompt = firstUserPrompt(events);
    const title = metadata.title ?? (prompt === undefined ? undefined : deriveSessionTitle(prompt));
    summaries.push({
      sessionId,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      ...(title === undefined ? {} : { title }),
      ...(metadata.forkedFromSessionId === undefined ? {} : { forkedFromSessionId: metadata.forkedFromSessionId }),
      ...(prompt === undefined ? {} : { firstUserPrompt: prompt }),
    });
  }

  const sorted = summaries.sort((left, right) => {
    const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
    return byUpdatedAt === 0 ? right.sessionId.localeCompare(left.sessionId) : byUpdatedAt;
  });

  return options.limit === undefined ? sorted : sorted.slice(0, Math.max(0, options.limit));
}

export async function loadSessionTree(workspaceRoot: string, sessionIdOrLatest: string): Promise<LoadedSessionTree> {
  const session = await loadSession(workspaceRoot, sessionIdOrLatest);
  const children = await Promise.all(
    (await listChildSessions(workspaceRoot, session.sessionId)).map((child) =>
      loadSessionTree(workspaceRoot, child.sessionId)
    )
  );

  return { session, children };
}

export async function resolveLatestSessionId(workspaceRoot: string): Promise<string> {
  const sessionsPath = getTopchesterSessionsPath(workspaceRoot);
  let entries: string[];
  try {
    entries = await readdir(sessionsPath);
  } catch {
    throw new Error("No sessions found");
  }

  const ids = entries.filter((entry) => SESSION_ID_PATTERN.test(entry)).sort();
  if (ids.length === 0) {
    throw new Error("No sessions found");
  }

  const candidates = await Promise.all(
    ids.map(async (sessionId) => ({
      sessionId,
      metadata: await readMetadata(join(sessionsPath, sessionId, "metadata.json")),
    }))
  );

  for (const candidate of candidates) {
    validateMetadataConsistency(
      candidate.metadata,
      candidate.sessionId,
      workspaceRoot,
      join(sessionsPath, candidate.sessionId, "metadata.json")
    );
  }

  const timestamps = new Set(candidates.map((candidate) => candidate.metadata.updatedAt));
  if (timestamps.size > 1) {
    return candidates
      .sort((left, right) => {
        const byUpdatedAt = left.metadata.updatedAt.localeCompare(right.metadata.updatedAt);
        return byUpdatedAt === 0 ? left.sessionId.localeCompare(right.sessionId) : byUpdatedAt;
      })
      .at(-1)!.sessionId;
  }

  return ids.at(-1)!;
}

export function rehydrateSession(events: SessionEvent[]): RehydratedSession {
  const transcript: TranscriptEntry[] = [];
  let status: string | undefined;
  let taskPlan: TaskPlanState | undefined;
  let runtimeConfigOverrides = emptyRuntimeConfigOverrides();
  let visibleOnlyActionValues = new Set<string>();

  for (const event of events) {
    switch (event.kind) {
      case "message":
        if (event.role === "assistant" && event.text === "ready" && event.meta === undefined) {
          break;
        }
        if (event.role === "system") {
          const startup = getStartupTranscriptEntry(event.meta);
          transcript.push(
            startup ??
              systemTranscriptEntry(
                event.text,
                isVisibleOnlyMessage(event.meta) || visibleOnlyActionValues.has(event.text)
                  ? { modelContext: false }
                  : {}
              )
          );
        } else if (event.role === "user") {
          transcript.push(
            userTranscriptEntry(
              event.text,
              isVisibleOnlyMessage(event.meta) || visibleOnlyActionValues.has(event.text) ? { modelContext: false } : {}
            )
          );
        } else {
          transcript.push(
            assistantTranscriptEntry(event.text, {
              ...(typeof event.meta === "string" ? { meta: event.meta } : {}),
              ...(isVisibleOnlyMessage(event.meta) || visibleOnlyActionValues.has(event.text)
                ? { modelContext: false }
                : {}),
            })
          );
        }
        if (event.role === "user") {
          visibleOnlyActionValues = new Set();
        }
        break;
      case "permission_auto_approved":
        break;
      case "tool_call":
        transcript.push({
          kind: "tool_call",
          persistence: "session",
          call: event.call as unknown as ToolCall,
          label: event.label,
          ...(event.diff === undefined ? {} : { diff: event.diff }),
        });
        break;
      case "hook_status":
        transcript.push({
          kind: "hook_status",
          persistence: "session",
          label: event.label,
          eventName: event.eventName as HookEventName,
          statusMessage: event.statusMessage,
        });
        break;
      case "task_plan":
        taskPlan = {
          items: event.items,
          updatedAt: event.updatedAt,
        };
        break;
      case "knowledge_status":
        break;
      case "runtime_config":
        runtimeConfigOverrides = {
          ...(event.activeModel === undefined ? {} : { activeModel: event.activeModel }),
          reasoningEffortByProvider: { ...event.reasoningEffortByProvider },
        };
        break;
      case "subagent_started":
      case "subagent_event":
      case "subagent_completed":
      case "subagent_failed":
        break;
      case "choice":
        transcript.push({
          kind: "choice",
          persistence: "session",
          tone: event.tone,
          title: event.title,
          ...(event.body === undefined ? {} : { body: event.body }),
          actions: event.actions,
        });
        visibleOnlyActionValues = new Set(
          event.actions
            .flatMap((action) => [action.label, action.value])
            .filter((value): value is string => Boolean(value))
        );
        break;
      case "status":
        status = event.status;
        break;
    }
  }

  return { transcript, status, ...(taskPlan === undefined ? {} : { taskPlan }), runtimeConfigOverrides };
}

function getStartupTranscriptEntry(meta: unknown): TranscriptEntry | undefined {
  if (typeof meta !== "object" || meta === null || !("source" in meta) || !("entry" in meta)) {
    return undefined;
  }

  const candidate = meta as { source?: unknown; entry?: unknown };
  return candidate.source === "startup" ? parseStartupTranscriptEntry(candidate.entry) : undefined;
}

function buildHandle(sessionDir: string, metadata: SessionMetadata, profile?: SessionWriteProfile): SessionHandle {
  const capacity = 128;
  type Pending = { event: SessionEvent };
  type Waiter = {
    payload: SessionEventPayload;
    resolve: (event: SessionEvent) => void;
    reject: (error: unknown) => void;
  };
  let pending: Pending[] = [];
  let waiters: Waiter[] = [];
  let scheduled = false;
  let writing: Promise<void> | undefined;
  let terminalError: unknown;
  let disposed = false;
  let nextEventId = metadata.lastEventId;
  let durableEventId = metadata.lastEventId;
  let outstanding = 0;
  const barriers = new Set<{ watermark: number; resolve: () => void; reject: (error: unknown) => void }>();
  const updateDepth = () => {
    if (profile) profile.maximumPendingPersistenceDepth = Math.max(profile.maximumPendingPersistenceDepth, outstanding);
  };
  const settleBarriers = () => {
    for (const barrier of barriers) {
      if (terminalError !== undefined) {
        barrier.reject(terminalError);
        barriers.delete(barrier);
      } else if (durableEventId >= barrier.watermark) {
        barrier.resolve();
        barriers.delete(barrier);
      }
    }
  };
  const admit = (payload: SessionEventPayload): SessionEvent => {
    const event = sessionEventSchema.parse({
      version: SESSION_EVENT_VERSION,
      id: nextEventId + 1,
      ts: new Date().toISOString(),
      ...payload,
    });
    nextEventId = event.id;
    pending.push({ event });
    outstanding += 1;
    updateDepth();
    return event;
  };
  const admitWaiters = () => {
    while (outstanding < capacity && waiters.length > 0 && terminalError === undefined) {
      const waiter = waiters.shift()!;
      try {
        waiter.resolve(admit(waiter.payload));
      } catch (error) {
        waiter.reject(error);
      }
    }
  };
  const writeReady = async (): Promise<void> => {
    scheduled = false;
    if (writing || pending.length === 0 || terminalError !== undefined) return;
    const batch = pending;
    pending = [];
    writing = (async () => {
      let previousEventFileSize: number | undefined;
      try {
        previousEventFileSize = (await stat(handle.eventsPath)).size;
        let nextMetadata = handle.metadata;
        for (const { event } of batch) {
          const title =
            nextMetadata.title === undefined &&
            event.kind === "message" &&
            event.role === "user" &&
            !isVisibleOnlySlashCommandMessage(event.meta)
              ? deriveSessionTitle(event.text)
              : nextMetadata.title;
          nextMetadata = {
            ...nextMetadata,
            updatedAt: event.ts,
            lastEventId: event.id,
            ...(title === undefined ? {} : { title }),
          };
        }
        await writeFile(handle.eventsPath, batch.map(({ event }) => `${JSON.stringify(event)}\n`).join(""), {
          flag: "a",
        });
        if (profile) profile.jsonlWriteBatches += 1;
        await writeMetadata(handle.metadataPath, nextMetadata);
        if (profile) profile.metadataWrites += 1;
        handle.metadata = nextMetadata;
        durableEventId = batch.at(-1)?.event.id ?? durableEventId;
        outstanding -= batch.length;
        if (profile) profile.sessionEvents += batch.length;
      } catch (error) {
        // A failed batch is terminal: callers must create/load a new handle rather than retrying into uncertain state.
        if (previousEventFileSize === undefined) {
          terminalError = error;
        } else {
          try {
            await truncate(handle.eventsPath, previousEventFileSize);
            terminalError = error;
          } catch (rollbackError) {
            terminalError = new AggregateError([error, rollbackError], "Session journal write and rollback failed");
          }
        }
        pending = [];
        outstanding = 0;
        for (const waiter of waiters) waiter.reject(terminalError);
        waiters = [];
        throw error;
      }
    })();
    try {
      await writing;
    } catch {
      // Individual append/flush promises receive the terminal failure.
    } finally {
      writing = undefined;
      if (terminalError === undefined) admitWaiters();
      if (pending.length > 0 && terminalError === undefined) void writeReady();
      settleBarriers();
    }
  };
  const requestWrite = () => {
    if (scheduled || writing || terminalError !== undefined) return;
    scheduled = true;
    queueMicrotask(() => void writeReady());
  };
  const handle: SessionHandle = {
    sessionId: metadata.sessionId,
    sessionDir,
    metadataPath: join(sessionDir, "metadata.json"),
    eventsPath: join(sessionDir, "events.jsonl"),
    metadata,
    enqueue(payload) {
      if (disposed) throw new Error("Session handle is disposed");
      if (terminalError !== undefined) throw terminalError;
      if (outstanding >= capacity) {
        return new Promise<SessionEvent>((resolve, reject) => waiters.push({ payload, resolve, reject }));
      }
      const event = admit(payload);
      requestWrite();
      return event;
    },
    append(payload) {
      let enqueued: SessionEvent | Promise<SessionEvent>;
      try {
        enqueued = handle.enqueue(payload);
      } catch (error) {
        return Promise.reject(error);
      }
      return Promise.resolve(enqueued).then((event) => handle.flush().then(() => event));
    },
    flush() {
      if (profile) profile.flushes += 1;
      if (terminalError !== undefined) return Promise.reject(terminalError);
      requestWrite();
      const watermark = nextEventId;
      return new Promise<void>((resolve, reject) => {
        barriers.add({ watermark, resolve, reject });
        settleBarriers();
      });
    },
    async dispose() {
      disposed = true;
      await handle.flush();
    },
  };

  return handle;
}

async function writeMetadata(path: string, metadata: SessionMetadata): Promise<void> {
  await writeFile(path, `${JSON.stringify(sessionMetadataSchema.parse(metadata), null, 2)}\n`);
}

function validateSessionId(sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("Session id must be an exact lowercase UUIDv7");
  }

  return sessionId;
}

async function readMetadata(path: string): Promise<SessionMetadata> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`Could not read session metadata at ${path}`);
  }

  const parsed = sessionMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Session metadata is not valid in ${path}: ${formatZodError(parsed.error)}`);
  }

  return parsed.data;
}

async function readEvents(path: string): Promise<SessionEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) {
      throw new Error("Session not found");
    }
    throw error;
  }
  const lines = raw.split("\n");
  const events: SessionEvent[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    if (line === "" && index === lines.length - 1) {
      continue;
    }
    if (line.trim().length === 0) {
      throw new Error(`Could not read session event in ${path} line ${lineNumber}: Blank lines are not allowed`);
    }

    let parsedLine: unknown;
    try {
      parsedLine = JSON.parse(line);
    } catch {
      throw new Error(`Could not read session event in ${path} line ${lineNumber}: invalid JSON`);
    }

    const parsed = sessionEventSchema.safeParse(parsedLine);
    if (!parsed.success) {
      throw new Error(`Could not read session event in ${path} line ${lineNumber}: ${formatZodError(parsed.error)}`);
    }
    events.push(parsed.data);
  }

  return events;
}

function validateMetadataConsistency(
  metadata: SessionMetadata,
  sessionId: string,
  workspaceRoot: string,
  path: string
): void {
  if (metadata.sessionId !== sessionId) {
    throw new Error(`Session metadata mismatch in ${path}: metadata.json sessionId does not match the folder`);
  }
  if (metadata.workspaceRoot !== workspaceRoot) {
    throw new Error(`Session metadata mismatch in ${path}: metadata.json workspaceRoot does not match this workspace`);
  }
}

function validateEventConsistency(metadata: SessionMetadata, events: SessionEvent[], path: string): void {
  let expectedId = 1;
  for (const event of events) {
    if (event.id !== expectedId) {
      throw new Error(
        `Session event consistency error in ${path}: expected event id ${expectedId} but found ${event.id}`
      );
    }
    expectedId += 1;
  }

  const finalEventId = events.at(-1)?.id ?? 0;
  if (metadata.lastEventId !== finalEventId) {
    throw new Error(
      `Session metadata mismatch: metadata.json lastEventId ${metadata.lastEventId} does not match final event id ${finalEventId}`
    );
  }
}

function formatZodError(error: ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "value"} ${issue.message}`).join("; ");
}

function isVisibleOnlyMessage(meta: unknown): boolean {
  return (
    typeof meta === "object" &&
    meta !== null &&
    "visibleOnly" in meta &&
    (meta as { visibleOnly?: unknown }).visibleOnly === true
  );
}

function firstUserPrompt(events: SessionEvent[]): string | undefined {
  for (const event of events) {
    if (event.kind === "message" && event.role === "user" && !isVisibleOnlySlashCommandMessage(event.meta)) {
      return event.text;
    }
  }

  return undefined;
}

function deriveSessionTitle(text: string | undefined, maxLength = SESSION_TITLE_MAX_LENGTH): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) {
    return undefined;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const shortened = normalized.slice(0, maxLength - 1);
  const wordBoundary = shortened.lastIndexOf(" ");
  const title = wordBoundary >= Math.floor(maxLength * 0.6) ? shortened.slice(0, wordBoundary) : shortened;

  return `${title.trimEnd()}…`;
}

function isVisibleOnlySlashCommandMessage(meta: unknown): boolean {
  return (
    typeof meta === "object" &&
    meta !== null &&
    "source" in meta &&
    (meta as { source?: unknown }).source === "slash_command" &&
    "visibleOnly" in meta &&
    (meta as { visibleOnly?: unknown }).visibleOnly === true
  );
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
