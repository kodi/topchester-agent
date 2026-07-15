import { getKnowledgeStatus } from "../status.js";
import { loadL1KnowledgeIndexFromRoot } from "../search.js";
import { type KnowledgeSourceDescriptor, type LoadedKnowledgeSource } from "./types.js";

export function getWorkspaceKnowledgeSource(workspaceRoot: string): KnowledgeSourceDescriptor {
  const status = getKnowledgeStatus(workspaceRoot);

  return {
    id: "project",
    kind: "workspace",
    rootPath: status.kbPath,
    pathLabel: status.kbPath,
    readOnly: false,
    ready: status.kbIsDirectory && status.kbContentState === "ready",
    supportsSync: true,
    ...(!status.kbExists
      ? { warning: "Project knowledge has not been created yet." }
      : !status.kbIsDirectory
        ? { warning: "Project knowledge path is not a folder." }
        : status.kbContentState !== "ready"
          ? { warning: "Project knowledge is empty." }
          : {}),
  };
}

export async function loadWorkspaceKnowledgeSource(workspaceRoot: string): Promise<LoadedKnowledgeSource> {
  const descriptor = getWorkspaceKnowledgeSource(workspaceRoot);

  if (!descriptor.ready) {
    throw new Error(descriptor.warning ?? "Project knowledge is unavailable.");
  }

  const loaded = await loadL1KnowledgeIndexFromRoot(workspaceRoot, descriptor.rootPath);

  return {
    ...descriptor,
    index: loaded.index,
    entryCount: loaded.index.size,
    invalidEntryCount: loaded.invalidEntryCount,
  };
}
