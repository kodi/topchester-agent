import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type AppContext } from "../src/app/context.js";
import { type AgentRuntimeEvent } from "../src/agent/events.js";
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
        description: "show non-clean knowledge files",
      },
      {
        value: "/kb compile",
        description: "process project files into L1 entries",
      },
      {
        value: "/kb sync",
        description: "process non-clean project files into L1 entries",
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
        description: "show non-clean knowledge files",
      },
      {
        value: "/kb compile",
        description: "process project files into L1 entries",
      },
      {
        value: "/kb sync",
        description: "process non-clean project files into L1 entries",
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
    expect(getSlashCommandSuggestions("/kb s")).toEqual([
      {
        value: "/kb status",
        description: "show non-clean knowledge files",
      },
      {
        value: "/kb sync",
        description: "process non-clean project files into L1 entries",
      },
    ]);
    expect(getSlashCommandSuggestions("/nope")).toEqual([]);
    expect(getSlashCommandSuggestions("hello")).toEqual([]);
  });

  it("reports /kb usage for unknown KB subcommands", async () => {
    await expect(executeSlashCommand("/kb nope", { workspaceRoot: "/repo" })).resolves.toEqual({
      messages: ["Usage: /kb init, /kb compile, /kb sync, /kb reset, or /kb status"],
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

  it("executes /kb sync through the dirty-file L1 pipeline", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await executeSlashCommand("/kb init", { workspaceRoot: workspace });
    await writeFile(join(workspace, "src", "index.ts"), "export const value = 1;\n");

    const result = await executeSlashCommand("/kb sync", {
      workspaceRoot: workspace,
      modelGateway: {
        async generateText() {
          return {
            text: JSON.stringify({
              language: "typescript",
              summary: "Syncs the entry file.",
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

    expect(result.messages).toContain("KB sync");
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
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "index.ts"), "export const value = 1;\n");

    const result = await executeSlashCommand("/kb status", { workspaceRoot: workspace });

    expect(result.messages).toContain("KB status");
    expect(result.messages).toContain(`workspace: ${workspace}`);
    expect(result.messages).toContain(`knowledge folder: ${join(workspace, "topchester-kb")} [missing]`);
    expect(result.messages).toContain("non-clean files: 1");
    expect(result.messages).toContain("");
    expect(result.messages.some((line) => line.startsWith("missing_entry\tsrc/index.ts\t"))).toBe(true);
    expect(result.messages).toContain("----");
    expect(result.messages).toContain("total non-clean files: 1");
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
    await expect(getRuntimeKnowledgeFolderState(runtime, "/kb sync")).resolves.toEqual({
      exists: true,
      isDirectory: true,
    });
    await expect(getRuntimeKnowledgeFolderState(runtime, "/kb reset")).resolves.toEqual({
      exists: false,
      isDirectory: false,
    });
  });

  it("adds non-clean file count to startup KB status", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, "topchester-kb"), { recursive: true });
    await writeFile(join(workspace, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(
      join(workspace, "topchester-kb", "manifest.json"),
      JSON.stringify({ l1: { completed: 0, currentEntries: 1 } }, null, 2)
    );
    const runtime = new TopchesterAgentRuntime(createTestContext(workspace));

    const events = await runtime.checkKnowledgeBase();
    const event = events.find((candidate) => candidate.type === "knowledge_status");

    expect(event?.type === "knowledge_status" ? event.status.nonCleanFileCount : undefined).toBe(1);
  });

  it("adds startup guidance when KB files are not current", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, "topchester-kb"), { recursive: true });
    await writeFile(join(workspace, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(
      join(workspace, "topchester-kb", "manifest.json"),
      JSON.stringify({ l1: { completed: 0, currentEntries: 1 } }, null, 2)
    );
    const runtime = new TopchesterAgentRuntime(createTestContext(workspace));

    const events = await runtime.checkKnowledgeBase();
    const event = getKnowledgeStatusEvent(events);

    expect(event?.guidance).toBe("Next: run /kb sync to update project knowledge, or /kb status to inspect the files.");
  });

  it("refreshes non-clean file count after /kb sync", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "index.ts"), "export const value = 1;\n");
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: fakeKbModel(),
    });

    await runtime.submitSlashCommand("/kb init");
    await runtime.submitSlashCommand("/kb compile");
    await writeFile(join(workspace, "src", "index.ts"), "export const value = 2;\n");

    const dirtyEvents = await runtime.submitSlashCommand("/kb status");
    const syncEvents = await runtime.submitSlashCommand("/kb sync");

    expect(getKnowledgeStatusEvent(dirtyEvents)?.status.nonCleanFileCount).toBe(1);
    expect(getKnowledgeStatusEvent(syncEvents)?.status.nonCleanFileCount).toBe(0);
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
        expect.objectContaining({ type: "tool_call", label: "edit_file: example.txt (changed +1/-1)" }),
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

  it("injects an L1 context pack into runtime model prompts when KB is ready", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    await mkdir(join(workspace, "topchester-kb", "l1-files", "src", "tui"), { recursive: true });
    await writeFile(join(workspace, "topchester-kb", "manifest.json"), '{"l1":{"currentEntries":1}}\n');
    await writeFile(
      join(workspace, "topchester-kb", "l1-files", "src", "tui", "status.ts.json"),
      `${JSON.stringify(
        {
          $schema: "../schema/file-entry.v1.json",
          id: "file:src/tui/status.ts",
          layer: "L1",
          type: "file",
          path: "src/tui/status.ts",
          language: "typescript",
          content_hash: `sha256:${"f".repeat(64)}`,
          size_bytes: 222,
          last_scanned_at: "2026-05-14T00:00:00Z",
          scan_status: "current",
          summary: "Renders the TUI status bar.",
          responsibilities: ["Show status bar details."],
          symbols: [],
          imports: [],
          exports: [],
          module_ids: [],
          feature_ids: [],
          test_ids: [],
          evidence: [{ kind: "path", value: "src/tui/status.ts" }],
          confidence: "medium",
        },
        null,
        2
      )}\n`
    );
    const prompts: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText(request: { prompt: string }) {
          prompts.push(request.prompt);
          return {
            text: "Use src/tui/status.ts.",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "status bar");

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "message", role: "assistant", text: "Use src/tui/status.ts." }),
      ])
    );
    expect(prompts[0]).toContain("Topchester KB context pack:");
    expect(prompts[0]).toContain("src/tui/status.ts");
    expect(prompts[0]).toContain("Conversation:\nUser: status bar");
  });

  it("formats write_file tool calls and results for the final model prompt", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    const prompts: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText(request: { prompt: string }) {
          prompts.push(request.prompt);

          return prompts.length === 1
            ? {
                text: JSON.stringify({
                  tool: "write_file",
                  args: {
                    path: "test/example.test.ts",
                    content: "it('works', () => {});\n",
                    create_parent_dirs: true,
                  },
                }),
                providerId: "fake",
                modelId: "fake-agent",
                purpose: "agent.primary" as const,
              }
            : {
                text: "Created test/example.test.ts.",
                providerId: "fake",
                modelId: "fake-agent",
                purpose: "agent.primary" as const,
              };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "add a test");

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_call", label: "write_file: test/example.test.ts (created +1)" }),
        expect.objectContaining({ type: "message", role: "assistant", text: "Created test/example.test.ts." }),
      ])
    );
    expect(await readFile(join(workspace, "test", "example.test.ts"), "utf8")).toBe("it('works', () => {});\n");
    expect(prompts[1]).toContain('Tool result from write_file "test/example.test.ts":');
    expect(prompts[1]).toContain("after_hash: sha256:");
    expect(prompts[1]).toContain("bytes_written: 23");
    expect(prompts[1]).toContain("line_count: 1");
    expect(prompts[1]).toContain("kb_state: needs_sync");
    expect(prompts[1]).toContain("created_parent_dirs: test");
    expect(prompts[1]).toContain("summary: created +1");
    expect(prompts[1]).not.toContain("it('works'");
  });

  it("emits task-plan events after successful plan_todo calls", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    await writeFile(join(workspace, "notes.txt"), "hello\n");
    const prompts: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText(request: { prompt: string }) {
          prompts.push(request.prompt);

          if (prompts.length === 1) {
            return {
              text: JSON.stringify({
                tool: "plan_todo",
                args: {
                  items: [
                    { text: "Create visible plan", status: "completed" },
                    { text: "Read notes", status: "in_progress" },
                  ],
                },
              }),
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          if (prompts.length === 2) {
            return {
              text: JSON.stringify({ tool: "read_file", args: { path: "notes.txt" } }),
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          return {
            text: "Read notes.txt.",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "read notes with a plan");
    const taskPlanEvent = events.find((event) => event.type === "task_plan");

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_call", label: "plan_todo: 2 items, 1 active" }),
        expect.objectContaining({ type: "tool_call", label: "read_file: notes.txt" }),
        expect.objectContaining({ type: "message", role: "assistant", text: "Read notes.txt." }),
      ])
    );
    expect(taskPlanEvent?.type === "task_plan" ? taskPlanEvent.plan.items : undefined).toEqual([
      { text: "Create visible plan", status: "completed" },
      { text: "Read notes", status: "in_progress" },
    ]);
    expect(prompts[1]).toContain("Tool result from plan_todo:");
    expect(prompts[1]).toContain("current: Read notes");
    expect(prompts[1]).toContain("visible plan when one is active");
  });

  it("requires an open task plan to be closed before the final answer", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    const prompts: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText(request: { prompt: string }) {
          prompts.push(request.prompt);

          if (prompts.length === 1) {
            return {
              text: JSON.stringify({
                tool: "plan_todo",
                args: {
                  items: [
                    { text: "Inspect", status: "completed" },
                    { text: "Review diff", status: "in_progress" },
                  ],
                },
              }),
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          if (prompts.length === 2) {
            return {
              text: "Done too early.",
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          if (prompts.length === 3) {
            return {
              text: JSON.stringify({
                tool: "plan_todo",
                args: {
                  items: [
                    { text: "Inspect", status: "completed" },
                    { text: "Review diff", status: "completed" },
                  ],
                },
              }),
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          return {
            text: "Done after closing plan.",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "do multi-step work");
    const assistantMessages = events.filter((event) => event.type === "message" && event.role === "assistant");
    const taskPlanEvents = events.filter((event) => event.type === "task_plan");

    expect(assistantMessages).toEqual([expect.objectContaining({ text: "Done after closing plan." })]);
    expect(taskPlanEvents.at(-1)?.type === "task_plan" ? taskPlanEvents.at(-1)?.plan.items : undefined).toEqual([
      { text: "Inspect", status: "completed" },
      { text: "Review diff", status: "completed" },
    ]);
    expect(prompts[2]).toContain("The visible plan still has unfinished items");
    expect(prompts[2]).toContain("Done too early.");
  });

  it("clears an open task plan if the model ignores the close-plan reminder", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    let calls = 0;
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText() {
          calls += 1;

          if (calls === 1) {
            return {
              text: JSON.stringify({
                tool: "plan_todo",
                args: {
                  items: [
                    { text: "Inspect", status: "completed" },
                    { text: "Review diff", status: "in_progress" },
                  ],
                },
              }),
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
            };
          }

          return {
            text: "Done but still ignored plan.",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "do multi-step work");
    const taskPlanEvents = events.filter((event) => event.type === "task_plan");

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "message", role: "assistant", text: "Done but still ignored plan." }),
      ])
    );
    expect(taskPlanEvents.at(-1)?.type === "task_plan" ? taskPlanEvents.at(-1)?.plan.items : undefined).toEqual([]);
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
        expect.objectContaining({ type: "tool_call", label: "find_file: test-foo.ts in ." }),
        expect.objectContaining({ type: "tool_call", label: "read_file: test-foo.ts" }),
        expect.objectContaining({ type: "tool_call", label: "edit_file: test-foo.ts (changed +1/-1)" }),
        expect.objectContaining({ type: "message", role: "assistant", text: "Updated test-foo.ts." }),
      ])
    );
    expect(prompts).toHaveLength(4);
    expect(prompts[1]).toContain(
      "find_file results are paths only; if the user asked to read or answer from file contents, call read_file on the relevant path before answering. Do not ask the user to provide the read_file result or permission."
    );
  });

  it("returns tool errors to the model instead of failing the chat", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    const prompts: string[] = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateText(request: { prompt: string }) {
          prompts.push(request.prompt);

          return prompts.length === 1
            ? {
                text: JSON.stringify({ tool: "read_file", args: { path: "missing.txt" } }),
                providerId: "fake",
                modelId: "fake-agent",
                purpose: "agent.primary" as const,
              }
            : {
                text: "missing.txt does not exist.",
                providerId: "fake",
                modelId: "fake-agent",
                purpose: "agent.primary" as const,
              };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "read missing file");

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_call",
          label: expect.stringContaining("read_file failed:"),
        }),
        expect.objectContaining({ type: "message", role: "assistant", text: "missing.txt does not exist." }),
      ])
    );
    expect(events.at(-1)).toEqual({ type: "status", status: "ready" });
    expect(prompts[1]).toContain("Tool result from read_file:");
    expect(prompts[1]).toContain("Error:");
  });

  it("asks whether to continue or abort after the tool call limit", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    let calls = 0;
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateAgentStep() {
          calls += 1;

          return {
            text: "",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
            toolCalls: [
              {
                id: `list-files-${calls}`,
                tool: "list_files",
                args: { path: ".", recursive: false, limit: 1 },
                source: "text-json",
              },
            ],
            toolProtocol: "text-json" as const,
            protocolAttempts: [],
            providerRejectedTools: false,
            warnings: [],
            openRouterRoutingApplied: false,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    const events = await runtime.submitMessage([], "keep listing");
    const choiceEvent = events.find((event): event is Extract<AgentRuntimeEvent, { type: "choice" }> => {
      return event.type === "choice";
    });

    expect(events.filter((event) => event.type === "tool_call")).toHaveLength(75);
    expect(calls).toBe(76);
    expect(choiceEvent).toEqual(
      expect.objectContaining({
        tone: "warning",
        title: "Tool call limit reached",
        actions: [
          { label: "Continue", value: "Continue the previous task from where you stopped." },
          { label: "Abort", value: "__topchester_abort__" },
        ],
      })
    );
    expect(events.at(-1)).toEqual({ type: "status", status: "ready" });
  });

  it("keeps using text JSON for the rest of a turn after native tools are rejected", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    await writeFile(join(workspace, "data.txt"), "hello\n");
    const requests: Array<{ toolProtocol?: string }> = [];
    const runtime = new TopchesterAgentRuntime({
      ...createTestContext(workspace),
      modelGateway: {
        async generateAgentStep(request: { toolProtocol?: string }) {
          requests.push(request);

          if (requests.length === 1) {
            return {
              text: "",
              providerId: "fake",
              modelId: "fake-agent",
              purpose: "agent.primary" as const,
              toolCalls: [{ id: "text-json-0", tool: "read_file", args: { path: "data.txt" }, source: "text-json" }],
              toolProtocol: "text-json" as const,
              protocolAttempts: [
                { protocol: "native-openai-compatible" as const, status: "failed" as const, reason: "rejected" },
                { protocol: "text-json" as const, status: "used" as const, reason: "provider rejected native tools" },
              ],
              providerRejectedTools: true,
              warnings: [],
              openRouterRoutingApplied: false,
            };
          }

          return {
            text: "Done.",
            providerId: "fake",
            modelId: "fake-agent",
            purpose: "agent.primary" as const,
            toolCalls: [],
            toolProtocol: "text-json" as const,
            protocolAttempts: [
              {
                protocol: "native-openai-compatible" as const,
                status: "skipped" as const,
                reason: "toolProtocol=text-json",
              },
              { protocol: "text-json" as const, status: "used" as const, reason: "forced text JSON protocol" },
            ],
            providerRejectedTools: false,
            warnings: [],
            openRouterRoutingApplied: false,
          };
        },
      } as unknown as AppContext["modelGateway"],
    });

    await runtime.submitMessage([], "read data");

    expect(requests.map((request) => request.toolProtocol)).toEqual([undefined, "text-json"]);
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

function fakeKbModel(): AppContext["modelGateway"] {
  return {
    async generateText() {
      return {
        text: JSON.stringify({
          language: "typescript",
          summary: "Summarizes the source file.",
          responsibilities: ["Describe the file for the project knowledge base."],
          symbols: [],
          imports: [],
          exports: [],
          module_ids: [],
          feature_ids: [],
          test_ids: [],
          evidence: [{ kind: "path", value: "model-path" }],
          confidence: "medium",
        }),
        providerId: "fake",
        modelId: "fake-kb",
        purpose: "kb.summarize" as const,
      };
    },
  } as unknown as AppContext["modelGateway"];
}

function getKnowledgeStatusEvent(
  events: AgentRuntimeEvent[]
): Extract<AgentRuntimeEvent, { type: "knowledge_status" }> | undefined {
  return events.find((candidate): candidate is Extract<AgentRuntimeEvent, { type: "knowledge_status" }> => {
    return candidate.type === "knowledge_status";
  });
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
