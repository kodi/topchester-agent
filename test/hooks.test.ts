import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
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
          PreToolUse: [{ command: `node ${shellQuote(script)} ${shellQuote(capture)}`, matcher: "bash" }],
        },
      }),
      "PreToolUse",
      createPayload(workspace, "PreToolUse", {
        tool: { name: "bash", input: { command: "pnpm test" }, callId: "call-1" },
      }),
      { toolName: "bash" }
    );

    expect(result.blocked?.message).toBe("blocked by hook");
    expect(result.contexts).toEqual(["extra context"]);

    const payload = JSON.parse(await readFile(capture, "utf8")) as Record<string, unknown>;
    expect(payload).toMatchObject({
      hook_event_name: "PreToolUse",
      event: "PreToolUse",
      cwd: workspace,
      source: "topchester",
      tool: { name: "bash", callId: "call-1" },
    });
  });

  it("runs command hooks with JSON stdin and stops from JSON stdout", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-hooks-stop-"));
    const script = join(workspace, "stop.cjs");

    await writeFile(
      script,
      [
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  process.stdout.write(JSON.stringify({ action: 'stop', message: 'stopped by hook', context: 'stop context' }));",
        "});",
      ].join("\n")
    );

    const result = await runTopchesterHooks(
      createHookTestContext(workspace, {
        hooks: {
          PreToolUse: [{ command: `node ${shellQuote(script)}`, matcher: "bash" }],
        },
      }),
      "PreToolUse",
      createPayload(workspace, "PreToolUse", {
        tool: { name: "bash", input: { command: "pnpm test" }, callId: "call-1" },
      }),
      { toolName: "bash" }
    );

    expect(result.stopped?.message).toBe("stopped by hook");
    expect(result.blocked).toBeUndefined();
    expect(result.contexts).toEqual(["stop context"]);
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

  it("reports configured hook status messages before running handlers", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-hooks-status-"));
    const script = join(workspace, "status.cjs");
    const order: string[] = [];

    await writeFile(script, "process.stdout.write(JSON.stringify({ message: 'hook complete' }));\n");

    const result = await runTopchesterHooks(
      createHookTestContext(workspace, {
        hooks: {
          Stop: [
            {
              command: `node ${shellQuote(script)}`,
              statusMessage: "Sending ClankerLog clank",
            },
          ],
        },
      }),
      "Stop",
      createPayload(workspace, "Stop", { finalMessage: "Done.", status: "completed" }),
      {
        onHookStart(status) {
          order.push(`${status.event}: ${status.statusMessage}`);
        },
      }
    );

    expect(order).toEqual(["Stop: Sending ClankerLog clank"]);
    expect(result.messages).toEqual(["hook complete"]);
  });

  it("adds active model metadata to runtime hook payloads when available", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-hooks-model-"));
    const script = join(workspace, "capture-model.cjs");
    const capture = join(workspace, "capture-model.json");

    await writeFile(
      script,
      [
        "const fs = require('node:fs');",
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        "  fs.writeFileSync(process.argv[2], input);",
        "});",
      ].join("\n")
    );

    const runtime = new TopchesterAgentRuntime({
      ...createHookTestContext(workspace, {
        hooks: {
          SessionStart: [{ command: `node ${shellQuote(script)} ${shellQuote(capture)}` }],
        },
      }),
      modelGateway: {
        resolveModel() {
          return {
            providerId: "openrouter",
            modelId: "anthropic/claude-sonnet-4.5",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    await runtime.runSessionStartHooks();

    const payload = JSON.parse(await readFile(capture, "utf8")) as Record<string, unknown>;
    expect(payload).toMatchObject({
      hook_event_name: "SessionStart",
      event: "SessionStart",
      cwd: workspace,
      model_purpose: "agent.primary",
      model_provider: "openrouter",
      model_id: "anthropic/claude-sonnet-4.5",
      model_ref: "openrouter/anthropic/claude-sonnet-4.5",
      model: {
        purpose: "agent.primary",
        providerId: "openrouter",
        modelId: "anthropic/claude-sonnet-4.5",
        ref: "openrouter/anthropic/claude-sonnet-4.5",
      },
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
          PreToolUse: [{ command: `node ${shellQuote(script)}`, matcher: "bash" }],
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
              id: "bash-1",
              source: "native" as const,
              tool: "bash",
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
      call: { tool: "bash" },
    });
    expect(events.at(-2)).toMatchObject({
      type: "message",
      role: "assistant",
      text: "Handled the blocked command.",
    });
  });

  it("stops before model work when UserPromptSubmit returns stop", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-hooks-user-stop-"));
    const script = join(workspace, "stop.cjs");
    let modelCalls = 0;

    await writeFile(
      script,
      [
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  process.stdout.write(JSON.stringify({ action: 'stop', message: 'prompt stopped by hook' }));",
        "});",
      ].join("\n")
    );

    const runtime = new TopchesterAgentRuntime({
      ...createHookTestContext(workspace, {
        hooks: {
          UserPromptSubmit: [{ command: `node ${shellQuote(script)}` }],
        },
      }),
      modelGateway: {
        async generateAgentStep() {
          modelCalls += 1;
          return fakeAgentStep("This should not run.");
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await collectRuntimeEvents(runtime.submitMessageStream([], "do work"));

    expect(modelCalls).toBe(0);
    expect(events).toContainEqual({ type: "message", role: "system", text: "prompt stopped by hook" });
    expect(events.at(-1)).toEqual({ type: "status", status: "ready" });
  });

  it("stops the turn when PreToolUse returns stop", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-hooks-pre-stop-"));
    const script = join(workspace, "stop.cjs");
    const prompts: string[] = [];

    await writeFile(
      script,
      [
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  process.stdout.write(JSON.stringify({ action: 'stop', message: 'tool stopped by hook' }));",
        "});",
      ].join("\n")
    );

    const runtime = new TopchesterAgentRuntime({
      ...createHookTestContext(workspace, {
        hooks: {
          PreToolUse: [{ command: `node ${shellQuote(script)}`, matcher: "read_file" }],
        },
      }),
      modelGateway: {
        async generateAgentStep(request: { prompt: string }) {
          prompts.push(request.prompt);
          return fakeAgentStep("", [
            {
              id: "read-1",
              source: "native" as const,
              tool: "read_file",
              args: { path: "data.txt" },
            },
          ]);
        },
      } as AppContext["modelGateway"],
    });

    const events = await collectRuntimeEvents(runtime.submitMessageStream([], "read data"));

    expect(prompts).toHaveLength(1);
    expect(events.some((event) => event.type === "tool_call")).toBe(false);
    expect(events).toContainEqual({ type: "message", role: "system", text: "tool stopped by hook" });
    expect(events.at(-1)).toEqual({ type: "status", status: "ready" });
  });

  it("stops the turn after a tool result when PostToolUse returns stop", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-hooks-post-stop-"));
    const script = join(workspace, "stop.cjs");
    const prompts: string[] = [];

    await writeFile(join(workspace, "data.txt"), "value\n");
    await writeFile(
      script,
      [
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  process.stdout.write(JSON.stringify({ action: 'stop', message: 'post-tool stopped by hook' }));",
        "});",
      ].join("\n")
    );

    const runtime = new TopchesterAgentRuntime({
      ...createHookTestContext(workspace, {
        hooks: {
          PostToolUse: [{ command: `node ${shellQuote(script)}`, matcher: "read_file" }],
        },
      }),
      modelGateway: {
        async generateAgentStep(request: { prompt: string }) {
          prompts.push(request.prompt);

          if (prompts.length > 1) {
            return fakeAgentStep("This should not continue.");
          }

          return fakeAgentStep("", [
            {
              id: "read-1",
              source: "native" as const,
              tool: "read_file",
              args: { path: "data.txt" },
            },
          ]);
        },
      } as AppContext["modelGateway"],
    });

    const events = await collectRuntimeEvents(runtime.submitMessageStream([], "read data"));

    expect(prompts).toHaveLength(1);
    expect(events.find((event) => event.type === "tool_call")).toMatchObject({
      type: "tool_call",
      call: { tool: "read_file", args: { path: "data.txt" } },
    });
    expect(events).toContainEqual({ type: "message", role: "system", text: "post-tool stopped by hook" });
    expect(events.some((event) => event.type === "message" && event.role === "assistant")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "status", status: "ready" });
  });

  it("streams Stop hook status before hook response messages", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-hooks-stop-status-"));
    const script = join(workspace, "stop.cjs");

    await writeFile(script, "process.stdout.write(JSON.stringify({ message: 'stop hook finished' }));\n");

    const runtime = new TopchesterAgentRuntime({
      ...createHookTestContext(workspace, {
        hooks: {
          Stop: [
            {
              command: `node ${shellQuote(script)}`,
              statusMessage: "Sending ClankerLog clank",
            },
          ],
        },
      }),
      modelGateway: {
        async generateAgentStep() {
          return fakeAgentStep("Done.");
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await collectRuntimeEvents(runtime.submitMessageStream([], "finish"));
    const statusIndex = events.findIndex((event) => event.type === "hook_status");
    const messageIndex = events.findIndex(
      (event) => event.type === "message" && event.role === "system" && event.text === "stop hook finished"
    );

    expect(events[statusIndex]).toMatchObject({
      type: "hook_status",
      eventName: "Stop",
      statusMessage: "Sending ClankerLog clank",
      label: "🪝 hook>stop: Sending ClankerLog clank",
    });
    expect(statusIndex).toBeGreaterThan(-1);
    expect(messageIndex).toBeGreaterThan(statusIndex);
  });

  it("runs PermissionRequest hooks before interactive command approval", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-hooks-approval-"));
    const script = join(workspace, "required.cjs");
    const capture = join(workspace, "required-capture.json");
    const prompts: string[] = [];
    const approvalRequests: Array<{ command: string; workdir: string; reason: string }> = [];

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
        "    env: { TOPCHESTER_HOOK_EVENT: process.env.TOPCHESTER_HOOK_EVENT }",
        "  }));",
        "});",
      ].join("\n")
    );

    const runtime = new TopchesterAgentRuntime({
      ...createHookTestContext(workspace, {
        hooks: {
          PermissionRequest: [{ command: `node ${shellQuote(script)} ${shellQuote(capture)}` }],
        },
      }),
      modelGateway: {
        async generateAgentStep(request: { prompt: string }) {
          prompts.push(request.prompt);

          if (request.prompt.includes("cancelled by user")) {
            return fakeAgentStep("The command was not approved.");
          }

          return fakeAgentStep("", [
            {
              id: "bash-approval-1",
              source: "native" as const,
              tool: "bash",
              args: { command: "node scripts/local-task.js", workdir: "." },
            },
          ]);
        },
      } as AppContext["modelGateway"],
    });

    const events = await collectRuntimeEvents(
      runtime.submitMessageStream([], "run local task", undefined, {
        async requestBashApproval(request) {
          approvalRequests.push(request);
          return "cancel";
        },
      })
    );

    expect(approvalRequests).toHaveLength(1);
    expect(approvalRequests[0]).toMatchObject({
      command: "node scripts/local-task.js",
      workdir: ".",
    });
    expect(prompts.some((prompt) => prompt.includes("cancelled by user"))).toBe(true);
    expect(events.at(-2)).toMatchObject({
      type: "message",
      role: "assistant",
      text: "The command was not approved.",
    });

    const captureJson = JSON.parse(await readFile(capture, "utf8")) as {
      payload: Record<string, unknown>;
      env: Record<string, unknown>;
    };
    expect(captureJson.payload).toMatchObject({
      hook_event_name: "PermissionRequest",
      event: "PermissionRequest",
      notification_type: "permission_prompt",
      source: "topchester",
      command: "node scripts/local-task.js",
      tool: { name: "bash", callId: "bash-approval-1" },
    });
    expect(captureJson.env).toEqual({ TOPCHESTER_HOOK_EVENT: "PermissionRequest" });
  });

  it("runs PermissionRequest hooks with auto-approval metadata before auto-allowing bash", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-hooks-auto-approval-"));
    const script = join(workspace, "auto-required.cjs");
    const capture = join(workspace, "auto-required-capture.json");
    const prompts: string[] = [];

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
        "    env: { TOPCHESTER_HOOK_EVENT: process.env.TOPCHESTER_HOOK_EVENT }",
        "  }));",
        "});",
      ].join("\n")
    );

    const runtime = new TopchesterAgentRuntime({
      ...createHookTestContext(workspace, {
        hooks: {
          PermissionRequest: [{ command: `node ${shellQuote(script)} ${shellQuote(capture)}` }],
        },
      }),
      modelGateway: {
        async generateAgentStep(request: { prompt: string }) {
          prompts.push(request.prompt);

          if (prompts.length === 1) {
            return fakeAgentStep("", [
              {
                id: "bash-auto-approval-1",
                source: "native" as const,
                tool: "bash",
                args: { command: "node --version", workdir: "." },
              },
            ]);
          }

          return fakeAgentStep("The command ran.");
        },
      } as AppContext["modelGateway"],
    });

    const events = await collectRuntimeEvents(
      runtime.submitMessageStream([], "run local task", undefined, {
        userApprovalMode: "auto_allow",
      })
    );

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "permission_auto_approved",
          command: "node --version",
          toolCallId: "bash-auto-approval-1",
        }),
        expect.objectContaining({ type: "tool_call", label: expect.stringContaining("bash: node --version") }),
      ])
    );
    expect(prompts[1]).toContain("Tool result from bash via node --version:");

    const captureJson = JSON.parse(await readFile(capture, "utf8")) as {
      payload: Record<string, unknown>;
      env: Record<string, unknown>;
    };
    expect(captureJson.payload).toMatchObject({
      hook_event_name: "PermissionRequest",
      event: "PermissionRequest",
      notification_type: "permission_prompt",
      permission_mode: "bash",
      approval_mode: "auto_allow",
      auto_approved: true,
      source: "topchester",
      command: "node --version",
      tool: { name: "bash", callId: "bash-auto-approval-1" },
    });
    expect(captureJson.env).toEqual({ TOPCHESTER_HOOK_EVENT: "PermissionRequest" });
  });

  it("blocks auto-approved bash before execution when PermissionRequest returns block", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-hooks-auto-approval-block-"));
    const script = join(workspace, "block.cjs");
    const prompts: string[] = [];

    await writeFile(
      script,
      [
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  process.stdout.write(JSON.stringify({ action: 'block', message: 'auto approval blocked by hook' }));",
        "});",
      ].join("\n")
    );

    const runtime = new TopchesterAgentRuntime({
      ...createHookTestContext(workspace, {
        hooks: {
          PermissionRequest: [{ command: `node ${shellQuote(script)}` }],
        },
      }),
      modelGateway: {
        async generateAgentStep(request: { prompt: string }) {
          prompts.push(request.prompt);

          if (prompts.length === 1) {
            return fakeAgentStep("", [
              {
                id: "bash-auto-approval-block-1",
                source: "native" as const,
                tool: "bash",
                args: { command: "node --version", workdir: "." },
              },
            ]);
          }

          return fakeAgentStep("The command was blocked.");
        },
      } as AppContext["modelGateway"],
    });

    const events = await collectRuntimeEvents(
      runtime.submitMessageStream([], "run local task", undefined, {
        userApprovalMode: "auto_allow",
      })
    );

    expect(events.some((event) => event.type === "permission_auto_approved")).toBe(false);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_call",
          label: "bash failed: auto approval blocked by hook",
        }),
        expect.objectContaining({ type: "message", role: "assistant", text: "The command was blocked." }),
      ])
    );
    expect(prompts[1]).toContain("auto approval blocked by hook");
  });

  it("stops the turn before interactive command approval when PermissionRequest returns stop", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-hooks-approval-stop-"));
    const script = join(workspace, "stop.cjs");
    const prompts: string[] = [];
    const approvalRequests: Array<{ command: string; workdir: string; reason: string }> = [];

    await writeFile(
      script,
      [
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  process.stdout.write(JSON.stringify({ action: 'stop', message: 'approval stopped by hook' }));",
        "});",
      ].join("\n")
    );

    const runtime = new TopchesterAgentRuntime({
      ...createHookTestContext(workspace, {
        hooks: {
          PermissionRequest: [{ command: `node ${shellQuote(script)}` }],
        },
      }),
      modelGateway: {
        async generateAgentStep(request: { prompt: string }) {
          prompts.push(request.prompt);
          return fakeAgentStep("", [
            {
              id: "bash-approval-1",
              source: "native" as const,
              tool: "bash",
              args: { command: "node scripts/local-task.js", workdir: "." },
            },
          ]);
        },
      } as AppContext["modelGateway"],
    });

    const events = await collectRuntimeEvents(
      runtime.submitMessageStream([], "run local task", undefined, {
        async requestBashApproval(request) {
          approvalRequests.push(request);
          return "run_once";
        },
      })
    );

    expect(prompts).toHaveLength(1);
    expect(approvalRequests).toEqual([]);
    expect(events.some((event) => event.type === "tool_call")).toBe(false);
    expect(events).toContainEqual({ type: "message", role: "system", text: "approval stopped by hook" });
    expect(events.at(-1)).toEqual({ type: "status", status: "ready" });
  });
});

function createHookTestContext(workspaceRoot: string, config: TopchesterConfig): AppContext {
  return {
    workspaceRoot,
    configLoadSpec: { workspaceRoot },
    baseConfig: config,
    runtimeConfigOverrides: { reasoningEffortByProvider: {} },
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
