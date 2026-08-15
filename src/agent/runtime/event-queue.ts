import { type AgentRuntimeEvent } from "../events.js";

export interface RuntimeEventQueueProfile {
  runtimeEvents: number;
  maximumQueueDepth: number;
  runtimeBatches?: number;
  maximumBatchSize?: number;
  hostYields?: number;
}

export interface RuntimeEventQueue {
  /** Returns a promise only when the bounded queue applies producer backpressure. */
  push(event: AgentRuntimeEvent): void | Promise<void>;
  close(error?: unknown): void;
  abort(error?: unknown): void;
  waitForEvents(): Promise<void>;
  drainReady(options?: RuntimeEventDrainOptions): { events: AgentRuntimeEvent[]; hasMore: boolean };
  drain(options?: RuntimeEventDrainOptions): Promise<AgentRuntimeEvent[]>;
  [Symbol.asyncIterator](): AsyncIterator<AgentRuntimeEvent>;
}

export interface RuntimeEventDrainOptions {
  maxEvents?: number;
  maxElapsedMs?: number;
  now?: () => number;
  yieldHost?: () => Promise<void>;
  /** Runs synchronously inside the bounded slice so elapsed time includes reduction work. */
  consume?: (event: AgentRuntimeEvent) => void;
}

/** Bounded O(1) FIFO queue. A producer receives a promise only after saturation. */
export function createRuntimeEventQueue(
  profile?: RuntimeEventQueueProfile,
  options: { capacity?: number } = {}
): RuntimeEventQueue {
  const capacity = options.capacity ?? 128;
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Runtime event queue capacity must be positive");
  const buffer: AgentRuntimeEvent[] = [];
  const waiters: Array<{ event: AgentRuntimeEvent; resolve: () => void; reject: (error: unknown) => void }> = [];
  let head = 0;
  let closed = false;
  let failure: unknown;
  let notify: (() => void) | undefined;
  const size = () => buffer.length - head;
  const updateDepth = () => {
    if (profile) profile.maximumQueueDepth = Math.max(profile.maximumQueueDepth, size());
  };
  const admit = () => {
    while (size() < capacity && waiters.length > 0 && !closed) {
      const waiter = waiters.shift()!;
      buffer.push(waiter.event);
      if (profile) profile.runtimeEvents += 1;
      updateDepth();
      waiter.resolve();
    }
    notify?.();
    notify = undefined;
  };
  const take = () => {
    const event = buffer[head++];
    if (head > 64 && head * 2 >= buffer.length) {
      buffer.splice(0, head);
      head = 0;
    }
    admit();
    return event;
  };
  const waitForWork = async () => {
    if (size() > 0 || closed) return;
    await new Promise<void>((resolve) => {
      notify = resolve;
    });
  };
  const closeQueue = (error?: unknown) => {
    if (closed) return;
    closed = true;
    failure = error;
    for (const waiter of waiters.splice(0)) waiter.reject(error ?? new Error("Runtime event queue is closed"));
    notify?.();
    notify = undefined;
  };
  return {
    push(event) {
      if (closed) throw failure ?? new Error("Runtime event queue is closed");
      if (size() < capacity) {
        buffer.push(event);
        if (profile) profile.runtimeEvents += 1;
        updateDepth();
        notify?.();
        notify = undefined;
        return;
      }
      return new Promise<void>((resolve, reject) => waiters.push({ event, resolve, reject }));
    },
    close(error) {
      closeQueue(error);
    },
    abort(error = new Error("Runtime event queue aborted")) {
      buffer.length = 0;
      head = 0;
      closeQueue(error);
    },
    async waitForEvents() {
      if (size() === 0 && !closed) await waitForWork();
      if (size() === 0 && failure !== undefined) throw failure;
    },
    drainReady(options = {}) {
      const maxEvents = options.maxEvents ?? capacity;
      const maxElapsedMs = options.maxElapsedMs ?? Number.POSITIVE_INFINITY;
      if (!Number.isInteger(maxEvents) || maxEvents < 1)
        throw new Error("Runtime event drain maxEvents must be positive");
      if (maxElapsedMs < 0 || Number.isNaN(maxElapsedMs))
        throw new Error("Runtime event drain maxElapsedMs must be non-negative");
      const now = options.now ?? performance.now.bind(performance);
      const started = now();
      const events: AgentRuntimeEvent[] = [];
      while (size() > 0 && events.length < maxEvents) {
        const event = take()!;
        events.push(event);
        options.consume?.(event);
        // Always make one event of progress, even when the caller's deadline has already elapsed.
        if (now() - started >= maxElapsedMs) break;
      }
      if (profile && events.length > 0) {
        profile.runtimeBatches = (profile.runtimeBatches ?? 0) + 1;
        profile.maximumBatchSize = Math.max(profile.maximumBatchSize ?? 0, events.length);
      }
      return { events, hasMore: size() > 0 };
    },
    async drain(options = {}) {
      await this.waitForEvents();
      const result = this.drainReady(options);
      if (result.hasMore && options.yieldHost) {
        if (profile) profile.hostYields = (profile.hostYields ?? 0) + 1;
        await options.yieldHost();
      }
      return result.events;
    },
    async *[Symbol.asyncIterator]() {
      while (size() > 0 || !closed) {
        const [event] = await this.drain({ maxEvents: 1 });
        if (event) yield event;
        else await waitForWork();
      }
      if (failure !== undefined) throw failure;
    },
  };
}
