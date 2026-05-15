import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { buildSkillRoots, type BuildSkillRootsOptions } from "./roots.js";
import { resolveSkillCandidates } from "./resolve.js";
import { scanSkillRoots } from "./scanner.js";
import {
  type DiscoveredSkillCandidate,
  type LoadedSkill,
  type ResolvedSkills,
  type SkillLinkedFiles,
  type SkillRoot,
} from "./types.js";

export type SkillLinkedFileGroup = keyof SkillLinkedFiles;

export interface SkillsServiceOptions extends BuildSkillRootsOptions {
  roots?: SkillRoot[];
}

export class SkillsService {
  private cache: { candidates: DiscoveredSkillCandidate[]; resolved: ResolvedSkills } | undefined;

  constructor(private readonly options: SkillsServiceOptions) {}

  async listSkills(): Promise<ResolvedSkills> {
    return (await this.load()).resolved;
  }

  async viewSkill(name: string): Promise<LoadedSkill> {
    const candidate = await this.findActiveCandidate(name);
    const content = await readFile(candidate.skillFile, "utf8");

    return {
      ...candidate,
      shadowed: false,
      shadowedBy: undefined,
      content,
      linkedFiles: candidate.linkedFiles,
    };
  }

  async readLinkedFile(name: string, group: SkillLinkedFileGroup, relativePath: string): Promise<string> {
    const candidate = await this.findActiveCandidate(name);
    const groupRoot = resolve(candidate.skillDir, group);
    const path = resolve(groupRoot, relativePath);

    if (!isInsidePath(groupRoot, path)) {
      throw new Error(`Linked skill file path stays outside ${group}.`);
    }

    if (!(await isFile(path))) {
      throw new Error(`Linked skill file not found: ${group}/${relativePath}`);
    }

    return readFile(path, "utf8");
  }

  reload(): void {
    this.cache = undefined;
  }

  private async findActiveCandidate(name: string): Promise<DiscoveredSkillCandidate> {
    const normalizedName = name.trim().toLowerCase();
    const { candidates, resolved } = await this.load();
    const active = resolved.active.find((skill) => skill.name.toLowerCase() === normalizedName);

    if (!active) {
      throw new Error(`Unknown skill: ${name}`);
    }

    const candidate = candidates.find(
      (item) => item.name.toLowerCase() === normalizedName && item.skillDir === active.skillDir
    );

    if (!candidate) {
      throw new Error(`Skill is no longer available: ${name}`);
    }

    return candidate;
  }

  private async load(): Promise<{ candidates: DiscoveredSkillCandidate[]; resolved: ResolvedSkills }> {
    if (this.cache) {
      return this.cache;
    }

    const roots = this.options.roots ?? buildSkillRoots(this.options);
    const candidates = await scanSkillRoots(roots);
    const resolved = resolveSkillCandidates(candidates);

    this.cache = { candidates, resolved };

    return this.cache;
  }
}

export function createSkillsService(options: SkillsServiceOptions): SkillsService {
  return new SkillsService(options);
}

function isInsidePath(root: string, path: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;

  return path === root || path.startsWith(normalizedRoot);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
