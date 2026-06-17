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

  app.use(express.json());

  app.get("/todos", (_request, response) => {
    response.json([]);
  });

  return app;
}
