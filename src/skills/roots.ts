import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type SkillRoot } from "./types.js";

export interface BuildSkillRootsOptions {
  workspaceRoot: string;
  homeDir?: string;
  packageRoot?: string;
  sessionRoots?: string[];
}

const COMPATIBILITY_ROOTS = [
  { path: ".claude/skills", source: "claude" },
  { path: ".opencode/skills", source: "opencode" },
  { path: ".gemini/skills", source: "gemini" },
  { path: ".windsurf/skills", source: "windsurf" },
] as const;

export function buildSkillRoots(options: BuildSkillRootsOptions): SkillRoot[] {
  const workspaceRoot = resolve(options.workspaceRoot);
  const homeDir = options.homeDir ?? process.env.HOME;
  const packageRoot = options.packageRoot ?? getDefaultPackageRoot();
  let precedence = 0;
  const roots: SkillRoot[] = [];
  const addRoot = (root: Omit<SkillRoot, "precedence">) => {
    roots.push({ ...root, precedence });
    precedence += 1;
  };

  addRoot({ source: "builtin", root: join(packageRoot, "skills"), readonly: true });
  addRoot({ source: "extension", root: join(packageRoot, "extensions", "skills"), readonly: true });

  if (homeDir) {
    addRoot({ source: "user-neutral", root: join(homeDir, ".agents", "skills") });
    addRoot({ source: "user-topchester", root: join(homeDir, ".topchester", "skills") });
  }

  for (const compatibilityRoot of COMPATIBILITY_ROOTS) {
    addRoot({
      source: "workspace-compat",
      root: join(workspaceRoot, compatibilityRoot.path),
      compatibilitySource: compatibilityRoot.source,
    });
  }

  addRoot({ source: "workspace-neutral", root: join(workspaceRoot, ".agents", "skills") });
  addRoot({ source: "workspace-topchester", root: join(workspaceRoot, ".topchester", "skills") });

  for (const sessionRoot of options.sessionRoots ?? []) {
    addRoot({ source: "session", root: resolve(workspaceRoot, sessionRoot) });
  }

  return roots;
}

function getDefaultPackageRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);

  return resolve(currentFile, "../../..");
}
