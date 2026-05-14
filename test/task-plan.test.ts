import { describe, expect, it } from "vitest";
import {
  applyTaskPlanUpdate,
  createEmptyTaskPlanState,
  createTaskPlanController,
  detectTaskPlanChange,
  formatTaskPlanForPrompt,
  formatTaskPlanNotice,
  formatTaskPlanForTui,
  planTodoArgsSchema,
  summarizeTaskPlan,
} from "../src/agent/task-plan.js";

describe("task plan", () => {
  it("accepts a valid plan update and trims item text", () => {
    const state = applyTaskPlanUpdate(
      createEmptyTaskPlanState(new Date("2026-05-14T00:00:00.000Z")),
      {
        items: [
          { text: " Inspect files ", status: "completed" },
          { text: "Implement change", status: "in_progress" },
          { text: "Run tests", status: "pending" },
        ],
      },
      new Date("2026-05-14T01:00:00.000Z")
    );

    expect(state).toEqual({
      items: [
        { text: "Inspect files", status: "completed" },
        { text: "Implement change", status: "in_progress" },
        { text: "Run tests", status: "pending" },
      ],
      updatedAt: "2026-05-14T01:00:00.000Z",
    });
    expect(summarizeTaskPlan(state)).toEqual({
      pendingCount: 1,
      inProgressCount: 1,
      completedCount: 1,
      currentItem: "Implement change",
    });
  });

  it("allows clearing the plan and completed-only plans", () => {
    expect(planTodoArgsSchema.safeParse({ items: [] }).success).toBe(true);
    expect(
      planTodoArgsSchema.safeParse({
        items: [
          { text: "Inspect files", status: "completed" },
          { text: "Run tests", status: "completed" },
        ],
      }).success
    ).toBe(true);
  });

  it("rejects empty, duplicate, multi-active, and unfinished inactive plans", () => {
    expect(planTodoArgsSchema.safeParse({ items: [{ text: "  ", status: "pending" }] }).success).toBe(false);
    expect(
      planTodoArgsSchema.safeParse({
        items: [
          { text: "Inspect files", status: "completed" },
          { text: " inspect files ", status: "in_progress" },
        ],
      }).success
    ).toBe(false);
    expect(
      planTodoArgsSchema.safeParse({
        items: [
          { text: "Inspect files", status: "in_progress" },
          { text: "Run tests", status: "in_progress" },
        ],
      }).success
    ).toBe(false);
    expect(
      planTodoArgsSchema.safeParse({
        items: [
          { text: "Inspect files", status: "completed" },
          { text: "Run tests", status: "pending" },
        ],
      }).success
    ).toBe(false);
  });

  it("formats compact prompt and TUI summaries", () => {
    const state = applyTaskPlanUpdate(createEmptyTaskPlanState(), {
      items: [
        { text: "Inspect runtime event flow", status: "completed" },
        { text: "Render the visible task plan in the TUI", status: "in_progress" },
        { text: "Run verification", status: "pending" },
      ],
    });

    expect(formatTaskPlanForPrompt(state)).toContain("pending: 1");
    expect(formatTaskPlanForPrompt(state)).toContain("current: Render the visible task plan in the TUI");
    expect(formatTaskPlanForTui(state, 32)).toEqual([
      "plan",
      "  [x] Inspect runtime event flow",
      "  [>] Render the visible task...",
      "  [ ] Run verification",
    ]);
  });

  it("keeps controller state scoped and replace-only", () => {
    const controller = createTaskPlanController(createEmptyTaskPlanState(), () => new Date("2026-05-14T02:00:00.000Z"));

    controller.update({
      items: [
        { text: "First", status: "completed" },
        { text: "Second", status: "in_progress" },
      ],
    });
    const replaced = controller.update({
      items: [{ text: "Done", status: "completed" }],
    });

    expect(replaced).toEqual({
      items: [{ text: "Done", status: "completed" }],
      updatedAt: "2026-05-14T02:00:00.000Z",
    });
    expect(controller.get()).toBe(replaced);
  });

  it("formats task-plan notices for create, update, complete, and clear", () => {
    const empty = createEmptyTaskPlanState(new Date("2026-05-14T00:00:00.000Z"));
    const active = applyTaskPlanUpdate(empty, {
      items: [
        { text: "Inspect", status: "completed" },
        { text: "Implement", status: "in_progress" },
      ],
    });
    const completed = applyTaskPlanUpdate(active, {
      items: [
        { text: "Inspect", status: "completed" },
        { text: "Implement", status: "completed" },
      ],
    });

    expect(detectTaskPlanChange(undefined, active)).toBe("created");
    expect(formatTaskPlanNotice("created", active)).toBe("todo plan created: Implement");
    expect(detectTaskPlanChange(active, completed)).toBe("updated");
    expect(formatTaskPlanNotice("updated", active)).toBe("todo plan updated: Implement");
    expect(formatTaskPlanNotice("updated", completed)).toBe("todo plan completed");
    expect(detectTaskPlanChange(active, empty)).toBe("cleared");
    expect(formatTaskPlanNotice("cleared", empty)).toBe("todo plan cleared");
  });
});
