import { homedir } from "node:os";
import { relative } from "node:path";
import {
  fetchOpenRouterModelChoices,
  rankOpenRouterModelChoices,
  type OpenRouterModelChoice,
} from "../model/openrouter.js";

export function filterOpenRouterChoices(
  choices: readonly OpenRouterModelChoice[],
  query: string
): OpenRouterModelChoice[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return rankOpenRouterModelChoices(choices);
  }
  return choices.filter(
    (choice) =>
      choice.ref.toLowerCase().includes(normalizedQuery) ||
      choice.id.toLowerCase().includes(normalizedQuery) ||
      choice.label.toLowerCase().includes(normalizedQuery)
  );
}

export function formatModelPickerLabel(modelRef: string): string {
  return modelRef.startsWith("openrouter/") ? modelRef.slice("openrouter/".length) : modelRef;
}

export function formatHomeRelativePath(path: string): string {
  const homeRelativePath = relative(homedir(), path);
  return !homeRelativePath || homeRelativePath.startsWith("..") || homeRelativePath.startsWith("/")
    ? path
    : `~/${homeRelativePath}`;
}

export async function fetchOpenRouterChoicesWithFallback(): Promise<OpenRouterModelChoice[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return fetchOpenRouterModelChoices();
  }
  try {
    return await fetchOpenRouterModelChoices({ apiKey, userFiltered: true });
  } catch {
    return fetchOpenRouterModelChoices({ apiKey });
  }
}
