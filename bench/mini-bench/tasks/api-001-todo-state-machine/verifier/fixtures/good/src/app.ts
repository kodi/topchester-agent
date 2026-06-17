import express, { type Express, type Request, type Response } from "express";

export type TodoStatus = "todo" | "doing" | "blocked" | "done" | "archived";

export interface Todo {
  id: string;
  title: string;
  status: TodoStatus;
  assignee: string | null;
  createdAt: string;
  updatedAt: string;
}

const statuses = new Set<TodoStatus>(["todo", "doing", "blocked", "done", "archived"]);
const transitions: Record<TodoStatus, TodoStatus[]> = {
  todo: ["doing", "archived"],
  doing: ["todo", "blocked", "done"],
  blocked: ["doing", "archived"],
  done: ["archived"],
  archived: [],
};

export function createApp(): Express {
  const app = express();
  const todos: Todo[] = [];
  let nextId = 1;

  app.use(express.json());

  app.post("/todos", (request: Request, response: Response) => {
    const title = normalizeText(request.body?.title);
    if (!title) {
      return sendError(response, 400, "invalid_title", "title must be a non-empty string");
    }

    const now = new Date().toISOString();
    const todo: Todo = {
      id: `todo-${nextId++}`,
      title,
      status: "todo",
      assignee: normalizeNullableText(request.body?.assignee),
      createdAt: now,
      updatedAt: now,
    };
    todos.push(todo);
    return response.status(201).json(todo);
  });

  app.get("/todos", (request: Request, response: Response) => {
    const status = request.query.status;
    if (status !== undefined && (!isSingleQueryValue(status) || !isStatus(status))) {
      return sendError(response, 400, "invalid_status", "status filter is invalid");
    }

    const assignee =
      request.query.assignee === undefined
        ? undefined
        : isSingleQueryValue(request.query.assignee)
          ? normalizeNullableText(request.query.assignee)
          : undefined;
    if (request.query.assignee !== undefined && assignee === undefined) {
      return sendError(response, 400, "invalid_assignee", "assignee filter is invalid");
    }

    return response.json(
      todos.filter((todo) => {
        if (status !== undefined && todo.status !== status) {
          return false;
        }
        if (assignee !== undefined && todo.assignee !== assignee) {
          return false;
        }
        return true;
      })
    );
  });

  app.get("/todos/:id", (request: Request, response: Response) => {
    const todo = todos.find((candidate) => candidate.id === request.params.id);
    if (!todo) {
      return sendError(response, 404, "not_found", "todo not found");
    }
    return response.json(todo);
  });

  app.patch("/todos/:id/status", (request: Request, response: Response) => {
    const todo = todos.find((candidate) => candidate.id === request.params.id);
    if (!todo) {
      return sendError(response, 404, "not_found", "todo not found");
    }

    const target = request.body?.status;
    if (!isStatus(target)) {
      return sendError(response, 400, "invalid_status", "status is invalid");
    }

    if (!transitions[todo.status].includes(target)) {
      return sendError(response, 409, "invalid_transition", `cannot transition from ${todo.status} to ${target}`);
    }

    todo.status = target;
    todo.updatedAt = new Date().toISOString();
    return response.json(todo);
  });

  return app;
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeNullableText(value: unknown): string | null {
  return normalizeText(value) ?? null;
}

function isStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && statuses.has(value as TodoStatus);
}

function isSingleQueryValue(value: unknown): value is string {
  return typeof value === "string";
}

function sendError(response: Response, status: number, code: string, message: string): Response {
  return response.status(status).json({
    error: {
      code,
      message,
    },
  });
}
