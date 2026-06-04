import { mkdir, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { uuidv7 } from "uuidv7";
import { ZodError } from "zod";
import { getTopchesterSessionsPath } from "../app/paths.js";
import { type HookEventName } from "../config/index.js";
import { type TaskPlanState } from "../agent/task-plan.js";
import { type ToolCall } from "../agent/tools.js";
import { hookStatusMessage, toolCallMessage, type ChatMessage } from "../tui/messages.js";
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

export interface SessionHandle {
  sessionId: string;
  sessionDir: string;
  metadataPath: string;
  eventsPath: string;
  metadata: SessionMetadata;
  append(payload: SessionEventPayload): Promise<SessionEvent>;
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

export interface RehydratedSession {
  messages: ChatMessage[];
  status?: string;
  taskPlan?: TaskPlanState;
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

export async function createSession(workspaceRoot: string): Promise<SessionHandle> {
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

  return buildHandle(sessionDir, metadata);
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
      ...(options.title === undefined ? {} : { title: options.title }),
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
  const messages: ChatMessage[] = [];
  let status: string | undefined;
  let taskPlan: TaskPlanState | undefined;
  let visibleOnlyActionValues = new Set<string>();

  for (const event of events) {
    switch (event.kind) {
      case "message":
        if (event.role === "assistant" && event.text === "ready" && event.meta === undefined) {
          break;
        }
        messages.push({
          kind: event.role === "assistant" ? "agent" : event.role,
          text: event.text,
          ...(typeof event.meta === "string" ? { meta: event.meta } : {}),
          ...(isVisibleOnlyMessage(event.meta) || visibleOnlyActionValues.has(event.text)
            ? { modelContext: false }
            : {}),
        });
        if (event.role === "user") {
          visibleOnlyActionValues = new Set();
        }
        break;
      case "tool_call":
        messages.push(toolCallMessage(event.call as unknown as ToolCall, event.label, undefined, event.diff));
        break;
      case "hook_status":
        messages.push(hookStatusMessage(event.label, event.eventName as HookEventName, event.statusMessage));
        break;
      case "task_plan":
        taskPlan = {
          items: event.items,
          updatedAt: event.updatedAt,
        };
        break;
      case "knowledge_status":
        break;
      case "subagent_started":
      case "subagent_event":
      case "subagent_completed":
      case "subagent_failed":
        break;
      case "choice":
        messages.push({
          kind: "modal",
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

  return { messages, status, ...(taskPlan === undefined ? {} : { taskPlan }) };
}

function buildHandle(sessionDir: string, metadata: SessionMetadata): SessionHandle {
  let appendQueue: Promise<void> = Promise.resolve();
  const handle: SessionHandle = {
    sessionId: metadata.sessionId,
    sessionDir,
    metadataPath: join(sessionDir, "metadata.json"),
    eventsPath: join(sessionDir, "events.jsonl"),
    metadata,
    append(payload) {
      const appendOperation = appendQueue.then(async () => {
        const previousEventFileSize = (await stat(handle.eventsPath)).size;
        const nextEvent = sessionEventSchema.parse({
          version: SESSION_EVENT_VERSION,
          id: handle.metadata.lastEventId + 1,
          ts: new Date().toISOString(),
          ...payload,
        });
        const nextMetadata = {
          ...handle.metadata,
          updatedAt: nextEvent.ts,
          lastEventId: nextEvent.id,
        };
        await writeFile(handle.eventsPath, `${JSON.stringify(nextEvent)}\n`, { flag: "a" });
        try {
          await writeMetadata(handle.metadataPath, nextMetadata);
        } catch (error) {
          await truncate(handle.eventsPath, previousEventFileSize);
          throw error;
        }
        handle.metadata = nextMetadata;

        return nextEvent;
      });

      appendQueue = appendOperation.then(
        () => undefined,
        () => undefined
      );

      return appendOperation;
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

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
