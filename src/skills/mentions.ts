import { type SkillActivation } from "./activation.js";
import { type SkillsService } from "./service.js";
import { type SkillDescriptor } from "./types.js";

const SKILL_MENTION_PATTERN = /@([A-Za-z0-9][A-Za-z0-9._-]*)/gu;

export function findSkillMentions(input: string, activeSkills: readonly SkillDescriptor[]): string[] {
  const activeNames = new Map(activeSkills.map((skill) => [skill.name.toLowerCase(), skill.name]));
  const mentions: string[] = [];
  const seen = new Set<string>();

  for (const match of input.matchAll(SKILL_MENTION_PATTERN)) {
    const candidate = match[1]?.toLowerCase();
    if (!candidate) {
      continue;
    }

    const skillName = activeNames.get(candidate);
    if (!skillName || seen.has(candidate)) {
      continue;
    }

    mentions.push(skillName);
    seen.add(candidate);
  }

  return mentions;
}

export async function resolveSkillMentionActivations(
  input: string,
  service: SkillsService
): Promise<SkillActivation[]> {
  const skills = await service.listSkills();
  const mentions = findSkillMentions(input, skills.active);

  return Promise.all(
    mentions.map(async (name) => ({
      skill: await service.viewSkill(name),
      instruction: input,
    }))
  );
}
