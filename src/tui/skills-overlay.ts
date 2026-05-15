import { type AgentChoiceAction } from "../agent/events.js";
import { type LoadedSkill, type ResolvedSkills, type SkillDescriptor } from "../skills/index.js";

export const SKILL_OVERLAY_RELOAD_VALUE = "__topchester_skills_reload__";
export const SKILL_OVERLAY_CLOSE_VALUE = "__topchester_skills_close__";
export const SKILL_OVERLAY_BACK_VALUE = "__topchester_skills_back__";

export function filterSkillsForOverlay(skills: readonly SkillDescriptor[], query = ""): SkillDescriptor[] {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return [...skills];
  }

  return skills.filter((skill) =>
    [skill.name, skill.description, skill.source, skill.compatibilitySource]
      .filter(Boolean)
      .some((value) => value!.toLowerCase().includes(normalizedQuery))
  );
}

export function formatSkillsOverlayBody(skills: ResolvedSkills, visibleSkills: readonly SkillDescriptor[]): string {
  const lines = [
    `active: ${skills.active.length}`,
    `shadowed: ${skills.shadowed.length}`,
    "",
    ...visibleSkills.map((skill) => `${skill.name}  ${formatSkillSource(skill)}\n  ${skill.description}`),
  ];

  if (visibleSkills.length === 0) {
    lines.push("No skills matched.");
  }

  return lines.join("\n");
}

export function createSkillsOverlayActions(visibleSkills: readonly SkillDescriptor[]): AgentChoiceAction[] {
  return [
    ...visibleSkills.map((skill) => ({
      label: `Inspect ${skill.name}`,
      value: `inspect:${skill.name}`,
    })),
    { label: "Reload", value: SKILL_OVERLAY_RELOAD_VALUE },
    { label: "Close", value: SKILL_OVERLAY_CLOSE_VALUE },
  ];
}

export function formatSkillInspectBody(skill: LoadedSkill): string {
  const linkedCounts = [
    `references ${skill.linkedFiles.references.length}`,
    `templates ${skill.linkedFiles.templates.length}`,
    `scripts ${skill.linkedFiles.scripts.length}`,
    `assets ${skill.linkedFiles.assets.length}`,
  ].join(", ");

  return [
    `source: ${formatSkillSource(skill)}`,
    `path: ${skill.skillFile}`,
    `linked: ${linkedCounts}`,
    "",
    skill.content,
  ].join("\n");
}

export function createSkillInspectActions(skill: LoadedSkill): AgentChoiceAction[] {
  return [
    { label: `Activate ${skill.name}`, value: `activate:${skill.name}` },
    { label: "Back", value: SKILL_OVERLAY_BACK_VALUE },
    { label: "Close", value: SKILL_OVERLAY_CLOSE_VALUE },
  ];
}

export function formatSkillSource(skill: { source: string; compatibilitySource?: string }): string {
  return skill.compatibilitySource ? `${skill.source}:${skill.compatibilitySource}` : skill.source;
}
