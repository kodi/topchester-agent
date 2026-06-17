import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const miniBenchRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const repoRoot = resolve(miniBenchRoot, "..", "..");
export const tasksRoot = resolve(miniBenchRoot, "tasks");
export const reportsRoot = resolve(miniBenchRoot, "reports");
export const composeFilePath = resolve(miniBenchRoot, "docker-compose.yaml");
