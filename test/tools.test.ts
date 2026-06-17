import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  applyExactEdits,
  createProfileToolCatalog,
  createToolCatalog,
  createToolPermissionView,
  editWorkspaceFile,
  executeToolCall,
  findWorkspaceFilesByName,
  getProfileToolDefinitions,
  getToolPromptLines,
  grepWorkspace,
  isToolErrorResult,
  isToolAllowed,
  listWorkspaceFiles,
  parseToolCall,
  parseToolCallRejection,
  parseToolCallWithSource,
  parseNativeToolCall,
  resolveAgentProfile,
  readWorkspaceFile,
  createReadFileCache,
  toAiSdkToolSet,
  writeWorkspaceFile,
  createTaskPlanController,
  defineTool,
} from "../src/agent/tools.js";
import { toolRegistry } from "../src/agent/tools/registry.js";
import { editFileArgsSchema } from "../src/agent/tools/edit-file.js";
import { writeFileArgsSchema } from "../src/agent/tools/write-file.js";
import { getChatSystemPrompt } from "../src/agent/prompts.js";
import { createTopchesterLogger } from "../src/logging/index.js";
import { clearSessionOverlay, getSessionOverlayState } from "../src/knowledge/session-overlay.js";

describe("agent tools", () => {
  it("parses plan_todo tool calls from JSON", () => {
    expect(
      parseToolCall(
        '{"tool":"plan_todo","args":{"items":[{"text":"Inspect files","status":"completed"},{"text":"Run tests","status":"in_progress"}]}}'
      )
    ).toEqual({
      tool: "plan_todo",
      args: {
        items: [
          { text: "Inspect files", status: "completed" },
          { text: "Run tests", status: "in_progress" },
        ],
      },
    });
  });

  it("parses read_file tool calls from JSON", () => {
    expect(parseToolCall('{"tool":"read_file","args":{"path":"package.json"}}')).toEqual({
      tool: "read_file",
      args: { path: "package.json" },
    });
  });

  it("parses read_file tool calls from JSON fences", () => {
    expect(parseToolCall('```json\n{"tool":"read_file","args":{"path":"src/index.ts"}}\n```')).toEqual({
      tool: "read_file",
      args: { path: "src/index.ts" },
    });
  });

  it("summarizes binary files instead of returning raw read_file contents", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    await writeFile(join(workspace, "program.bin"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 3]));

    const result = await readWorkspaceFile(workspace, "program.bin");

    expect(result.skipped).toBe("binary");
    expect(result.bytes).toBe(8);
    expect(result.content).toContain("appears to be binary or non-UTF-8");
    expect(result.content).toContain("first_8_bytes_hex: 7f 45 4c 46 00 01 02 03");
    expect(result.content).not.toContain("\u0000");
    expect(result.hash).toMatch(/^sha256:/);
  });

  it("summarizes oversized files instead of returning raw read_file contents", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    await writeFile(join(workspace, "large.txt"), "a".repeat(512 * 1024 + 1));

    const result = await readWorkspaceFile(workspace, "large.txt");

    expect(result.skipped).toBe("too_large");
    expect(result.bytes).toBe(512 * 1024 + 1);
    expect(result.content).toContain("above the 524288 byte limit");
    expect(result.content).toContain("shell inspection tools");
    expect(result.content.length).toBeLessThan(2000);
    expect(result.hash).toMatch(/^sha256:/);
  });

  it("uses a tighter read_file limit in terminal-bench profile", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    await writeFile(join(workspace, "large.txt"), "a".repeat(64 * 1024 + 1));

    const result = await readWorkspaceFile(workspace, "large.txt", { benchmarkProfile: "terminal-bench" });

    expect(result.skipped).toBe("too_large");
    expect(result.bytes).toBe(64 * 1024 + 1);
    expect(result.content).toContain("above the 65536 byte limit");
    expect(result.content).toContain("Use read_file with offset and limit");
  });

  it("reads focused byte ranges from large files", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    await writeFile(join(workspace, "large.txt"), "0123456789".repeat(10_000));

    const result = await readWorkspaceFile(workspace, "large.txt", {
      benchmarkProfile: "terminal-bench",
      offset: 10,
      limit: 8,
    });

    expect(result.skipped).toBeUndefined();
    expect(result.offset).toBe(10);
    expect(result.length).toBe(8);
    expect(result.truncated).toBe(true);
    expect(result.content).toContain("read_file range: large.txt bytes 10-18 of 100000 (truncated)");
    expect(result.content).toContain("01234567");
  });

  it("dedupes repeated unchanged read_file ranges", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    await writeFile(join(workspace, "notes.txt"), "first line\nsecond line\n");
    const cache = createReadFileCache();

    const first = await readWorkspaceFile(workspace, "notes.txt", { cache });
    const second = await readWorkspaceFile(workspace, "notes.txt", { cache });

    expect(first.content).toBe("first line\nsecond line\n");
    expect(second.deduped).toBe(true);
    expect(second.content).toContain("exact unchanged file range was already shown");
    expect(second.content).not.toContain("second line");
  });

  it("parses grep tool calls from JSON", () => {
    expect(parseToolCall('{"tool":"grep","args":{"pattern":"needle","path":"src"}}')).toEqual({
      tool: "grep",
      args: { pattern: "needle", path: "src" },
    });
  });

  it("parses list_files tool calls from JSON", () => {
    expect(parseToolCall('{"tool":"list_files","args":{"path":"src","recursive":true,"limit":20}}')).toEqual({
      tool: "list_files",
      args: { path: "src", recursive: true, limit: 20 },
    });
  });

  it("parses list_files defaults from JSON", () => {
    expect(parseToolCall('{"tool":"list_files","args":{}}')).toEqual({
      tool: "list_files",
      args: { path: ".", recursive: false, limit: 500 },
    });
  });

  it("parses find_file tool calls from JSON", () => {
    expect(parseToolCall('{"tool":"find_file","args":{"query":"runtime"}}')).toEqual({
      tool: "find_file",
      args: { query: "runtime", path: ".", limit: 50 },
    });
  });

  it("parses edit_file tool calls from JSON", () => {
    expect(
      parseToolCall(
        '{"tool":"edit_file","args":{"path":"src/example.ts","expected_current_hash":"sha256:abc","edits":[{"old_text":"off","new_text":"on"}]}}'
      )
    ).toEqual({
      tool: "edit_file",
      args: {
        path: "src/example.ts",
        expected_current_hash: "sha256:abc",
        edits: [{ old_text: "off", new_text: "on" }],
      },
    });
  });

  it("parses apply_patch tool calls from JSON", () => {
    expect(
      parseToolCall(
        '{"tool":"apply_patch","args":{"patch":"*** Begin Patch\\n*** Update File: src/example.ts\\n@@\\n-const enabled = false;\\n+const enabled = true;\\n*** End Patch\\n"}}'
      )
    ).toEqual({
      tool: "apply_patch",
      args: {
        patch:
          "*** Begin Patch\n*** Update File: src/example.ts\n@@\n-const enabled = false;\n+const enabled = true;\n*** End Patch\n",
      },
    });
  });

  it("parses write_file tool calls from JSON", () => {
    expect(
      parseToolCall(
        '{"tool":"write_file","args":{"path":"test/example.test.ts","content":"it(\\"works\\", () => {});\\n","create_parent_dirs":true}}'
      )
    ).toEqual({
      tool: "write_file",
      args: {
        path: "test/example.test.ts",
        content: 'it("works", () => {});\n',
        create_parent_dirs: true,
      },
    });
  });

  it("parses finish_task tool calls from JSON", () => {
    expect(
      parseToolCall(
        '{"tool":"finish_task","args":{"final_response":"Changed src/example.ts.","files_changed":["src/example.ts"],"validation":["pnpm test"],"remaining_issues":[]}}'
      )
    ).toEqual({
      tool: "finish_task",
      args: {
        final_response: "Changed src/example.ts.",
        files_changed: ["src/example.ts"],
        validation: ["pnpm test"],
        remaining_issues: [],
      },
    });
  });

  it("parses inspect_command tool calls from JSON", () => {
    expect(
      parseToolCall('{"tool":"inspect_command","args":{"command":"pwd && rg --files docs/plans | head -20"}}')
    ).toEqual({
      tool: "inspect_command",
      args: {
        command: "pwd && rg --files docs/plans | head -20",
        workdir: ".",
        timeout_ms: 10_000,
      },
    });
  });

  it("parses run_validator tool calls from JSON", () => {
    expect(
      parseToolCall(
        '{"tool":"run_validator","args":{"command":"pnpm test test/tools.test.ts","validator":"test","timeout_ms":120000}}'
      )
    ).toEqual({
      tool: "run_validator",
      args: {
        command: "pnpm test test/tools.test.ts",
        validator: "test",
        workdir: ".",
        timeout_ms: 120_000,
      },
    });

    expect(
      parseToolCall(
        '{"tool":"run_validator","args":{"command":"pnpm format-check","validator":"format-check","workdir":".","timeout_ms":60000}}'
      )
    ).toEqual({
      tool: "run_validator",
      args: {
        command: "pnpm format-check",
        validator: "format_check",
        workdir: ".",
        timeout_ms: 60_000,
      },
    });

    expect(
      parseToolCall(
        '{"tool":"run_validator","args":{"command":"pnpm exec oxfmt . --check","validator":"format","workdir":".","timeout_ms":30000}}'
      )
    ).toEqual({
      tool: "run_validator",
      args: {
        command: "pnpm exec oxfmt . --check",
        validator: "format_check",
        workdir: ".",
        timeout_ms: 30_000,
      },
    });
  });

  it("reports known text tool calls with invalid arguments", () => {
    expect(parseToolCallRejection('{"tool":"read_file","args":{"path":123}}')).toMatchObject({
      source: "text-json",
      tool: "read_file",
    });
  });

  it("parses bash tool calls from JSON", () => {
    expect(parseToolCall('{"tool":"bash","args":{"command":"node scripts/check-fixtures.mjs"}}')).toEqual({
      tool: "bash",
      args: {
        command: "node scripts/check-fixtures.mjs",
        workdir: ".",
        timeout_ms: 120_000,
      },
    });
  });

  it("parses skills tool calls from JSON", () => {
    expect(parseToolCall('{"tool":"skills_list","args":{}}')).toEqual({
      tool: "skills_list",
      args: {},
    });
    expect(parseToolCall('{"tool":"skill_view","args":{"name":"code-review"}}')).toEqual({
      tool: "skill_view",
      args: { name: "code-review" },
    });
  });

  it("parses the first tool call when the model emits concatenated tool JSON", () => {
    expect(
      parseToolCall(
        '{"tool":"find_file","args":{"query":"test-foo.ts"}}{"tool":"read_file","args":{"path":"test-foo.ts"}}'
      )
    ).toEqual({
      tool: "find_file",
      args: { query: "test-foo.ts", path: ".", limit: 50 },
    });
  });

  it("parses a leading tool call when the model appends prose", () => {
    expect(
      parseToolCall(
        '{"tool":"edit_file","args":{"path":"test-foo.ts","edits":[{"old_text":"console.log(\\"hello\\");","new_text":"console.log(\\"HELLO\\");"}]}}Changed the file.'
      )
    ).toEqual({
      tool: "edit_file",
      args: {
        path: "test-foo.ts",
        edits: [{ old_text: 'console.log("hello");', new_text: 'console.log("HELLO");' }],
      },
    });
  });

  it("parses a leading tool call with literal newlines inside JSON strings", () => {
    expect(
      parseToolCall(
        '{"tool":"plan_todo","args":{"items":[{"text":"Inspect message rendering","status":"completed"},{"text":"Find background styling\n call","status":"completed"}]}}The answer starts here.'
      )
    ).toEqual({
      tool: "plan_todo",
      args: {
        items: [
          { text: "Inspect message rendering", status: "completed" },
          { text: "Find background styling\n call", status: "completed" },
        ],
      },
    });
  });

  it("parses a tool call that starts on its own line after prose", () => {
    expect(
      parseToolCall(
        [
          "I notice my write_file call was cut off mid-content. Let me write the complete plan file.",
          "",
          '{"tool":"write_file","args":{"path":"docs/plans/apply-plan.md","content":"# Apply Plan\\n\\n## Summary\\n\\nWrite the plan.\\n"}}',
        ].join("\n")
      )
    ).toEqual({
      tool: "write_file",
      args: {
        path: "docs/plans/apply-plan.md",
        content: "# Apply Plan\n\n## Summary\n\nWrite the plan.\n",
      },
    });
  });

  it("rejects unknown tools and invalid tool args", () => {
    expect(parseToolCall('{"tool":"unknown","args":{}}')).toBeUndefined();
    expect(
      parseToolCall(
        '{"tool":"plan_todo","args":{"items":[{"text":"One","status":"in_progress"},{"text":"Two","status":"in_progress"}]}}'
      )
    ).toBeUndefined();
    expect(parseToolCall('{"tool":"read_file","args":{"path":123}}')).toBeUndefined();
    expect(parseToolCall('{"tool":"list_files","args":{"limit":0}}')).toBeUndefined();
    expect(parseToolCall('{"tool":"grep","args":{"path":"src"}}')).toBeUndefined();
    expect(parseToolCall('{"tool":"find_file","args":{"query":""}}')).toBeUndefined();
  });

  it("converts every registered tool to an AI SDK tool schema", () => {
    const tools = toAiSdkToolSet(Object.values(toolRegistry));

    expect(Object.keys(tools).sort()).toEqual(Object.keys(toolRegistry).sort());
    expect(tools.read_file).toMatchObject({
      description: "Read a UTF-8 file inside the workspace.",
      inputSchema: toolRegistry.read_file.argsSchema,
    });
  });

  it("keeps native tool args validated by the registered Zod schema", () => {
    const readFileTool = toAiSdkToolSet(Object.values(toolRegistry)).read_file;

    expect(readFileTool.inputSchema).toBe(toolRegistry.read_file.argsSchema);
    expect(toolRegistry.read_file.argsSchema.safeParse({ path: "package.json" }).success).toBe(true);
    expect(toolRegistry.read_file.argsSchema.safeParse({ path: 123 }).success).toBe(false);
  });

  it("uses an active tool catalog for dynamic JSON, XML, native, and AI SDK tool paths", async () => {
    const dynamicTool = defineTool({
      name: "mcp_fixture_echo",
      description: "Echo a dynamic MCP fixture value.",
      prompt: "mcp_fixture_echo: echo a dynamic MCP fixture value.",
      argsSchema: z.object({ message: z.string() }),
      parallelSafe: true,
      async execute(_context, args) {
        return {
          tool: "mcp_fixture_echo",
          content: `echo:${args.message}`,
        };
      },
    });
    const catalog = createToolCatalog([dynamicTool]);
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));

    expect(parseToolCall('{"tool":"mcp_fixture_echo","args":{"message":"json"}}', catalog)).toEqual({
      tool: "mcp_fixture_echo",
      args: { message: "json" },
    });
    expect(
      parseToolCallWithSource(
        "<mcp_fixture_echo><message>xml</message></mcp_fixture_echo>",
        ["text-json", "text-xml"],
        catalog
      )
    ).toEqual({
      source: "text-xml",
      remainder: "",
      call: {
        tool: "mcp_fixture_echo",
        args: { message: "xml" },
      },
    });
    expect(parseToolCallWithSource("<mcp_fixture_echo><message>xml</message></mcp_fixture_echo>")).toBeUndefined();
    expect(toAiSdkToolSet(catalog.definitions()).mcp_fixture_echo).toMatchObject({
      description: "Echo a dynamic MCP fixture value.",
      inputSchema: dynamicTool.argsSchema,
    });
    expect(parseNativeToolCall("mcp_fixture_echo", { message: "native" }, catalog)).toEqual({
      tool: "mcp_fixture_echo",
      args: { message: "native" },
    });

    await expect(
      executeToolCall(workspace, { tool: "mcp_fixture_echo", args: { message: "run" } }, { toolCatalog: catalog })
    ).resolves.toEqual({
      tool: "mcp_fixture_echo",
      content: "echo:run",
    });
  });

  it("keeps dynamic catalog tools on the primary profile only", () => {
    const dynamicTool = defineTool({
      name: "mcp_fixture_echo",
      description: "Echo a dynamic MCP fixture value.",
      prompt: "mcp_fixture_echo: echo a dynamic MCP fixture value.",
      argsSchema: z.object({ message: z.string() }),
      async execute(_context, args) {
        return {
          tool: "mcp_fixture_echo",
          content: args.message,
        };
      },
    });
    const primaryCatalog = createProfileToolCatalog(createToolPermissionView(resolveAgentProfile("primary")), [
      dynamicTool,
    ]);
    const subagentCatalog = createProfileToolCatalog(createToolPermissionView(resolveAgentProfile("general")), [
      dynamicTool,
    ]);

    expect(primaryCatalog.has("mcp_fixture_echo")).toBe(true);
    expect(subagentCatalog.has("mcp_fixture_echo")).toBe(false);
  });

  it("parses conservative XML tool calls after JSON", () => {
    expect(parseToolCallWithSource("<read_file><path>data.txt</path></read_file>")).toEqual({
      source: "text-xml",
      remainder: "",
      call: {
        tool: "read_file",
        args: { path: "data.txt" },
      },
    });
    expect(parseToolCallWithSource('<tool_call>find_file query="runtime" limit=20</tool_call>')).toEqual({
      source: "text-xml",
      remainder: "",
      call: {
        tool: "find_file",
        args: { query: "runtime", path: ".", limit: 20 },
      },
    });
    expect(parseToolCallWithSource('<tool_call>grep {"pattern":"needle","path":"src"}</tool_call>')).toEqual({
      source: "text-xml",
      remainder: "",
      call: {
        tool: "grep",
        args: { pattern: "needle", path: "src" },
      },
    });
    expect(
      parseToolCallWithSource(
        '<tool_call>plan_todo {"items":[{"text":"Inspect files","status":"in_progress"}]}</tool_call>'
      )
    ).toEqual({
      source: "text-xml",
      remainder: "",
      call: {
        tool: "plan_todo",
        args: { items: [{ text: "Inspect files", status: "in_progress" }] },
      },
    });
  });

  it("rejects ambiguous or invalid XML tool calls", () => {
    expect(parseToolCallWithSource("<unknown><path>data.txt</path></unknown>")).toBeUndefined();
    expect(parseToolCallWithSource("<read_file><path>a.txt</path><path>b.txt</path></read_file>")).toBeUndefined();
    expect(parseToolCallWithSource("<read_file><path><nested>a.txt</nested></path></read_file>")).toBeUndefined();
    expect(
      parseToolCallWithSource("<read_file><path>data.txt</path></read_file><read_file><path>two.txt</path></read_file>")
    ).toBeUndefined();
  });

  it("executes parsed tool calls through the registry", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    await writeFile(join(workspace, "package.json"), '{"name":"real"}\n');
    const call = parseToolCall('{"tool":"read_file","args":{"path":"package.json"}}');

    if (!call) {
      throw new Error("Expected read_file tool call to parse.");
    }

    await expect(executeToolCall(workspace, call)).resolves.toEqual({
      tool: "read_file",
      path: "package.json",
      content: '{"name":"real"}\n',
      hash: hashContent('{"name":"real"}\n'),
    });
  });

  it("applies patch-style updates and creates files", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "example.ts"), "const enabled = false;\n");
    const call = parseToolCall(
      JSON.stringify({
        tool: "apply_patch",
        args: {
          patch: [
            "*** Begin Patch",
            "*** Update File: src/example.ts",
            "@@",
            "-const enabled = false;",
            "+const enabled = true;",
            "*** Add File: src/new.ts",
            "+export const value = 1;",
            "*** End Patch",
            "",
          ].join("\n"),
        },
      })
    );

    if (!call) {
      throw new Error("Expected apply_patch tool call to parse.");
    }

    const result = await executeToolCall(workspace, call);

    expect(result.tool).toBe("apply_patch");
    expect(result.content).toContain("Edited src/example.ts");
    expect(result.content).toContain("Created src/new.ts");
    expect(await readFile(join(workspace, "src", "example.ts"), "utf8")).toBe("const enabled = true;\n");
    expect(await readFile(join(workspace, "src", "new.ts"), "utf8")).toBe("export const value = 1;\n");
  });

  it("loads nested project instructions once for path-scoped read tools", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "AGENTS.md"), "Root rule.\n");
    await writeFile(join(workspace, "src", "AGENTS.md"), "Use src naming rules.\n");
    await writeFile(join(workspace, "src", "a.txt"), "a\n");
    await writeFile(join(workspace, "src", "b.txt"), "b\n");
    const projectInstructions = { shownSourceKeys: new Set(["AGENTS.md"]) };
    const firstCall = parseToolCall('{"tool":"read_file","args":{"path":"src/a.txt"}}');
    const secondCall = parseToolCall('{"tool":"read_file","args":{"path":"src/b.txt"}}');

    if (!firstCall || !secondCall) {
      throw new Error("Expected read_file tool calls to parse.");
    }

    const first = await executeToolCall(workspace, firstCall, { projectInstructions });
    const second = await executeToolCall(workspace, secondCall, { projectInstructions });

    expect(first.content).toContain("Use src naming rules.");
    expect(first.projectInstructions?.sources.map((source) => source.relativePath)).toEqual(["src/AGENTS.md"]);
    expect(second.content).toBe("b\n");
    expect(second.projectInstructions).toBeUndefined();
  });

  it("does not attach project instructions when directly reading an instruction file", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "AGENTS.md"), "Use src naming rules.\n");
    const call = parseToolCall('{"tool":"read_file","args":{"path":"src/AGENTS.md"}}');

    if (!call) {
      throw new Error("Expected read_file tool call to parse.");
    }

    const result = await executeToolCall(workspace, call, { projectInstructions: { shownSourceKeys: new Set() } });

    expect(result.content).toBe("Use src naming rules.\n");
    expect(result.projectInstructions).toBeUndefined();
  });

  it("guards nested edit_file until newly relevant project instructions have been shown", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "AGENTS.md"), "Root rule.\n");
    await writeFile(join(workspace, "src", "AGENTS.md"), "Use src naming rules.\n");
    await writeFile(join(workspace, "src", "value.txt"), "enabled=false\n");
    const projectInstructions = { shownSourceKeys: new Set(["AGENTS.md"]) };
    const call = parseToolCall(
      '{"tool":"edit_file","args":{"path":"src/value.txt","edits":[{"old_text":"enabled=false\\n","new_text":"enabled=true\\n"}]}}'
    );

    if (!call) {
      throw new Error("Expected edit_file tool call to parse.");
    }

    const guarded = await executeToolCall(workspace, call, { projectInstructions });

    expect(guarded.content).toContain("edit_file did not change src/value.txt.");
    expect(guarded.content).toContain("Use src naming rules.");
    expect(guarded.warning).toContain("retry edit_file");
    expect(await readFile(join(workspace, "src", "value.txt"), "utf8")).toBe("enabled=false\n");

    const edited = await executeToolCall(workspace, call, { projectInstructions });

    expect(edited.content).toContain("Edited src/value.txt");
    expect(await readFile(join(workspace, "src", "value.txt"), "utf8")).toBe("enabled=true\n");
  });

  it("rejects instruction-file edits without explicit user intent", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    await writeFile(join(workspace, "AGENTS.md"), "Keep this rule.\n");
    const call = parseToolCall(
      '{"tool":"edit_file","args":{"path":"AGENTS.md","edits":[{"old_text":"Keep this rule.\\n","new_text":"Change this rule.\\n"}]}}'
    );

    if (!call) {
      throw new Error("Expected edit_file tool call to parse.");
    }

    const result = await executeToolCall(workspace, call, {
      currentUserMessage: "Update the README.",
      projectInstructions: { shownSourceKeys: new Set(["AGENTS.md"]) },
    });

    expect(result.content).toContain("edit_file did not change AGENTS.md.");
    expect(result.warning).toContain("explicit user intent");
    expect(await readFile(join(workspace, "AGENTS.md"), "utf8")).toBe("Keep this rule.\n");
  });

  it("allows instruction-file edits when the user explicitly asks for them", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    await writeFile(join(workspace, "AGENTS.md"), "Keep this rule.\n");
    const call = parseToolCall(
      '{"tool":"edit_file","args":{"path":"AGENTS.md","edits":[{"old_text":"Keep this rule.\\n","new_text":"Change this rule.\\n"}]}}'
    );

    if (!call) {
      throw new Error("Expected edit_file tool call to parse.");
    }

    const result = await executeToolCall(workspace, call, {
      currentUserMessage: "Update AGENTS.md with the new instruction.",
      projectInstructions: { shownSourceKeys: new Set(["AGENTS.md"]) },
    });

    expect(result.content).toContain("Edited AGENTS.md");
    expect(await readFile(join(workspace, "AGENTS.md"), "utf8")).toBe("Change this rule.\n");
  });

  it("rejects instruction-file writes without explicit user intent", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    const call = parseToolCall('{"tool":"write_file","args":{"path":"AGENTS.override.md","content":"Local rule.\\n"}}');

    if (!call) {
      throw new Error("Expected write_file tool call to parse.");
    }

    const result = await executeToolCall(workspace, call, {
      currentUserMessage: "Create a local note.",
      projectInstructions: { shownSourceKeys: new Set() },
    });

    expect(result.content).toContain("write_file did not change AGENTS.override.md.");
    expect(result.warning).toContain("explicit user intent");
    await expect(readFile(join(workspace, "AGENTS.override.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("guards configured instruction filenames", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    await writeFile(join(workspace, "CLAUDE.md"), "Keep this rule.\n");
    const call = parseToolCall(
      '{"tool":"edit_file","args":{"path":"CLAUDE.md","edits":[{"old_text":"Keep this rule.\\n","new_text":"Change this rule.\\n"}]}}'
    );

    if (!call) {
      throw new Error("Expected edit_file tool call to parse.");
    }

    const result = await executeToolCall(workspace, call, {
      config: { instructions: { fallbackFiles: ["CLAUDE.md"] } },
      currentUserMessage: "Update a normal source file.",
      projectInstructions: { shownSourceKeys: new Set(["CLAUDE.md"]) },
    });

    expect(result.content).toContain("edit_file did not change CLAUDE.md.");
    expect(await readFile(join(workspace, "CLAUDE.md"), "utf8")).toBe("Keep this rule.\n");
  });

  it("executes plan_todo through runtime-provided task-plan state", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    const taskPlan = createTaskPlanController();
    const call = parseToolCall(
      '{"tool":"plan_todo","args":{"items":[{"text":"Inspect files","status":"completed"},{"text":"Run tests","status":"in_progress"}]}}'
    );

    if (!call) {
      throw new Error("Expected plan_todo tool call to parse.");
    }

    await expect(executeToolCall(workspace, call, { taskPlan })).resolves.toMatchObject({
      tool: "plan_todo",
      pendingCount: 0,
      inProgressCount: 1,
      completedCount: 1,
      currentItem: "Run tests",
      content: expect.stringContaining("current: Run tests"),
    });
    expect(taskPlan.get().items).toEqual([
      { text: "Inspect files", status: "completed" },
      { text: "Run tests", status: "in_progress" },
    ]);
  });

  it("requires runtime task-plan state for plan_todo", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    const call = parseToolCall(
      '{"tool":"plan_todo","args":{"items":[{"text":"Inspect files","status":"in_progress"}]}}'
    );

    if (!call) {
      throw new Error("Expected plan_todo tool call to parse.");
    }

    const result = await executeToolCall(workspace, call);

    expect(isToolErrorResult(result)).toBe(true);
    expect(result.content).toContain("plan_todo requires runtime task-plan state");
  });

  it("filters denied tools out of profile prompts and native tool schemas", () => {
    const profile = resolveAgentProfile("explore");
    const permissions = createToolPermissionView(profile);
    const prompt = getChatSystemPrompt({ profile, permissions });
    const nativeTools = toAiSdkToolSet(getProfileToolDefinitions(permissions));

    expect(prompt).toContain("Agent profile: Explore (explore).");
    expect(prompt).not.toContain("plan_todo:");
    expect(prompt).not.toContain("edit_file:");
    expect(prompt).not.toContain("write_file:");
    expect(prompt).not.toContain("git_commit:");
    expect(Object.keys(nativeTools).sort()).toEqual([
      "find_file",
      "git_diff",
      "git_log",
      "git_status",
      "grep",
      "list_files",
      "read_file",
      "skill_view",
      "skills_list",
    ]);
  });

  it("rejects denied tools at execution time", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    const permissions = createToolPermissionView(resolveAgentProfile("explore"));
    const call = parseToolCall(
      '{"tool":"edit_file","args":{"path":"a.txt","edits":[{"old_text":"a","new_text":"b"}]}}'
    );

    if (!call) {
      throw new Error("Expected edit_file tool call to parse.");
    }

    const result = await executeToolCall(workspace, call, { permissions });

    expect(isToolErrorResult(result)).toBe(true);
    expect(result.content).toContain('Tool "edit_file" is not allowed for agent profile "explore"');
  });

  it("explains how to recover when run_validator receives a mutating formatter command", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({ scripts: { "format": "oxfmt .", "format-check": "oxfmt . --check" } })
    );
    const call = parseToolCall(
      '{"tool":"run_validator","args":{"command":"pnpm format","validator":"format_check","timeout_ms":10000}}'
    );

    if (!call) {
      throw new Error("Expected run_validator tool call to parse.");
    }

    const result = await executeToolCall(workspace, call);

    expect(isToolErrorResult(result)).toBe(true);
    expect(result.content).toContain("command policy rejected 'format' because it is not a validator script");
    expect(result.content).toContain("Use run_validator with a check-only command such as pnpm format-check");
    expect(result.content).toContain("use bash for mutating formatter commands such as pnpm format");
  });

  it("inherits parent denied tools when building child profile permissions", () => {
    const profile = resolveAgentProfile("explore");
    const permissions = createToolPermissionView(profile, { deniedTools: ["read_file"] });

    expect(isToolAllowed(permissions, "read_file")).toBe(false);
    expect(isToolAllowed(permissions, "grep")).toBe(true);
  });

  it("rejects task prompts that ask read-only subagents to execute shell commands", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    const call = parseToolCall(
      JSON.stringify({
        tool: "task",
        args: {
          description: "Inspect binary",
          prompt: "Use bash to run xxd /app/doomgeneric_mips and report output.",
          subagent_type: "explore",
        },
      })
    );

    if (!call) {
      throw new Error("Expected task tool call to parse.");
    }

    const result = await executeToolCall(workspace, call, {
      subagents: {
        async runTask() {
          throw new Error("subagent should not run");
        },
      } as any,
    });

    expect(isToolErrorResult(result)).toBe(true);
    expect(result.content).toContain('task subagent "explore" cannot run bash');
    expect(result.content).toContain("Use the parent bash/run_validator tools directly");
  });

  it("gets model prompt lines from the tool registry", () => {
    expect(getToolPromptLines()).toEqual([
      'task: delegate read-only file/search/git research to a child agent. Do not use task for shell commands, bash, Python/Node scripts, validators, edits, writes, finish_task, or other execution work; use parent tools directly. To use it, reply with only JSON: {"tool":"task","args":{"description":"Inspect runtime event flow","prompt":"Read the runtime and summarize how events are emitted.","subagent_type":"explore"}}',
      'plan_todo: replace the visible session task plan for genuinely multi-step work. Usually create it once after initial orientation, keep 2-6 short milestone items, exactly one in_progress item while work remains, and batch updates when milestones change. Do not call plan_todo twice in a row, after routine reads/searches, after failed edit attempts, for wording-only changes, or just to report completed work before a final answer. To use it, reply with only JSON: {"tool":"plan_todo","args":{"items":[{"text":"Inspect relevant files","status":"in_progress"},{"text":"Implement focused change","status":"pending"}]}}',
      'read_file: read a UTF-8 file inside the workspace. For large files, use offset and limit to read a focused byte range. To use it, reply with only JSON: {"tool":"read_file","args":{"path":"package.json"}}',
      'list_files: list files and directories inside the workspace; top-level by default, recursive only when requested, with "/" after directory names. To use it, reply with only JSON: {"tool":"list_files","args":{"path":"src","recursive":false,"limit":500}}',
      'grep: search text inside file contents in the workspace; output lines are the files containing the matched text, and paths mentioned inside those lines are not confirmed files unless checked with find_file or read_file. To use it, reply with only JSON: {"tool":"grep","args":{"pattern":"function name","path":"src"}}',
      'find_file: find existing files by fuzzy path or filename inside the workspace; matches may appear in the middle of a filename, and results are file paths, not file contents. To use it, reply with only JSON: {"tool":"find_file","args":{"query":"runtime"}}',
      'apply_patch: apply a patch to files inside the workspace. Use it for real source changes, especially multi-file edits. The patch must start with "*** Begin Patch" and end with "*** End Patch"; use "*** Add File: path", "*** Update File: path", or "*** Delete File: path" sections. For updates, include @@ hunks with context/removal/addition lines. Example: {"tool":"apply_patch","args":{"patch":"*** Begin Patch\\n*** Update File: src/example.ts\\n@@\\n-const enabled = false;\\n+const enabled = true;\\n*** End Patch\\n"}}',
      'edit_file: edit an existing UTF-8 file inside the workspace with exact old_text/new_text replacements; read the file first, keep old_text small but unique, and make multiple disjoint edits for one file in one call. expected_current_hash is optional and must be the current/pre-edit hash returned by the latest read_file for that file; never invent it or use a predicted after-edit hash. To use it, reply with only JSON: {"tool":"edit_file","args":{"path":"src/example.ts","expected_current_hash":"sha256:current-file-hash-from-read_file","edits":[{"old_text":"const enabled = false;\\n","new_text":"const enabled = true;\\n"}]}}',
      'write_file: create a new UTF-8 file inside the workspace by default; use edit_file for targeted changes to existing files; pass create_parent_dirs:true only when creating the folder path is intended. Replace an existing whole file only with overwrite:true and expected_current_hash set to the current/pre-write hash returned by the latest read_file for that file; never invent it or use a predicted after-write hash. To create a file, reply with only JSON: {"tool":"write_file","args":{"path":"test/example.test.ts","content":"import { it, expect } from \\"vitest\\";\\n\\nit(\\"works\\", () => {\\n  expect(true).toBe(true);\\n});\\n","create_parent_dirs":true}}',
      'git_status: inspect branch, head, clean state, staged, unstaged, and untracked files without parsing shell output. To use it, reply with only JSON: {"tool":"git_status","args":{"path":".","include_untracked":true}}',
      'git_diff: inspect a bounded Git diff; use scope "all", "unstaged", or "staged", and include_untracked:true only when untracked file patches are needed. To use it, reply with only JSON: {"tool":"git_diff","args":{"scope":"all","include_untracked":true}}',
      'git_log: inspect recent commits without parsing shell output. To use it, reply with only JSON: {"tool":"git_log","args":{"limit":10,"path":"src/agent/runtime/index.ts"}}',
      'git_add: stage only explicit paths the user asked to stage; first inspect git_status, reject broad paths, and pass expected_status for each path. To use it, reply with only JSON: {"tool":"git_add","args":{"paths":["src/example.ts"],"expected_status":[{"path":"src/example.ts","status":"modified"}]}}',
      'git_commit: commit only after the user explicitly asks and staged paths exactly match expected_staged_paths. To use it, reply with only JSON: {"tool":"git_commit","args":{"message":"Add feature","expected_staged_paths":["src/example.ts"]}}',
      'inspect_command: run a safe read-only discovery command inside the workspace for quick repo orientation; prefer read_file, list_files, grep, and find_file for exact file tasks, and do not use it for builds, tests, installs, network, shell scripts, edits, or user-requested specific commands such as node --version, which node, or pnpm --version. To use it, reply with only JSON: {"tool":"inspect_command","args":{"command":"pwd && rg --files docs/plans | head -20","workdir":".","timeout_ms":10000}}',
      'run_validator: run a strict verification command after edits, such as tests, lint, typecheck, build, check, format-check, or smoke; format means check-only commands such as pnpm format-check, not mutating formatter commands such as pnpm format; failed exits are useful evidence and should be inspected before retrying. To use it, reply with only JSON: {"tool":"run_validator","args":{"command":"pnpm test test/tools.test.ts","validator":"test","workdir":".","timeout_ms":120000}}',
      'bash: run an approval-gated shell command for terminal work that needs shell syntax, one-off user-requested commands, package manager commands, scripts, pipelines, redirects, or chaining. Prefer run_validator for tests, lint, typecheck, build, check, format-check, and smoke. To use it, reply with only JSON: {"tool":"bash","args":{"command":"printf hi | wc -c","workdir":".","timeout_ms":120000,"description":"count bytes"}}',
      'finish_task: complete the task with a brief final response only after tool results prove the work is done. In benchmark or require-finish mode, this is the only valid terminal action; normal assistant messages are progress notes and do not finish the task, and remaining_issues must be empty. For implementation tasks, do not call finish_task until source files were changed by edit_file, write_file, apply_patch, or another mutating tool, unless no code change is truly required. Example: {"tool":"finish_task","args":{"final_response":"Changed src/foo.ts and ran pnpm test foo.test.ts.","files_changed":["src/foo.ts"],"validation":["pnpm test foo.test.ts"],"remaining_issues":[]}}',
      'skills_list: List available on-demand skills without loading full skill bodies. Args: {}. Example: {"tool":"skills_list","args":{}}',
      'skill_view: Load full SKILL.md content for one skill by name. Args: {"name":"skill-name"}. Example: {"tool":"skill_view","args":{"name":"code-review"}}',
    ]);
  });

  it("tells the model to verify paths mentioned inside grep output", () => {
    expect(getChatSystemPrompt()).toContain(
      "If grep output mentions another path, treat that mentioned path as content until find_file or read_file confirms it exists."
    );
  });

  it("tells the model when to use plan_todo", () => {
    const prompt = getChatSystemPrompt();

    expect(prompt).toContain("Use plan_todo for genuinely multi-step work");
    expect(prompt).toContain("Batch plan_todo updates");
    expect(prompt).toContain("Never call plan_todo twice in a row");
    expect(prompt).toContain("Do not use plan_todo for simple one-step answers");
    expect(prompt).toContain("Do not call plan_todo only to summarize completed work before a final answer");
  });

  it("tells the model how to use edit_file safely", () => {
    const prompt = getChatSystemPrompt();

    expect(prompt).toContain("When using a tool, output exactly one tool JSON object and no prose");
    expect(prompt).toContain("After the tool result, either output the next single tool JSON object");
    expect(prompt).toContain("Use read_file before editing a file");
    expect(prompt).toContain("use the current pre-edit/pre-write hash from the latest read_file result");
    expect(prompt).toContain("Use edit_file for targeted edits to existing files");
    expect(prompt).toContain("Keep edit_file old_text small but unique");
    expect(prompt).toContain("Do not include line labels or grep prefixes in old_text");
  });

  it("tells the model how to use write_file safely", () => {
    const prompt = getChatSystemPrompt();

    expect(prompt).toContain("Use write_file to create new files by default");
    expect(prompt).toContain("It fails when the file already exists");
    expect(prompt).toContain("Pass write_file create_parent_dirs:true only when");
    expect(prompt).toContain(
      "the file already exists unless you are replacing the whole file with overwrite:true and expected_current_hash from read_file"
    );
    expect(prompt).toContain("Do not use inspect_command for file creation or file mutation");
  });

  it("tells the model to verify edits with run_validator", () => {
    const prompt = getChatSystemPrompt();

    expect(prompt).toContain("After code edits, use run_validator when there is a relevant test");
    expect(prompt).toContain("Use run_validator for format-check only");
    expect(prompt).toContain("Use bash for mutating formatter commands such as pnpm format");
    expect(prompt).toContain("Failed run_validator exits are evidence");
    expect(prompt).toContain("retry with bash when approval or project policy allows it");
    expect(prompt).toContain("Do not use inspect_command for tests, builds, lint, typecheck");
    expect(prompt).toContain("When the user explicitly asks to run a command or asks for command output");
    expect(prompt).toContain("bash is the approval-gated shell runner");
    expect(prompt).toContain("let permission policy return the allowed, rejected, or approval result");
    expect(prompt).toContain("Prefer dedicated tools for file reads, file writes, edits, Git inspection, and searches");
    expect(prompt).toContain("Use bash for arbitrary shell syntax");
    expect(prompt).toContain("Do not use bash for file reads, file writes, Git inspection");
  });

  it("tells the model inspect_command is only for read-only orientation", () => {
    const prompt = getChatSystemPrompt();

    expect(prompt).toContain("Use list_files, grep, find_file, and read_file for exact file listing");
    expect(prompt).toContain("Use git_status, git_diff, and git_log for Git state");
    expect(prompt).toContain("Use git_add and git_commit only when the user explicitly asks");
    expect(prompt).toContain("Use inspect_command only for quick read-only repo orientation");
    expect(prompt).toContain("when the user did not ask to run a specific command");
    expect(prompt).toContain("inspect_command is not a shell");
    expect(prompt).toContain("Unsafe commands, shell expansion, scripts, installs, builds, tests, network access");
    expect(prompt).toContain("Do not use inspect_command when the user asks to run a specific command");
    expect(prompt).toContain("use bash or run_validator instead");
  });

  it("logs tool calls and result metadata without debug-level content", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    const logFile = join(workspace, "tool.log");
    await writeFile(join(workspace, "package.json"), '{"name":"real"}\n');
    const call = parseToolCall('{"tool":"read_file","args":{"path":"package.json"}}');

    if (!call) {
      throw new Error("Expected read_file tool call to parse.");
    }

    await withEnv({ TOPCHESTER_LOG_LEVEL: "debug", TOPCHESTER_LOG_FILE: logFile }, async () => {
      const { logger } = createTopchesterLogger(workspace);

      await executeToolCall(workspace, call, { logger });

      const logLines = (await readFile(logFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      expect(logLines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "tool_call", tool: "read_file" }),
          expect.objectContaining({ event: "tool_result", tool: "read_file", contentLength: 16 }),
        ])
      );
      expect(JSON.stringify(logLines)).not.toContain('{"name":"real"}');
    });
  });

  it("executes inspect_command through the registry and logs bounded metadata", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    const logFile = join(workspace, "tool.log");
    const call = parseToolCall('{"tool":"inspect_command","args":{"command":"pwd"}}');

    if (!call) {
      throw new Error("Expected inspect_command tool call to parse.");
    }

    await withEnv({ TOPCHESTER_LOG_LEVEL: "debug", TOPCHESTER_LOG_FILE: logFile }, async () => {
      const { logger } = createTopchesterLogger(workspace);
      const result = await executeToolCall(workspace, call, { logger });
      const logLines = await readJsonLogLines(logFile);

      expect(result).toMatchObject({
        tool: "inspect_command",
        command: "pwd",
        cwd: ".",
        exitCode: 0,
      });
      if (result.tool !== "inspect_command" || isToolErrorResult(result)) {
        throw new Error("Expected inspect_command result.");
      }
      expect(logLines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "tool_call", tool: "inspect_command" }),
          expect.objectContaining({
            event: "tool_result",
            tool: "inspect_command",
            command: "pwd",
            cwd: ".",
            exitCode: 0,
            stdoutLength: result.stdout.length,
          }),
        ])
      );
      expect(JSON.stringify(logLines)).not.toContain(`"stdout":"${result.stdout.trim()}`);
    });
  });

  it("does not include inspect_command output in debug logs", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    const bin = await mkdtemp(join(tmpdir(), "topchester-tools-bin-"));
    const logFile = join(workspace, "tool.log");
    await writeExecutable(join(bin, "rg"), "printf 'SECRET_INSPECT_OUTPUT\\n'");
    const call = parseToolCall('{"tool":"inspect_command","args":{"command":"rg needle"}}');

    if (!call) {
      throw new Error("Expected inspect_command tool call to parse.");
    }

    await withEnv({ TOPCHESTER_LOG_LEVEL: "debug", TOPCHESTER_LOG_FILE: logFile }, async () => {
      const { logger } = createTopchesterLogger(workspace);

      await executeToolCall(workspace, call, { logger, pathEnv: bin });

      const logText = await readFile(logFile, "utf8");

      expect(logText).toContain('"tool":"inspect_command"');
      expect(logText).toContain('"stdoutLength":22');
      expect(logText).not.toContain("SECRET_INSPECT_OUTPUT");
    });
  });

  it("reads files scoped to the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    await writeFile(join(workspace, "package.json"), '{"name":"real"}\n');

    const result = await readWorkspaceFile(workspace, "package.json");

    expect(result).toEqual({
      tool: "read_file",
      path: "package.json",
      content: '{"name":"real"}\n',
      hash: hashContent('{"name":"real"}\n'),
    });
  });

  it("rejects files outside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));

    await expect(readWorkspaceFile(workspace, "../package.json")).rejects.toThrow(
      "read_file can only read files inside the workspace"
    );
  });

  it("lists top-level workspace directory entries", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, ".env.example"), "");
    await writeFile(join(workspace, "README.md"), "");

    const result = await listWorkspaceFiles(workspace, { path: ".", recursive: false, limit: 500 });

    expect(result).toEqual({
      tool: "list_files",
      path: ".",
      content: [".env.example", "README.md", "src/"].join("\n"),
      warning: undefined,
    });
  });

  it("lists workspace directory entries recursively", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    await mkdir(join(workspace, "src", "agent"), { recursive: true });
    await writeFile(join(workspace, "src", "agent", "runtime.ts"), "");
    await writeFile(join(workspace, "src", "index.ts"), "");

    const result = await listWorkspaceFiles(workspace, { path: "src", recursive: true, limit: 500 });

    expect(result.content).toBe(["src/agent/", "src/index.ts", "src/agent/runtime.ts"].join("\n"));
  });

  it("applies list_files limit and reports truncation", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    await writeFile(join(workspace, "a.txt"), "");
    await writeFile(join(workspace, "b.txt"), "");

    const result = await listWorkspaceFiles(workspace, { path: ".", recursive: false, limit: 1 });

    expect(result).toEqual({
      tool: "list_files",
      path: ".",
      content: ["a.txt", "[1 entry limit reached. Use a narrower path or a higher limit for more.]"].join("\n"),
      warning: "1 entry limit reached.",
    });
  });

  it("rejects list_files paths outside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));

    await expect(listWorkspaceFiles(workspace, { path: "..", recursive: false, limit: 500 })).rejects.toThrow(
      "list_files can only list directories inside the workspace"
    );
  });

  it("uses rg before grep when both are available", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    const bin = await mkdtemp(join(tmpdir(), "topchester-tools-bin-"));
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", "file.ts"), "needle\n");
    await writeExecutable(join(bin, "rg"), "printf 'src/file.ts:1:needle from rg\\n'");
    await writeExecutable(join(bin, "grep"), "printf 'src/file.ts:1:needle from grep\\n'");

    const result = await grepWorkspace(workspace, { pattern: "needle", path: "src" }, { pathEnv: bin });

    expect(result.command).toBe("rg");
    expect(result.content).toBe("src/file.ts:1:needle from rg");
  });

  it("passes no-ignore to rg grep so ignored files are searchable", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    const bin = await mkdtemp(join(tmpdir(), "topchester-tools-bin-"));
    await writeExecutable(
      join(bin, "rg"),
      'printf "%s\\n" "$@" > "$PWD/rg-args.txt"\nprintf "test-foo.ts:1:needle\\n"'
    );

    const result = await grepWorkspace(workspace, { pattern: "needle" }, { pathEnv: bin });

    expect(result.content).toBe("test-foo.ts:1:needle");
    await expect(readFile(join(workspace, "rg-args.txt"), "utf8")).resolves.toContain("--no-ignore\n");
  });

  it("finds ignored files by name with the native rg collector", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    await writeFile(join(workspace, ".gitignore"), "test-foo.ts\n");
    await writeFile(join(workspace, "test-foo.ts"), "");

    const result = await findWorkspaceFilesByName(workspace, { query: "test-foo.ts", path: ".", limit: 10 });

    expect(result.content).toBe("test-foo.ts");
  });

  it("logs grep native command selection and trace output", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    const logFile = join(workspace, "tool.log");
    const bin = await mkdtemp(join(tmpdir(), "topchester-tools-bin-"));
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", "file.ts"), "needle\n");
    await writeExecutable(join(bin, "rg"), "printf 'src/file.ts:1:needle from rg\\n'");

    await withEnv({ TOPCHESTER_LOG_LEVEL: "trace", TOPCHESTER_LOG_FILE: logFile }, async () => {
      const { logger } = createTopchesterLogger(workspace);

      await grepWorkspace(workspace, { pattern: "needle", path: "src" }, { pathEnv: bin, logger });

      const logLines = await readJsonLogLines(logFile);

      expect(logLines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "native_tool_selected", tool: "grep", nativeTool: "rg" }),
          expect.objectContaining({
            event: "grep_command_output",
            command: "rg",
            stdout: "src/file.ts:1:needle from rg\n",
          }),
        ])
      );
    });
  });

  it("falls back to grep when rg is not available", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    const bin = await mkdtemp(join(tmpdir(), "topchester-tools-bin-"));
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", "file.ts"), "needle\n");
    await writeExecutable(join(bin, "grep"), "printf 'src/file.ts:1:needle from grep\\n'");

    const result = await grepWorkspace(workspace, { pattern: "needle", path: "src" }, { pathEnv: bin });

    expect(result.command).toBe("grep");
    expect(result.content).toBe("src/file.ts:1:needle from grep");
  });

  it("warns when neither rg nor grep is available", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    const bin = await mkdtemp(join(tmpdir(), "topchester-tools-bin-"));

    const result = await grepWorkspace(workspace, { pattern: "needle" }, { pathEnv: bin });

    expect(result).toEqual({
      tool: "grep",
      path: ".",
      content: "grep could not run because neither rg nor grep is available on PATH.",
      warning: "grep could not run because neither rg nor grep is available on PATH.",
    });
  });

  it("rejects grep paths outside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));

    await expect(grepWorkspace(workspace, { pattern: "needle", path: ".." })).rejects.toThrow(
      "grep can only search inside the workspace"
    );
  });

  it("returns grep execution failures as tool error results", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    const bin = await mkdtemp(join(tmpdir(), "topchester-tools-bin-"));
    await writeExecutable(join(bin, "rg"), "printf 'rg: bad path\\n' >&2\nexit 2");
    const call = parseToolCall('{"tool":"grep","args":{"pattern":"needle","path":"src scripts package.json"}}');

    if (!call) {
      throw new Error("Expected grep tool call to parse.");
    }

    const result = await executeToolCall(workspace, call, { pathEnv: bin });

    expect(isToolErrorResult(result)).toBe(true);
    expect(result.content).toContain("rg failed: rg: bad path");
  });

  it("finds fuzzy file name matches relative to the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    const bin = await mkdtemp(join(tmpdir(), "topchester-tools-bin-"));
    await mkdir(join(workspace, "src", "agent"), { recursive: true });
    await mkdir(join(workspace, "docs"), { recursive: true });
    await writeFile(join(workspace, "src", "agent", "runtime.ts"), "");
    await writeFile(join(workspace, "src", "agent", "runtime-events.ts"), "");
    await writeFile(join(workspace, "docs", "architecture.md"), "");

    const result = await findWorkspaceFilesByName(
      workspace,
      { query: "rntime", path: ".", limit: 10 },
      { pathEnv: bin }
    );

    expect(result).toEqual({
      tool: "find_file",
      path: ".",
      content: ["src/agent/runtime.ts", "src/agent/runtime-events.ts"].join("\n"),
    });
  });

  it("uses rg to list find_file candidates before the TypeScript fallback", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    const logFile = join(workspace, "tool.log");
    const bin = await mkdtemp(join(tmpdir(), "topchester-tools-bin-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "runtime-native.ts"), "");
    await writeExecutable(
      join(bin, "rg"),
      'printf "%s\\n" "$@" > "$PWD/rg-find-args.txt"\nprintf "src/runtime-native.ts\\n"'
    );

    await withEnv({ TOPCHESTER_LOG_LEVEL: "debug", TOPCHESTER_LOG_FILE: logFile }, async () => {
      const { logger } = createTopchesterLogger(workspace);
      const result = await findWorkspaceFilesByName(
        workspace,
        { query: "runtime native", path: ".", limit: 10 },
        { pathEnv: bin, logger }
      );

      expect(result.content).toBe("src/runtime-native.ts");
      await expect(readFile(join(workspace, "rg-find-args.txt"), "utf8")).resolves.toContain("--no-ignore\n");
      await expect(readJsonLogLines(logFile)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "native_tool_selected", tool: "find_file", nativeTool: "rg" }),
        ])
      );
    });
  });

  it("scopes find_file to a workspace path and applies the result limit", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    const bin = await mkdtemp(join(tmpdir(), "topchester-tools-bin-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, "test"), { recursive: true });
    await writeFile(join(workspace, "src", "runtime.ts"), "");
    await writeFile(join(workspace, "src", "runtime-events.ts"), "");
    await writeFile(join(workspace, "test", "runtime.test.ts"), "");

    const result = await findWorkspaceFilesByName(
      workspace,
      { query: "runtime", path: "src", limit: 1 },
      { pathEnv: bin }
    );

    expect(result).toEqual({
      tool: "find_file",
      path: "src",
      content: "src/runtime.ts",
    });
  });

  it("ignores heavy generated dependency folders while finding files", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    const bin = await mkdtemp(join(tmpdir(), "topchester-tools-bin-"));
    await mkdir(join(workspace, "node_modules"), { recursive: true });
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "node_modules", "runtime.ts"), "");
    await writeFile(join(workspace, "src", "runtime.ts"), "");

    const result = await findWorkspaceFilesByName(
      workspace,
      { query: "runtime", path: ".", limit: 10 },
      { pathEnv: bin }
    );

    expect(result.content).toBe("src/runtime.ts");
  });

  it("rejects find_file paths outside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));

    await expect(findWorkspaceFilesByName(workspace, { query: "package", path: "..", limit: 10 })).rejects.toThrow(
      "find_file can only search inside the workspace"
    );
  });

  it("edits existing workspace files through the tool executor", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    const file = join(workspace, "example.txt");
    await writeFile(file, "enabled=false\n");
    const call = parseToolCall(
      '{"tool":"edit_file","args":{"path":"example.txt","edits":[{"old_text":"enabled=false\\n","new_text":"enabled=true\\n"}]}}'
    );

    if (!call) {
      throw new Error("Expected edit_file tool call to parse.");
    }

    const result = await executeToolCall(workspace, call);

    expect(await readFile(file, "utf8")).toBe("enabled=true\n");
    expect(result).toMatchObject({
      tool: "edit_file",
      path: "example.txt",
      firstChangedLine: 1,
      bytesChanged: -1,
    });
    expect(result.content).toContain("after_hash: sha256:");
    expect(result.content).toContain("-1 │ enabled=false");
    expect(result.content).toContain("+1 │ enabled=true");
  });

  it("creates new workspace files through the tool executor", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    clearSessionOverlay(workspace);
    const call = parseToolCall('{"tool":"write_file","args":{"path":"example.txt","content":"alpha\\nbeta\\n"}}');

    if (!call) {
      throw new Error("Expected write_file tool call to parse.");
    }

    const result = await executeToolCall(workspace, call);

    expect(await readFile(join(workspace, "example.txt"), "utf8")).toBe("alpha\nbeta\n");
    expect(result).toMatchObject({
      tool: "write_file",
      path: "example.txt",
      hash: hashContent("alpha\nbeta\n"),
      bytesWritten: 11,
      lineCount: 2,
      createdParentDirs: [],
      kbState: "needs_sync",
      writeEvent: {
        kind: "file_create",
        source: "agent",
        path: "example.txt",
        afterHash: hashContent("alpha\nbeta\n"),
        firstChangedLine: 1,
        writeSummary: "created +2",
      },
    });
    expect(result.content).toContain("Created example.txt");
    expect(result.content).toContain("hash: sha256:");
    expect(result.content).toContain("line_count: 2");
    expect(result.content).not.toContain("alpha");
  });

  it("rejects write_file paths outside the workspace and invalid paths", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));

    await expect(writeWorkspaceFile(workspace, { path: "../example.txt", content: "new\n" })).rejects.toThrow(
      "write_file can only write files inside the workspace"
    );
    await expect(writeWorkspaceFile(workspace, { path: ".", content: "new\n" })).rejects.toThrow(
      "write_file path must point to a file inside the workspace"
    );
    await expect(writeWorkspaceFile(workspace, { path: "bad\0name.txt", content: "new\n" })).rejects.toThrow(
      "write_file path is invalid"
    );
  });

  it("rejects existing write_file targets", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    await writeFile(join(workspace, "example.txt"), "old\n");

    await expect(writeWorkspaceFile(workspace, { path: "example.txt", content: "new\n" })).rejects.toThrow(
      "write_file can only create new files: example.txt"
    );
    expect(await readFile(join(workspace, "example.txt"), "utf8")).toBe("old\n");
  });

  it("replaces existing write_file targets only with overwrite and expected_current_hash", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    clearSessionOverlay(workspace);
    const file = join(workspace, "example.txt");
    await writeFile(file, "old\nline\n");
    const beforeHash = hashContent("old\nline\n");

    const result = await writeWorkspaceFile(workspace, {
      path: "example.txt",
      content: "new\n",
      overwrite: true,
      expected_current_hash: beforeHash,
    });

    expect(await readFile(file, "utf8")).toBe("new\n");
    expect(result).toMatchObject({
      tool: "write_file",
      path: "example.txt",
      hash: hashContent("new\n"),
      beforeHash,
      bytesWritten: 4,
      bytesChanged: -5,
      lineCount: 1,
      lineDelta: -1,
      writeEvent: {
        kind: "file_overwrite",
        path: "example.txt",
        beforeHash,
        afterHash: hashContent("new\n"),
        writeSummary: "overwritten +1/-2",
      },
    });
    expect(result.content).toContain("before_hash: sha256:");
    expect(result.content).toContain("line_delta: -1");
    expect(getSessionOverlayState(workspace).mutationEvents).toEqual([
      expect.objectContaining({
        kind: "file_overwrite",
        path: "example.txt",
        beforeHash,
        afterHash: hashContent("new\n"),
      }),
    ]);
  });

  it("rejects write_file overwrite without expected_current_hash or an existing file", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));

    await expect(
      writeWorkspaceFile(workspace, { path: "example.txt", content: "new\n", overwrite: true })
    ).rejects.toThrow("write_file overwrite requires expected_current_hash for example.txt");
    await expect(
      writeWorkspaceFile(workspace, {
        path: "example.txt",
        content: "new\n",
        overwrite: true,
        expected_current_hash: hashContent("old\n"),
      })
    ).rejects.toThrow("write_file overwrite requires an existing file: example.txt");
  });

  it("rejects write_file overwrite when expected_current_hash does not match", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    const file = join(workspace, "example.txt");
    await writeFile(file, "old\n");

    await expect(
      writeWorkspaceFile(workspace, {
        path: "example.txt",
        content: "new\n",
        overwrite: true,
        expected_current_hash: `sha256:${"0".repeat(64)}`,
      })
    ).rejects.toThrow("write_file expected_current_hash did not match example.txt");
    expect(await readFile(file, "utf8")).toBe("old\n");
  });

  it("rejects missing write_file parent directories by default", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));

    await expect(writeWorkspaceFile(workspace, { path: "src/example.txt", content: "new\n" })).rejects.toThrow(
      "write_file parent directory does not exist: src"
    );
  });

  it("creates write_file parent directories only when requested", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));

    const result = await writeWorkspaceFile(workspace, {
      path: "src/generated/example.txt",
      content: "new\n",
      create_parent_dirs: true,
    });

    expect(await readFile(join(workspace, "src", "generated", "example.txt"), "utf8")).toBe("new\n");
    expect(result.createdParentDirs).toEqual(["src", "src/generated"]);
    expect(result.content).toContain("created_parent_dirs: src, src/generated");
  });

  it("rejects write_file content with NUL bytes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));

    await expect(writeWorkspaceFile(workspace, { path: "example.txt", content: "bad\0content" })).rejects.toThrow(
      "write_file content must not contain NUL bytes"
    );
  });

  it("marks created files dirty in the session overlay", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    clearSessionOverlay(workspace);

    await writeWorkspaceFile(workspace, { path: "example.txt", content: "new\n" });

    expect(getSessionOverlayState(workspace)).toMatchObject({
      drift: "dirty_known",
      kbState: "needs_sync",
      needsSync: true,
      dirtyFiles: [
        {
          path: "example.txt",
          source: "agent",
          drift: "dirty_known",
          kbState: "needs_sync",
          l1State: "stale",
          derivedState: "suspect",
          afterHash: hashContent("new\n"),
          firstChangedLine: 1,
          editCount: 1,
        },
      ],
      editEvents: [],
      mutationEvents: [
        {
          kind: "file_create",
          source: "agent",
          path: "example.txt",
          afterHash: hashContent("new\n"),
          writeSummary: "created +1",
        },
      ],
    });
  });

  it("does not leave a write_file target when creation fails", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    await mkdir(join(workspace, "src"));
    await chmod(join(workspace, "src"), 0o500);

    try {
      await expect(writeWorkspaceFile(workspace, { path: "src/example.txt", content: "new\n" })).rejects.toThrow();
      await expect(readFile(join(workspace, "src", "example.txt"), "utf8")).rejects.toThrow();
    } finally {
      await chmod(join(workspace, "src"), 0o700);
    }
  });

  it("serializes concurrent same-file writes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));

    const results = await Promise.allSettled([
      writeWorkspaceFile(workspace, { path: "example.txt", content: "first\n" }),
      writeWorkspaceFile(workspace, { path: "example.txt", content: "second\n" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(["first\n", "second\n"]).toContain(await readFile(join(workspace, "example.txt"), "utf8"));
  });

  it("rejects edit_file paths outside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));

    await expect(
      editWorkspaceFile(workspace, { path: "../example.txt", edits: [{ old_text: "old", new_text: "new" }] })
    ).rejects.toThrow("edit_file can only edit files inside the workspace");
  });

  it("rejects missing files and directories", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    await mkdir(join(workspace, "src"));

    await expect(
      editWorkspaceFile(workspace, { path: "missing.txt", edits: [{ old_text: "old", new_text: "new" }] })
    ).rejects.toThrow("edit_file can only edit existing files");
    await expect(
      editWorkspaceFile(workspace, { path: "src", edits: [{ old_text: "old", new_text: "new" }] })
    ).rejects.toThrow("edit_file can only edit regular files");
  });

  it("rejects invalid UTF-8 files", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    await writeFile(join(workspace, "binary.bin"), Buffer.from([0xff]));

    await expect(
      editWorkspaceFile(workspace, { path: "binary.bin", edits: [{ old_text: "old", new_text: "new" }] })
    ).rejects.toThrow("edit_file can only edit UTF-8 text files");
  });

  it("checks expected_current_hash before writing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    const file = join(workspace, "example.txt");
    await writeFile(file, "old\n");

    await expect(
      editWorkspaceFile(workspace, {
        path: "example.txt",
        expected_current_hash: `sha256:${"0".repeat(64)}`,
        edits: [{ old_text: "old\n", new_text: "new\n" }],
      })
    ).rejects.toThrow("edit_file expected_current_hash did not match example.txt");
    expect(await readFile(file, "utf8")).toBe("old\n");
  });

  it("returns before and after hashes for successful edits", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    const file = join(workspace, "example.txt");
    clearSessionOverlay(workspace);
    await writeFile(file, "old\n");
    const beforeHash = hashContent("old\n");

    const result = await editWorkspaceFile(workspace, {
      path: "example.txt",
      expected_current_hash: beforeHash,
      edits: [{ old_text: "old\n", new_text: "new\n" }],
    });

    expect(result.beforeHash).toBe(beforeHash);
    expect(result.afterHash).toBe(hashContent("new\n"));
    expect(result.diff).toContain("-1 │ old");
    expect(result.diff).toContain("+1 │ new");
    expect(result.kbState).toBe("needs_sync");
    expect(result.editEvent).toMatchObject({
      kind: "file_edit",
      source: "agent",
      path: "example.txt",
      beforeHash,
      afterHash: hashContent("new\n"),
      firstChangedLine: 1,
      diffSummary: "+1/-1",
    });
  });

  it("marks edited files dirty in the session overlay", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    const file = join(workspace, "example.txt");
    clearSessionOverlay(workspace);
    await writeFile(file, "old\n");

    await editWorkspaceFile(workspace, {
      path: "example.txt",
      edits: [{ old_text: "old\n", new_text: "new\n" }],
    });

    expect(getSessionOverlayState(workspace)).toMatchObject({
      drift: "dirty_known",
      kbState: "needs_sync",
      needsSync: true,
      dirtyFiles: [
        {
          path: "example.txt",
          source: "agent",
          drift: "dirty_known",
          kbState: "needs_sync",
          l1State: "stale",
          derivedState: "suspect",
          afterHash: hashContent("new\n"),
          firstChangedLine: 1,
          editCount: 1,
        },
      ],
      editEvents: [
        {
          kind: "file_edit",
          source: "agent",
          path: "example.txt",
          diffSummary: "+1/-1",
        },
      ],
    });
  });

  it("does not partially write when an edit fails", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    const file = join(workspace, "example.txt");
    await writeFile(file, "old\n");

    await expect(
      editWorkspaceFile(workspace, { path: "example.txt", edits: [{ old_text: "missing\n", new_text: "new\n" }] })
    ).rejects.toThrow("old_text at index 0 was not found");
    expect(await readFile(file, "utf8")).toBe("old\n");
  });

  it("serializes concurrent same-file edits", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    const file = join(workspace, "example.txt");
    await writeFile(file, "start\n");

    await Promise.all([
      editWorkspaceFile(workspace, { path: "example.txt", edits: [{ old_text: "start\n", new_text: "middle\n" }] }),
      editWorkspaceFile(workspace, { path: "example.txt", edits: [{ old_text: "middle\n", new_text: "done\n" }] }),
    ]);

    expect(await readFile(file, "utf8")).toBe("done\n");
  });
});

