import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { checkTopchesterProductPack } from "../src/knowledge/product/pack.js";

describe("Topchester product knowledge pack", () => {
  it("is portable, current, schema-valid, and version-matched", async () => {
    const result = await checkTopchesterProductPack(process.cwd());

    expect(result.manifest.sourceId).toBe("topchester");
    expect(result.manifest.sourceKind).toBe("builtin-product");
    expect(result.manifest.productVersion).toBe("0.76.0");
    expect(result.sourcePaths.length).toBeGreaterThan(20);
    expect(result.entryPaths).toHaveLength(result.sourcePaths.length);
    expect(JSON.stringify(result.manifest)).not.toContain(process.cwd());
  });

  it("ships only paths allowed by the product specification", async () => {
    const result = await checkTopchesterProductPack(process.cwd());
    const entryTexts = await Promise.all(result.entryPaths.map((path) => readFile(path, "utf8")));

    expect(result.sourcePaths.some((path) => path.startsWith("docs/configuration/"))).toBe(true);
    expect(result.sourcePaths.some((path) => path.startsWith("docs/features/"))).toBe(true);
    expect(result.sourcePaths.some((path) => path.startsWith("docs/plans/"))).toBe(false);
    expect(entryTexts.every((text) => !text.includes("workspaceRoot"))).toBe(true);
  });

  it("fails clearly when an allowlisted input changes without regeneration", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "topchester-product-stale-"));
    for (const path of ["docs", "skills", "knowledge", "resources", "package.json", "agents.json"]) {
      await cp(join(process.cwd(), path), join(fixture, path), { recursive: true });
    }
    const input = join(fixture, "docs", "configuration", "ignore-paths.md");
    await writeFile(input, `${await readFile(input, "utf8")}\nStale fixture change.\n`);

    await expect(checkTopchesterProductPack(fixture)).rejects.toThrow("source hashes are stale");
  });
});
