# Filterable Todo Panel

Implement `src/TodoPanel.ts`.

Export:

```ts
export type TodoStatus = "todo" | "doing" | "done" | "archived";

export interface Todo {
  id: string;
  title: string;
  assignee: string | null;
  status: TodoStatus;
  createdAt: string;
}

export function TodoPanel(props: { initialTodos: Todo[]; onChange?: (todos: Todo[]) => void }): React.ReactElement;
```

The component should manage its own todo state. Do not mutate `initialTodos` or todo objects passed in props.

## UI Requirements

- Render every visible todo title.
- Render each todo assignee, or `Unassigned` when `assignee` is `null`.
- Render status counts for `total`, `todo`, `doing`, `done`, and `archived`.
- Include a title input with accessible label `Title`.
- Include an assignee input with accessible label `Assignee`.
- Include an add button named `Add todo`.
- Reject blank titles.
- Trim title and assignee values when adding.
- Store blank assignees as `null`.
- Include a search input with accessible label `Search`.
- Include a status filter control with accessible label `Status filter`.
- Include a sort control with accessible label `Sort todos`.

## Behavior

New todos should have:

- generated stable string ids,
- status `todo`,
- `createdAt` set to an ISO timestamp.

Search should match title or assignee, case-insensitively.

Status filter should support:

- `all`
- `todo`
- `doing`
- `done`
- `archived`

Sort should support:

- `created-desc`: newest first
- `created-asc`: oldest first
- `title`: title A-Z

Each rendered todo should include a button named `Advance <title>`.

Advance transitions:

- `todo` -> `doing`
- `doing` -> `done`
- `done` -> `archived`
- `archived` stays `archived`

Call `onChange` with the full updated todo list after every add or status transition.

Run:

```sh
pnpm test
```
