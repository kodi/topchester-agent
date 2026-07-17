import { type ConversationTurn } from "../agent/conversation.js";
import { detectTaskPlanChange, type TaskPlanChangeKind, type TaskPlanState } from "../agent/task-plan.js";
import { type KnowledgeStatus } from "../knowledge/status.js";
import { type SessionSummary } from "../session/store.js";
import { type TranscriptEntry } from "./transcript.js";

export type { TaskPlanState } from "../agent/task-plan.js";

export interface TuiEphemeralState {
  text: string;
  tone: "normal" | "muted";
}

export interface TuiSessionPickerState {
  items: SessionSummary[];
}

export interface TuiViewState {
  sessionId: string;
  sessionEpoch: number;
  workspaceLabel: string;
  transcript: readonly TranscriptEntry[];
  status: string;
  knowledgeStatus?: KnowledgeStatus;
  modelLabel: string;
  taskPlan?: TaskPlanState;
  taskPlanNotice?: string;
  startupHint?: string;
  ephemeral?: TuiEphemeralState;
  temporaryLine?: string;
  noticeLine?: string;
  queuedFollowUpCount: number;
  promptHint?: string;
  canCancel: boolean;
  managedDialog: boolean;
  sessionPicker?: TuiSessionPickerState;
}

export type TuiViewListener = (snapshot: TuiViewState) => void;

export class TuiViewStore {
  private readonly listeners = new Set<TuiViewListener>();
  private temporaryLineTimer: ReturnType<typeof setTimeout> | undefined;
  private state: TuiViewState;

  constructor(options: {
    sessionId: string;
    workspaceLabel: string;
    transcript: TranscriptEntry[];
    modelLabel: string;
    taskPlan?: TaskPlanState;
    startupHint?: string;
  }) {
    this.state = {
      sessionId: options.sessionId,
      sessionEpoch: 0,
      workspaceLabel: options.workspaceLabel,
      transcript: [...options.transcript],
      status: "ready",
      modelLabel: options.modelLabel,
      queuedFollowUpCount: 0,
      canCancel: false,
      managedDialog: false,
      ...(options.taskPlan === undefined ? {} : { taskPlan: options.taskPlan }),
      ...(options.startupHint === undefined ? {} : { startupHint: options.startupHint }),
    };
  }

  getSnapshot(): TuiViewState {
    return {
      ...this.state,
      transcript: [...this.state.transcript],
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

  addEntry(entry: TranscriptEntry): void {
    this.state = { ...this.state, transcript: [...this.state.transcript, entry] };
    this.emit();
  }

  addEntries(entries: readonly TranscriptEntry[]): void {
    if (entries.length === 0) {
      return;
    }
    this.state = { ...this.state, transcript: [...this.state.transcript, ...entries] };
    this.emit();
  }

  removeActiveChoice(): void {
    if (this.state.transcript.at(-1)?.kind !== "choice") {
      return;
    }
    this.state = { ...this.state, transcript: this.state.transcript.slice(0, -1), managedDialog: false };
    this.emit();
  }

  discardLastUserEntry(text: string): void {
    const last = this.state.transcript.at(-1);
    if (last?.kind !== "user" || last.text !== text) {
      return;
    }
    this.state = { ...this.state, transcript: this.state.transcript.slice(0, -1) };
    this.emit();
  }

  reset(options: {
    sessionId: string;
    transcript: TranscriptEntry[];
    modelLabel: string;
    taskPlan?: TaskPlanState;
    status?: string;
    startupHint?: string;
  }): void {
    this.clearTemporaryLineTimer();
    this.state = {
      sessionId: options.sessionId,
      sessionEpoch: this.state.sessionEpoch + 1,
      workspaceLabel: this.state.workspaceLabel,
      transcript: [...options.transcript],
      status: options.status ?? "ready",
      modelLabel: options.modelLabel,
      queuedFollowUpCount: 0,
      canCancel: false,
      managedDialog: false,
      ...(options.taskPlan === undefined ? {} : { taskPlan: options.taskPlan }),
      ...(options.startupHint === undefined ? {} : { startupHint: options.startupHint }),
    };
    this.emit();
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

  setTemporaryLine(temporaryLine: string | undefined, expireAfterMs?: number): void {
    this.clearTemporaryLineTimer();
    this.patch({ temporaryLine });
    if (temporaryLine && expireAfterMs && expireAfterMs > 0) {
      this.temporaryLineTimer = setTimeout(() => {
        this.temporaryLineTimer = undefined;
        if (this.state.temporaryLine === temporaryLine) {
          this.patch({ temporaryLine: undefined });
        }
      }, expireAfterMs);
      this.temporaryLineTimer.unref?.();
    }
  }

  setNoticeLine(noticeLine: string | undefined): void {
    this.patch({ noticeLine });
  }

  setQueuedFollowUpCount(queuedFollowUpCount: number): void {
    this.patch({ queuedFollowUpCount: Math.max(0, queuedFollowUpCount) });
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

  dispose(): void {
    this.clearTemporaryLineTimer();
    this.listeners.clear();
  }

  private patch(patch: Partial<TuiViewState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private clearTemporaryLineTimer(): void {
    if (this.temporaryLineTimer) {
      clearTimeout(this.temporaryLineTimer);
      this.temporaryLineTimer = undefined;
    }
  }
}
