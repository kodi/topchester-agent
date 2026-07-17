import { createRequire } from "node:module";

const FALLBACK_VERSION = "0.0.0";
declare const TOPCHESTER_VERSION: string | undefined;

export function getTopchesterVersion(): string {
  if (typeof TOPCHESTER_VERSION === "string") {
    return TOPCHESTER_VERSION;
  }

  try {
    const packageJson = createRequire(import.meta.url)("../package.json") as { version?: unknown };

    return typeof packageJson.version === "string" ? packageJson.version : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}
