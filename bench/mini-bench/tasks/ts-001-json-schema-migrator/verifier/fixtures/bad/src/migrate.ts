export interface MigrationResult {
  configs: unknown[];
  errors: unknown[];
}

export function migrateConfigs(_records: unknown[]): MigrationResult {
  return {
    configs: [],
    errors: [],
  };
}
