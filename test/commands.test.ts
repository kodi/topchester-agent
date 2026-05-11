import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  executeSlashCommand,
  formatKnowledgeStatus,
  getSlashCommandSuggestions,
  parseSlashCommand,
} from "../src/agent/commands.js";

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
    ]);
    expect(getSlashCommandSuggestions("/k")).toEqual([
      {
        value: "/kb status",
        description: "show project knowledge base status",
      },
    ]);
    expect(getSlashCommandSuggestions("/nope")).toEqual([]);
    expect(getSlashCommandSuggestions("hello")).toEqual([]);
  });

  it("reports /kb usage for unknown KB subcommands", async () => {
    await expect(executeSlashCommand("/kb init", { workspaceRoot: "/repo" })).resolves.toEqual({
      messages: ["Usage: /kb status"],
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

  it("executes /kb status against the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-commands-"));
    await mkdir(join(workspace, "topchester-kb"), { recursive: true });

    const result = await executeSlashCommand("/kb status", { workspaceRoot: workspace });

    expect(result.messages).toContain(`knowledge folder: ${join(workspace, "topchester-kb")} [ok] (default)`);
    expect(result.messages).toContain("state: knowledge base found");
  });
});
