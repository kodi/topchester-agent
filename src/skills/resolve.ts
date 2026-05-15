import { type DiscoveredSkillCandidate, type ResolvedSkills, type SkillDescriptor } from "./types.js";

export function resolveSkillCandidates(candidates: readonly DiscoveredSkillCandidate[]): ResolvedSkills {
  const byName = new Map<string, DiscoveredSkillCandidate[]>();

  for (const candidate of candidates) {
    const key = normalizeSkillName(candidate.name);
    const existing = byName.get(key);
    if (existing) {
      existing.push(candidate);
    } else {
      byName.set(key, [candidate]);
    }
  }

  const active: SkillDescriptor[] = [];
  const shadowed: SkillDescriptor[] = [];

  for (const group of byName.values()) {
    const winner = group.reduce((best, candidate) => (candidate.precedence >= best.precedence ? candidate : best));
    active.push(toDescriptor({ ...winner, shadowed: false, shadowedBy: undefined }));

    for (const candidate of group) {
      if (candidate === winner) {
        continue;
      }

      shadowed.push(
        toDescriptor({
          ...candidate,
          shadowed: true,
          shadowedBy: winner.skillDir,
        })
      );
    }
  }

  return {
    active: sortDescriptors(active),
    shadowed: sortDescriptors(shadowed),
  };
}

export function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase();
}

function toDescriptor(candidate: DiscoveredSkillCandidate): SkillDescriptor {
  const { linkedFiles: _linkedFiles, ...descriptor } = candidate;

  return descriptor;
}

function sortDescriptors(descriptors: SkillDescriptor[]): SkillDescriptor[] {
  return descriptors.sort((left, right) => {
    const nameComparison = normalizeSkillName(left.name).localeCompare(normalizeSkillName(right.name));
    if (nameComparison !== 0) {
      return nameComparison;
    }

    return left.precedence - right.precedence;
  });
}
