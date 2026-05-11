import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseToolCall, readWorkspaceFile } from "../src/agent/tools.js";

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
});
