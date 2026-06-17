import React, { useMemo, useState } from "react";

export type TodoStatus = "todo" | "doing" | "done" | "archived";

export interface Todo {
  id: string;
  title: string;
  assignee: string | null;
  status: TodoStatus;
  createdAt: string;
}

const statuses: TodoStatus[] = ["todo", "doing", "done", "archived"];

export function TodoPanel(props: { initialTodos: Todo[]; onChange?: (todos: Todo[]) => void }): React.ReactElement {
  const [todos, setTodos] = useState<Todo[]>(() => props.initialTodos.map((todo) => ({ ...todo })));
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<TodoStatus | "all">("all");
  const [sort, setSort] = useState<"created-desc" | "created-asc" | "title">("created-desc");
  const [nextId, setNextId] = useState(1);

  const visibleTodos = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return [...todos]
      .filter((todo) => statusFilter === "all" || todo.status === statusFilter)
      .filter((todo) => {
        if (!normalizedSearch) {
          return true;
        }
        return (
          todo.title.toLowerCase().includes(normalizedSearch) ||
          (todo.assignee ?? "").toLowerCase().includes(normalizedSearch)
        );
      })
      .sort((left, right) => {
        if (sort === "title") {
          return left.title.localeCompare(right.title);
        }
        const diff = Date.parse(left.createdAt) - Date.parse(right.createdAt);
        return sort === "created-asc" ? diff : -diff;
      });
  }, [search, sort, statusFilter, todos]);

  function updateTodos(nextTodos: Todo[]): void {
    setTodos(nextTodos);
    props.onChange?.(nextTodos.map((todo) => ({ ...todo })));
  }

  function addTodo(event: React.FormEvent): void {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      return;
    }
    const trimmedAssignee = assignee.trim();
    const nextTodo: Todo = {
      id: `todo-${Date.now()}-${nextId}`,
      title: trimmedTitle,
      assignee: trimmedAssignee ? trimmedAssignee : null,
      status: "todo",
      createdAt: new Date().toISOString(),
    };
    setNextId((value) => value + 1);
    updateTodos([...todos, nextTodo]);
    setTitle("");
    setAssignee("");
  }

  function advanceTodo(id: string): void {
    updateTodos(
      todos.map((todo) => {
        if (todo.id !== id) {
          return todo;
        }
        return {
          ...todo,
          status: nextStatus(todo.status),
        };
      })
    );
  }

  const counts = countTodos(todos);

  return React.createElement(
    "section",
    { "aria-label": "Todo panel" },
    React.createElement(
      "div",
      { "aria-label": "Todo counts" },
      React.createElement("span", null, `total: ${todos.length}`),
      " ",
      ...statuses.flatMap((status) => [
        React.createElement("span", { key: status }, `${status}: ${counts[status]}`),
        " ",
      ])
    ),
    React.createElement(
      "form",
      { onSubmit: addTodo },
      React.createElement(
        "label",
        null,
        "Title",
        React.createElement("input", { value: title, onChange: (event) => setTitle(event.currentTarget.value) })
      ),
      React.createElement(
        "label",
        null,
        "Assignee",
        React.createElement("input", { value: assignee, onChange: (event) => setAssignee(event.currentTarget.value) })
      ),
      React.createElement("button", { type: "submit" }, "Add todo")
    ),
    React.createElement(
      "label",
      null,
      "Search",
      React.createElement("input", { value: search, onChange: (event) => setSearch(event.currentTarget.value) })
    ),
    React.createElement(
      "label",
      null,
      "Status filter",
      React.createElement(
        "select",
        {
          value: statusFilter,
          onChange: (event) => setStatusFilter(event.currentTarget.value as TodoStatus | "all"),
        },
        React.createElement("option", { value: "all" }, "All"),
        ...statuses.map((status) => React.createElement("option", { key: status, value: status }, status))
      )
    ),
    React.createElement(
      "label",
      null,
      "Sort todos",
      React.createElement(
        "select",
        {
          value: sort,
          onChange: (event) => setSort(event.currentTarget.value as "created-desc" | "created-asc" | "title"),
        },
        React.createElement("option", { value: "created-desc" }, "Newest first"),
        React.createElement("option", { value: "created-asc" }, "Oldest first"),
        React.createElement("option", { value: "title" }, "Title")
      )
    ),
    React.createElement(
      "ul",
      null,
      visibleTodos.map((todo) =>
        React.createElement(
          "li",
          { "key": todo.id, "data-testid": `todo-${todo.id}` },
          React.createElement("strong", null, todo.title),
          React.createElement("span", null, todo.assignee ?? "Unassigned"),
          React.createElement("span", null, todo.status),
          React.createElement(
            "button",
            { type: "button", onClick: () => advanceTodo(todo.id) },
            `Advance ${todo.title}`
          )
        )
      )
    )
  );
}

function nextStatus(status: TodoStatus): TodoStatus {
  if (status === "todo") {
    return "doing";
  }
  if (status === "doing") {
    return "done";
  }
  if (status === "done") {
    return "archived";
  }
  return "archived";
}

function countTodos(todos: Todo[]): Record<TodoStatus, number> {
  return {
    todo: todos.filter((todo) => todo.status === "todo").length,
    doing: todos.filter((todo) => todo.status === "doing").length,
    done: todos.filter((todo) => todo.status === "done").length,
    archived: todos.filter((todo) => todo.status === "archived").length,
  };
}
