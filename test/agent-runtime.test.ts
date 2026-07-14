import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { type AppContext } from "../src/app/context.js";
import { TopchesterAgentRuntime } from "../src/agent/runtime/index.js";

const mcpFixtureServerPath = join(process.cwd(), "test/fixtures/mcp/stdio-server.js");

describe("agent runtime project instructions", () => {
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

  it("rejects implementation completion when no source file was edited", async () => {
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

    const events = await runtime.submitMessage([], "implement the requested change");
    const finalMessage = events.findLast((event) => event.type === "message" && event.role === "assistant");

    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain("no successful source-file edit yet");
    expect(prompts[2]).toContain("Previous draft answer that was rejected as unsupported");
    expect(finalMessage).toMatchObject({
      type: "message",
      role: "assistant",
      text: expect.stringContaining("no successful source-file edit occurred"),
    });
  });

  it("accepts finish_task after a source edit", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-agent-runtime-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "value.ts"), "export const value = 1;\n");
    let step = 0;
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText() {
          step += 1;
          if (step === 1) {
            return {
              text: JSON.stringify({
                tool: "edit_file",
                args: {
                  path: "src/value.ts",
                  edits: [{ old_text: "export const value = 1;\n", new_text: "export const value = 2;\n" }],
                },
              }),
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          return {
            text: JSON.stringify({
              tool: "finish_task",
              args: {
                final_response: "Changed src/value.ts.",
                files_changed: ["src/value.ts"],
                validation: [],
                remaining_issues: [],
              },
            }),
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "update the value");

    expect(await readFile(join(workspace, "src", "value.ts"), "utf8")).toBe("export const value = 2;\n");
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_call", label: "finish_task" }));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "message", role: "assistant", text: "Changed src/value.ts." })
    );
  });

  it("continues after plain text when finish_task is required", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-agent-runtime-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "value.ts"), "export const value = 1;\n");
    const previous = process.env.TOPCHESTER_REQUIRE_FINISH_TASK;
    process.env.TOPCHESTER_REQUIRE_FINISH_TASK = "1";

    let step = 0;
    const prompts: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText(request: { prompt: string }) {
          prompts.push(request.prompt);
          step += 1;

          if (step === 1) {
            return {
              text: JSON.stringify({
                tool: "edit_file",
                args: {
                  path: "src/value.ts",
                  edits: [{ old_text: "export const value = 1;\n", new_text: "export const value = 2;\n" }],
                },
              }),
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          if (step === 2) {
            return {
              text: "Now I need to run validation.",
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          return {
            text: JSON.stringify({
              tool: "finish_task",
              args: {
                final_response: "Changed src/value.ts.",
                files_changed: ["src/value.ts"],
                validation: [],
                remaining_issues: [],
              },
            }),
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    try {
      const events = await runtime.submitMessage([], "implement the requested change");

      expect(await readFile(join(workspace, "src", "value.ts"), "utf8")).toBe("export const value = 2;\n");
      expect(prompts).toHaveLength(3);
      expect(prompts[2]).toContain("requires finish_task as the only terminal action");
      expect(events).not.toContainEqual(
        expect.objectContaining({ type: "message", role: "assistant", text: "Now I need to run validation." })
      );
      expect(events).toContainEqual(
        expect.objectContaining({ type: "message", role: "assistant", text: "Changed src/value.ts." })
      );
    } finally {
      if (previous === undefined) {
        delete process.env.TOPCHESTER_REQUIRE_FINISH_TASK;
      } else {
        process.env.TOPCHESTER_REQUIRE_FINISH_TASK = previous;
      }
    }
  });

  it("allows terminal-bench finish after a workspace-changing bash command", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-agent-runtime-"));
    const previous = process.env.TOPCHESTER_REQUIRE_FINISH_TASK;
    process.env.TOPCHESTER_REQUIRE_FINISH_TASK = "1";

    let step = 0;
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText() {
          step += 1;

          if (step === 1) {
            return {
              text: JSON.stringify({
                tool: "bash",
                args: {
                  command: "mkdir -p output && printf ok > output/result.txt",
                  timeout_ms: 10000,
                  description: "create benchmark output",
                },
              }),
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          return {
            text: JSON.stringify({
              tool: "finish_task",
              args: {
                final_response: "Created output/result.txt.",
                files_changed: ["output/result.txt"],
                validation: [],
                remaining_issues: [],
              },
            }),
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    try {
      const events = await runtime.submitMessage([], "create the requested benchmark output", undefined, undefined, {
        benchmarkProfile: "terminal-bench",
      });

      expect(await readFile(join(workspace, "output", "result.txt"), "utf8")).toBe("ok");
      expect(events).toContainEqual(expect.objectContaining({ type: "tool_call", label: "finish_task" }));
      expect(events).toContainEqual(
        expect.objectContaining({ type: "message", role: "assistant", text: "Created output/result.txt." })
      );
    } finally {
      if (previous === undefined) {
        delete process.env.TOPCHESTER_REQUIRE_FINISH_TASK;
      } else {
        process.env.TOPCHESTER_REQUIRE_FINISH_TASK = previous;
      }
    }
  });

  it("rejects finish_task with remaining issues when finish_task is required", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-agent-runtime-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "value.ts"), "export const value = 1;\nexport const done = false;\n");
    const previous = process.env.TOPCHESTER_REQUIRE_FINISH_TASK;
    process.env.TOPCHESTER_REQUIRE_FINISH_TASK = "1";

    let step = 0;
    const prompts: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText(request: { prompt: string }) {
          prompts.push(request.prompt);
          step += 1;

          if (step === 1) {
            return {
              text: JSON.stringify({
                tool: "edit_file",
                args: {
                  path: "src/value.ts",
                  edits: [{ old_text: "export const value = 1;\n", new_text: "export const value = 2;\n" }],
                },
              }),
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          if (step === 2) {
            return {
              text: JSON.stringify({
                tool: "finish_task",
                args: {
                  final_response: "Changed src/value.ts, but validation still fails.",
                  files_changed: ["src/value.ts"],
                  validation: ["fake test failed"],
                  remaining_issues: ["validation still fails"],
                },
              }),
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          if (step === 3) {
            return {
              text: JSON.stringify({
                tool: "edit_file",
                args: {
                  path: "src/value.ts",
                  edits: [{ old_text: "export const done = false;\n", new_text: "export const done = true;\n" }],
                },
              }),
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          return {
            text: JSON.stringify({
              tool: "finish_task",
              args: {
                final_response: "Changed src/value.ts.",
                files_changed: ["src/value.ts"],
                validation: ["fake test passed"],
                remaining_issues: [],
              },
            }),
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    try {
      const events = await runtime.submitMessage([], "implement the requested change");

      expect(await readFile(join(workspace, "src", "value.ts"), "utf8")).toBe(
        "export const value = 2;\nexport const done = true;\n"
      );
      expect(prompts).toHaveLength(4);
      expect(prompts[2]).toContain("benchmark mode cannot finish with known remaining issues");
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "tool_call",
          label: expect.stringContaining("benchmark mode cannot finish with known remaining issues"),
        })
      );
      expect(events).toContainEqual(
        expect.objectContaining({ type: "message", role: "assistant", text: "Changed src/value.ts." })
      );
    } finally {
      if (previous === undefined) {
        delete process.env.TOPCHESTER_REQUIRE_FINISH_TASK;
      } else {
        process.env.TOPCHESTER_REQUIRE_FINISH_TASK = previous;
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
    runtimeConfigOverrides: { reasoningEffortByProvider: {} },
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
