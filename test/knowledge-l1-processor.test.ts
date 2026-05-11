import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { l1QueueFileSchema, l1QueueStatuses } from "../src/knowledge/compiler/l1.js";
import { l1FileEntrySchema, l1FileScanStatuses } from "../src/knowledge/compiler/l1-entry.js";
import {
  encodeL1FileEntryFileName,
  getL1FileEntryPath,
  mapL1FileEntryFileNames,
  normalizeL1FilePath,
} from "../src/knowledge/compiler/path-encoding.js";

const sha256 = `sha256:${"a".repeat(64)}`;

function makeValidL1Entry(overrides: Record<string, unknown> = {}) {
  return {
    $schema: "../schema/file-entry.v1.json",
    id: "file:src/server/routes/users.ts",
    layer: "L1",
    type: "file",
    path: "src/server/routes/users.ts",
    language: "typescript",
    content_hash: sha256,
    size_bytes: 12345,
    last_scanned_at: "2026-05-11T00:00:00Z",
    scan_status: "current",
    summary: "Defines HTTP routes for user account lookup and profile updates.",
    responsibilities: [
      "Register user-related HTTP handlers",
      "Validate request parameters",
      "Call the user service layer",
    ],
    symbols: [
      {
        id: "symbol:src/server/routes/users.ts#registerUserRoutes",
        kind: "function",
        name: "registerUserRoutes",
        exported: true,
        summary: "Attaches user routes to the server router.",
      },
    ],
    imports: ["file:src/server/services/user-service.ts"],
    exports: ["registerUserRoutes"],
    module_ids: ["module:server.users"],
    feature_ids: ["feature:user-profile"],
    test_ids: ["file:tests/server/users.test.ts"],
    evidence: [
      {
        kind: "path",
        value: "src/server/routes/users.ts",
      },
      {
        kind: "symbol",
        value: "registerUserRoutes",
      },
    ],
    confidence: "medium",
    ...overrides,
  };
}

describe("L1 queue contracts", () => {
  it("validates L1 queue files with every durable queue status", () => {
    const queuedFiles = l1QueueStatuses.map((status) => ({
      id: `file:src/${status}.ts`,
      path: `src/${status}.ts`,
      sizeBytes: 42,
      hash: sha256,
      status,
    }));

    const queue = l1QueueFileSchema.parse({
      layer: "L1",
      generatedAt: "2026-05-11T00:00:00Z",
      queuedFiles,
    });

    expect(queue.queuedFiles.map((file) => file.status)).toEqual([...l1QueueStatuses]);
  });

  it("rejects queue files with unsupported queue statuses", () => {
    expect(() =>
      l1QueueFileSchema.parse({
        layer: "L1",
        generatedAt: "2026-05-11T00:00:00Z",
        queuedFiles: [
          {
            id: "file:src/file.ts",
            path: "src/file.ts",
            sizeBytes: 42,
            hash: sha256,
            status: "stale",
          },
        ],
      })
    ).toThrow();
  });
});

describe("L1 file entry contracts", () => {
  it("accepts every documented L1 scan status", () => {
    for (const scanStatus of l1FileScanStatuses) {
      expect(() => l1FileEntrySchema.parse(makeValidL1Entry({ scan_status: scanStatus }))).not.toThrow();
    }
  });

  it("rejects invalid L1 file entries", () => {
    expect(() => l1FileEntrySchema.parse(makeValidL1Entry())).not.toThrow();
    expect(() => l1FileEntrySchema.parse(makeValidL1Entry({ content_hash: "sha256:not-a-hash" }))).toThrow();
    expect(() => l1FileEntrySchema.parse(makeValidL1Entry({ id: "file:src/other.ts" }))).toThrow();
    expect(() => l1FileEntrySchema.parse(makeValidL1Entry({ confidence: "certain" }))).toThrow();
    expect(() => l1FileEntrySchema.parse(makeValidL1Entry({ scan_status: "unknown" }))).toThrow();
  });
});

describe("L1 path encoding", () => {
  it("encodes file paths into stable L1 entry filenames", () => {
    const filePath = "src/server/routes/users.ts";
    const fileName = encodeL1FileEntryFileName(filePath);

    expect(encodeL1FileEntryFileName(filePath)).toBe(fileName);
    expect(fileName).toMatch(/^[a-f0-9]{16}-src%2Fserver%2Froutes%2Fusers\.ts\.json$/);
    expect(fileName).not.toContain("/");
    expect(fileName).not.toContain("\\");
    expect(getL1FileEntryPath("/repo/topchester-kb", filePath)).toBe(join("/repo/topchester-kb", "l1-files", fileName));
  });

  it("keeps collision-prone paths on separate L1 entry filenames", () => {
    const paths = ["src/a/b.ts", "src%2Fa/b.ts", "src/a%2Fb.ts", "src/a_b.ts", "src/A/b.ts", "src:a/b.ts"];
    const fileNames = paths.map((path) => encodeL1FileEntryFileName(path));
    const fileNameMap = mapL1FileEntryFileNames(paths);

    expect(new Set(fileNames).size).toBe(paths.length);
    expect([...fileNameMap.values()]).toEqual(fileNames);
    expect(new Set(fileNames.map((fileName) => fileName.toLowerCase())).size).toBe(paths.length);
    for (const fileName of fileNames) {
      expect(fileName).toMatch(/\.json$/);
      expect(fileName).not.toContain("/");
      expect(fileName).not.toContain("\\");
    }
  });

  it("rejects unsafe source paths before building L1 entry paths", () => {
    const unsafePaths = [
      "",
      "/absolute/path.ts",
      "C:/absolute/path.ts",
      "C:relative/path.ts",
      "./C:/absolute/path.ts",
      "./C:relative/path.ts",
      ".",
      "..",
      "../outside.ts",
      "src/../outside.ts",
      "src//file.ts",
      "src/./file.ts",
      "src\\..\\outside.ts",
      "src/file\u0000.ts",
    ];

    for (const unsafePath of unsafePaths) {
      expect(() => normalizeL1FilePath(unsafePath)).toThrow();
      expect(() => encodeL1FileEntryFileName(unsafePath)).toThrow();
      expect(() => getL1FileEntryPath("/repo/topchester-kb", unsafePath)).toThrow();
    }
  });

  it("still encodes valid POSIX workspace-relative paths", () => {
    expect(normalizeL1FilePath("./src/server/routes/users.ts")).toBe("src/server/routes/users.ts");
    expect(encodeL1FileEntryFileName("src:module/file.ts")).toMatch(/^[a-f0-9]{16}-src%3Amodule%2Ffile\.ts\.json$/);
  });
});
