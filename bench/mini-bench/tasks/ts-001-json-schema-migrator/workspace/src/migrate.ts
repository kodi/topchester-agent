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

export function migrateConfigs(_records: unknown[]): MigrationResult {
  return {
    configs: [],
    errors: [],
  };
}
