import { describe, expect, it, vi } from "vite-plus/test";
import { checkAgentReady } from "../src/agent/health.js";
import { type ModelGateway } from "../src/model/index.js";

describe("agent startup health check", () => {
  it("classifies an SDK parse error after its own timeout as timed out", async () => {
    vi.useFakeTimers();
    try {
      const modelGateway = {
        async generateText({ abortSignal }: { abortSignal?: AbortSignal }) {
          return new Promise<never>((_resolve, reject) => {
            abortSignal?.addEventListener("abort", () => reject(new Error("Invalid JSON response")), { once: true });
          });
        },
      } as unknown as ModelGateway;

      const result = checkAgentReady(modelGateway);
      const assertion = expect(result).resolves.toBe("timed-out");
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
