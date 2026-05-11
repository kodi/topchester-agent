import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import pino, { type Logger } from "pino";
import { getTopchesterLogFilePath } from "../app/paths.js";

const LOG_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

export interface TopchesterLoggerInfo {
  logger: Logger;
  level: string;
  logFilePath?: string;
}

export function createTopchesterLogger(workspaceRoot: string): TopchesterLoggerInfo {
  const level = normalizeLogLevel(process.env.TOPCHESTER_LOG_LEVEL);

  if (level === "silent") {
    return {
      logger: pino({ enabled: false }),
      level,
    };
  }

  const logFilePath = getTopchesterLogFilePath(workspaceRoot);
  mkdirSync(dirname(logFilePath), { recursive: true });

  const logger = pino(
    {
      base: undefined,
      level,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.destination({ dest: logFilePath, sync: true })
  );

  logger.debug({ event: "logger_ready", logFilePath, level }, "logger ready");

  return {
    logger,
    level,
    logFilePath,
  };
}

function normalizeLogLevel(level: string | undefined): string {
  const normalized = level?.trim().toLowerCase();

  if (!normalized || normalized === "off") {
    return "silent";
  }

  return LOG_LEVELS.has(normalized) ? normalized : "info";
}
