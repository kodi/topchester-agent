import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getTopchesterSessionsPath } from "../app/paths.js";
import {
  SESSION_EVENT_VERSION,
  SESSION_METADATA_VERSION,
  sessionEventSchema,
  sessionMetadataSchema,
  type SessionEvent,
  type SessionEventPayload,
  type SessionMetadata,
} from "./events.js";

const UUIDV7_MAX_SEQUENCE = 0xfff;
let lastTimestamp = 0;
let sequence = 0;

export interface SessionHandle {
  sessionId: string;
  sessionDir: string;
  metadataPath: string;
  eventsPath: string;
  metadata: SessionMetadata;
  append(payload: SessionEventPayload): Promise<SessionEvent>;
}

export function generateSessionId(now = Date.now()): string {
  if (now > lastTimestamp) {
    lastTimestamp = now;
    sequence = 0;
  } else {
    sequence = (sequence + 1) & UUIDV7_MAX_SEQUENCE;
    if (sequence === 0) {
      lastTimestamp += 1;
    }
  }

  const timestamp = BigInt(lastTimestamp) & 0xffffffffffffn;
  const random = randomBytes(8);
  const bytes = new Uint8Array(16);
  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);
  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
  bytes[7] = sequence & 0xff;
  bytes[8] = 0x80 | (random[0] & 0x3f);
  bytes.set(random.subarray(1), 9);

  return toUuid(bytes);
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

export async function loadSessionForAppend(workspaceRoot: string, sessionId: string): Promise<SessionHandle> {
  const sessionDir = join(getTopchesterSessionsPath(workspaceRoot), sessionId);
  const metadataPath = join(sessionDir, "metadata.json");
  const metadata = sessionMetadataSchema.parse(JSON.parse(await readFile(metadataPath, "utf8")));

  return buildHandle(sessionDir, metadata);
}

function buildHandle(sessionDir: string, metadata: SessionMetadata): SessionHandle {
  const handle: SessionHandle = {
    sessionId: metadata.sessionId,
    sessionDir,
    metadataPath: join(sessionDir, "metadata.json"),
    eventsPath: join(sessionDir, "events.jsonl"),
    metadata,
    async append(payload) {
      const nextEvent = sessionEventSchema.parse({
        version: SESSION_EVENT_VERSION,
        id: handle.metadata.lastEventId + 1,
        ts: new Date().toISOString(),
        ...payload,
      });
      await writeFile(handle.eventsPath, `${JSON.stringify(nextEvent)}\n`, { flag: "a" });
      handle.metadata = {
        ...handle.metadata,
        updatedAt: nextEvent.ts,
        lastEventId: nextEvent.id,
      };
      await writeMetadata(handle.metadataPath, handle.metadata);

      return nextEvent;
    },
  };

  return handle;
}

async function writeMetadata(path: string, metadata: SessionMetadata): Promise<void> {
  await writeFile(path, `${JSON.stringify(sessionMetadataSchema.parse(metadata), null, 2)}\n`);
}

function toUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
