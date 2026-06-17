import React from "react";

export type TodoStatus = "todo" | "doing" | "done" | "archived";

export interface Todo {
  id: string;
  title: string;
  assignee: string | null;
  status: TodoStatus;
  createdAt: string;
}

export function TodoPanel(props: { initialTodos: Todo[]; onChange?: (todos: Todo[]) => void }): React.ReactElement {
  return React.createElement(
    "section",
    null,
    React.createElement("div", null, `total: ${props.initialTodos.length}`),
    React.createElement(
      "ul",
      null,
      props.initialTodos.map((todo) => React.createElement("li", { key: todo.id }, todo.title))
    )
  );
}
