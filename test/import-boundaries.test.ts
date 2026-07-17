import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const workspaceRoot = process.cwd();

describe("application import boundaries", () => {
  it("keeps session, agent, and shared run logic independent of TUI modules", async () => {
    const files = [
      ...(await listTypeScriptFiles(join(workspaceRoot, "src", "session"))),
      ...(await listTypeScriptFiles(join(workspaceRoot, "src", "agent"))),
      join(workspaceRoot, "src", "cli", "run.ts"),
    ];
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const imports = [...source.matchAll(/\b(?:from|import)\s*\(?\s*["'](?<specifier>[^"']+)["']/gu)].flatMap(
        (match) => (match.groups?.specifier ? [match.groups.specifier] : [])
      );

      if (imports.some((specifier) => /(?:^|\/)tui(?:\/|$)/u.test(specifier))) {
        offenders.push(relative(workspaceRoot, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps neutral transcript modules free of renderer and ANSI dependencies", async () => {
    const files = await listTypeScriptFiles(join(workspaceRoot, "src", "chat"));
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (/@opentui|pi-tui|\/tui\/|\/cli\/ui/u.test(source)) {
        offenders.push(relative(workspaceRoot, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps application orchestration out of OpenTUI components", async () => {
    const directory = join(workspaceRoot, "src", "tui", "opentui");
    const files = (await listTypeScriptFiles(directory)).filter((file) => !file.endsWith("/renderer.tsx"));
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const imports = [...source.matchAll(/\b(?:from|import)\s*\(?\s*["'](?<specifier>[^"']+)["']/gu)].flatMap(
        (match) => (match.groups?.specifier ? [match.groups.specifier] : [])
      );
      if (imports.some((specifier) => /\.\.\/\.\.\/(?:agent|app|config|knowledge|session|skills)\//u.test(specifier))) {
        offenders.push(relative(workspaceRoot, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("has no legacy pi-tui imports", async () => {
    const files = await listTypeScriptFiles(join(workspaceRoot, "src"));
    const offenders: string[] = [];
    for (const file of files) {
      if ((await readFile(file, "utf8")).includes("pi-tui")) offenders.push(relative(workspaceRoot, file));
    }
    expect(offenders).toEqual([]);
  });
});

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return listTypeScriptFiles(path);
      }
      return extname(entry.name) === ".ts" || entry.name.endsWith(".tsx") ? [path] : [];
    })
  );

  return files.flat();
}
