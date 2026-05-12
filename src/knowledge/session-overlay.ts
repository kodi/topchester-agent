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

export interface DirtyFileState {
  path: string;
  source: "agent";
  drift: "dirty_known";
  kbState: "needs_sync";
  l1State: "stale";
  derivedState: "suspect";
  beforeHash: string;
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
  updatedAt?: string;
}

interface MutableSessionOverlayState extends Omit<SessionOverlayState, "dirtyFiles" | "editEvents"> {
  dirtyFiles: Map<string, DirtyFileState>;
  editEvents: FileEditEvent[];
}

const overlays = new Map<string, MutableSessionOverlayState>();

export function recordAgentFileEdit(workspaceRoot: string, event: FileEditEvent): SessionOverlayState {
  const key = resolve(workspaceRoot);
  const overlay = getOrCreateOverlay(key);
  const previous = overlay.dirtyFiles.get(event.path);

  overlay.drift = "dirty_known";
  overlay.kbState = "needs_sync";
  overlay.needsSync = true;
  overlay.updatedAt = event.timestamp;
  overlay.editEvents.push(event);
  overlay.dirtyFiles.set(event.path, {
    path: event.path,
    source: "agent",
    drift: "dirty_known",
    kbState: "needs_sync",
    l1State: "stale",
    derivedState: "suspect",
    beforeHash: previous?.beforeHash ?? event.beforeHash,
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
    updatedAt: overlay.updatedAt,
  };
}
