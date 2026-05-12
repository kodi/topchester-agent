import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createL1QueueFile,
  l1QueueFileSchema,
  l1QueueStatuses,
  type L1QueueItem,
} from "../src/knowledge/compiler/l1.js";
import { l1FileEntrySchema, l1FileScanStatuses } from "../src/knowledge/compiler/l1-entry.js";
import {
  parseL1ModelJson,
  processL1Queue,
  processL1QueueItem,
  type L1SummaryModel,
} from "../src/knowledge/compiler/l1-processor.js";
import { knowledgeCompilerIdentity } from "../src/knowledge/compiler/manifest.js";
import {
  getL1FileEntryPath,
  getL1FileEntryRelativePath,
  mapL1FileEntryRelativePaths,
  normalizeL1FilePath,
} from "../src/knowledge/compiler/path-encoding.js";

const sha256 = `sha256:${"a".repeat(64)}`;
const fixedNow = () => new Date("2026-05-11T00:00:00.000Z");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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

async function makeWorkspace(files: Record<string, string>): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "topchester-l1-"));
  tempDirs.push(workspaceRoot);

  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(workspaceRoot, path);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content, { flush: true });
  }

  return workspaceRoot;
}

function hashContent(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function makeQueueItem(path: string, content: string, overrides: Partial<L1QueueItem> = {}): L1QueueItem {
  return {
    id: `file:${path}`,
    path,
    sizeBytes: Buffer.byteLength(content),
    hash: hashContent(content),
    status: "queued",
    ...overrides,
  };
}

function makeFakeModel(text: string): L1SummaryModel & { calls: Array<{ system: string; prompt: string }> } {
  const calls: Array<{ system: string; prompt: string }> = [];
  return {
    calls,
    async generateText(request) {
      calls.push({ system: request.system, prompt: request.prompt });
      return { text, providerId: "fake", modelId: "fake-l1", purpose: "kb.summarize" };
    },
  };
}

function makeSequenceModel(texts: string[]): L1SummaryModel & { calls: Array<{ system: string; prompt: string }> } {
  const calls: Array<{ system: string; prompt: string }> = [];
  return {
    calls,
    async generateText(request) {
      calls.push({ system: request.system, prompt: request.prompt });
      const text = texts.shift();
      if (text === undefined) {
        throw new Error("No fake response left");
      }
      return { text, providerId: "fake", modelId: "fake-l1", purpose: "kb.summarize" };
    },
  };
}

async function writeQueue(queuePath: string, items: L1QueueItem[]): Promise<void> {
  await writeFile(queuePath, `${JSON.stringify(createL1QueueFile(items, "2026-05-11T00:00:00.000Z"), null, 2)}\n`);
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

describe("L1 path mapping", () => {
  it("maps file paths into stable mirrored L1 entry paths", () => {
    const filePath = "src/server/routes/users.ts";
    const entryPath = getL1FileEntryRelativePath(filePath);

    expect(getL1FileEntryRelativePath(filePath)).toBe(entryPath);
    expect(entryPath).toBe("src/server/routes/users.ts.json");
    expect(entryPath).not.toContain("\\");
    expect(getL1FileEntryPath("/repo/topchester-kb", filePath)).toBe(
      join("/repo/topchester-kb", "l1-files", "src", "server", "routes", "users.ts.json")
    );
  });

  it("keeps distinct paths on separate mirrored L1 entry paths", () => {
    const paths = ["src/a/b.ts", "src%2Fa/b.ts", "src/a%2Fb.ts", "src/a_b.ts", "src:module/file.ts"];
    const entryPaths = paths.map((path) => getL1FileEntryRelativePath(path));
    const entryPathMap = mapL1FileEntryRelativePaths(paths);

    expect(new Set(entryPaths).size).toBe(paths.length);
    expect([...entryPathMap.values()]).toEqual(entryPaths);
    for (const path of entryPaths) {
      expect(path).toMatch(/\.json$/);
      expect(path).not.toContain("\\");
    }
  });

  it("rejects mirrored L1 entry paths that collide on case-insensitive filesystems", () => {
    expect(() => mapL1FileEntryRelativePaths(["src/a/b.ts", "src/A/b.ts"])).toThrow();
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
      expect(() => getL1FileEntryRelativePath(unsafePath)).toThrow();
      expect(() => getL1FileEntryPath("/repo/topchester-kb", unsafePath)).toThrow();
    }
  });

  it("still accepts valid POSIX workspace-relative paths", () => {
    expect(normalizeL1FilePath("./src/server/routes/users.ts")).toBe("src/server/routes/users.ts");
    expect(getL1FileEntryRelativePath("src:module/file.ts")).toBe("src:module/file.ts.json");
  });
});

describe("single-file L1 processing", () => {
  it("writes one current entry from a valid fake model response", async () => {
    const content = "export function greet(name: string) { return `hi ${name}`; }\n";
    const workspaceRoot = await makeWorkspace({ "src/greet.ts": content });
    const kbPath = join(workspaceRoot, "topchester-kb");
    const model = makeFakeModel(JSON.stringify(makeValidL1Entry({ path: "src/greet.ts", id: "file:src/greet.ts" })));

    const result = await processL1QueueItem({
      workspaceRoot,
      kbPath,
      item: makeQueueItem("src/greet.ts", content),
      model,
      now: fixedNow,
    });

    expect(result.item.status).toBe("completed");
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.prompt).toContain("src/greet.ts");
    expect(result.entryPath).toBe(getL1FileEntryPath(kbPath, "src/greet.ts"));
    const entry = l1FileEntrySchema.parse(JSON.parse(await readFile(result.entryPath!, "utf8")));
    expect(entry.scan_status).toBe("current");
    expect(entry.summary).toContain("Defines HTTP routes");
  });

  it("overrides deterministic fields even when the model lies", async () => {
    const content = "export const answer = 42;\n";
    const workspaceRoot = await makeWorkspace({ "src/answer.ts": content });
    const kbPath = join(workspaceRoot, "topchester-kb");
    const model = makeFakeModel(
      JSON.stringify(
        makeValidL1Entry({
          id: "file:wrong.ts",
          path: "wrong.ts",
          content_hash: `sha256:${"b".repeat(64)}`,
          size_bytes: 999,
          last_scanned_at: "1999-01-01T00:00:00Z",
          scan_status: "invalid",
        })
      )
    );

    const result = await processL1QueueItem({
      workspaceRoot,
      kbPath,
      item: makeQueueItem("src/answer.ts", content),
      model,
      now: fixedNow,
    });

    expect(result.item.status).toBe("completed");
    const entry = l1FileEntrySchema.parse(JSON.parse(await readFile(result.entryPath!, "utf8")));
    expect(entry.id).toBe("file:src/answer.ts");
    expect(entry.path).toBe("src/answer.ts");
    expect(entry.content_hash).toBe(hashContent(content));
    expect(entry.size_bytes).toBe(Buffer.byteLength(content));
    expect(entry.last_scanned_at).toBe("2026-05-11T00:00:00.000Z");
    expect(entry.scan_status).toBe("current");
  });

  it("normalizes common loose model arrays into schema-valid semantic fields", async () => {
    const content = "export function clsx() { return '' }\n";
    const workspaceRoot = await makeWorkspace({ "src/index.js": content });
    const kbPath = join(workspaceRoot, "topchester-kb");
    const model = makeFakeModel(
      JSON.stringify(
        makeValidL1Entry({
          id: "file:wrong.js",
          path: "wrong.js",
          symbols: [{ name: "clsx", description: "extra field" }, "toVal", { id: "symbol:src/index.js#derived" }],
          imports: ["node:fs", "file:src/lite.js", ""],
          exports: [{ name: "default" }, "clsx"],
          module_ids: ["runtime", "module:runtime"],
          feature_ids: ["classes", "feature:class-names"],
          test_ids: ["handles strings", "file:test/index.js"],
          evidence: ["src/index.js", { kind: "path", value: "src/index.js" }, { kind: "", value: "ignored" }],
        })
      )
    );

    const result = await processL1QueueItem({
      workspaceRoot,
      kbPath,
      item: makeQueueItem("src/index.js", content),
      model,
      now: fixedNow,
    });

    expect(result.item.status).toBe("completed");
    const entry = l1FileEntrySchema.parse(JSON.parse(await readFile(result.entryPath!, "utf8")));
    expect(entry.symbols).toEqual([
      {
        id: "symbol:src/index.js#clsx",
        kind: "symbol",
        name: "clsx",
        exported: false,
        summary: "Symbol named clsx.",
      },
      {
        id: "symbol:src/index.js#toVal",
        kind: "symbol",
        name: "toVal",
        exported: false,
        summary: "Symbol named toVal.",
      },
      {
        id: "symbol:src/index.js#derived",
        kind: "symbol",
        name: "derived",
        exported: false,
        summary: "Symbol named derived.",
      },
    ]);
    expect(entry.imports).toEqual(["file:src/lite.js"]);
    expect(entry.exports).toEqual(["clsx"]);
    expect(entry.module_ids).toEqual(["module:runtime"]);
    expect(entry.feature_ids).toEqual(["feature:class-names"]);
    expect(entry.test_ids).toEqual(["file:test/index.js"]);
    expect(entry.evidence).toEqual([{ kind: "path", value: "src/index.js" }]);
  });

  it("fails safely for invalid, empty, and semantically incomplete model output", async () => {
    const content = "export const value = true;\n";
    const invalidCases = ["not json", "", JSON.stringify({ summary: "" })];

    for (const [index, text] of invalidCases.entries()) {
      const workspaceRoot = await makeWorkspace({ "src/value.ts": content });
      const result = await processL1QueueItem({
        workspaceRoot,
        kbPath: join(workspaceRoot, "topchester-kb"),
        item: makeQueueItem("src/value.ts", content),
        model: makeFakeModel(text),
        now: fixedNow,
      });

      expect(result.item.status, `case ${index}`).toBe("failed");
      expect(result.entryPath).toBeUndefined();
      expect(result.item.failure?.message).not.toContain(content);
      expect(result.item.failure?.failedAt).toBe("2026-05-11T00:00:00.000Z");
    }
  });

  it("extracts one JSON object from wrappers and rejects ambiguous or missing JSON", () => {
    const entry = makeValidL1Entry();

    expect(parseL1ModelJson(`Here is the entry:\n\`\`\`json\n${JSON.stringify(entry)}\n\`\`\``)).toEqual(entry);
    expect(parseL1ModelJson(`prose before\n${JSON.stringify(entry)}\nprose after`)).toEqual(entry);
    expect(() => parseL1ModelJson(`${JSON.stringify(entry)}\n${JSON.stringify(entry)}`)).toThrow(/ambiguous/i);
    expect(() => parseL1ModelJson("no json here")).toThrow(/did not contain/i);
  });

  it("stores useful sanitized failure metadata without raw secret sentinels", async () => {
    const content = "export const secret = false;\n";
    const workspaceRoot = await makeWorkspace({ "src/secret.ts": content });
    const model: L1SummaryModel = {
      async generateText() {
        throw new Error("provider failed with SECRET_SENTINEL_DO_NOT_WRITE and sk-testsecret");
      },
    };

    const result = await processL1QueueItem({
      workspaceRoot,
      kbPath: join(workspaceRoot, "topchester-kb"),
      item: makeQueueItem("src/secret.ts", content),
      model,
      now: fixedNow,
    });

    expect(result.item.status).toBe("failed");
    expect(result.item.failure?.code).toBe("processing_error");
    expect(result.item.failure?.message).toContain("[redacted]");
    expect(JSON.stringify(result.item)).not.toContain("SECRET_SENTINEL_DO_NOT_WRITE");
    expect(JSON.stringify(result.item)).not.toContain("sk-testsecret");
  });

  it("marks changed and deleted queued files without writing current entries", async () => {
    const originalContent = "export const before = 1;\n";
    const workspaceRoot = await makeWorkspace({ "src/changed.ts": "export const after = 2;\n" });
    const missingWorkspaceRoot = await makeWorkspace({});

    const changed = await processL1QueueItem({
      workspaceRoot,
      kbPath: join(workspaceRoot, "topchester-kb"),
      item: makeQueueItem("src/changed.ts", originalContent),
      model: makeFakeModel(JSON.stringify(makeValidL1Entry())),
      now: fixedNow,
    });
    const missing = await processL1QueueItem({
      workspaceRoot: missingWorkspaceRoot,
      kbPath: join(missingWorkspaceRoot, "topchester-kb"),
      item: makeQueueItem("src/missing.ts", originalContent),
      model: makeFakeModel(JSON.stringify(makeValidL1Entry())),
      now: fixedNow,
    });

    expect(changed.item.status).toBe("changed");
    expect(changed.entryPath).toBeUndefined();
    expect(missing.item.status).toBe("missing_file");
    expect(missing.entryPath).toBeUndefined();
  });

  it("marks symlink escapes changed before model calls or current entry writes", async () => {
    const content = "export const outside = true;\n";
    const workspaceRoot = await makeWorkspace({});
    const outsideRoot = await makeWorkspace({ "outside.ts": content });
    const kbPath = join(workspaceRoot, "topchester-kb");
    const model = makeFakeModel(JSON.stringify(makeValidL1Entry()));

    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await symlink(join(outsideRoot, "outside.ts"), join(workspaceRoot, "src/link.ts"));

    const result = await processL1QueueItem({
      workspaceRoot,
      kbPath,
      item: makeQueueItem("src/link.ts", content),
      model,
      now: fixedNow,
    });

    expect(result.item.status).toBe("changed");
    expect(model.calls).toHaveLength(0);
    expect(result.entryPath).toBeUndefined();
    await expect(readFile(getL1FileEntryPath(kbPath, "src/link.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails oversized files clearly without writing placeholder current entries", async () => {
    const content = "x".repeat(256 * 1024 + 1);
    const workspaceRoot = await makeWorkspace({ "src/huge.txt": content });

    const result = await processL1QueueItem({
      workspaceRoot,
      kbPath: join(workspaceRoot, "topchester-kb"),
      item: makeQueueItem("src/huge.txt", content),
      model: makeFakeModel(JSON.stringify(makeValidL1Entry())),
      now: fixedNow,
    });

    expect(result.item.status).toBe("failed");
    expect(result.item.failure?.code).toBe("file_too_large");
    expect(result.item.failure?.message).toContain("too large");
    expect(result.entryPath).toBeUndefined();
  });
});

describe("durable L1 queue processing", () => {
  it("persists completed work, continues after failures, and writes matching manifest counts", async () => {
    const workspaceRoot = await makeWorkspace({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
      "src/c.ts": "export const c = 3;\n",
    });
    const kbPath = join(workspaceRoot, "topchester-kb");
    const cachePath = join(workspaceRoot, ".agents/topchester-kb-cache");
    const queuePath = join(cachePath, "l1-queue.json");
    const manifestPath = join(kbPath, "manifest.json");
    await mkdir(cachePath, { recursive: true });
    await writeQueue(queuePath, [
      makeQueueItem("src/a.ts", "export const a = 1;\n"),
      makeQueueItem("src/b.ts", "export const b = 2;\n"),
      makeQueueItem("src/c.ts", "export const c = 3;\n"),
    ]);
    const model = makeSequenceModel([
      JSON.stringify(makeValidL1Entry({ id: "file:src/a.ts", path: "src/a.ts" })),
      "",
      JSON.stringify(makeValidL1Entry({ id: "file:src/c.ts", path: "src/c.ts" })),
    ]);

    const result = await processL1Queue({
      workspaceRoot,
      kbPath,
      queuePath,
      manifestPath,
      gitignoreFiles: [],
      model,
      now: fixedNow,
    });

    expect(result.queuedFiles.map((item) => item.status)).toEqual(["completed", "failed", "completed"]);
    expect(result.summary).toMatchObject({
      queued: 0,
      completed: 2,
      failed: 1,
      changed: 0,
      missing: 0,
      currentEntries: 2,
    });
    expect(
      l1FileEntrySchema.parse(JSON.parse(await readFile(getL1FileEntryPath(kbPath, "src/a.ts"), "utf8"))).path
    ).toBe("src/a.ts");
    expect(
      l1FileEntrySchema.parse(JSON.parse(await readFile(getL1FileEntryPath(kbPath, "src/c.ts"), "utf8"))).path
    ).toBe("src/c.ts");
    const persistedQueue = l1QueueFileSchema.parse(JSON.parse(await readFile(queuePath, "utf8")));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    expect(persistedQueue.queuedFiles.map((item) => item.status)).toEqual(["completed", "failed", "completed"]);
    expect(manifest.compiler).toEqual(knowledgeCompilerIdentity);
    expect(manifest.l1).toEqual(result.summary);
  });

  it("skips valid current entries, regenerates stale entries, and resumes in-progress items", async () => {
    const unchanged = "export const unchanged = true;\n";
    const changed = "export const changed = true;\n";
    const resumed = "export const resumed = true;\n";
    const workspaceRoot = await makeWorkspace({
      "src/unchanged.ts": unchanged,
      "src/changed.ts": changed,
      "src/resumed.ts": resumed,
    });
    const kbPath = join(workspaceRoot, "topchester-kb");
    const cachePath = join(workspaceRoot, ".agents/topchester-kb-cache");
    const queuePath = join(cachePath, "l1-queue.json");
    const manifestPath = join(kbPath, "manifest.json");
    await mkdir(cachePath, { recursive: true });
    await mkdir(dirname(getL1FileEntryPath(kbPath, "src/unchanged.ts")), { recursive: true });
    await writeFile(
      getL1FileEntryPath(kbPath, "src/unchanged.ts"),
      `${JSON.stringify(
        makeValidL1Entry({
          id: "file:src/unchanged.ts",
          path: "src/unchanged.ts",
          content_hash: hashContent(unchanged),
          size_bytes: Buffer.byteLength(unchanged),
        }),
        null,
        2
      )}\n`
    );
    await writeFile(
      getL1FileEntryPath(kbPath, "src/changed.ts"),
      `${JSON.stringify(
        makeValidL1Entry({
          id: "file:src/changed.ts",
          path: "src/changed.ts",
          content_hash: hashContent("old"),
        }),
        null,
        2
      )}\n`
    );
    await writeQueue(queuePath, [
      makeQueueItem("src/unchanged.ts", unchanged, { status: "completed" }),
      makeQueueItem("src/changed.ts", changed, { status: "completed" }),
      makeQueueItem("src/resumed.ts", resumed, { status: "in_progress" }),
    ]);
    const model = makeSequenceModel([
      JSON.stringify(makeValidL1Entry({ id: "file:src/changed.ts", path: "src/changed.ts" })),
      JSON.stringify(makeValidL1Entry({ id: "file:src/resumed.ts", path: "src/resumed.ts" })),
    ]);

    const result = await processL1Queue({
      workspaceRoot,
      kbPath,
      queuePath,
      manifestPath,
      gitignoreFiles: [],
      model,
      now: fixedNow,
    });

    expect(model.calls).toHaveLength(2);
    expect(model.calls[0]?.prompt).toContain("src/changed.ts");
    expect(result.queuedFiles.map((item) => item.status)).toEqual(["completed", "completed", "completed"]);
    const changedEntry = l1FileEntrySchema.parse(
      JSON.parse(await readFile(getL1FileEntryPath(kbPath, "src/changed.ts"), "utf8"))
    );
    expect(changedEntry.content_hash).toBe(hashContent(changed));
  });

  it("handles changed, missing, and orphaned current entries without counting stale files current", async () => {
    const original = "export const before = 1;\n";
    const workspaceRoot = await makeWorkspace({
      "src/changed.ts": "export const after = 2;\n",
      "src/kept.ts": "export const kept = true;\n",
    });
    const kbPath = join(workspaceRoot, "topchester-kb");
    const cachePath = join(workspaceRoot, ".agents/topchester-kb-cache");
    const queuePath = join(cachePath, "l1-queue.json");
    const manifestPath = join(kbPath, "manifest.json");
    await mkdir(cachePath, { recursive: true });
    await mkdir(dirname(getL1FileEntryPath(kbPath, "src/orphan.ts")), { recursive: true });
    await writeFile(
      getL1FileEntryPath(kbPath, "src/orphan.ts"),
      `${JSON.stringify(makeValidL1Entry({ id: "file:src/orphan.ts", path: "src/orphan.ts" }), null, 2)}\n`
    );
    await writeQueue(queuePath, [
      makeQueueItem("src/changed.ts", original),
      makeQueueItem("src/missing.ts", original),
      makeQueueItem("src/kept.ts", "export const kept = true;\n"),
    ]);

    const result = await processL1Queue({
      workspaceRoot,
      kbPath,
      queuePath,
      manifestPath,
      gitignoreFiles: [],
      model: makeFakeModel(JSON.stringify(makeValidL1Entry({ id: "file:src/kept.ts", path: "src/kept.ts" }))),
      now: fixedNow,
    });

    expect(result.queuedFiles.map((item) => item.status)).toEqual(["changed", "missing_file", "completed"]);
    expect(result.summary).toMatchObject({ completed: 1, changed: 1, missing: 1, currentEntries: 1 });
    await expect(readFile(getL1FileEntryPath(kbPath, "src/orphan.ts"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects tampered persisted queues before workspace reads or writes", async () => {
    const workspaceRoot = await makeWorkspace({ "src/safe.ts": "export const safe = true;\n" });
    const kbPath = join(workspaceRoot, "topchester-kb");
    const cachePath = join(workspaceRoot, ".agents/topchester-kb-cache");
    const queuePath = join(cachePath, "l1-queue.json");
    const manifestPath = join(kbPath, "manifest.json");
    await mkdir(cachePath, { recursive: true });
    await writeFile(
      queuePath,
      `${JSON.stringify(
        {
          layer: "L1",
          generatedAt: "2026-05-11T00:00:00.000Z",
          queuedFiles: [
            {
              id: "file:../outside.ts",
              path: "../outside.ts",
              sizeBytes: 1,
              hash: hashContent("x"),
              status: "queued",
            },
          ],
        },
        null,
        2
      )}\n`
    );

    await expect(
      processL1Queue({
        workspaceRoot,
        kbPath,
        queuePath,
        manifestPath,
        gitignoreFiles: [],
        model: makeFakeModel(JSON.stringify(makeValidL1Entry())),
        now: fixedNow,
      })
    ).rejects.toThrow();
    await expect(readdir(join(kbPath, "l1-files"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
