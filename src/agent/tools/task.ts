import { z } from "zod";
import { createToolPermissionView, isToolAllowed, resolveAgentProfile } from "../profiles.js";
import { defineTool, type ToolCall, type ToolResult } from "./types.js";

export const taskArgsSchema = z.object({
  description: z.string().min(1),
  prompt: z.string().min(1),
  subagent_type: z.string().optional(),
  task_id: z.string().optional(),
});

export type TaskToolArgs = z.infer<typeof taskArgsSchema>;
export type TaskToolCall = ToolCall<"task", TaskToolArgs>;

export interface TaskToolResult extends ToolResult<"task"> {
  childSessionId: string;
  status: "completed" | "failed";
  profileId: string;
}

export const taskTool = defineTool({
  name: "task",
  description:
    "Delegate read-only file/search/git research to a child agent. Do not use for shell commands, bash, Python/Node scripts, validators, edits, writes, tiny local inspections, or other execution work.",
  prompt:
    'task: delegate read-only file/search/git research to a child agent. Do not use task for shell commands, bash, Python/Node scripts, validators, edits, writes, tiny local inspections, or other execution work; use parent tools directly. If the relevant workspace context is just a README plus a few obvious source files, inspect them directly with list_files/read_file instead of spawning a subagent. To use it, reply with only JSON: {"tool":"task","args":{"description":"Inspect runtime event flow","prompt":"Read the runtime and summarize how events are emitted.","subagent_type":"explore"}}',
  argsSchema: taskArgsSchema,
  async execute(context, args): Promise<TaskToolResult> {
    if (!context.subagents) {
      throw new Error("task requires a runtime subagent manager.");
    }

    rejectUnsupportedSubagentPrompt(args);

    const result = await context.subagents.runTask({
      description: args.description,
      prompt: args.prompt,
      subagentType: args.subagent_type,
      taskId: args.task_id,
      parentToolCallId: context.toolCallId ?? args.task_id ?? "task",
      eventSink: context.eventSink,
      abortSignal: context.abortSignal,
    });

    return {
      tool: "task",
      childSessionId: result.sessionId,
      status: result.status,
      profileId: result.profileId,
      content: [
        `Task ${result.status}: ${args.description}`,
        `child_session: ${result.sessionId}`,
        `profile: ${result.profileId}`,
        "",
        result.result,
      ].join("\n"),
    };
  },
});

function rejectUnsupportedSubagentPrompt(args: TaskToolArgs): void {
  const profile = resolveAgentProfile(args.subagent_type ?? "explore");
  const permissions = createToolPermissionView(profile);

  if (isToolAllowed(permissions, "bash") || !looksLikeShellExecutionRequest(args.prompt)) {
    return;
  }

  throw new Error(
    `task subagent "${profile.id}" cannot run bash, shell commands, Python/Node scripts, validators, or other execution tools. Use the parent bash tool directly, or delegate only read-only file/search/git research.`
  );
}

function looksLikeShellExecutionRequest(prompt: string): boolean {
  return /\b(use|run|execute)\s+(bash|shell|command|commands|python3?|node|npm|npx|pnpm|xxd|readelf|objdump|file)\b/i.test(
    prompt
  );
}
