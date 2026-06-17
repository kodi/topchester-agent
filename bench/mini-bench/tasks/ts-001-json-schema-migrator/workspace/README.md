# JSON Schema Migrator

Implement `migrateConfigs(records)` in `src/migrate.ts`.

The input is an array of legacy config records. Return a `MigrationResult` with migrated configs and validation errors.

Rules:

- A valid record must be a plain object with a non-empty string `id`.
- Invalid records are skipped and produce an error with `index`, optional `id`, `code`, and `message`.
- `enabled` defaults to `true` when omitted. If present, it must be a boolean.
- Legacy settings live under `settings`.
- `settings.retries` becomes `retry.maxAttempts`.
- `settings.timeoutMs` becomes `retry.timeoutMs`.
- `retries` and `timeoutMs` may be numbers or decimal strings.
- `retries` defaults to `3` and must be an integer from `0` through `10`.
- `timeoutMs` defaults to `5000` and must be an integer from `100` through `60000`.
- `settings.tags` may be an array of strings or a comma-separated string.
- Tags are trimmed, lowercased, deduplicated, sorted, and blank tags are ignored.
- `metadata` must be a plain object when present. Copy it into the migrated config.
- Preserve unknown top-level fields under `extras`, excluding `id`, `enabled`, `settings`, and `metadata`.
- Preserve input order for valid migrated configs and error order.

Use these error codes:

- `invalid_record`: the record is not a plain object.
- `invalid_id`: `id` is missing, blank, or not a string.
- `invalid_enabled`: `enabled` is present but not a boolean.
- `invalid_settings`: `settings` is present but not a plain object.
- `invalid_retries`: `settings.retries` is present but is not an integer from `0` through `10`.
- `invalid_timeout`: `settings.timeoutMs` is present but is not an integer from `100` through `60000`.
- `invalid_tags`: `settings.tags` is present but is not a string or an array of strings.
- `invalid_metadata`: `metadata` is present but not a plain object.

Error messages should be useful human-readable strings. Their exact wording is not important.

Output shape:

```ts
interface MigratedConfig {
  version: 2;
  id: string;
  enabled: boolean;
  retry: {
    maxAttempts: number;
    timeoutMs: number;
  };
  tags: string[];
  metadata: Record<string, unknown>;
  extras: Record<string, unknown>;
}
```

Run:

```sh
pnpm test
```
