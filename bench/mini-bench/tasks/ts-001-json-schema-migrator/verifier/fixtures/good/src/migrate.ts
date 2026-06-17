export interface MigrationError {
  index: number;
  id?: string;
  code: string;
  message: string;
}

export interface MigratedConfig {
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

export interface MigrationResult {
  configs: MigratedConfig[];
  errors: MigrationError[];
}

const knownKeys = new Set(["id", "enabled", "settings", "metadata"]);

export function migrateConfigs(records: unknown[]): MigrationResult {
  const configs: MigratedConfig[] = [];
  const errors: MigrationError[] = [];

  records.forEach((record, index) => {
    if (!isPlainObject(record)) {
      errors.push({
        index,
        code: "invalid_record",
        message: "Record must be a plain object.",
      });
      return;
    }

    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) {
      errors.push({
        index,
        code: "invalid_id",
        message: "id must be a non-empty string.",
      });
      return;
    }

    if ("enabled" in record && typeof record.enabled !== "boolean") {
      errors.push({
        index,
        id,
        code: "invalid_enabled",
        message: "enabled must be a boolean when provided.",
      });
      return;
    }

    const settings = record.settings === undefined ? {} : record.settings;
    if (!isPlainObject(settings)) {
      errors.push({
        index,
        id,
        code: "invalid_settings",
        message: "settings must be a plain object when provided.",
      });
      return;
    }

    const maxAttempts = parseBoundedInteger(settings.retries, 3, 0, 10);
    if (maxAttempts === undefined) {
      errors.push({
        index,
        id,
        code: "invalid_retries",
        message: "settings.retries must be an integer from 0 through 10.",
      });
      return;
    }

    const timeoutMs = parseBoundedInteger(settings.timeoutMs, 5000, 100, 60000);
    if (timeoutMs === undefined) {
      errors.push({
        index,
        id,
        code: "invalid_timeout",
        message: "settings.timeoutMs must be an integer from 100 through 60000.",
      });
      return;
    }

    const tags = normalizeTags(settings.tags);
    if (!tags) {
      errors.push({
        index,
        id,
        code: "invalid_tags",
        message: "settings.tags must be a string or an array of strings when provided.",
      });
      return;
    }

    const metadata = record.metadata === undefined ? {} : record.metadata;
    if (!isPlainObject(metadata)) {
      errors.push({
        index,
        id,
        code: "invalid_metadata",
        message: "metadata must be a plain object when provided.",
      });
      return;
    }

    configs.push({
      version: 2,
      id,
      enabled: typeof record.enabled === "boolean" ? record.enabled : true,
      retry: {
        maxAttempts,
        timeoutMs,
      },
      tags,
      metadata: { ...metadata },
      extras: collectExtras(record),
    });
  });

  return { configs, errors };
}

function parseBoundedInteger(value: unknown, defaultValue: number, min: number, max: number): number | undefined {
  if (value === undefined) {
    return defaultValue;
  }

  const parsed =
    typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}

function normalizeTags(value: unknown): string[] | undefined {
  if (value === undefined) {
    return [];
  }

  const rawTags = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : undefined;
  if (!rawTags || rawTags.some((tag) => typeof tag !== "string")) {
    return undefined;
  }

  return [...new Set(rawTags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}

function collectExtras(record: Record<string, unknown>): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!knownKeys.has(key)) {
      extras[key] = value;
    }
  }
  return extras;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
