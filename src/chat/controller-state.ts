import { type ConversationTurn } from "../agent/conversation.js";
import { detectTaskPlanChange, type TaskPlanChangeKind, type TaskPlanState } from "../agent/task-plan.js";
import { type KnowledgeStatus } from "../knowledge/status.js";
import { type SessionSummary } from "../session/store.js";
import { type TranscriptEntry } from "./transcript.js";
import { type ContextStatus } from "../agent/context/types.js";
import { isRetainedRuntimeContextTurn } from "../agent/context/projection.js";

export type { TaskPlanState } from "../agent/task-plan.js";

export interface TuiEphemeralState {
  text: string;
  tone: "normal" | "muted";
}

export interface TuiSessionPickerState {
  items: SessionSummary[];
}

export interface TuiTranscriptRecord {
  readonly sessionEpoch: number;
  readonly id: number;
  readonly entry: TranscriptEntry;
}

export type TuiTranscriptChange =
  | { readonly kind: "none"; readonly sessionEpoch: number }
  | { readonly kind: "append"; readonly sessionEpoch: number; readonly records: readonly TuiTranscriptRecord[] }
  | { readonly kind: "remove"; readonly sessionEpoch: number; readonly recordIds: readonly number[] }
  | { readonly kind: "reset"; readonly sessionEpoch: number; readonly records: readonly TuiTranscriptRecord[] };

export interface TuiViewState {
  sessionId: string;
  sessionEpoch: number;
  clearTerminalEpoch?: number;
  workspaceLabel: string;
  transcript: readonly TranscriptEntry[];
  transcriptRecords: readonly TuiTranscriptRecord[];
  transcriptChange: TuiTranscriptChange;
  status: string;
  knowledgeStatus?: KnowledgeStatus;
  modelLabel: string;
  contextStatus?: ContextStatus;
  taskPlan?: TaskPlanState;
  taskPlanNotice?: string;
  startupHint?: string;
  ephemeral?: TuiEphemeralState;
  temporaryLine?: string;
  noticeLine?: string;
  queuedFollowUpCount: number;
  queuedFollowUpPreview?: string;
  promptHint?: string;
  canCancel: boolean;
  managedDialog: boolean;
  sessionPicker?: TuiSessionPickerState;
}

export type TuiViewListener = (snapshot: TuiViewState) => void;

/** Optional, test-only measurement seam. Normal TUI sessions do not allocate it. */
export interface TuiViewProfile {
  viewPublications: number;
  transcriptRecordsInspected: number;
  /** Transient updates replaced before their scheduled publication. */
  coalescedUpdates?: number;
}

/** Framework-neutral scheduling seam for display-only view updates. */
export interface TuiTransientScheduler {
  schedule(callback: () => void): void;
  cancel(): void;
  dispose(): void;
}

export function createTransientScheduler(frameMs = 1000 / 30): TuiTransientScheduler {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let callback: (() => void) | undefined;
  let disposed = false;
  return {
    schedule(next) {
      if (disposed) return;
      callback = next;
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        const pending = callback;
        callback = undefined;
        pending?.();
      }, frameMs);
      timer.unref?.();
    },
    cancel() {
      callback = undefined;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    dispose() {
      disposed = true;
      this.cancel();
    },
  };
}

export class TuiViewStore {
  private readonly listeners = new Set<TuiViewListener>();
  private temporaryLineTimer: ReturnType<typeof setTimeout> | undefined;
  private state: TuiViewState;
  private nextTranscriptRecordId = 0;
  private batchDepth = 0;
  private batchChanged = false;
  private batchTranscriptChange: TuiTranscriptChange | undefined;
  private batchTemporaryLineUpdate: { temporaryLine: string | undefined; expireAfterMs?: number } | undefined;
  private transientPending = false;
  private readonly transientScheduler: TuiTransientScheduler;
  private disposed = false;
  private modelContextTurns: ConversationTurn[] | undefined;

