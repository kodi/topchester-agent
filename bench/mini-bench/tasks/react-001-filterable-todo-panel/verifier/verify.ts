import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AssertionResult, TaskVerifier } from "../../../src/types.ts";
import { runCommand } from "../../../src/command.ts";

const ciEnv = { ...process.env, CI: "true" };

const verify: TaskVerifier = async (context) => {
  const assertions: AssertionResult[] = [];
  const hiddenDir = resolve(context.workspacePath, ".agents", "mini-bench-hidden");
  const hiddenTestPath = resolve(hiddenDir, "TodoPanel.hidden.test.ts");

  const install = await runCommand("pnpm", ["install", "--ignore-workspace", "--frozen-lockfile"], {
    cwd: context.workspacePath,
    env: ciEnv,
    timeoutMs: 120_000,
  });

  assertions.push({
    name: "workspace dependencies are linked",
    passed: install.exitCode === 0,
    message: install.exitCode === 0 ? "pnpm install completed." : formatVerifierFailure(install.stdout, install.stderr),
  });

  if (install.exitCode !== 0) {
    return {
      passed: false,
      score: 0,
      assertions,
    };
  }

  await mkdir(hiddenDir, { recursive: true });
  await writeFile(hiddenTestPath, buildHiddenTestSource());

  const result = await runCommand("pnpm", ["exec", "vitest", "run", hiddenTestPath], {
    cwd: context.workspacePath,
    env: ciEnv,
    timeoutMs: 120_000,
  });

  assertions.push({
    name: "passes hidden React behavior tests",
    passed: result.exitCode === 0,
    message:
      result.exitCode === 0 ? "Behavior matched hidden cases." : formatVerifierFailure(result.stdout, result.stderr),
  });

  const passed = assertions.every((assertion) => assertion.passed);
  return {
    passed,
    score: passed ? 1 : 0,
    assertions,
  };
};

function buildHiddenTestSource(): string {
  return String.raw`
import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TodoPanel, type Todo } from "../../src/TodoPanel.ts";

afterEach(() => cleanup());

const seedTodos: Todo[] = [
  {
    id: "todo-1",
    title: "Write API docs",
    assignee: "Ada",
    status: "todo",
    createdAt: "2026-06-17T10:00:00.000Z",
  },
  {
    id: "todo-2",
    title: "Review traces",
    assignee: "Grace",
    status: "doing",
    createdAt: "2026-06-17T12:00:00.000Z",
  },
  {
    id: "todo-3",
    title: "Ship release",
    assignee: null,
    status: "done",
    createdAt: "2026-06-17T11:00:00.000Z",
  },
];

describe("hidden TodoPanel behavior", () => {
  it("does not mutate initial todos and keeps component instances isolated", async () => {
    const user = userEvent.setup();
    const original = structuredClone(seedTodos);
    const firstChange = vi.fn();
    const secondChange = vi.fn();

    const first = render(React.createElement(TodoPanel, { initialTodos: seedTodos, onChange: firstChange }));
    await user.click(within(first.getByTestId("todo-todo-1")).getByRole("button", { name: "Advance Write API docs" }));
    expect(within(first.getByTestId("todo-todo-1")).getByText("doing")).toBeTruthy();
    expect(seedTodos).toEqual(original);
    first.unmount();

    render(React.createElement(TodoPanel, { initialTodos: seedTodos, onChange: secondChange }));
    expect(within(screen.getByTestId("todo-todo-1")).getByText("todo")).toBeTruthy();
    expect(secondChange).not.toHaveBeenCalled();
  });

  it("filters, searches, sorts, counts, adds, and advances todos", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(React.createElement(TodoPanel, { initialTodos: seedTodos, onChange }));

    expect(screen.getByText("total: 3")).toBeTruthy();
    expect(screen.getByText("todo: 1")).toBeTruthy();
    expect(screen.getByText("doing: 1")).toBeTruthy();
    expect(screen.getByText("done: 1")).toBeTruthy();
    expect(screen.getByText("archived: 0")).toBeTruthy();

    await user.selectOptions(screen.getByLabelText("Status filter"), "doing");
    expect(screen.getByText("Review traces")).toBeTruthy();
    expect(screen.queryByText("Write API docs")).toBeNull();

    await user.selectOptions(screen.getByLabelText("Status filter"), "all");
    await user.type(screen.getByLabelText("Search"), "ada");
    expect(screen.getByText("Write API docs")).toBeTruthy();
    expect(screen.queryByText("Review traces")).toBeNull();

    await user.clear(screen.getByLabelText("Search"));
    await user.selectOptions(screen.getByLabelText("Sort todos"), "title");
    const titles = screen.getAllByRole("listitem").map((item) => item.textContent ?? "");
    expect(titles[0]).toContain("Review traces");
    expect(titles[1]).toContain("Ship release");
    expect(titles[2]).toContain("Write API docs");

    await user.type(screen.getByLabelText("Title"), "  Analyze costs  ");
    await user.type(screen.getByLabelText("Assignee"), "  Lin  ");
    await user.click(screen.getByRole("button", { name: "Add todo" }));
    expect(screen.getByText("Analyze costs")).toBeTruthy();
    expect(screen.getByText("Lin")).toBeTruthy();
    expect(onChange).toHaveBeenLastCalledWith(expect.arrayContaining([
      expect.objectContaining({ title: "Analyze costs", assignee: "Lin", status: "todo" }),
    ]));

    const added = onChange.mock.calls.at(-1)?.[0].find((todo: Todo) => todo.title === "Analyze costs");
    expect(typeof added?.id).toBe("string");
    expect(Number.isNaN(Date.parse(added?.createdAt ?? ""))).toBe(false);

    await user.click(within(screen.getByTestId("todo-todo-2")).getByRole("button", { name: "Advance Review traces" }));
    expect(within(screen.getByTestId("todo-todo-2")).getByText("done")).toBeTruthy();
  });

  it("rejects blank titles and stores blank assignees as null", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(React.createElement(TodoPanel, { initialTodos: [], onChange }));

    await user.type(screen.getByLabelText("Title"), "   ");
    await user.click(screen.getByRole("button", { name: "Add todo" }));
    expect(screen.queryByRole("listitem")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText("Title"));
    await user.type(screen.getByLabelText("Title"), " Unassigned task ");
    await user.type(screen.getByLabelText("Assignee"), "   ");
    await user.click(screen.getByRole("button", { name: "Add todo" }));
    expect(screen.getByText("Unassigned task")).toBeTruthy();
    expect(screen.getByText("Unassigned")).toBeTruthy();
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ title: "Unassigned task", assignee: null }),
    ]);
  });
});
`;
}

function formatVerifierFailure(stdout: string, stderr: string): string {
  const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  const compact = output.split("\n").filter(Boolean).slice(-28).join("\n");
  return compact.length <= 1_600 ? compact : `${compact.slice(0, 1_600)}...`;
}

export default verify;
