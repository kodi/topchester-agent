import { z } from "zod";
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
  description: "Delegate a focused prompt to a constrained child agent session.",
  prompt:
    'task: delegate focused read-only research or isolated analysis to a child agent session. Use it when parallel context gathering would help. To use it, reply with only JSON: {"tool":"task","args":{"description":"Inspect runtime event flow","prompt":"Read the runtime and summarize how events are emitted.","subagent_type":"explore"}}',
  argsSchema: taskArgsSchema,
  async execute(context, args): Promise<TaskToolResult> {
    if (!context.subagents) {
      throw new Error("task requires a runtime subagent manager.");
    }

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
