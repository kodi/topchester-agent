import { z } from "zod";
import { defineTool, type ToolCall, type ToolResult } from "./types.js";

export const finishTaskArgsSchema = z.object({
  final_response: z.string().describe("Brief final response for the user."),
  files_changed: z
    .array(z.string())
    .optional()
    .describe("Workspace-relative files actually changed by successful edit tools."),
  validation: z
    .array(z.string())
    .optional()
    .describe("Tests, checks, or validation commands actually run, or an empty array if none were run."),
  remaining_issues: z
    .array(z.string())
    .optional()
    .describe("Known remaining issues or risks, or an empty array if none are known."),
});

export type FinishTaskToolArgs = z.infer<typeof finishTaskArgsSchema>;
export type FinishTaskToolCall = ToolCall<"finish_task", FinishTaskToolArgs>;

export interface FinishTaskToolResult extends ToolResult<"finish_task"> {
  finalResponse: string;
  filesChanged: string[];
  validation: string[];
  remainingIssues: string[];
}

export const finishTaskTool = defineTool<"finish_task", FinishTaskToolArgs, FinishTaskToolResult>({
  name: "finish_task",
  description:
    "Finish the current task only after the requested work has actually been completed with tools. Do not use this to claim edits, file reads, or validation that did not happen.",
  prompt:
    'finish_task: complete the task with a brief final response only after tool results prove the work is done. In benchmark or require-finish mode, this is the only valid terminal action; normal assistant messages are progress notes and do not finish the task, and remaining_issues must be empty. For implementation tasks, do not call finish_task until source files were changed by edit_file, write_file, apply_patch, or another mutating tool, unless no code change is truly required. Example: {"tool":"finish_task","args":{"final_response":"Changed src/foo.ts and ran pnpm test foo.test.ts.","files_changed":["src/foo.ts"],"validation":["pnpm test foo.test.ts"],"remaining_issues":[]}}',
  argsSchema: finishTaskArgsSchema,
  execute: async (_context, args) => {
    const filesChanged = args.files_changed ?? [];
    const validation = args.validation ?? [];
    const remainingIssues = args.remaining_issues ?? [];
    const content = [
      "finish_task requested",
      filesChanged.length > 0 ? `files_changed: ${filesChanged.join(", ")}` : "files_changed: none",
      validation.length > 0 ? `validation: ${validation.join("; ")}` : "validation: none",
      remainingIssues.length > 0 ? `remaining_issues: ${remainingIssues.join("; ")}` : "remaining_issues: none",
      args.final_response,
    ].join("\n");

    return {
      tool: "finish_task",
      content,
      finalResponse: args.final_response,
      filesChanged,
      validation,
      remainingIssues,
    };
  },
});