  constructor(options: {
    sessionId: string;
    workspaceLabel: string;
    transcript: TranscriptEntry[];
    modelLabel: string;
    taskPlan?: TaskPlanState;
    startupHint?: string;
    modelContextTurns?: ConversationTurn[];
    contextStatus?: ContextStatus;
    profile?: TuiViewProfile;
    transientScheduler?: TuiTransientScheduler;
  }) {
    this.profile = options.profile;
    this.modelContextTurns = options.modelContextTurns ? [...options.modelContextTurns] : undefined;
    this.transientScheduler = options.transientScheduler ?? createTransientScheduler();
    const transcript = [...options.transcript];
    const transcriptRecords = this.createTranscriptRecords(transcript, 0);
    this.state = {
      sessionId: options.sessionId,
      sessionEpoch: 0,
      workspaceLabel: options.workspaceLabel,
      transcript,
      transcriptRecords,
      transcriptChange: { kind: "reset", sessionEpoch: 0, records: transcriptRecords },
      status: "ready",
      modelLabel: options.modelLabel,
      queuedFollowUpCount: 0,
      canCancel: false,
      managedDialog: false,
      ...(options.taskPlan === undefined ? {} : { taskPlan: options.taskPlan }),
      ...(options.startupHint === undefined ? {} : { startupHint: options.startupHint }),
      ...(options.contextStatus === undefined ? {} : { contextStatus: options.contextStatus }),
    };
  }

  getSnapshot(): TuiViewState {
    return {
      ...this.state,
      ...(this.state.taskPlan === undefined
        ? {}
        : { taskPlan: { ...this.state.taskPlan, items: [...this.state.taskPlan.items] } }),
      ...(this.state.sessionPicker === undefined
        ? {}
        : { sessionPicker: { items: [...this.state.sessionPicker.items] } }),
    };
  }

