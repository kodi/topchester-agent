import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { type AppContext } from "../src/app/context.js";
import { TopchesterAgentRuntime } from "../src/agent/runtime/index.js";
import { createRuntimeEventQueue } from "../src/agent/runtime/event-queue.js";
import { createSession } from "../src/session/store.js";

const mcpFixtureServerPath = join(process.cwd(), "test/fixtures/mcp/stdio-server.js");

describe("runtime event queue", () => {
  it("preserves FIFO order, applies count/time limits around consume, and records yields", async () => {
    const profile = { runtimeEvents: 0, maximumQueueDepth: 0, runtimeBatches: 0, maximumBatchSize: 0, hostYields: 0 };
    const queue = createRuntimeEventQueue(profile, { capacity: 4 });
    for (const status of ["one", "two", "three"]) void queue.push({ type: "status", status });
    let clock = 0;
    const consumed: string[] = [];
    const batch = await queue.drain({
      maxEvents: 3,
      maxElapsedMs: 0,
      now: () => clock,
      consume: (event) => {
        consumed.push(event.type === "status" ? event.status : "unexpected");
        clock += 1;
      },
      yieldHost: async () => {},
    });
    expect(batch.map((event) => (event.type === "status" ? event.status : "unexpected"))).toEqual(["one"]);
    expect(consumed).toEqual(["one"]);
    expect(profile).toMatchObject({ runtimeBatches: 1, maximumBatchSize: 1, hostYields: 1 });
    expect((await queue.drain({ maxEvents: 2 })).map((event) => (event.type === "status" ? event.status : ""))).toEqual(
      ["two", "three"]
    );
  });

  it("backpressures the 129th producer until a consumer frees capacity and cleans up close/abort waiters", async () => {
    const queue = createRuntimeEventQueue(undefined, { capacity: 2 });
    void queue.push({ type: "status", status: "one" });
    void queue.push({ type: "status", status: "two" });
    const blocked = queue.push({ type: "status", status: "three" });
    expect(blocked).toBeInstanceOf(Promise);
    await queue.drain({ maxEvents: 1 });
    await expect(Promise.resolve(blocked)).resolves.toBeUndefined();
    expect((await queue.drain({ maxEvents: 2 })).map((event) => (event.type === "status" ? event.status : ""))).toEqual(
      ["two", "three"]
    );

    const aborted = createRuntimeEventQueue(undefined, { capacity: 1 });
    void aborted.push({ type: "status", status: "one" });
    const waiting = aborted.push({ type: "status", status: "two" });
    aborted.abort(new Error("cancelled"));
    await expect(Promise.resolve(waiting)).rejects.toThrow("cancelled");
    await expect(aborted.drain()).rejects.toThrow("cancelled");
  });

  it("drains buffered work before a producer error and wakes an empty aborted consumer", async () => {
    const failed = createRuntimeEventQueue(undefined, { capacity: 2 });
    void failed.push({ type: "status", status: "before failure" });
    failed.close(new Error("producer failed"));
    await expect(failed.drain()).resolves.toEqual([{ type: "status", status: "before failure" }]);
    await expect(failed.drain()).rejects.toThrow("producer failed");
    expect(() => failed.push({ type: "status", status: "too late" })).toThrow("producer failed");

    const aborted = createRuntimeEventQueue();
    const waiting = aborted.waitForEvents();
    aborted.abort(new Error("consumer cancelled"));
    await expect(waiting).rejects.toThrow("consumer cancelled");

    expect(() => createRuntimeEventQueue(undefined, { capacity: 0 })).toThrow("capacity must be positive");
  });
});

