import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyExactEdits,
  editWorkspaceFile,
  executeToolCall,
  findWorkspaceFilesByName,
  getToolPromptLines,
  grepWorkspace,
  isToolErrorResult,
  listWorkspaceFiles,
  parseToolCall,
  parseToolCallWithSource,
  readWorkspaceFile,
  toAiSdkToolSet,
  writeWorkspaceFile,
  createTaskPlanController,
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

  it("gets model prompt lines from the tool registry", () => {
    expect(getToolPromptLines()).toEqual([
      'plan_todo: replace the visible session task plan for non-trivial multi-step work; keep 2-6 short items, exactly one in_progress item while work remains, and use [] only to clear. Do not use plan_todo just to report completed work before a final answer. To use it, reply with only JSON: {"tool":"plan_todo","args":{"items":[{"text":"Inspect relevant files","status":"in_progress"},{"text":"Implement focused change","status":"pending"}]}}',
      'read_file: read a UTF-8 file inside the workspace. To use it, reply with only JSON: {"tool":"read_file","args":{"path":"package.json"}}',
      'list_files: list files and directories inside the workspace; top-level by default, recursive only when requested, with "/" after directory names. To use it, reply with only JSON: {"tool":"list_files","args":{"path":"src","recursive":false,"limit":500}}',
      'grep: search text inside file contents in the workspace; output lines are the files containing the matched text, and paths mentioned inside those lines are not confirmed files unless checked with find_file or read_file. To use it, reply with only JSON: {"tool":"grep","args":{"pattern":"function name","path":"src"}}',
      'find_file: find existing files by fuzzy path or filename inside the workspace; matches may appear in the middle of a filename, and results are file paths, not file contents. To use it, reply with only JSON: {"tool":"find_file","args":{"query":"runtime"}}',
      'edit_file: edit an existing UTF-8 file inside the workspace with exact old_text/new_text replacements; read the file first, keep old_text small but unique, and make multiple disjoint edits for one file in one call. expected_current_hash is optional and must be the current/pre-edit hash returned by the latest read_file for that file; never invent it or use a predicted after-edit hash. To use it, reply with only JSON: {"tool":"edit_file","args":{"path":"src/example.ts","expected_current_hash":"sha256:current-file-hash-from-read_file","edits":[{"old_text":"const enabled = false;\\n","new_text":"const enabled = true;\\n"}]}}',
      'write_file: create a new UTF-8 file inside the workspace by default; use edit_file for targeted changes to existing files; pass create_parent_dirs:true only when creating the folder path is intended. Replace an existing whole file only with overwrite:true and expected_current_hash set to the current/pre-write hash returned by the latest read_file for that file; never invent it or use a predicted after-write hash. To create a file, reply with only JSON: {"tool":"write_file","args":{"path":"test/example.test.ts","content":"import { it, expect } from \\"vitest\\";\\n\\nit(\\"works\\", () => {\\n  expect(true).toBe(true);\\n});\\n","create_parent_dirs":true}}',
      'git_status: inspect branch, head, clean state, staged, unstaged, and untracked files without parsing shell output. To use it, reply with only JSON: {"tool":"git_status","args":{"path":".","include_untracked":true}}',
      'git_diff: inspect a bounded Git diff; use scope "all", "unstaged", or "staged", and include_untracked:true only when untracked file patches are needed. To use it, reply with only JSON: {"tool":"git_diff","args":{"scope":"all","include_untracked":true}}',
      'git_log: inspect recent commits without parsing shell output. To use it, reply with only JSON: {"tool":"git_log","args":{"limit":10,"path":"src/agent/runtime.ts"}}',
      'git_add: stage only explicit paths the user asked to stage; first inspect git_status, reject broad paths, and pass expected_status for each path. To use it, reply with only JSON: {"tool":"git_add","args":{"paths":["src/example.ts"],"expected_status":[{"path":"src/example.ts","status":"modified"}]}}',
      'git_commit: commit only after the user explicitly asks and staged paths exactly match expected_staged_paths. To use it, reply with only JSON: {"tool":"git_commit","args":{"message":"Add feature","expected_staged_paths":["src/example.ts"]}}',
      'inspect_command: run a safe read-only discovery command inside the workspace for quick orientation; prefer read_file, list_files, grep, and find_file for exact file tasks, and do not use it for builds, tests, installs, network, shell scripts, or edits. To use it, reply with only JSON: {"tool":"inspect_command","args":{"command":"pwd && rg --files docs/plans | head -20","workdir":".","timeout_ms":10000}}',
    ]);
  });

  it("tells the model to verify paths mentioned inside grep output", () => {
    expect(getChatSystemPrompt()).toContain(
      "If grep output mentions another path, treat that mentioned path as content until find_file or read_file confirms it exists."
    );
  });

  it("tells the model when to use plan_todo", () => {
    const prompt = getChatSystemPrompt();

    expect(prompt).toContain("Use plan_todo for non-trivial multi-step work");
    expect(prompt).toContain("Keep plan_todo items short");
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

  it("tells the model inspect_command is only for read-only orientation", () => {
    const prompt = getChatSystemPrompt();

    expect(prompt).toContain("Use list_files, grep, find_file, and read_file for exact file listing");
    expect(prompt).toContain("Use git_status, git_diff, and git_log for Git state");
    expect(prompt).toContain("Use git_add and git_commit only when the user explicitly asks");
    expect(prompt).toContain("Use inspect_command only for quick read-only repo orientation");
    expect(prompt).toContain("inspect_command is not a shell");
    expect(prompt).toContain("Unsafe commands, shell expansion, scripts, installs, builds, tests, network access");
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
    expect(result.content).toContain("-enabled=false");
    expect(result.content).toContain("+enabled=true");
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
    expect(result.diff).toContain("-old");
    expect(result.diff).toContain("+new");
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
    expect(result.diff).toContain("-beta");
    expect(result.diff).toContain("+bravo");
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
