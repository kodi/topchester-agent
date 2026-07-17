import { existsSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type SkillRoot } from "./types.js";

declare const TOPCHESTER_PACKAGE_ROOT: string | undefined;

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
  const workspaceScopeRoots = getWorkspaceScopeRoots(workspaceRoot);
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

  for (const scopeRoot of workspaceScopeRoots) {
    for (const compatibilityRoot of COMPATIBILITY_ROOTS) {
      addRoot({
        source: "workspace-compat",
        root: join(scopeRoot, compatibilityRoot.path),
        compatibilitySource: compatibilityRoot.source,
      });
    }

    addRoot({ source: "workspace-neutral", root: join(scopeRoot, ".agents", "skills") });
    addRoot({ source: "workspace-topchester", root: join(scopeRoot, ".topchester", "skills") });
  }

  for (const sessionRoot of options.sessionRoots ?? []) {
    addRoot({ source: "session", root: resolve(workspaceRoot, sessionRoot) });
  }

  return roots;
}

function getDefaultPackageRoot(): string {
  if (typeof TOPCHESTER_PACKAGE_ROOT === "string") {
    return TOPCHESTER_PACKAGE_ROOT;
  }

  const currentFile = fileURLToPath(import.meta.url);

  return resolve(currentFile, "../../..");
}

function getWorkspaceScopeRoots(workspaceRoot: string): string[] {
  const gitRoot = findNearestGitRoot(workspaceRoot);

  if (!gitRoot || gitRoot === workspaceRoot) {
    return [workspaceRoot];
  }

  const roots: string[] = [];
  let current = workspaceRoot;

  while (true) {
    roots.push(current);
    if (current === gitRoot) {
      break;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return roots.reverse();
}

function findNearestGitRoot(start: string): string | undefined {
  let current = start;
  const root = parse(start).root;

  while (true) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }

    if (current === root) {
      return undefined;
    }

    current = dirname(current);
  }
}
