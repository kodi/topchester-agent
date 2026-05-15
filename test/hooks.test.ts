import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TopchesterAgentRuntime } from "../src/agent/runtime/index.js";
import { type AgentRuntimeEvent } from "../src/agent/events.js";
import { runTopchesterHooks, type HookRunPayload } from "../src/agent/hooks.js";
import { type AppContext } from "../src/app/context.js";
import { type TopchesterConfig } from "../src/config/index.js";
import { type ModelAgentResult } from "../src/model/index.js";

describe("agent hooks", () => {
  it("runs command hooks with JSON stdin and blocks tool use from JSON stdout", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-hooks-"));
    const script = join(workspace, "hook.cjs");
    const capture = join(workspace, "capture.json");

    await writeFile(
      script,
      [
        "const fs = require('node:fs');",
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        "  fs.writeFileSync(process.argv[2], input);",
        "  process.stdout.write(JSON.stringify({ action: 'block', message: 'blocked by hook', context: 'extra context' }));",
        "});",
      ].join("\n")
    );

    const result = await runTopchesterHooks(
      createHookTestContext(workspace, {
        hooks: {
          PreToolUse: [{ command: `node ${shellQuote(script)} ${shellQuote(capture)}`, matcher: "run_command" }],
        },
      }),
      "PreToolUse",
      createPayload(workspace, "PreToolUse", {
        tool: { name: "run_command", input: { command: "pnpm test" }, callId: "call-1" },
      }),
      { toolName: "run_command" }
    );

    expect(result.blocked?.message).toBe("blocked by hook");
    expect(result.contexts).toEqual(["extra context"]);

    const payload = JSON.parse(await readFile(capture, "utf8")) as Record<string, unknown>;
    expect(payload).toMatchObject({
      hook_event_name: "PreToolUse",
      event: "PreToolUse",
      cwd: workspace,
      source: "topchester",
      tool: { name: "run_command", callId: "call-1" },
    });
  });

  it("can integrate peon-ping through a normal command hook", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-hooks-"));
    const script = join(workspace, "peon.cjs");
    const capture = join(workspace, "peon-capture.json");

    await writeFile(
      script,
      [
        "const fs = require('node:fs');",
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        "  fs.writeFileSync(process.argv[2], JSON.stringify({",
        "    payload: JSON.parse(input),",
        "    env: {",
        "      TOPCHESTER_HOOK_EVENT: process.env.TOPCHESTER_HOOK_EVENT,",
        "      TOPCHESTER_HOOK_TOOL: process.env.TOPCHESTER_HOOK_TOOL",
        "    }",
        "  }));",
        "  process.stdout.write('PEON_EXIT=false\\nSTATUS=done\\n');",
        "});",
      ].join("\n")
    );

    const result = await runTopchesterHooks(
      createHookTestContext(workspace, {
        hooks: {
          Stop: [{ command: `node ${shellQuote(script)} ${shellQuote(capture)} >/dev/null` }],
        },
      }),
      "Stop",
      createPayload(workspace, "Stop", { finalMessage: "Done.", status: "completed" })
    );

    expect(result.contexts).toEqual([]);
    expect(result.messages).toEqual([]);
    expect(result.blocked).toBeUndefined();
    expect(result.stopped).toBeUndefined();

    const captureJson = JSON.parse(await readFile(capture, "utf8")) as {
      payload: Record<string, unknown>;
      env: Record<string, unknown>;
    };
    expect(captureJson.payload).toMatchObject({
      hook_event_name: "Stop",
      event: "Stop",
      source: "topchester",
      finalMessage: "Done.",
    });
    expect(captureJson.env).toEqual({
      TOPCHESTER_HOOK_EVENT: "Stop",
      TOPCHESTER_HOOK_TOOL: "",
    });
  });

  it("applies PreToolUse blocks inside the runtime tool loop", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-hooks-runtime-"));
    const script = join(workspace, "block.cjs");
    const prompts: string[] = [];

    await writeFile(
      script,
      [
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  process.stdout.write(JSON.stringify({ action: 'block', message: 'blocked by hook' }));",
        "});",
      ].join("\n")
    );

    const runtime = new TopchesterAgentRuntime({
      ...createHookTestContext(workspace, {
        hooks: {
          PreToolUse: [{ command: `node ${shellQuote(script)}`, matcher: "run_command" }],
        },
      }),
      modelGateway: {
        async generateAgentStep(request: { prompt: string }) {
          prompts.push(request.prompt);

          if (request.prompt.includes("blocked by hook")) {
            return fakeAgentStep("Handled the blocked command.");
          }

          return fakeAgentStep("", [
            {
              id: "run-command-1",
              source: "native" as const,
              tool: "run_command",
              args: { command: "node --version", workdir: "." },
            },
          ]);
        },
      } as AppContext["modelGateway"],
    });

    const events = await collectRuntimeEvents(runtime.submitMessageStream([], "run node"));

    expect(prompts.some((prompt) => prompt.includes("blocked by hook"))).toBe(true);
    expect(events.find((event) => event.type === "tool_call")).toMatchObject({
      type: "tool_call",
      call: { tool: "run_command" },
    });
    expect(events.at(-2)).toMatchObject({
      type: "message",
      role: "assistant",
      text: "Handled the blocked command.",
    });
  });
});

function createHookTestContext(workspaceRoot: string, config: TopchesterConfig): AppContext {
  return {
    workspaceRoot,
    config,
    devFlags: new Set(),
    modelGateway: {} as AppContext["modelGateway"],
    logger: {
      debug() {},
      trace() {},
      info() {},
      warn() {},
      error() {},
      child() {
        return this;
      },
    } as unknown as AppContext["logger"],
  };
}

function createPayload(
  workspaceRoot: string,
  event: HookRunPayload["event"],
  extra: Record<string, unknown> = {}
): HookRunPayload {
  return {
    hook_event_name: event,
    event,
    cwd: workspaceRoot,
    workspaceRoot,
    source: "topchester",
    session_id: "session-1",
    sessionId: "session-1",
    ...extra,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function fakeAgentStep(text: string, toolCalls: ModelAgentResult["toolCalls"] = []): ModelAgentResult {
  return {
    text,
    providerId: "fake",
    modelId: "fake-agent",
    purpose: "agent.primary",
    toolCalls,
    toolProtocol: "native-openai-compatible",
    protocolAttempts: [],
    providerRejectedTools: false,
    warnings: [],
    openRouterRoutingApplied: false,
  };
}

async function collectRuntimeEvents(events: AsyncIterable<AgentRuntimeEvent>): Promise<AgentRuntimeEvent[]> {
  const collected: AgentRuntimeEvent[] = [];

  for await (const event of events) {
    collected.push(event);
  }

  return collected;
}
