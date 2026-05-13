import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AppContext } from "../src/app/context.js";
import {
  executeSlashCommand,
  formatKnowledgeStatus,
  getSlashCommandSuggestions,
  parseSlashCommand,
} from "../src/agent/commands.js";
import { TopchesterAgentRuntime } from "../src/agent/runtime.js";

describe("slash commands", () => {
  it("parses slash commands and arguments", () => {
    expect(parseSlashCommand("/kb status")).toEqual({ name: "kb", args: ["status"] });
    expect(parseSlashCommand(" /kb   status  ")).toEqual({ name: "kb", args: ["status"] });
    expect(parseSlashCommand("kb status")).toBeUndefined();
    expect(parseSlashCommand("/")).toBeUndefined();
  });

  it("reports unknown commands", async () => {
    await expect(executeSlashCommand("/nope", { workspaceRoot: "/repo" })).resolves.toEqual({
      messages: ["Unknown command: /nope", "Try /kb status."],
    });
  });

  it("suggests slash commands by typed prefix", () => {
    expect(getSlashCommandSuggestions("/")).toEqual([
      {
        value: "/kb status",
        description: "show project knowledge base status",
      },
      {
        value: "/kb compile",
        description: "process project files into L1 entries",
      },
      {
        value: "/kb init",
        description: "start project knowledge base setup",
      },
      {
        value: "/kb reset",
        description: "delete the local knowledge base and cache",
      },
    ]);
    expect(getSlashCommandSuggestions("/k")).toEqual([
      {
        value: "/kb status",
        description: "show project knowledge base status",
      },
      {
        value: "/kb compile",
        description: "process project files into L1 entries",
      },
      {
        value: "/kb init",
        description: "start project knowledge base setup",
      },
      {
        value: "/kb reset",
        description: "delete the local knowledge base and cache",
      },
    ]);
    expect(getSlashCommandSuggestions("/kb i")).toEqual([
      {
        value: "/kb init",
        description: "start project knowledge base setup",
      },
    ]);
    expect(getSlashCommandSuggestions("/kb r")).toEqual([
      {
        value: "/kb reset",
        description: "delete the local knowledge base and cache",
      },
    ]);
    expect(getSlashCommandSuggestions("/nope")).toEqual([]);
    expect(getSlashCommandSuggestions("hello")).toEqual([]);
  });

  it("reports /kb usage for unknown KB subcommands", async () => {
    await expect(executeSlashCommand("/kb nope", { workspaceRoot: "/repo" })).resolves.toEqual({
      messages: ["Usage: /kb init, /kb compile, /kb reset, or /kb status"],
    });
  });

  it("executes /kb init and creates project folders", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));

    const result = await executeSlashCommand("/kb init", { workspaceRoot: workspace });

    expect(result.messages).toContain("KB init");
    expect(result.messages).toContain(`workspace: ${workspace}`);
    expect(result.messages).toContain(`created: ${join(workspace, ".agents/topchester")}`);
    expect(result.messages).toContain(`created: ${join(workspace, ".agents/topchester/sessions")}`);
    expect(result.messages).toContain(`created: ${join(workspace, ".agents/topchester/logs")}`);
    expect(result.messages).toContain(`created: ${join(workspace, "topchester-kb")}`);
    expect(result.messages).toContain(`created: ${join(workspace, "topchester-kb/l1-files")}`);
    expect(result.messages).toContain(`created: ${join(workspace, ".agents/topchester-kb-cache")}`);
    await expect(stat(join(workspace, ".agents/topchester"))).resolves.toMatchObject({});
  });

  it("executes /kb reset and removes knowledge folders", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    const kbPath = join(workspace, "topchester-kb");
    const cachePath = join(workspace, ".agents/topchester-kb-cache");
    await mkdir(kbPath, { recursive: true });
    await mkdir(cachePath, { recursive: true });
    await writeFile(join(kbPath, "manifest.json"), "{}\n");
    await writeFile(join(cachePath, "l1-queue.json"), "[]\n");

    const result = await executeSlashCommand("/kb reset", { workspaceRoot: workspace });

    expect(result.messages).toContain("KB reset");
    expect(result.messages).toContain(`removed: ${kbPath}`);
    expect(result.messages).toContain(`removed: ${cachePath}`);
    expect(result.messages).toContain("state: project knowledge base was reset");
    await expect(stat(kbPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(cachePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("executes /kb compile through the model-backed L1 pipeline", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await executeSlashCommand("/kb init", { workspaceRoot: workspace });
    await writeFile(join(workspace, "src", "index.ts"), "export const value = 1;\n");

    const result = await executeSlashCommand("/kb compile", {
      workspaceRoot: workspace,
      modelGateway: {
        async generateText() {
          return {
            text: JSON.stringify({
              language: "typescript",
              summary: "Describes the entry file.",
              responsibilities: ["Export a test value."],
              symbols: [],
              imports: [],
              exports: ["value"],
              module_ids: [],
              feature_ids: [],
              test_ids: [],
              evidence: [{ kind: "path", value: "src/index.ts" }],
              confidence: "medium",
            }),
            providerId: "fake",
            modelId: "fake-l1",
            purpose: "kb.summarize" as const,
          };
        },
      },
    });

    expect(result.messages).toContain("KB compile");
    expect(result.messages).toContain("queued: 1");
    expect(result.messages).toContain("completed: 1");
    expect(result.messages).toContain("state: L1 entries are ready and current");
  });

  it("surfaces /kb compile setup and model failures as chat messages", async () => {
    await expect(executeSlashCommand("/kb compile", { workspaceRoot: "/repo" })).resolves.toEqual({
      messages: ['No model configured for purpose "kb.summarize"; L1 entries were not processed.'],
    });
  });

  it("formats missing KB status", () => {
    expect(
      formatKnowledgeStatus({
        workspaceRoot: "/repo",
        kbPath: "/repo/topchester-kb",
        cachePath: "/repo/.agents/topchester-kb-cache",
        kbExists: false,
        kbIsDirectory: false,
        cacheExists: false,
        cacheIsDirectory: false,
        kbPathSource: "default",
        cachePathSource: "default",
      })
    ).toEqual([
      "KB status",
      "workspace: /repo",
      "knowledge folder: /repo/topchester-kb [missing] (default)",
      "local cache folder: /repo/.agents/topchester-kb-cache [missing] (default)",
      "state: no knowledge base found yet",
    ]);
  });

  it("formats empty KB status", () => {
    expect(
      formatKnowledgeStatus({
        workspaceRoot: "/repo",
        kbPath: "/repo/topchester-kb",
        cachePath: "/repo/.agents/topchester-kb-cache",
        kbExists: true,
        kbIsDirectory: true,
        cacheExists: false,
        cacheIsDirectory: false,
        kbContentState: "empty",
        kbPathSource: "default",
        cachePathSource: "default",
      })
    ).toEqual([
      "KB status",
      "workspace: /repo",
      "knowledge folder: /repo/topchester-kb [empty] (default)",
      "local cache folder: /repo/.agents/topchester-kb-cache [missing] (default)",
      "state: knowledge base folder is empty",
    ]);
  });

  it("executes /kb status against the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    await mkdir(join(workspace, "topchester-kb"), { recursive: true });

    const result = await executeSlashCommand("/kb status", { workspaceRoot: workspace });

    expect(result.messages).toContain(`knowledge folder: ${join(workspace, "topchester-kb")} [empty] (default)`);
    expect(result.messages).toContain("state: knowledge base folder is empty");
  });

  it("refreshes runtime KB status after KB slash commands", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    const runtime = new TopchesterAgentRuntime(createTestContext(workspace));

    await expect(getRuntimeKnowledgeFolderState(runtime, "/kb status")).resolves.toEqual({
      exists: false,
      isDirectory: false,
    });
    await expect(getRuntimeKnowledgeFolderState(runtime, "/kb init")).resolves.toEqual({
      exists: true,
      isDirectory: true,
    });
    await expect(getRuntimeKnowledgeFolderState(runtime, "/kb compile")).resolves.toEqual({
      exists: true,
      isDirectory: true,
    });
    await expect(getRuntimeKnowledgeFolderState(runtime, "/kb reset")).resolves.toEqual({
      exists: false,
      isDirectory: false,
    });
  });

  it("formats edit_file tool calls and results for the final model prompt", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    await writeFile(join(workspace, "example.txt"), "enabled=false\n");
    const prompts: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText(request: { prompt: string }) {
          prompts.push(request.prompt);

          return prompts.length === 1
            ? {
                text: JSON.stringify({
                  tool: "edit_file",
                  args: {
                    path: "example.txt",
                    edits: [{ old_text: "enabled=false\n", new_text: "enabled=true\n" }],
                  },
                }),
                providerId: "fake",
                modelId: "fake-agent",
                purpose: "agent.primary" as const,
              }
            : {
                text: "Updated example.txt.",
                providerId: "fake",
                modelId: "fake-agent",
                purpose: "agent.primary" as const,
              };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "turn it on");

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_call", label: "Tool edit_file: example.txt (changed +1/-1)" }),
        expect.objectContaining({ type: "message", role: "assistant", text: "Updated example.txt." }),
      ])
    );
    expect(prompts[1]).toContain('Tool result from edit_file "example.txt":');
    expect(prompts[1]).toContain("after_hash: sha256:");
    expect(prompts[1]).toContain("kb_state: needs_sync");
    expect(prompts[1]).toContain("first_changed_line: 1");
    expect(prompts[1]).toContain("```diff");
    expect(prompts[1]).toContain("-enabled=false");
    expect(prompts[1]).toContain("+enabled=true");
    expect(prompts[1]).not.toContain("Edited example.txt");
  });

  it("continues executing tool calls until the model gives a final answer", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    await writeFile(join(workspace, "test-foo.ts"), 'console.log("hello");\n');
    const prompts: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText(request: { prompt: string }) {
          prompts.push(request.prompt);

          if (prompts.length === 1) {
            return {
              text: JSON.stringify({ tool: "find_file", args: { query: "test-foo.ts" } }),
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          if (prompts.length === 2) {
            return {
              text: JSON.stringify({ tool: "read_file", args: { path: "test-foo.ts" } }),
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          if (prompts.length === 3) {
            return {
              text: JSON.stringify({
                tool: "edit_file",
                args: {
                  path: "test-foo.ts",
                  edits: [{ old_text: 'console.log("hello");\n', new_text: 'console.log("HELLO, WORLD!!!!");\n' }],
                },
              }),
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          return {
            text: "Updated test-foo.ts.",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], 'change the console log text to say "HELLO, WORLD!!!!"');

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_call", label: "Tool find_file: test-foo.ts in ." }),
        expect.objectContaining({ type: "tool_call", label: "Tool read_file: test-foo.ts" }),
        expect.objectContaining({ type: "tool_call", label: "Tool edit_file: test-foo.ts (changed +1/-1)" }),
        expect.objectContaining({ type: "message", role: "assistant", text: "Updated test-foo.ts." }),
      ])
    );
    expect(prompts).toHaveLength(4);
  });
});

function createTestContext(workspaceRoot: string): AppContext {
  return {
    workspaceRoot,
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
      error() {},
    } as unknown as AppContext["logger"],
  };
}

async function getRuntimeKnowledgeFolderState(
  runtime: TopchesterAgentRuntime,
  command: string
): Promise<{ exists: boolean; isDirectory: boolean } | undefined> {
  const events = await runtime.submitSlashCommand(command);
  const event = events.find((candidate) => candidate.type === "knowledge_status");

  return event?.type === "knowledge_status"
    ? { exists: event.status.kbExists, isDirectory: event.status.kbIsDirectory }
    : undefined;
}
