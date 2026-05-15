import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { defineTool, type ToolCall, type ToolResult } from "./types.js";
import { appendProjectInstructionsToToolContent, resolveToolProjectInstructions } from "./project-instructions.js";

export const readFileArgsSchema = z.object({
  path: z.string(),
});

export type ReadFileToolArgs = z.infer<typeof readFileArgsSchema>;
export type ReadFileToolCall = ToolCall<"read_file", ReadFileToolArgs>;
export interface ReadFileToolResult extends ToolResult<"read_file"> {
  hash: string;
}

export const readFileTool = defineTool({
  name: "read_file",
  description: "Read a UTF-8 file inside the workspace.",
  prompt:
    'read_file: read a UTF-8 file inside the workspace. To use it, reply with only JSON: {"tool":"read_file","args":{"path":"package.json"}}',
  argsSchema: readFileArgsSchema,
  parallelSafe: true,
  mutatesWorkspace: false,
  resourceKeys: (args) => [`file:${args.path}`],
  execute: async (context, args) => {
    const result = await readWorkspaceFile(context.workspaceRoot, args.path);
    const projectInstructions = await resolveToolProjectInstructions(context, {
      targetPath: args.path,
      skipWhenTargetIsInstructionFile: true,
    });

    return {
      ...result,
      content: appendProjectInstructionsToToolContent(result.content, projectInstructions),
      projectInstructions,
    };
  },
});

export async function readWorkspaceFile(workspaceRoot: string, path: string): Promise<ReadFileToolResult> {
  const resolvedWorkspace = resolve(workspaceRoot);
  const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(resolvedWorkspace, path);
  const relativePath = relative(resolvedWorkspace, resolvedPath);

  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`read_file can only read files inside the workspace: ${path}`);
  }

  const bytes = await readFile(resolvedPath);
  const content = bytes.toString("utf8");

  return {
    tool: "read_file",
    path: relativePath || ".",
    content,
    hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}
