import { join } from "node:path";

export function getL1FileEntryRelativePath(filePath: string): string {
  const normalizedPath = normalizeL1FilePath(filePath);
  return `${normalizedPath}.json`;
}

export function getL1FileEntryPath(kbPath: string, filePath: string): string {
  return join(kbPath, "l1-files", getL1FileEntryRelativePath(filePath));
}

export function mapL1FileEntryRelativePaths(filePaths: string[]): Map<string, string> {
  const entryPathsByPath = new Map<string, string>();
  const pathsByCaseFoldedEntryPath = new Map<string, string>();

  for (const filePath of filePaths) {
    const normalizedPath = normalizeL1FilePath(filePath);
    const entryPath = getL1FileEntryRelativePath(normalizedPath);
    const caseFoldedEntryPath = entryPath.toLowerCase();
    const existingPath = pathsByCaseFoldedEntryPath.get(caseFoldedEntryPath);

    if (existingPath && existingPath !== normalizedPath) {
      throw new Error(`L1 file entry path collision between ${existingPath} and ${normalizedPath}`);
    }

    pathsByCaseFoldedEntryPath.set(caseFoldedEntryPath, normalizedPath);
    entryPathsByPath.set(normalizedPath, entryPath);
  }

  return entryPathsByPath;
}

export function normalizeL1FilePath(filePath: string): string {
  const normalizedPath = filePath.replace(/^\.\//, "");

  if (
    !normalizedPath ||
    /^[A-Za-z]:/.test(normalizedPath) ||
    normalizedPath.startsWith("/") ||
    normalizedPath.includes("\0") ||
    normalizedPath.includes("\\") ||
    normalizedPath.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Invalid workspace-relative file path: ${filePath}`);
  }

  return normalizedPath;
}