  subscribe(listener: TuiViewListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Applies synchronous view mutations atomically and emits at most once. */
  batch<T>(reducer: () => T): T {
    const checkpoint = { state: this.state, nextTranscriptRecordId: this.nextTranscriptRecordId };
    const checkpointChanged = this.batchChanged;
    const checkpointTranscriptChange = this.batchTranscriptChange;
    const checkpointTemporaryLineUpdate = this.batchTemporaryLineUpdate;
    const outermost = this.batchDepth === 0;
    if (outermost) {
      this.batchChanged = false;
      this.batchTranscriptChange = { kind: "none", sessionEpoch: this.state.sessionEpoch };
      this.batchTemporaryLineUpdate = undefined;
    }
    this.batchDepth += 1;
    try {
      const result = reducer();
      this.batchDepth -= 1;
      if (outermost) {
        const changed = this.batchChanged;
        const temporaryLineUpdate = this.batchTemporaryLineUpdate;
        this.batchChanged = false;
        this.batchTranscriptChange = undefined;
        this.batchTemporaryLineUpdate = undefined;
        if (temporaryLineUpdate)
          this.scheduleTemporaryLine(temporaryLineUpdate.temporaryLine, temporaryLineUpdate.expireAfterMs);
        if (changed) this.emit();
      }
      return result;
    } catch (error) {
      this.state = checkpoint.state;
      this.nextTranscriptRecordId = checkpoint.nextTranscriptRecordId;
      this.batchChanged = checkpointChanged;
      this.batchTranscriptChange = checkpointTranscriptChange;
      this.batchTemporaryLineUpdate = checkpointTemporaryLineUpdate;
      this.batchDepth -= 1;
      if (outermost) {
        this.batchChanged = false;
        this.batchTranscriptChange = undefined;
        this.batchTemporaryLineUpdate = undefined;
      }
      throw error;
    }
  }

  addEntry(entry: TranscriptEntry): void {
    const record = this.createTranscriptRecord(entry, this.state.sessionEpoch);
    this.replaceState({
      ...this.state,
      transcript: [...this.state.transcript, entry],
      transcriptRecords: [...this.state.transcriptRecords, record],
      transcriptChange: { kind: "append", sessionEpoch: this.state.sessionEpoch, records: [record] },
    });
    this.appendModelContextEntry(entry);
  }

  addEntries(entries: readonly TranscriptEntry[]): void {
    if (entries.length === 0) {
      return;
    }
    const records = this.createTranscriptRecords(entries, this.state.sessionEpoch);
    this.replaceState({
      ...this.state,
      transcript: [...this.state.transcript, ...entries],
      transcriptRecords: [...this.state.transcriptRecords, ...records],
      transcriptChange: { kind: "append", sessionEpoch: this.state.sessionEpoch, records },
    });
    for (const entry of entries) this.appendModelContextEntry(entry);
  }

  removeActiveChoice(): void {
    if (this.state.transcript.at(-1)?.kind !== "choice") {
      return;
    }
    this.removeLastTranscriptRecord({ managedDialog: false });
  }

  discardLastUserEntry(text: string): void {
    const last = this.state.transcript.at(-1);
    if (last?.kind !== "user" || last.text !== text) {
      return;
    }
    this.removeLastTranscriptRecord();
  }

  reset(options: {
    sessionId: string;
    transcript: TranscriptEntry[];
    modelLabel: string;
    taskPlan?: TaskPlanState;
    status?: string;
    startupHint?: string;
    clearTerminal?: boolean;
    modelContextTurns?: ConversationTurn[];
    contextStatus?: ContextStatus;
  }): void {
    if (this.batchDepth > 0) this.batchTemporaryLineUpdate = { temporaryLine: undefined };
    else this.clearTemporaryLineTimer();
    const sessionEpoch = this.state.sessionEpoch + 1;
    this.nextTranscriptRecordId = 0;
    this.modelContextTurns = options.modelContextTurns ? [...options.modelContextTurns] : undefined;
    const transcript = [...options.transcript];
    const transcriptRecords = this.createTranscriptRecords(transcript, sessionEpoch);
    this.replaceState({
      sessionId: options.sessionId,
      sessionEpoch,
      ...(options.clearTerminal ? { clearTerminalEpoch: sessionEpoch } : {}),
      workspaceLabel: this.state.workspaceLabel,
      transcript,
      transcriptRecords,
      transcriptChange: { kind: "reset", sessionEpoch, records: transcriptRecords },
      status: options.status ?? "ready",
      modelLabel: options.modelLabel,
      queuedFollowUpCount: 0,
      canCancel: false,
      managedDialog: false,
      ...(options.taskPlan === undefined ? {} : { taskPlan: options.taskPlan }),
      ...(options.startupHint === undefined ? {} : { startupHint: options.startupHint }),
      ...(options.contextStatus === undefined ? {} : { contextStatus: options.contextStatus }),
    });
  }

  setStatus(status: string): void {
    this.patch({ status });
  }

  isReady(): boolean {
    return this.state.status === "ready";
  }

  setKnowledgeStatus(knowledgeStatus: KnowledgeStatus | undefined): void {
    this.patch({ knowledgeStatus });
  }

  setModelLabel(modelLabel: string): void {
    this.patch({ modelLabel });
  }

  setContextStatus(contextStatus: ContextStatus | undefined): void {
    this.patch({ contextStatus });
  }

  setModelContextTurns(turns: readonly ConversationTurn[] | undefined): void {
    this.modelContextTurns = turns ? [...turns] : undefined;
  }

  setTaskPlan(taskPlan: TaskPlanState | undefined): TaskPlanChangeKind {
    const change = detectTaskPlanChange(this.state.taskPlan, taskPlan);
    this.patch({ taskPlan: taskPlan && taskPlan.items.length > 0 ? taskPlan : undefined });
    return change;
  }

  clearTaskPlan(now: Date = new Date()): TaskPlanState | undefined {
    if (!this.state.taskPlan) {
      return undefined;
    }
    const cleared = { items: [], updatedAt: now.toISOString() } satisfies TaskPlanState;
    this.patch({ taskPlan: undefined, taskPlanNotice: undefined });
    return cleared;
  }

  setTaskPlanNotice(taskPlanNotice: string | undefined): void {
    this.patch({ taskPlanNotice });
  }

  setStartupHint(startupHint: string | undefined): void {
    this.patch({ startupHint });
  }

  setEphemeral(ephemeral: TuiEphemeralState | undefined): void {
    this.patch({ ephemeral });
  }

  setTransientEphemeral(ephemeral: TuiEphemeralState | undefined): void {
    this.scheduleTransient(() => {
      if (this.disposed) return;
      this.state = {
        ...this.state,
        ephemeral,
        transcriptChange: { kind: "none", sessionEpoch: this.state.sessionEpoch },
      };
      this.publish();
    });
  }

  setTemporaryLine(temporaryLine: string | undefined, expireAfterMs?: number): void {
    this.patch({ temporaryLine });
    if (this.batchDepth > 0) this.batchTemporaryLineUpdate = { temporaryLine, expireAfterMs };
    else this.scheduleTemporaryLine(temporaryLine, expireAfterMs);
  }

  setTransientTemporaryLine(temporaryLine: string | undefined, expireAfterMs?: number): void {
    this.scheduleTransient(() => {
      if (!this.disposed) this.setTemporaryLine(temporaryLine, expireAfterMs);
    });
  }

  setNoticeLine(noticeLine: string | undefined): void {
    this.patch({ noticeLine });
  }

  setQueuedFollowUps(queuedFollowUpCount: number, queuedFollowUpPreview?: string): void {
    const count = Math.max(0, queuedFollowUpCount);
    this.patch({
      queuedFollowUpCount: count,
      queuedFollowUpPreview: count > 0 ? queuedFollowUpPreview : undefined,
    });
  }

  setPromptHint(promptHint: string | undefined): void {
    this.patch({ promptHint });
  }

  setCanCancel(canCancel: boolean): void {
    this.patch({ canCancel });
  }

  setManagedDialog(managedDialog: boolean): void {
    this.patch({ managedDialog });
  }

  openSessionPicker(items: SessionSummary[]): void {
    this.patch({ sessionPicker: { items } });
  }

  closeSessionPicker(): void {
    this.patch({ sessionPicker: undefined });
  }

  getConversationTurns(): ConversationTurn[] {
    if (this.modelContextTurns) return [...this.modelContextTurns];
    return this.state.transcript.flatMap((entry): ConversationTurn[] => {
      if (entry.kind === "user") {
        return entry.modelContext === false ? [] : [{ role: "user", text: entry.text }];
      }
      if (entry.kind === "assistant") {
        return entry.text === "ready" || entry.modelContext === false ? [] : [{ role: "assistant", text: entry.text }];
      }
      return [];
    });
  }

  private appendModelContextEntry(entry: TranscriptEntry): void {
    if (!this.modelContextTurns) return;
    if (entry.kind === "user" && entry.modelContext !== false) {
      this.modelContextTurns.push({ role: "user", text: entry.text });
    } else if (entry.kind === "assistant" && entry.text !== "ready" && entry.modelContext !== false) {
      if (this.modelContextTurns.some(isRetainedRuntimeContextTurn)) {
        this.modelContextTurns = this.modelContextTurns.filter((turn) => !isRetainedRuntimeContextTurn(turn));
      }
      this.modelContextTurns.push({ role: "assistant", text: entry.text });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearTemporaryLineTimer();
    this.transientScheduler.dispose();
    this.listeners.clear();
  }

  private patch(patch: Partial<TuiViewState>): void {
    this.cancelTransient();
    this.replaceState({
      ...this.state,
      ...patch,
      transcriptChange: { kind: "none", sessionEpoch: this.state.sessionEpoch },
    });
  }

  private replaceState(next: TuiViewState): void {
    this.cancelTransient();
    if (this.batchDepth > 0) {
      this.batchTranscriptChange = mergeTranscriptChanges(
        this.batchTranscriptChange ?? { kind: "none", sessionEpoch: this.state.sessionEpoch },
        next.transcriptChange
      );
      this.state = { ...next, transcriptChange: this.batchTranscriptChange };
    } else {
      this.state = next;
    }
    this.publish();
  }

  private publish(): void {
    if (this.disposed) return;
    if (this.batchDepth > 0) {
      this.batchChanged = true;
      return;
    }
    this.emit();
  }

  private cancelTransient(): void {
    this.transientPending = false;
    this.transientScheduler.cancel();
  }

  private scheduleTransient(callback: () => void): void {
    if (this.transientPending && this.profile) this.profile.coalescedUpdates = (this.profile.coalescedUpdates ?? 0) + 1;
    this.transientPending = true;
    this.transientScheduler.schedule(() => {
      this.transientPending = false;
      callback();
    });
  }

  private emit(): void {
    if (this.profile) this.profile.viewPublications += 1;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private readonly profile: TuiViewProfile | undefined;

  private createTranscriptRecord(entry: TranscriptEntry, sessionEpoch: number): TuiTranscriptRecord {
    return { sessionEpoch, id: this.nextTranscriptRecordId++, entry };
  }

  private createTranscriptRecords(
    entries: readonly TranscriptEntry[],
    sessionEpoch: number
  ): readonly TuiTranscriptRecord[] {
    return entries.map((entry) => this.createTranscriptRecord(entry, sessionEpoch));
  }

  private removeLastTranscriptRecord(patch: Partial<TuiViewState> = {}): void {
    const removed = this.state.transcriptRecords.at(-1);
    if (!removed) {
      return;
    }
    this.replaceState({
      ...this.state,
      ...patch,
      transcript: this.state.transcript.slice(0, -1),
      transcriptRecords: this.state.transcriptRecords.slice(0, -1),
      transcriptChange: {
        kind: "remove",
        sessionEpoch: this.state.sessionEpoch,
        recordIds: [removed.id],
      },
    });
  }

  private clearTemporaryLineTimer(): void {
    if (this.temporaryLineTimer) {
      clearTimeout(this.temporaryLineTimer);
      this.temporaryLineTimer = undefined;
    }
  }

  private scheduleTemporaryLine(temporaryLine: string | undefined, expireAfterMs?: number): void {
    this.clearTemporaryLineTimer();
    if (!temporaryLine || !expireAfterMs || expireAfterMs <= 0) return;
    this.temporaryLineTimer = setTimeout(() => {
      this.temporaryLineTimer = undefined;
      if (this.state.temporaryLine === temporaryLine) this.patch({ temporaryLine: undefined });
    }, expireAfterMs);
    this.temporaryLineTimer.unref?.();
  }
}

function mergeTranscriptChanges(previous: TuiTranscriptChange, next: TuiTranscriptChange): TuiTranscriptChange {
  if (next.kind === "reset") return next;
  if (previous.kind === "reset") {
    if (next.kind === "append" && previous.sessionEpoch === next.sessionEpoch) {
      return { kind: "reset", sessionEpoch: previous.sessionEpoch, records: [...previous.records, ...next.records] };
    }
    if (next.kind === "remove" && previous.sessionEpoch === next.sessionEpoch) {
      const removed = new Set(next.recordIds);
      return {
        kind: "reset",
        sessionEpoch: previous.sessionEpoch,
        records: previous.records.filter((record) => !removed.has(record.id)),
      };
    }
    return previous;
  }
  if (previous.kind === "append" && next.kind === "append" && previous.sessionEpoch === next.sessionEpoch) {
    return { kind: "append", sessionEpoch: next.sessionEpoch, records: [...previous.records, ...next.records] };
  }
  if (previous.kind === "append" && next.kind === "remove" && previous.sessionEpoch === next.sessionEpoch) {
    const removed = new Set(next.recordIds);
    const records = previous.records.filter((record) => !removed.has(record.id));
    return records.length > 0
      ? { kind: "append", sessionEpoch: previous.sessionEpoch, records }
      : { kind: "none", sessionEpoch: next.sessionEpoch };
  }
  return next.kind === "none" ? previous : next;
}
