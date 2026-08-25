import { resolve } from "node:path";

export type SessionOverlayDrift = "clean" | "dirty_known";
export type SessionOverlayKbState = "current" | "needs_sync";

export interface FileEditEvent {
  kind: "file_edit";
  source: "agent";
  path: string;
  beforeHash: string;
  afterHash: string;
  firstChangedLine: number;
  diffSummary: string;
  timestamp: string;
}

export interface FileCreateEvent {
  kind: "file_create";
  source: "agent";
  path: string;
  afterHash: string;
  firstChangedLine: 1;
  writeSummary: string;
  timestamp: string;
}

export interface FileOverwriteEvent {
  kind: "file_overwrite";
  source: "agent";
  path: string;
  beforeHash: string;
  afterHash: string;
  firstChangedLine: 1;
  writeSummary: string;
  timestamp: string;
}

export type FileMutationEvent = FileEditEvent | FileCreateEvent | FileOverwriteEvent;

export interface DirtyFileState {
  path: string;
  source: "agent";
  drift: "dirty_known";
  kbState: "needs_sync";
  l1State: "stale";
  derivedState: "suspect";
  beforeHash?: string;
  afterHash: string;
  firstChangedLine: number;
  lastEditedAt: string;
  editCount: number;
}

export interface SessionOverlayState {
  workspaceRoot: string;
  drift: SessionOverlayDrift;
  kbState: SessionOverlayKbState;
  needsSync: boolean;
  dirtyFiles: DirtyFileState[];
  editEvents: FileEditEvent[];
  mutationEvents: FileMutationEvent[];
  updatedAt?: string;
}

interface MutableSessionOverlayState extends Omit<SessionOverlayState, "dirtyFiles" | "editEvents" | "mutationEvents"> {
  dirtyFiles: Map<string, DirtyFileState>;
  editEvents: FileEditEvent[];
  mutationEvents: FileMutationEvent[];
}

const overlays = new Map<string, MutableSessionOverlayState>();

export function recordAgentFileEdit(workspaceRoot: string, event: FileEditEvent): SessionOverlayState {
  return recordAgentFileMutation(workspaceRoot, event);
}

export function recordAgentFileCreate(workspaceRoot: string, event: FileCreateEvent): SessionOverlayState {
  return recordAgentFileMutation(workspaceRoot, event);
}

export function recordAgentFileMutation(workspaceRoot: string, event: FileMutationEvent): SessionOverlayState {
  const key = resolve(workspaceRoot);
  const overlay = getOrCreateOverlay(key);
  const previous = overlay.dirtyFiles.get(event.path);

  overlay.drift = "dirty_known";
  overlay.kbState = "needs_sync";
  overlay.needsSync = true;
  overlay.updatedAt = event.timestamp;
  overlay.mutationEvents.push(event);

  if (event.kind === "file_edit") {
    overlay.editEvents.push(event);
  }

  overlay.dirtyFiles.set(event.path, {
    path: event.path,
    source: "agent",
    drift: "dirty_known",
    kbState: "needs_sync",
    l1State: "stale",
    derivedState: "suspect",
    beforeHash: previous?.beforeHash ?? (event.kind === "file_create" ? undefined : event.beforeHash),
    afterHash: event.afterHash,
    firstChangedLine: event.firstChangedLine,
    lastEditedAt: event.timestamp,
    editCount: (previous?.editCount ?? 0) + 1,
  });

  return snapshotOverlay(overlay);
}

export function getSessionOverlayState(workspaceRoot: string): SessionOverlayState {
  return snapshotOverlay(getOrCreateOverlay(resolve(workspaceRoot)));
}

export function clearSessionOverlay(workspaceRoot: string): SessionOverlayState {
  const key = resolve(workspaceRoot);
  overlays.delete(key);

  return snapshotOverlay(getOrCreateOverlay(key));
}

export function clearSyncedSessionOverlayFile(
  workspaceRoot: string,
  path: string,
  syncedHash: string
): SessionOverlayState {
  const overlay = getOrCreateOverlay(resolve(workspaceRoot));
  const dirtyFile = overlay.dirtyFiles.get(path);
  if (!dirtyFile || dirtyFile.afterHash !== syncedHash) return snapshotOverlay(overlay);

  overlay.dirtyFiles.delete(path);
  if (overlay.dirtyFiles.size === 0) {
    overlay.drift = "clean";
    overlay.kbState = "current";
    overlay.needsSync = false;
  }
  return snapshotOverlay(overlay);
}

function getOrCreateOverlay(workspaceRoot: string): MutableSessionOverlayState {
  const existing = overlays.get(workspaceRoot);

  if (existing) {
    return existing;
  }

  const overlay: MutableSessionOverlayState = {
    workspaceRoot,
    drift: "clean",
    kbState: "current",
    needsSync: false,
    dirtyFiles: new Map(),
    editEvents: [],
    mutationEvents: [],
  };
  overlays.set(workspaceRoot, overlay);

  return overlay;
}

function snapshotOverlay(overlay: MutableSessionOverlayState): SessionOverlayState {
  return {
    workspaceRoot: overlay.workspaceRoot,
    drift: overlay.drift,
    kbState: overlay.kbState,
    needsSync: overlay.needsSync,
    dirtyFiles: [...overlay.dirtyFiles.values()].map((file) => ({ ...file })),
    editEvents: overlay.editEvents.map((event) => ({ ...event })),
    mutationEvents: overlay.mutationEvents.map((event) => ({ ...event })),
    updatedAt: overlay.updatedAt,
  };
}
