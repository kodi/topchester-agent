# Basic TypeScript Transform

Implement `summarizeUsers(users)` in `src/summary.ts`.

Rules:

- Ignore users where `active` is `false`.
- Trim each active user's `name`.
- Ignore active users whose trimmed name is empty.
- Normalize each active user's email domain to lowercase.
- Count active users by `role`.
- Return sorted unique active user names.
- Return sorted unique active email domains.
- Return the total number of valid active users.

Use ordinary TypeScript arrays, objects, and strings. Keep the implementation general.
