export type SkillSourceKind =
  | "builtin"
  | "extension"
  | "user-neutral"
  | "user-topchester"
  | "workspace-compat"
  | "workspace-neutral"
  | "workspace-topchester"
  | "session";

export type SkillCompatibilitySource = "claude" | "opencode" | "gemini" | "windsurf";

export interface SkillRoot {
  source: SkillSourceKind;
  root: string;
  precedence: number;
  compatibilitySource?: SkillCompatibilitySource;
  readonly?: boolean;
}

export interface SkillDescriptor {
  name: string;
  description: string;
  source: SkillSourceKind;
  root: string;
  skillDir: string;
  skillFile: string;
  precedence: number;
  shadowed: boolean;
  shadowedBy?: string;
  compatibilitySource?: SkillCompatibilitySource;
  frontmatter?: Record<string, unknown>;
}

export interface SkillLinkedFiles {
  references: string[];
  templates: string[];
  scripts: string[];
  assets: string[];
}

export interface LoadedSkill extends SkillDescriptor {
  content: string;
  linkedFiles: SkillLinkedFiles;
}

export interface ParsedSkillMarkdown {
  frontmatter?: Record<string, unknown>;
  body: string;
}

export interface DiscoveredSkillCandidate extends SkillDescriptor {
  linkedFiles: SkillLinkedFiles;
}

export interface ResolvedSkills {
  active: SkillDescriptor[];
  shadowed: SkillDescriptor[];
}

export const DEFAULT_SKILL_DESCRIPTION = "No description provided.";
