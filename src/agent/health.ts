import { type ModelGateway } from "../model/index.js";

export type AgentReadyCheckResult = "ready" | "not-ready" | "timed-out";

export async function checkAgentReady(
  modelGateway: ModelGateway,
  abortSignal?: AbortSignal
): Promise<AgentReadyCheckResult> {
  const abortController = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, 30_000);
  const abort = () => abortController.abort();

  abortSignal?.addEventListener("abort", abort, { once: true });

  try {
    const result = await modelGateway.generateText({
      purpose: "agent.fast",
      system: "You are a startup health check. Reply with exactly one word: ready",
      prompt: "Reply with exactly: ready",
      abortSignal: abortController.signal,
    });

    return result.text.trim().toLowerCase().includes("ready") ? "ready" : "not-ready";
  } catch (error) {
    if (timedOut && isAbortError(error)) {
      return "timed-out";
    }

    throw error;
  } finally {
    clearTimeout(timeout);
    abortSignal?.removeEventListener("abort", abort);
  }
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "AbortError" || error.message.toLowerCase().includes("aborted");
}
