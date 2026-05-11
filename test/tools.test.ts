import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  executeToolCall,
  getToolPromptLines,
  grepWorkspace,
  parseToolCall,
  readWorkspaceFile,
} from "../src/agent/tools.js";

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

  it("rejects unknown tools and invalid tool args", () => {
    expect(parseToolCall('{"tool":"unknown","args":{}}')).toBeUndefined();
    expect(parseToolCall('{"tool":"read_file","args":{"path":123}}')).toBeUndefined();
    expect(parseToolCall('{"tool":"grep","args":{"path":"src"}}')).toBeUndefined();
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
    });
  });

  it("gets model prompt lines from the tool registry", () => {
    expect(getToolPromptLines()).toEqual([
      'read_file: read a UTF-8 file inside the workspace. To use it, reply with only JSON: {"tool":"read_file","args":{"path":"package.json"}}',
      'grep: search text inside the workspace. To use it, reply with only JSON: {"tool":"grep","args":{"pattern":"function name","path":"src"}}',
    ]);
  });

  it("reads files scoped to the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));
    await writeFile(join(workspace, "package.json"), '{"name":"real"}\n');

    const result = await readWorkspaceFile(workspace, "package.json");

    expect(result).toEqual({
      tool: "read_file",
      path: "package.json",
      content: '{"name":"real"}\n',
    });
  });

  it("rejects files outside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-tools-"));

    await expect(readWorkspaceFile(workspace, "../package.json")).rejects.toThrow(
      "read_file can only read files inside the workspace"
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
});

async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}