describe("agent runtime project instructions", () => {
  it("logs session-scoped turn, model, and setup timing records", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-agent-runtime-"));
    const session = await createSession(workspace);
    const logLines: Array<Record<string, unknown>> = [];
    const context = createTestContext(workspace);
    context.logger = createCaptureLogger(logLines);
    context.modelGateway = {
      async generateText() {
        return {
          text: "Done.",
          providerId: "fake",
          modelId: "fake-agent",
          purpose: "agent.primary" as const,
        };
      },
    } as unknown as AppContext["modelGateway"];
    const runtime = new TopchesterAgentRuntime(context);

    await runtime.submitMessage([], "hello", undefined, undefined, { session });

    const timingLines = logLines.filter((line) =>
      ["session_turn_started", "session_phase", "model_response", "session_turn_finished"].includes(String(line.event))
    );
    expect(timingLines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "session_turn_started", sessionId: session.sessionId }),
        expect.objectContaining({ event: "session_phase", category: "setup", sessionId: session.sessionId }),
        expect.objectContaining({
          event: "model_response",
          modelId: "fake-agent",
          sessionId: session.sessionId,
          modelDurationMs: expect.any(Number),
        }),
        expect.objectContaining({
          event: "session_turn_finished",
          sessionId: session.sessionId,
          durationMs: expect.any(Number),
        }),
      ])
    );
    expect(new Set(timingLines.map((line) => line.turnId)).size).toBe(1);
  });

  it("injects root project instructions into the system prompt", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-agent-runtime-"));
    await writeFile(join(workspace, "AGENTS.md"), "Answer in short sentences.\n");
    const systems: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText(request: { system: string }) {
          systems.push(request.system);
          return {
            text: "Done.",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    await runtime.submitMessage([], "hello");

    expect(systems).toHaveLength(1);
    expect(systems[0]).toContain("You are Topchester");
    expect(systems[0]).toContain("# AGENTS.md instructions");
    expect(systems[0]).toContain("## AGENTS.md for .");
    expect(systems[0]).toContain("Answer in short sentences.");
  });

  it("omits the project instruction block when no instruction file exists", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-agent-runtime-"));
    const systems: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText(request: { system: string }) {
          systems.push(request.system);
          return {
            text: "Done.",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    await runtime.submitMessage([], "hello");

    expect(systems).toHaveLength(1);
    expect(systems[0]).not.toContain("# AGENTS.md instructions");
  });

  it("honors runtime project instruction config", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-agent-runtime-"));
    await writeFile(join(workspace, "AGENT.md"), "Use the custom file.\n");
    const systems: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      config: { instructions: { files: ["AGENT.md"] } },
      modelGateway: {
        async generateText(request: { system: string }) {
          systems.push(request.system);
          return {
            text: "Done.",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    await runtime.submitMessage([], "hello");

    expect(systems[0]).toContain("Use the custom file.");
  });

  it("can disable runtime project instructions", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-agent-runtime-"));
    await writeFile(join(workspace, "AGENTS.md"), "Do not load me.\n");
    const systems: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      config: { instructions: { enabled: false } },
      modelGateway: {
        async generateText(request: { system: string }) {
          systems.push(request.system);
          return {
            text: "Done.",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    await runtime.submitMessage([], "hello");

    expect(systems[0]).not.toContain("Do not load me.");
    expect(await runtime.checkProjectInstructions()).toEqual([]);
  });

  it("reports compact startup project instruction status", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-agent-runtime-"));
    await writeFile(join(workspace, "AGENTS.md"), "Project instruction.\n");
    await writeFile(join(workspace, "AGENTS.override.md"), "Local instruction.\n");
    const runtime = new TopchesterAgentRuntime(createTestContext(workspace));

    const events = await runtime.checkProjectInstructions();

    expect(events).toEqual([
      {
        type: "message",
        role: "system",
        text: "Project instructions: AGENTS.md, AGENTS.override.md",
      },
    ]);
  });

  it("feeds nested project instructions back before retrying a scoped edit", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-agent-runtime-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "AGENTS.md"), "Root rule.\n");
    await writeFile(join(workspace, "src", "AGENTS.md"), "Use src naming rules.\n");
    await writeFile(join(workspace, "src", "value.txt"), "enabled=false\n");
    const prompts: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText(request: { prompt: string }) {
          prompts.push(request.prompt);

          if (request.prompt.includes("+enabled=true")) {
            return {
              text: "Edited.",
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          return {
            text: JSON.stringify({
              tool: "edit_file",
              args: {
                path: "src/value.txt",
                edits: [{ old_text: "enabled=false\n", new_text: "enabled=true\n" }],
              },
            }),
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "turn it on");

    expect(prompts).toHaveLength(3);
    expect(events.filter((event) => event.type === "instruction_context")).toEqual([
      {
        type: "instruction_context",
        sources: [{ path: "AGENTS.md", scopePath: ".", bytes: Buffer.byteLength("Root rule.\n"), truncated: false }],
      },
      {
        type: "instruction_context",
        sources: [
          {
            path: "src/AGENTS.md",
            scopePath: "src",
            bytes: Buffer.byteLength("Use src naming rules.\n"),
            truncated: false,
          },
        ],
      },
    ]);
    expect(prompts[1]).toContain("edit_file did not change src/value.txt.");
    expect(prompts[1]).toContain("Use src naming rules.");
    expect(prompts[2]).toContain("+enabled=true");
    expect(await readFile(join(workspace, "src", "value.txt"), "utf8")).toBe("enabled=true\n");
  });

  it("ignores the legacy completion environment flag and returns the model's final response unchanged", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-agent-runtime-"));
    const prompts: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText(request: { prompt: string }) {
          prompts.push(request.prompt);
          return {
            text: "Implemented the requested change in src/value.ts.",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const previousRequireFinishTask = process.env.TOPCHESTER_REQUIRE_FINISH_TASK;
    process.env.TOPCHESTER_REQUIRE_FINISH_TASK = "1";
    try {
      const events = await runtime.submitMessage([], "implement the requested change");
      const finalMessage = events.findLast((event) => event.type === "message" && event.role === "assistant");

      expect(prompts).toHaveLength(1);
      expect(finalMessage).toMatchObject({
        type: "message",
        role: "assistant",
        text: "Implemented the requested change in src/value.ts.",
      });
    } finally {
      if (previousRequireFinishTask === undefined) {
        delete process.env.TOPCHESTER_REQUIRE_FINISH_TASK;
      } else {
        process.env.TOPCHESTER_REQUIRE_FINISH_TASK = previousRequireFinishTask;
      }
    }
  });

  it("exposes configured stdio MCP tools to the runtime loop and feeds results back to the model", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-agent-runtime-"));
    const prompts: string[] = [];
    const toolNames: string[][] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      config: {
        mcp: {
          fixture: {
            type: "stdio",
            command: process.execPath,
            args: [mcpFixtureServerPath],
            env: {},
            enabled: true,
            timeoutMs: 5000,
            enabledTools: ["echo"],
          },
        },
      },
      modelGateway: {
        async generateText(request: { prompt: string; tools?: Array<{ name: string }> }) {
          prompts.push(request.prompt);
          toolNames.push(request.tools?.map((tool) => tool.name) ?? []);

          if (prompts.length === 1) {
            return {
              text: JSON.stringify({
                tool: "mcp_fixture_echo",
                args: { message: "hello from runtime" },
              }),
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          return {
            text: "MCP result handled.",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "call mcp echo");

    expect(toolNames[0]).toContain("mcp_fixture_echo");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_call",
        call: expect.objectContaining({
          tool: "mcp_fixture_echo",
          args: { message: "hello from runtime" },
        }),
        label: 'mcp_fixture_echo: {"message":"hello from runtime"}',
      })
    );
    expect(prompts[1]).toContain("Tool result from mcp_fixture_echo:");
    expect(prompts[1]).toContain("hello from runtime");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message",
        role: "assistant",
        text: "MCP result handled.",
      })
    );
  });

  it("runs tool hooks for MCP tool names", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-agent-runtime-"));
    const hookScript = join(workspace, "capture-hook.mjs");
    const capturePath = join(workspace, "hook-events.jsonl");
    await writeFile(
      hookScript,
      [
        "import { appendFileSync } from 'node:fs';",
        "const chunks = [];",
        "process.stdin.on('data', (chunk) => chunks.push(chunk));",
        "process.stdin.on('end', () => {",
        "  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));",
        "  appendFileSync(process.argv[2], JSON.stringify({ event: payload.event, tool: payload.tool?.name }) + '\\n');",
        "});",
      ].join("\n")
    );
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      config: {
        mcp: {
          fixture: {
            type: "stdio",
            command: process.execPath,
            args: [mcpFixtureServerPath],
            env: {},
            enabled: true,
            timeoutMs: 5000,
            enabledTools: ["echo"],
          },
        },
        hooks: {
          PreToolUse: [
            {
              matcher: "mcp_fixture_echo",
              command: `${process.execPath} ${shellQuote(hookScript)} ${shellQuote(capturePath)}`,
            },
          ],
          PostToolUse: [
            {
              matcher: "mcp_fixture_echo",
              command: `${process.execPath} ${shellQuote(hookScript)} ${shellQuote(capturePath)}`,
            },
          ],
        },
      },
      modelGateway: {
        async generateText(request: { prompt: string }) {
          if (!request.prompt.includes("Tool result from mcp_fixture_echo")) {
            return {
              text: JSON.stringify({ tool: "mcp_fixture_echo", args: { message: "hook me" } }),
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          return {
            text: "Done.",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    await runtime.submitMessage([], "call mcp echo");

    const captured = (await readFile(capturePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(captured).toEqual([
      { event: "PreToolUse", tool: "mcp_fixture_echo" },
      { event: "PostToolUse", tool: "mcp_fixture_echo" },
    ]);
  });

  it("omits tools from failed MCP servers without crashing the turn", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-agent-runtime-"));
    const toolNames: string[][] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      config: {
        mcp: {
          fixture: {
            type: "stdio",
            command: process.execPath,
            args: [mcpFixtureServerPath, "--fail"],
            env: {},
            enabled: true,
            timeoutMs: 5000,
          },
        },
      },
      modelGateway: {
        async generateText(request: { tools?: Array<{ name: string }> }) {
          toolNames.push(request.tools?.map((tool) => tool.name) ?? []);

          return {
            text: "Done despite failed MCP.",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "hello");

    expect(toolNames[0]).not.toContain("mcp_fixture_echo");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message",
        role: "assistant",
        text: "Done despite failed MCP.",
      })
    );
  });
});

function createTestContext(workspaceRoot: string): AppContext {
  return {
    workspaceRoot,
    configLoadSpec: { workspaceRoot },
    baseConfig: {},
    runtimeConfigOverrides: { modelOverrides: {}, reasoningEffortByProvider: {} },
    config: {},
    modelGateway: {
      async generateText() {
        throw new Error("model should not be called for this test");
      },
    } as unknown as AppContext["modelGateway"],
    devFlags: new Set(),
    logger: {
      debug() {},
      trace() {},
      warn() {},
      error() {},
    } as unknown as AppContext["logger"],
  };
}

function createCaptureLogger(
  lines: Array<Record<string, unknown>>,
  base: Record<string, unknown> = {}
): AppContext["logger"] {
  const write = (payload: unknown) => {
    if (typeof payload === "object" && payload !== null) {
      lines.push({ ...base, ...(payload as Record<string, unknown>) });
    }
  };
  const logger = {
    debug: write,
    trace: write,
    warn: write,
    error: write,
    child(fields: Record<string, unknown>) {
      return createCaptureLogger(lines, { ...base, ...fields });
    },
  };
  return logger as unknown as AppContext["logger"];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
