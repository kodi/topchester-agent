import { z } from "zod";
import {
  createSkillsService,
  type LoadedSkill,
  type ResolvedSkills,
  type SkillLinkedFileGroup,
} from "../../skills/index.js";
import { defineTool, type ToolResult } from "./types.js";

export interface SkillsListToolResult extends ToolResult<"skills_list"> {
  skills: ResolvedSkills;
}

export interface SkillViewToolResult extends ToolResult<"skill_view"> {
  skill: LoadedSkill;
}

export interface SkillReadToolResult extends ToolResult<"skill_read"> {
  group: SkillLinkedFileGroup;
  relativePath: string;
  bytes: number;
  truncated: boolean;
}

export const skillViewArgsSchema = z.object({
  name: z.string().trim().min(1),
});

export type SkillViewToolArgs = z.infer<typeof skillViewArgsSchema>;

export const skillReadArgsSchema = z.object({
  name: z.string().trim().min(1),
  group: z.enum(["references", "templates", "scripts", "assets"]),
  path: z.string().trim().min(1),
});

export type SkillReadToolArgs = z.infer<typeof skillReadArgsSchema>;

export type SkillsListToolCall = {
  tool: "skills_list";
  args: Record<string, never>;
};

export type SkillViewToolCall = {
  tool: "skill_view";
  args: SkillViewToolArgs;
};

export type SkillReadToolCall = {
  tool: "skill_read";
  args: SkillReadToolArgs;
};

export const skillsListTool = defineTool({
  name: "skills_list",
  description: "List available Topchester skills as compact metadata.",
  prompt:
    'skills_list: List available on-demand skills without loading full skill bodies. Args: {}. Example: {"tool":"skills_list","args":{}}',
  argsSchema: z.object({}).strict(),
  parallelSafe: true,
  async execute(context): Promise<SkillsListToolResult> {
    const skills = await createSkillsService({ workspaceRoot: context.workspaceRoot }).listSkills();

    return {
      tool: "skills_list",
      content: formatSkillsList(skills),
      skills,
    };
  },
});

export const skillViewTool = defineTool({
  name: "skill_view",
  description: "Load the full SKILL.md content for one available Topchester skill.",
  prompt:
    'skill_view: Load full SKILL.md content for one skill by name. Args: {"name":"skill-name"}. Example: {"tool":"skill_view","args":{"name":"code-review"}}',
  argsSchema: skillViewArgsSchema,
  parallelSafe: true,
  async execute(context, args): Promise<SkillViewToolResult> {
    const skill = await createSkillsService({ workspaceRoot: context.workspaceRoot }).viewSkill(args.name);

    return {
      tool: "skill_view",
      path: skill.skillFile,
      content: formatLoadedSkill(skill),
      skill,
    };
  },
});

export const skillReadTool = defineTool({
  name: "skill_read",
  description: "Read one linked file named by an available Topchester skill.",
  prompt:
    'skill_read: Read a linked reference, template, script, or asset named by skill_view. Args: {"name":"skill-name","group":"references|templates|scripts|assets","path":"relative/path"}. Example: {"tool":"skill_read","args":{"name":"topchester","group":"references","path":"configuration.md"}}',
  argsSchema: skillReadArgsSchema,
  parallelSafe: true,
  async execute(context, args): Promise<SkillReadToolResult> {
    const result = await createSkillsService({ workspaceRoot: context.workspaceRoot }).readLinkedFile(
      args.name,
      args.group,
      args.path
    );

    return {
      tool: "skill_read",
      content: [
        `Skill: ${args.name}`,
        `Linked file: ${args.group}/${args.path}`,
        `Bytes: ${result.bytes}${result.truncated ? " (truncated)" : ""}`,
        "",
        result.content,
      ].join("\n"),
      group: args.group,
      relativePath: args.path,
      bytes: result.bytes,
      truncated: result.truncated,
    };
  },
});

function formatSkillsList(skills: ResolvedSkills): string {
  if (skills.active.length === 0) {
    return "No skills found.";
  }

  const lines = [
    "Available skills:",
    ...skills.active.map((skill) => `- ${skill.name}: ${skill.description} (${formatSkillSource(skill)})`),
  ];

  if (skills.shadowed.length > 0) {
    lines.push("", `Shadowed skills: ${skills.shadowed.length}`);
  }

  return lines.join("\n");
}

function formatLoadedSkill(skill: LoadedSkill): string {
  return [
    `Skill: ${skill.name}`,
    `Source: ${formatSkillSource(skill)}`,
    `Path: ${skill.skillFile}`,
    "",
    skill.content,
  ].join("\n");
}

function formatSkillSource(skill: { source: string; compatibilitySource?: string }): string {
  return skill.compatibilitySource ? `${skill.source}:${skill.compatibilitySource}` : skill.source;
}
