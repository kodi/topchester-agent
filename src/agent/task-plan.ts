import { z } from "zod";
import { ui } from "../cli/ui.js";

export const planTodoStatusSchema = z.enum(["pending", "in_progress", "completed"]);

export type PlanTodoStatus = z.infer<typeof planTodoStatusSchema>;

export interface TaskPlanItem {
  text: string;
  status: PlanTodoStatus;
}

export interface TaskPlanState {
  items: TaskPlanItem[];
  updatedAt: string;
}

export interface TaskPlanSummary {
  pendingCount: number;
  inProgressCount: number;
  completedCount: number;
  currentItem?: string;
}

export interface TaskPlanController {
  update(args: PlanTodoToolArgs): TaskPlanState;
  get(): TaskPlanState;
}

export type TaskPlanChangeKind = "created" | "updated" | "cleared" | "unchanged";

const taskPlanItemSchema = z.object({
  text: z.string().trim().min(1, "Plan item text cannot be empty."),
  status: planTodoStatusSchema,
});

export const planTodoArgsSchema = z
  .object({
    items: z.array(taskPlanItemSchema).max(20, "Plan updates are limited to 20 items."),
  })
  .superRefine((args, context) => {
    const seen = new Set<string>();
    let inProgressCount = 0;
    let incompleteCount = 0;

    args.items.forEach((item, index) => {
      const key = item.text.toLocaleLowerCase("en");

      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          message: "Plan item text must be unique.",
          path: ["items", index, "text"],
        });
      }
      seen.add(key);

      if (item.status === "in_progress") {
        inProgressCount += 1;
      }

      if (item.status !== "completed") {
        incompleteCount += 1;
      }
    });

    if (inProgressCount > 1) {
      context.addIssue({
        code: "custom",
        message: "At most one plan item can be in_progress.",
        path: ["items"],
      });
    }

    if (args.items.length > 0 && incompleteCount > 0 && inProgressCount === 0) {
      context.addIssue({
        code: "custom",
        message: "A non-completed plan must have exactly one in_progress item.",
        path: ["items"],
      });
    }
  });

export type PlanTodoToolArgs = z.infer<typeof planTodoArgsSchema>;

export function createEmptyTaskPlanState(now: Date = new Date()): TaskPlanState {
  return {
    items: [],
    updatedAt: now.toISOString(),
  };
}

export function applyTaskPlanUpdate(
  _previous: TaskPlanState,
  args: PlanTodoToolArgs,
  now: Date = new Date()
): TaskPlanState {
  const parsed = planTodoArgsSchema.parse(args);

  return {
    items: parsed.items.map((item) => ({ text: item.text, status: item.status })),
    updatedAt: now.toISOString(),
  };
}

export function createTaskPlanController(
  initialState: TaskPlanState = createEmptyTaskPlanState(),
  now: () => Date = () => new Date()
): TaskPlanController {
  let state = initialState;

  return {
    update(args) {
      state = applyTaskPlanUpdate(state, args, now());
      return state;
    },
    get() {
      return state;
    },
  };
}

export function summarizeTaskPlan(state: TaskPlanState): TaskPlanSummary {
  const pendingCount = state.items.filter((item) => item.status === "pending").length;
  const inProgressCount = state.items.filter((item) => item.status === "in_progress").length;
  const completedCount = state.items.filter((item) => item.status === "completed").length;
  const currentItem = state.items.find((item) => item.status === "in_progress")?.text;

  return {
    pendingCount,
    inProgressCount,
    completedCount,
    ...(currentItem === undefined ? {} : { currentItem }),
  };
}

export function isTaskPlanCompleted(state: TaskPlanState | undefined): boolean {
  return Boolean(state && state.items.length > 0 && state.items.every((item) => item.status === "completed"));
}

export function formatTaskPlanForPrompt(state: TaskPlanState): string {
  const summary = summarizeTaskPlan(state);

  return [
    "Plan updated",
    `pending: ${summary.pendingCount}`,
    `in_progress: ${summary.inProgressCount}`,
    `completed: ${summary.completedCount}`,
    summary.currentItem ? `current: ${summary.currentItem}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function detectTaskPlanChange(
  previous: TaskPlanState | undefined,
  next: TaskPlanState | undefined
): TaskPlanChangeKind {
  const hadPlan = Boolean(previous && previous.items.length > 0);
  const hasPlan = Boolean(next && next.items.length > 0);

  if (!hadPlan && hasPlan) {
    return "created";
  }

  if (hadPlan && !hasPlan) {
    return "cleared";
  }

  if (hadPlan && hasPlan) {
    return "updated";
  }

  return "unchanged";
}

export function formatTaskPlanNotice(change: TaskPlanChangeKind, state: TaskPlanState): string | undefined {
  if (change === "unchanged") {
    return undefined;
  }

  if (change === "cleared" || state.items.length === 0) {
    return "todo plan cleared";
  }

  const summary = summarizeTaskPlan(state);

  if (summary.inProgressCount === 0 && summary.pendingCount === 0) {
    return "todo plan completed";
  }

  const prefix = change === "created" ? "todo plan created" : "todo plan updated";

  return summary.currentItem ? `${prefix}: ${summary.currentItem}` : prefix;
}

export function formatTaskPlanForTui(state: TaskPlanState, width: number, visibleLimit = 6): string[] {
  if (state.items.length === 0) {
    return [];
  }

  const safeWidth = Math.max(12, width);
  const itemWidth = Math.max(1, safeWidth - 6);
  const visibleItems = state.items.slice(0, visibleLimit);
  const lines = visibleItems.map((item) => formatTaskPlanTuiLine(item, truncateText(item.text, itemWidth)));
  const remaining = state.items.length - visibleItems.length;

  if (remaining > 0) {
    lines.push(ui.muted(`  +${remaining} more`));
  }

  return lines;
}

function formatTaskPlanTuiLine(item: TaskPlanItem, text: string): string {
  switch (item.status) {
    case "completed":
      return `  ${ui.ok("[x]")} ${ui.muted(text)}`;
    case "in_progress":
      return `  ${ui.ok("[>]")} ${ui.ok(text)}`;
    case "pending":
      return `  ${ui.muted("[ ]")} ${text}`;
  }
}

function truncateText(text: string, width: number): string {
  if (text.length <= width) {
    return text;
  }

  if (width <= 3) {
    return ".".repeat(Math.max(0, width));
  }

  return `${text.slice(0, width - 3)}...`;
}