describe("edit_file pure edit engine", () => {
  it("defines the edit_file argument schema", () => {
    expect(() =>
      editFileArgsSchema.parse({
        path: "src/example.ts",
        expected_current_hash: "sha256:optional",
        edits: [{ old_text: "const enabled = false;\n", new_text: "const enabled = true;\n" }],
      })
    ).not.toThrow();
    expect(() => editFileArgsSchema.parse({ path: "src/example.ts", edits: [] })).toThrow();
  });

  it("applies one exact replacement and returns diff metadata", () => {
    const result = applyExactEdits(
      "alpha\nbeta\ngamma\n",
      [{ old_text: "beta\n", new_text: "bravo\n" }],
      "example.txt"
    );

    expect(result.newContent).toBe("alpha\nbravo\ngamma\n");
    expect(result.firstChangedLine).toBe(2);
    expect(result.diff).toContain("--- a/example.txt\n+++ b/example.txt");
    expect(result.diff).toContain(" 1 │ alpha");
    expect(result.diff).toContain("-2 │ beta");
    expect(result.diff).toContain("+2 │ bravo");
    expect(result.diff).toContain(" 3 │ gamma");
  });

  it("applies multiple blocks against the original content", () => {
    const result = applyExactEdits("one\ntwo\nthree\nfour\n", [
      { old_text: "two\n", new_text: "2\n" },
      { old_text: "four\n", new_text: "4\n" },
    ]);

    expect(result.newContent).toBe("one\n2\nthree\n4\n");
    expect(result.firstChangedLine).toBe(2);
  });

  it("rejects empty old_text", () => {
    expect(() => applyExactEdits("alpha\n", [{ old_text: "", new_text: "beta" }])).toThrow(
      "old_text at index 0 must not be empty"
    );
  });

  it("rejects missing matches", () => {
    expect(() => applyExactEdits("alpha\n", [{ old_text: "beta\n", new_text: "bravo\n" }])).toThrow(
      "old_text at index 0 was not found"
    );
  });

  it("rejects duplicate old_text entries", () => {
    expect(() =>
      applyExactEdits("alpha\nbeta\n", [
        { old_text: "alpha\n", new_text: "a\n" },
        { old_text: "alpha\n", new_text: "again\n" },
      ])
    ).toThrow("old_text at index 1 duplicates an earlier edit");
  });

  it("rejects old_text that matches more than once", () => {
    expect(() => applyExactEdits("same\nsame\n", [{ old_text: "same\n", new_text: "changed\n" }])).toThrow(
      "old_text at index 0 matched 2 times"
    );
  });

  it("rejects overlapping edit ranges", () => {
    expect(() =>
      applyExactEdits("abcdef\n", [
        { old_text: "abc", new_text: "ABC" },
        { old_text: "bcde", new_text: "BCDE" },
      ])
    ).toThrow("edit_file edits must not overlap");
  });

  it("rejects identical output", () => {
    expect(() => applyExactEdits("alpha\n", [{ old_text: "alpha\n", new_text: "alpha\n" }])).toThrow(
      "edit_file did not change the file content"
    );
  });

  it("preserves CRLF line endings", () => {
    const result = applyExactEdits("alpha\r\nbeta\r\n", [{ old_text: "beta\n", new_text: "bravo\n" }]);

    expect(result.newContent).toBe("alpha\r\nbravo\r\n");
  });

  it("preserves UTF-8 BOM", () => {
    const result = applyExactEdits("\uFEFFalpha\nbeta\n", [{ old_text: "beta\n", new_text: "bravo\n" }]);

    expect(result.newContent).toBe("\uFEFFalpha\nbravo\n");
  });
});

describe("write_file arguments", () => {
  it("defines the write_file argument schema", () => {
    expect(() =>
      writeFileArgsSchema.parse({
        path: "src/example.ts",
        content: "export const value = 1;\n",
        create_parent_dirs: true,
        overwrite: true,
        expected_current_hash: "sha256:optional",
      })
    ).not.toThrow();
    expect(() => writeFileArgsSchema.parse({ path: "src/example.ts", content: 123 })).toThrow();
    expect(() =>
      writeFileArgsSchema.parse({ path: "src/example.ts", content: "", create_parent_dirs: "yes" })
    ).toThrow();
  });
});

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

async function readJsonLogLines(path: string): Promise<Record<string, unknown>[]> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function withEnv(env: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));

  try {
    for (const [key, value] of Object.entries(env)) {
      process.env[key] = value;
    }

    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function hashContent(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
