import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TodoPanel, type Todo } from "./TodoPanel.ts";

const initialTodos: Todo[] = [
  {
    id: "todo-1",
    title: "Write docs",
    assignee: "Ada",
    status: "todo",
    createdAt: "2026-06-17T10:00:00.000Z",
  },
  {
    id: "todo-2",
    title: "Ship release",
    assignee: null,
    status: "done",
    createdAt: "2026-06-17T11:00:00.000Z",
  },
];

describe("TodoPanel", () => {
  it("renders, filters, adds todos, and advances state", async () => {
    const user = userEvent.setup();
    const changes: Todo[][] = [];
    render(React.createElement(TodoPanel, { initialTodos, onChange: (todos) => changes.push(todos) }));

    expect(screen.getByText("Write docs")).toBeTruthy();
    expect(screen.getByText("Ship release")).toBeTruthy();
    expect(screen.getByText("total: 2")).toBeTruthy();
    expect(screen.getByText("todo: 1")).toBeTruthy();
    expect(screen.getByText("done: 1")).toBeTruthy();

    await user.selectOptions(screen.getByLabelText("Status filter"), "todo");
    expect(screen.getByText("Write docs")).toBeTruthy();
    expect(screen.queryByText("Ship release")).toBeNull();

    await user.selectOptions(screen.getByLabelText("Status filter"), "all");
    await user.type(screen.getByLabelText("Search"), "release");
    expect(screen.getByText("Ship release")).toBeTruthy();
    expect(screen.queryByText("Write docs")).toBeNull();

    await user.clear(screen.getByLabelText("Search"));
    await user.type(screen.getByLabelText("Title"), " Review metrics ");
    await user.type(screen.getByLabelText("Assignee"), " Grace ");
    await user.click(screen.getByRole("button", { name: "Add todo" }));

    expect(screen.getByText("Review metrics")).toBeTruthy();
    expect(screen.getByText("Grace")).toBeTruthy();
    expect(changes.at(-1)?.some((todo) => todo.title === "Review metrics")).toBe(true);

    const item = screen.getByTestId("todo-todo-1");
    await user.click(within(item).getByRole("button", { name: "Advance Write docs" }));
    expect(within(item).getByText("doing")).toBeTruthy();
  });
});
