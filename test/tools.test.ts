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
  listWorkspaceFiles,
  parseToolCall,
  readWorkspaceFile,
} from "../src/agent/tools.js";
import { editFileArgsSchema } from "../src/agent/tools/edit-file.js";
import { getChatSystemPrompt } from "../src/agent/prompts.js";
import { createTopchesterLogger } from "../src/logging/index.js";
import { clearSessionOverlay, getSessionOverlayState } from "../src/knowledge/session-overlay.js";

describe("agent tools", () => {
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
        '{"tool":"edit_file","args":{"path":"src/example.ts","expected_hash":"sha256:abc","edits":[{"old_text":"off","new_text":"on"}]}}'
      )
    ).toEqual({
      tool: "edit_file",
      args: {
        path: "src/example.ts",
        expected_hash: "sha256:abc",
        edits: [{ old_text: "off", new_text: "on" }],
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

  it("rejects unknown tools and invalid tool args", () => {
    expect(parseToolCall('{"tool":"unknown","args":{}}')).toBeUndefined();
    expect(parseToolCall('{"tool":"read_file","args":{"path":123}}')).toBeUndefined();
    expect(parseToolCall('{"tool":"list_files","args":{"limit":0}}')).toBeUndefined();
    expect(parseToolCall('{"tool":"grep","args":{"path":"src"}}')).toBeUndefined();
    expect(parseToolCall('{"tool":"find_file","args":{"query":""}}')).toBeUndefined();
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

  it("gets model prompt lines from the tool registry", () => {
    expect(getToolPromptLines()).toEqual([
      'read_file: read a UTF-8 file inside the workspace. To use it, reply with only JSON: {"tool":"read_file","args":{"path":"package.json"}}',
      'list_files: list files and directories inside the workspace; top-level by default, recursive only when requested, with "/" after directory names. To use it, reply with only JSON: {"tool":"list_files","args":{"path":"src","recursive":false,"limit":500}}',
      'grep: search text inside file contents in the workspace; output lines are the files containing the matched text, and paths mentioned inside those lines are not confirmed files unless checked with find_file or read_file. To use it, reply with only JSON: {"tool":"grep","args":{"pattern":"function name","path":"src"}}',
      'find_file: find existing files by fuzzy path or filename inside the workspace; matches may appear in the middle of a filename, and results are file paths, not file contents. To use it, reply with only JSON: {"tool":"find_file","args":{"query":"runtime"}}',
      'edit_file: edit an existing UTF-8 file inside the workspace with exact old_text/new_text replacements; read the file first, keep old_text small but unique, and make multiple disjoint edits for one file in one call. To use it, reply with only JSON: {"tool":"edit_file","args":{"path":"src/example.ts","expected_hash":"sha256:optional-current-file-hash","edits":[{"old_text":"const enabled = false;\\n","new_text":"const enabled = true;\\n"}]}}',
    ]);
  });

  it("tells the model to verify paths mentioned inside grep output", () => {
    expect(getChatSystemPrompt()).toContain(
      "If grep output mentions another path, treat that mentioned path as content until find_file or read_file confirms it exists."
    );
  });

  it("tells the model how to use edit_file safely", () => {
    const prompt = getChatSystemPrompt();

    expect(prompt).toContain("When using a tool, output exactly one tool JSON object and no prose");
    expect(prompt).toContain("After the tool result, either output the next single tool JSON object");
    expect(prompt).toContain("Use read_file before editing a file");
    expect(prompt).toContain("Use edit_file for targeted edits to existing files");
    expect(prompt).toContain("Keep edit_file old_text small but unique");
    expect(prompt).toContain("Do not include line labels or grep prefixes in old_text");
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

  it("checks expected_hash before writing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    const file = join(workspace, "example.txt");
    await writeFile(file, "old\n");

    await expect(
      editWorkspaceFile(workspace, {
        path: "example.txt",
        expected_hash: `sha256:${"0".repeat(64)}`,
        edits: [{ old_text: "old\n", new_text: "new\n" }],
      })
    ).rejects.toThrow("edit_file expected_hash did not match example.txt");
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
      expected_hash: beforeHash,
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
        expected_hash: "sha256:optional",
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
