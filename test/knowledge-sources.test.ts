import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  createAutomaticKnowledgeContext,
  getBuiltinProductKnowledgeSource,
  getKnowledgeSourceDescriptors,
  resolveTopchesterPackageRoot,
  shouldRouteToTopchesterProduct,
} from "../src/knowledge/sources/index.js";
import { getL1FileEntryPath } from "../src/knowledge/compiler/path-encoding.js";

describe("knowledge sources", () => {
  it("prefers the nearest package root inside an isolated npm prefix", async () => {
    const prefix = await mkdtemp(join(tmpdir(), "topchester-package-root-"));
    const packageRoot = join(prefix, "node_modules", "topchester-ai");
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await writeFile(join(prefix, "package.json"), '{"dependencies":{"topchester-ai":"file:fixture.tgz"}}\n');
    await writeFile(join(packageRoot, "package.json"), '{"name":"topchester-ai"}\n');

    expect(resolveTopchesterPackageRoot(join(packageRoot, "dist", "bin.mjs"))).toBe(packageRoot);
  });

  it("routes explicit and focused Topchester product requests without matching generic work", () => {
    for (const query of [
      "How does Topchester load config?",
      "What does TOPCHESTER_KB_DIR do?",
      "Run /kb status",
      "Explain knowledge sync",
      "How do project instructions work?",
    ]) {
      expect(shouldRouteToTopchesterProduct(query), query).toBe(true);
    }

    for (const query of ["Fix the config parser", "Add a hook to this React component", "Review these skills"]) {
      expect(shouldRouteToTopchesterProduct(query), query).toBe(false);
    }
  });

  it("loads product context without a project KB and keeps source provenance", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-product-only-"));
    const result = await createAutomaticKnowledgeContext(workspace, "How does Topchester configuration work?", {
      packageRoot: process.cwd(),
      productVersion: "0.76.0",
    });

    expect(result.selectedSourceIds).toEqual(["topchester"]);
    expect(result.contextPack?.relevantFiles.length).toBeGreaterThan(0);
    expect(result.contextPack?.relevantFiles.every((file) => file.sourceId === "topchester")).toBe(true);
    expect(result.contextPack?.relevantFiles.every((file) => file.sourceVersion === "0.76.0")).toBe(true);
    expect(result.contextPack?.relevantFiles.every((file) => file.readOnly)).toBe(true);
  });

  it("does not load product context for an ordinary repository query", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-product-negative-"));
    const result = await createAutomaticKnowledgeContext(workspace, "Fix the status bar rendering bug", {
      packageRoot: process.cwd(),
      productVersion: "0.76.0",
    });

    expect(result.selectedSourceIds).toEqual([]);
    expect(result.contextPack).toBeUndefined();
  });

  it("rejects a built-in source whose manifest version does not match the package", async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), "topchester-product-version-"));
    const resourceRoot = join(packageRoot, "resources", "knowledge", "topchester");
    await mkdir(resourceRoot, { recursive: true });
    const manifest = JSON.parse(
      await readFile(join(process.cwd(), "resources", "knowledge", "topchester", "manifest.json"), "utf8")
    );
    await writeFile(
      join(resourceRoot, "manifest.json"),
      `${JSON.stringify({ ...manifest, productVersion: "9.9.9" })}\n`
    );

    await expect(getBuiltinProductKnowledgeSource({ packageRoot, productVersion: "0.76.0" })).resolves.toMatchObject({
      ready: false,
      readOnly: true,
      version: "9.9.9",
      warning: expect.stringContaining("not installed Topchester 0.76.0"),
    });
  });

  it("reports project and product descriptors independently", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-source-list-"));
    const descriptors = await getKnowledgeSourceDescriptors(workspace, {
      packageRoot: process.cwd(),
      productVersion: "0.76.0",
    });

    expect(descriptors).toMatchObject([
      { id: "project", kind: "workspace", ready: false, readOnly: false, supportsSync: true },
      {
        id: "topchester",
        kind: "builtin-product",
        ready: true,
        readOnly: true,
        supportsSync: false,
        version: "0.76.0",
      },
    ]);
  });

  it("merges project and product matches without colliding equal entry ids", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-source-merge-"));
    const kbRoot = join(workspace, "topchester-kb");
    const path = "docs/configuration/config-files.md";
    const entryPath = getL1FileEntryPath(kbRoot, path);
    await mkdir(join(kbRoot, "l1-files", "docs", "configuration"), { recursive: true });
    await writeFile(join(kbRoot, "manifest.json"), '{"l1":{"currentEntries":1,"completed":1}}\n');
    await writeFile(
      entryPath,
      `${JSON.stringify({
        $schema: "../schema/file-entry.v1.json",
        id: `file:${path}`,
        layer: "L1",
        type: "file",
        path,
        language: "markdown",
        content_hash: `sha256:${"e".repeat(64)}`,
        size_bytes: 100,
        last_scanned_at: "2026-07-15T00:00:00Z",
        scan_status: "current",
        file_role: "doc",
        summary: "Project-specific Topchester configuration notes.",
        responsibilities: ["Explain Topchester configuration."],
        symbols: [],
        imports: [],
        exports: [],
        module_ids: [],
        feature_ids: [],
        test_ids: [],
        declared_test_targets: [],
        likely_test_targets: [],
        tested_by: [],
        evidence: [{ kind: "path", value: path }],
        confidence: "high",
      })}\n`
    );

    const result = await createAutomaticKnowledgeContext(workspace, "Topchester configuration", {
      packageRoot: process.cwd(),
      productVersion: "0.76.0",
    });
    const colliding = result.contextPack?.relevantFiles.filter((file) => file.id === `file:${path}`) ?? [];

    expect(result.selectedSourceIds).toEqual(["project", "topchester"]);
    expect(
      colliding.map((file) => file.sourceId).sort((left, right) => String(left).localeCompare(String(right)))
    ).toEqual(["project", "topchester"]);
  });

  it("keeps a product source failure non-blocking", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "topchester-source-failure-"));
    const result = await createAutomaticKnowledgeContext(workspace, "Topchester configuration", {
      packageRoot: process.cwd(),
      productVersion: "9.9.9",
    });

    expect(result.contextPack).toBeUndefined();
    expect(result.warnings.join(" ")).toContain("not installed Topchester 9.9.9");
  });
});
