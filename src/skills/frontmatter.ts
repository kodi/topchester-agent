import { parseDocument } from "yaml";
import { DEFAULT_SKILL_DESCRIPTION, type ParsedSkillMarkdown } from "./types.js";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;

export function parseSkillMarkdown(content: string): ParsedSkillMarkdown {
  const match = FRONTMATTER_PATTERN.exec(content);

  if (!match) {
    return { body: content };
  }

  const document = parseDocument(match[1] ?? "");
  const value = document.toJSON();
  const frontmatter = isRecord(value) ? value : {};

  return {
    frontmatter,
    body: content.slice(match[0].length).replace(/^\r?\n/u, ""),
  };
}

export function getSkillMetadataFromMarkdown(
  content: string,
  fallbackName: string
): { name: string; description: string; frontmatter?: Record<string, unknown>; body: string } {
  const parsed = parseSkillMarkdown(content);
  const name =
    typeof parsed.frontmatter?.name === "string" && parsed.frontmatter.name.trim()
      ? parsed.frontmatter.name.trim()
      : fallbackName;
  const description =
    typeof parsed.frontmatter?.description === "string" && parsed.frontmatter.description.trim()
      ? parsed.frontmatter.description.trim()
      : DEFAULT_SKILL_DESCRIPTION;

  return {
    name,
    description,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
