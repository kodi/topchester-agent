import express, { type Express } from "express";

export type TodoStatus = "todo" | "doing" | "blocked" | "done" | "archived";

export interface Todo {
  id: string;
  title: string;
  status: TodoStatus;
  assignee: string | null;
  createdAt: string;
  updatedAt: string;
}

export function createApp(): Express {
  const app = express();
  const todos: Todo[] = [];
  let nextId = 1;

  app.use(express.json());

  app.post("/todos", (request, response) => {
    const now = new Date().toISOString();
    const todo: Todo = {
      id: `todo-${nextId++}`,
      title: request.body?.title ?? "",
      status: "todo",
      assignee: request.body?.assignee ?? null,
      createdAt: now,
      updatedAt: now,
    };
    todos.push(todo);
    response.status(201).json(todo);
  });

  app.get("/todos", (_request, response) => {
    response.json(todos);
  });

  app.get("/todos/:id", (request, response) => {
    response.json(todos.find((todo) => todo.id === request.params.id) ?? null);
  });

  app.patch("/todos/:id/status", (request, response) => {
    const todo = todos.find((candidate) => candidate.id === request.params.id);
    if (!todo) {
      response.status(404).json({ error: { code: "not_found", message: "todo not found" } });
      return;
    }
    todo.status = request.body?.status;
    todo.updatedAt = new Date().toISOString();
    response.json(todo);
  });

  return app;
}
