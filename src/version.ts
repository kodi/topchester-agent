import { createRequire } from "node:module";

const FALLBACK_VERSION = "0.0.0";

export function getTopchesterVersion(): string {
  try {
    const packageJson = createRequire(import.meta.url)("../package.json") as { version?: unknown };

    return typeof packageJson.version === "string" ? packageJson.version : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}
