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
  description:
    "Replace the visible session plan for genuinely multi-step work. Keep 2-6 short milestones, exactly one in progress while work remains, and update only when milestones change. Skip this tool for small tasks and final summaries.",
  prompt:
    'plan_todo: replace the visible session task plan for genuinely multi-step work. Usually create it once after initial orientation, keep 2-6 short milestone items, exactly one in_progress item while work remains, and batch updates when milestones change. Do not call plan_todo twice in a row, after routine reads/searches, after failed edit attempts, for wording-only changes, or just to report completed work before a final answer. To use it, reply with only JSON: {"tool":"plan_todo","args":{"items":[{"text":"Inspect relevant files","status":"in_progress"},{"text":"Implement focused change","status":"pending"}]}}',
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
