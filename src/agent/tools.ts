import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export interface ToolCall {
  tool: "read_file";
  args: {
    path: string;
  };
}

export interface ToolResult {
  tool: ToolCall["tool"];
  path: string;
  content: string;
}

export function parseToolCall(text: string): ToolCall | undefined {
  const trimmed = stripJsonFence(text.trim());
  let value: unknown;

  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }

  if (!isRecord(value) || value.tool !== "read_file" || !isRecord(value.args) || typeof value.args.path !== "string") {
    return undefined;
  }

  return {
    tool: "read_file",
    args: {
      path: value.args.path,
    },
  };
}

export async function executeToolCall(workspaceRoot: string, call: ToolCall): Promise<ToolResult> {
  switch (call.tool) {
    case "read_file":
      return readWorkspaceFile(workspaceRoot, call.args.path);
  }
}

export async function readWorkspaceFile(workspaceRoot: string, path: string): Promise<ToolResult> {
  const resolvedWorkspace = resolve(workspaceRoot);
  const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(resolvedWorkspace, path);
  const relativePath = relative(resolvedWorkspace, resolvedPath);

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`read_file can only read files inside the workspace: ${path}`);
  }

  const content = await readFile(resolvedPath, "utf8");

  return {
    tool: "read_file",
    path: relativePath || ".",
    content,
  };
}

function stripJsonFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);

  return match?.[1] ?? text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
