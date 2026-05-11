import { isAbsolute, join, resolve } from "node:path";

export const TOPCHESTER_STATE_DIR = ".agents/topchester";
export const TOPCHESTER_SESSIONS_DIR = `${TOPCHESTER_STATE_DIR}/sessions`;
export const TOPCHESTER_LOGS_DIR = `${TOPCHESTER_STATE_DIR}/logs`;
export const TOPCHESTER_DEFAULT_LOG_FILE = `${TOPCHESTER_LOGS_DIR}/topchester.log`;

export function resolveWorkspacePath(workspaceRoot: string, path: string): string {
  return isAbsolute(path) ? path : resolve(workspaceRoot, path);
}

export function getTopchesterStatePath(workspaceRoot: string): string {
  return resolveWorkspacePath(workspaceRoot, TOPCHESTER_STATE_DIR);
}

export function getTopchesterSessionsPath(workspaceRoot: string): string {
  return resolveWorkspacePath(workspaceRoot, TOPCHESTER_SESSIONS_DIR);
}

export function getTopchesterLogsPath(workspaceRoot: string): string {
  return resolveWorkspacePath(workspaceRoot, TOPCHESTER_LOGS_DIR);
}

export function getTopchesterLogFilePath(workspaceRoot: string, logFile = process.env.TOPCHESTER_LOG_FILE): string {
  return logFile
    ? resolveWorkspacePath(workspaceRoot, logFile)
    : join(getTopchesterLogsPath(workspaceRoot), "topchester.log");
}
