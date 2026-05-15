import {
  formatTaskPlanForPrompt,
  planTodoArgsSchema,
  summarizeTaskPlan,
  type PlanTodoToolArgs,
  type TaskPlanState,
} from "../task-plan.js";
import { defineTool, type ToolCall, type ToolResult } from "./types.js";

export type PlanTodoToolCall = ToolCall<"plan_todo", PlanTodoToolArgs>;

export interface PlanTodoToolResult extends ToolResult<"plan_todo"> {
  plan: TaskPlanState;
  pendingCount: number;
  inProgressCount: number;
  completedCount: number;
  currentItem?: string;
}

export const planTodoTool = defineTool({
  name: "plan_todo",
  description: "Replace the visible session task plan for multi-step work.",
  prompt:
    'plan_todo: replace the visible session task plan for non-trivial multi-step work; keep 2-6 short items, exactly one in_progress item while work remains, and use [] only to clear. Do not use plan_todo just to report completed work before a final answer. To use it, reply with only JSON: {"tool":"plan_todo","args":{"items":[{"text":"Inspect relevant files","status":"in_progress"},{"text":"Implement focused change","status":"pending"}]}}',
  argsSchema: planTodoArgsSchema,
  async execute(context, args): Promise<PlanTodoToolResult> {
    if (!context.taskPlan) {
      throw new Error("plan_todo requires runtime task-plan state.");
    }

    const plan = context.taskPlan.update(args);
    const summary = summarizeTaskPlan(plan);

    return {
      tool: "plan_todo",
      content: formatTaskPlanForPrompt(plan),
      plan,
      ...summary,
    };
  },
});
