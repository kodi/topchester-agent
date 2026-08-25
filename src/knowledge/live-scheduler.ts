import { type Logger } from "pino";
import { type TopchesterConfig } from "../config/index.js";
import { syncL1File, type SyncL1FileResult } from "./compiler/index.js";
import { type L1SummaryModel } from "./compiler/l1-processor.js";
import { getKnowledgeStatus } from "./status.js";

export type LiveL1TouchReason = "read" | "create" | "edit" | "overwrite";

export interface LiveL1TouchEvent {
  path: string;
  hash: string;
  reason: LiveL1TouchReason;
}

export interface LiveL1SchedulerSnapshot {
  enabled: boolean;
  queued: number;
  syncing: boolean;
  syncingPath?: string;
  lastError?: string;
}

export interface LiveL1SchedulerOptions {
  workspaceRoot: string;
  getConfig(): TopchesterConfig;
  getModel(): L1SummaryModel | undefined;
  logger?: Logger;
  debounceMs?: number;
  onSynced?: (event: LiveL1TouchEvent, result: SyncL1FileResult) => void;
}

interface PendingJob extends LiveL1TouchEvent {
  timer: ReturnType<typeof setTimeout>;
}

export class LiveL1Scheduler {
  private readonly debounceMs: number;
  private readonly pending = new Map<string, PendingJob>();
  private readonly ready = new Map<string, LiveL1TouchEvent>();
  private readonly readyOrder: string[] = [];
  private readonly lastSyncedHash = new Map<string, string>();
  private readonly listeners = new Set<(snapshot: LiveL1SchedulerSnapshot) => void>();
  private started = false;
  private processing = false;
  private syncingPath: string | undefined;
  private lastError: string | undefined;

  constructor(private readonly options: LiveL1SchedulerOptions) {
    this.debounceMs = options.debounceMs ?? 400;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.emit();
  }

  stop(): void {
    if (!this.started && this.pending.size === 0 && this.ready.size === 0) return;
    this.started = false;
    for (const job of this.pending.values()) clearTimeout(job.timer);
    this.pending.clear();
    this.ready.clear();
    this.readyOrder.length = 0;
    this.emit();
  }

  enqueue(event: LiveL1TouchEvent): boolean {
    if (!this.started || !this.options.getConfig().knowledge?.live) return false;
    const status = getKnowledgeStatus(this.options.workspaceRoot);
    if (!status.kbExists || !status.kbIsDirectory) return false;
    if (this.lastSyncedHash.get(event.path) === event.hash) return false;

    const existing = this.pending.get(event.path);
    if (existing?.hash === event.hash) return false;
    if (existing) clearTimeout(existing.timer);
    if (this.ready.get(event.path)?.hash === event.hash) return false;

    const timer = setTimeout(() => this.makeReady(event), this.debounceMs);
    timer.unref?.();
    this.pending.set(event.path, { ...event, timer });
    this.emit();
    return true;
  }

  snapshot(): LiveL1SchedulerSnapshot {
    return {
      enabled: this.started,
      queued: this.pending.size + this.ready.size,
      syncing: this.processing,
      ...(this.syncingPath ? { syncingPath: this.syncingPath } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  subscribe(listener: (snapshot: LiveL1SchedulerSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  async waitForIdle(): Promise<void> {
    while (this.pending.size > 0 || this.ready.size > 0 || this.processing) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }

  private makeReady(event: LiveL1TouchEvent): void {
    const pending = this.pending.get(event.path);
    if (!pending || pending.hash !== event.hash) return;
    this.pending.delete(event.path);
    if (!this.ready.has(event.path)) this.readyOrder.push(event.path);
    this.ready.set(event.path, event);
    this.emit();
    void this.processReady();
  }

  private async processReady(): Promise<void> {
    if (this.processing || !this.started) return;
    this.processing = true;
    try {
      while (this.started) {
        const path = this.readyOrder.shift();
        if (!path) break;
        const event = this.ready.get(path);
        this.ready.delete(path);
        if (!event || this.lastSyncedHash.get(path) === event.hash) continue;

        this.syncingPath = path;
        this.emit();
        try {
          const result = await syncL1File(this.options.workspaceRoot, {
            path,
            expectedHash: event.hash,
            config: this.options.getConfig(),
            model: this.options.getModel(),
          });
          this.lastError = undefined;
          if (result.status === "completed" || result.status === "skipped_current") {
            this.lastSyncedHash.set(path, event.hash);
            this.options.onSynced?.(event, result);
          } else if (result.status === "changed" && result.hash && result.hash !== event.hash) {
            this.enqueue({ ...event, hash: result.hash });
          }
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : String(error);
          this.options.logger?.debug(
            { event: "live_l1_sync_failed", path, error: this.lastError },
            "live L1 sync failed"
          );
        } finally {
          this.syncingPath = undefined;
          this.emit();
        }
      }
    } finally {
      this.processing = false;
      this.syncingPath = undefined;
      this.emit();
    }
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
