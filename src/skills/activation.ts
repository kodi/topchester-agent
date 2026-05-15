import { type LoadedSkill } from "./types.js";

export interface SkillActivation {
  skill: LoadedSkill;
  instruction: string;
}

export function formatSkillActivationPrompt(activations: readonly SkillActivation[]): string {
  const sections = activations.map(({ skill, instruction }) =>
    [
      "Use the following skill for this task.",
      "",
      `[Skill: ${skill.name}]`,
      `[Skill directory: ${skill.skillDir}]`,
      "",
      skill.content,
      "",
      "User instruction:",
      instruction,
    ].join("\n")
  );

  return sections.join("\n\n---\n\n");
}

export function formatSkillActivationNotice(skillName: string, hasInstruction: boolean): string {
  return hasInstruction ? `Skill activated: ${skillName}` : `Skill activated for the next message: ${skillName}`;
}
