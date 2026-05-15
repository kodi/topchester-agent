import { z } from "zod";
import { createSkillsService, type LoadedSkill, type ResolvedSkills } from "../../skills/index.js";
import { defineTool, type ToolResult } from "./types.js";

export interface SkillsListToolResult extends ToolResult<"skills_list"> {
  skills: ResolvedSkills;
}

export interface SkillViewToolResult extends ToolResult<"skill_view"> {
  skill: LoadedSkill;
}

export const skillViewArgsSchema = z.object({
  name: z.string().trim().min(1),
});

export type SkillViewToolArgs = z.infer<typeof skillViewArgsSchema>;

export type SkillsListToolCall = {
  tool: "skills_list";
  args: Record<string, never>;
};

export type SkillViewToolCall = {
  tool: "skill_view";
  args: SkillViewToolArgs;
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
