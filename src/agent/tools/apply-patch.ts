import { rm, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { editWorkspaceFile } from "./edit-file.js";
import { defineTool, type ToolCall, type ToolResult } from "./types.js";
import { writeWorkspaceFile } from "./write-file.js";

export const applyPatchArgsSchema = z.object({
  patch: z.string().describe("Patch text wrapped in *** Begin Patch and *** End Patch."),
});

export type ApplyPatchToolArgs = z.infer<typeof applyPatchArgsSchema>;
export type ApplyPatchToolCall = ToolCall<"apply_patch", ApplyPatchToolArgs>;

export interface ApplyPatchToolResult extends ToolResult<"apply_patch"> {
  changedFiles: string[];
  diffs: string[];
  kbState: "needs_sync";
}

type PatchOperation =
  | { kind: "add"; path: string; content: string }
  | { kind: "update"; path: string; edits: Array<{ old_text: string; new_text: string }> }
  | { kind: "delete"; path: string };

export const applyPatchTool = defineTool<"apply_patch", ApplyPatchToolArgs, ApplyPatchToolResult>({
  name: "apply_patch",
  description:
    "Apply a patch to create, update, or delete files inside the workspace. Use this for multi-file edits or when patch-style editing is easier than exact edit_file replacements.",
  prompt:
    'apply_patch: apply a patch to files inside the workspace. Use it for real source changes, especially multi-file edits. The patch must start with "*** Begin Patch" and end with "*** End Patch"; use "*** Add File: path", "*** Update File: path", or "*** Delete File: path" sections. For updates, include @@ hunks with context/removal/addition lines. Example: {"tool":"apply_patch","args":{"patch":"*** Begin Patch\\n*** Update File: src/example.ts\\n@@\\n-const enabled = false;\\n+const enabled = true;\\n*** End Patch\\n"}}',
  argsSchema: applyPatchArgsSchema,
  mutatesWorkspace: true,
  requiresExclusiveWorkspace: true,
  execute: async (context, args) => {
    const operations = parsePatch(args.patch);
    const changedFiles: string[] = [];
    const diffs: string[] = [];
    const summaries: string[] = [];

    for (const operation of operations) {
      if (operation.kind === "add") {
        const result = await writeWorkspaceFile(
          context.workspaceRoot,
          { path: operation.path, content: operation.content, create_parent_dirs: true },
          { logger: context.logger, onFileTouch: context.onFileTouch }
        );
        changedFiles.push(result.path ?? operation.path);
        summaries.push(result.content);
        continue;
      }

      if (operation.kind === "update") {
        const result = await editWorkspaceFile(
          context.workspaceRoot,
          { path: operation.path, edits: operation.edits },
          { logger: context.logger, onFileTouch: context.onFileTouch }
        );
        changedFiles.push(result.path ?? operation.path);
        diffs.push(result.diff);
        summaries.push(result.content);
        continue;
      }

      const relativePath = await deleteWorkspaceFile(context.workspaceRoot, operation.path);
      changedFiles.push(relativePath);
      summaries.push(`Deleted ${relativePath}\nkb_state: needs_sync`);
    }

    return {
      tool: "apply_patch",
      content: summaries.join("\n\n"),
      changedFiles,
      diffs,
      kbState: "needs_sync",
    };
  },
});

function parsePatch(patch: string): PatchOperation[] {
  const lines = patch.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let index = skipBlank(lines, 0);

  if (lines[index] !== "*** Begin Patch") {
    throw new Error("apply_patch patch must start with *** Begin Patch.");
  }

  index += 1;
  const operations: PatchOperation[] = [];

  while (index < lines.length) {
    index = skipBlank(lines, index);
    const line = lines[index];

    if (line === "*** End Patch") {
      return operations;
    }

    if (!line) {
      break;
    }

    const addMatch = line.match(/^\*\*\* Add File: (.+)$/u);
    if (addMatch) {
      const path = addMatch[1]!;
      const contentLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.startsWith("*** ")) {
        const contentLine = lines[index]!;
        if (!contentLine.startsWith("+")) {
          throw new Error(`apply_patch add file lines must start with +: ${path}`);
        }
        contentLines.push(contentLine.slice(1));
        index += 1;
      }
      operations.push({ kind: "add", path, content: `${contentLines.join("\n")}\n` });
      continue;
    }

    const updateMatch = line.match(/^\*\*\* Update File: (.+)$/u);
    if (updateMatch) {
      const path = updateMatch[1]!;
      const edits: Array<{ old_text: string; new_text: string }> = [];
      index += 1;

      while (index < lines.length && !lines[index]!.startsWith("*** ")) {
        const current = lines[index]!;
        if (current.startsWith("*** Move to: ")) {
          throw new Error("apply_patch move/rename sections are not supported yet.");
        }
        if (!current.startsWith("@@")) {
          index += 1;
          continue;
        }

        index += 1;
        const oldLines: string[] = [];
        const newLines: string[] = [];

        while (index < lines.length && !lines[index]!.startsWith("@@") && !lines[index]!.startsWith("*** ")) {
          const hunkLine = lines[index]!;
          if (hunkLine.startsWith(" ")) {
            oldLines.push(hunkLine.slice(1));
            newLines.push(hunkLine.slice(1));
          } else if (hunkLine.startsWith("-")) {
            oldLines.push(hunkLine.slice(1));
          } else if (hunkLine.startsWith("+")) {
            newLines.push(hunkLine.slice(1));
          } else if (hunkLine === "\\ No newline at end of file") {
            // Ignore standard diff marker; Topchester edits preserve normal text files.
          } else {
            throw new Error(`apply_patch update hunk lines must start with space, -, or +: ${path}`);
          }
          index += 1;
        }

        const oldText = `${oldLines.join("\n")}\n`;
        const newText = `${newLines.join("\n")}\n`;
        if (oldText === newText) {
          throw new Error(`apply_patch update hunk did not change content: ${path}`);
        }
        edits.push({ old_text: oldText, new_text: newText });
      }

      if (edits.length === 0) {
        throw new Error(`apply_patch update file has no hunks: ${path}`);
      }
      operations.push({ kind: "update", path, edits });
      continue;
    }

    const deleteMatch = line.match(/^\*\*\* Delete File: (.+)$/u);
    if (deleteMatch) {
      operations.push({ kind: "delete", path: deleteMatch[1]! });
      index += 1;
      continue;
    }

    throw new Error(`apply_patch unknown section header: ${line}`);
  }

  throw new Error("apply_patch patch must end with *** End Patch.");
}

function skipBlank(lines: string[], index: number): number {
  while (index < lines.length && lines[index] === "") {
    index += 1;
  }
  return index;
}

async function deleteWorkspaceFile(workspaceRoot: string, path: string): Promise<string> {
  if (path.includes("\0") || path.length === 0) {
    throw new Error("apply_patch delete path is invalid.");
  }

  const resolvedWorkspace = resolve(workspaceRoot);
  const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(resolvedWorkspace, path);
  const relativePath = relative(resolvedWorkspace, resolvedPath);

  if (relativePath.startsWith("..") || isAbsolute(relativePath) || relativePath === "") {
    throw new Error(`apply_patch can only delete files inside the workspace: ${path}`);
  }

  const target = await stat(resolvedPath);
  if (!target.isFile()) {
    throw new Error(`apply_patch can only delete regular files: ${relativePath}`);
  }

  await rm(resolvedPath);
  return relativePath;
}
