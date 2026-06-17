import React from "react";

export type TodoStatus = "todo" | "doing" | "done" | "archived";

export interface Todo {
  id: string;
  title: string;
  assignee: string | null;
  status: TodoStatus;
  createdAt: string;
}

export function TodoPanel(_props: { initialTodos: Todo[]; onChange?: (todos: Todo[]) => void }): React.ReactElement {
  return React.createElement("section", null, "TODO");
}
