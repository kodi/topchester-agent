import { type AgentRuntimeEvent } from "../events.js";

export interface RuntimeEventQueue {
  push(event: AgentRuntimeEvent): void;
  close(): void;
  [Symbol.asyncIterator](): AsyncIterator<AgentRuntimeEvent>;
}

export interface RuntimeEventQueueProfile {
  runtimeEvents: number;
  maximumQueueDepth: number;
}

export function createRuntimeEventQueue(profile?: RuntimeEventQueueProfile): RuntimeEventQueue {
  const events: AgentRuntimeEvent[] = [];
  let closed = false;
  let notify: (() => void) | undefined;

  return {
    push(event) {
      events.push(event);
      if (profile) {
        profile.runtimeEvents += 1;
        profile.maximumQueueDepth = Math.max(profile.maximumQueueDepth, events.length);
      }
      notify?.();
      notify = undefined;
    },

    close() {
      closed = true;
      notify?.();
      notify = undefined;
    },

    async *[Symbol.asyncIterator]() {
      while (!closed || events.length > 0) {
        const event = events.shift();
        if (event) {
          yield event;
          continue;
        }

        await new Promise<void>((resolve) => {
          notify = resolve;
        });
      }
    },
  };
}
