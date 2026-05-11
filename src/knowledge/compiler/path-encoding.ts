import { createHash } from "node:crypto";
import { join } from "node:path";

const READABLE_FILE_NAME_LIMIT = 120;

export function encodeL1FileEntryFileName(filePath: string): string {
  const normalizedPath = normalizeL1FilePath(filePath);
  const digest = createHash("sha256").update(normalizedPath).digest("hex").slice(0, 16);
  const encodedPath = encodePathForFileName(normalizedPath);
  const readablePath =
    encodedPath.length > READABLE_FILE_NAME_LIMIT ? `${encodedPath.slice(0, READABLE_FILE_NAME_LIMIT)}~` : encodedPath;

  return `${digest}-${readablePath}.json`;
}

export function getL1FileEntryPath(kbPath: string, filePath: string): string {
  return join(kbPath, "l1-files", encodeL1FileEntryFileName(filePath));
}

export function mapL1FileEntryFileNames(filePaths: string[]): Map<string, string> {
  const fileNamesByPath = new Map<string, string>();
  const pathsByCaseFoldedFileName = new Map<string, string>();

  for (const filePath of filePaths) {
    const normalizedPath = normalizeL1FilePath(filePath);
    const fileName = encodeL1FileEntryFileName(normalizedPath);
    const caseFoldedFileName = fileName.toLowerCase();
    const existingPath = pathsByCaseFoldedFileName.get(caseFoldedFileName);

    if (existingPath && existingPath !== normalizedPath) {
      throw new Error(`Encoded L1 file entry path collision between ${existingPath} and ${normalizedPath}`);
    }

    pathsByCaseFoldedFileName.set(caseFoldedFileName, normalizedPath);
    fileNamesByPath.set(normalizedPath, fileName);
  }

  return fileNamesByPath;
}

export function normalizeL1FilePath(filePath: string): string {
  const normalizedPath = filePath.replace(/^\.\//, "");

  if (
    !normalizedPath ||
    normalizedPath.startsWith("/") ||
    normalizedPath.includes("\0") ||
    normalizedPath.includes("\\") ||
    normalizedPath.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Invalid workspace-relative file path: ${filePath}`);
  }

  return normalizedPath;
}

function encodePathForFileName(filePath: string): string {
  return encodeURIComponent(filePath).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}
