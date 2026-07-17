import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { getSkillMetadataFromMarkdown } from "./frontmatter.js";
import {
  type DiscoveredSkillCandidate,
  type SkillLinkedFiles,
  type SkillRoot,
  type SkillCompatibilitySource,
} from "./types.js";

const LINKED_FILE_GROUPS = ["references", "templates", "scripts", "assets"] as const;
declare const TOPCHESTER_BUILTIN_SKILL_FILES: readonly string[] | undefined;

export async function scanSkillRoots(roots: readonly SkillRoot[]): Promise<DiscoveredSkillCandidate[]> {
  const candidates = await Promise.all(roots.map((root) => scanSkillRoot(root)));

  return candidates.flat();
}

export async function scanSkillRoot(root: SkillRoot): Promise<DiscoveredSkillCandidate[]> {
  if (root.source === "builtin" && typeof TOPCHESTER_BUILTIN_SKILL_FILES !== "undefined") {
    return scanEmbeddedSkillRoot(root, TOPCHESTER_BUILTIN_SKILL_FILES);
  }

  const entries = await readDirectorySafe(root.root);
  const candidates: DiscoveredSkillCandidate[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillDir = join(root.root, entry.name);
    const skillFile = join(skillDir, "SKILL.md");

    if (!(await isFile(skillFile))) {
      continue;
    }

    const candidate = await readSkillCandidate(root, skillDir, skillFile);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

async function scanEmbeddedSkillRoot(
  root: SkillRoot,
  embeddedFiles: readonly string[]
): Promise<DiscoveredSkillCandidate[]> {
  const candidates: DiscoveredSkillCandidate[] = [];
  const skillNames = embeddedFiles
    .filter((path) => path.endsWith("/SKILL.md") && !path.slice(0, -"/SKILL.md".length).includes("/"))
    .map((path) => path.slice(0, -"/SKILL.md".length))
    .sort();

  for (const skillName of skillNames) {
    const skillDir = join(root.root, skillName);
    const candidate = await readSkillCandidate(root, skillDir, join(skillDir, "SKILL.md"), embeddedFiles);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  return candidates;
}

async function readSkillCandidate(
  root: SkillRoot,
  skillDir: string,
  skillFile: string,
  embeddedFiles?: readonly string[]
): Promise<DiscoveredSkillCandidate | undefined> {
  try {
    const content = await readFile(skillFile, "utf8");
    const metadata = getSkillMetadataFromMarkdown(content, basename(skillDir));

    return {
      name: metadata.name,
      description: metadata.description,
      source: root.source,
      root: root.root,
      skillDir,
      skillFile,
      precedence: root.precedence,
      shadowed: false,
      compatibilitySource: root.compatibilitySource as SkillCompatibilitySource | undefined,
      frontmatter: metadata.frontmatter,
      linkedFiles: embeddedFiles
        ? listEmbeddedLinkedFiles(relative(root.root, skillDir), embeddedFiles)
        : await listLinkedFiles(skillDir),
    };
  } catch {
    return undefined;
  }
}

function listEmbeddedLinkedFiles(skillName: string, embeddedFiles: readonly string[]): SkillLinkedFiles {
  const groups: SkillLinkedFiles = {
    references: [],
    templates: [],
    scripts: [],
    assets: [],
  };

  for (const group of LINKED_FILE_GROUPS) {
    const prefix = `${skillName}/${group}/`;
    groups[group] = embeddedFiles
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length))
      .sort();
  }

  return groups;
}

export async function listLinkedFiles(skillDir: string): Promise<SkillLinkedFiles> {
  const groups: SkillLinkedFiles = {
    references: [],
    templates: [],
    scripts: [],
    assets: [],
  };

  await Promise.all(
    LINKED_FILE_GROUPS.map(async (group) => {
      groups[group] = await listFilesRelative(join(skillDir, group));
    })
  );

  return groups;
}

async function listFilesRelative(root: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(dir: string): Promise<void> {
    const entries = await readDirectorySafe(dir);

    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }

      if (entry.isFile()) {
        files.push(relative(root, path));
      }
    }
  }

  if (!(await isDirectory(root))) {
    return [];
  }

  await visit(root);

  return files.sort();
}

async function readDirectorySafe(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
