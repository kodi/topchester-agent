import { loadBuiltinProductKnowledgeSource, getBuiltinProductKnowledgeSource } from "./builtin-product.js";
import { loadWorkspaceKnowledgeSource, getWorkspaceKnowledgeSource } from "./workspace.js";
import { type KnowledgeSourceDescriptor, type KnowledgeSourceId, type LoadedKnowledgeSource } from "./types.js";

export interface KnowledgeSourceRegistryOptions {
  packageRoot?: string;
  productVersion?: string;
}

export async function getKnowledgeSourceDescriptors(
  workspaceRoot: string,
  options: KnowledgeSourceRegistryOptions = {}
): Promise<KnowledgeSourceDescriptor[]> {
  return [getWorkspaceKnowledgeSource(workspaceRoot), await getBuiltinProductKnowledgeSource(options)];
}

export async function loadKnowledgeSource(
  workspaceRoot: string,
  id: KnowledgeSourceId,
  options: KnowledgeSourceRegistryOptions = {}
): Promise<LoadedKnowledgeSource> {
  return id === "project" ? loadWorkspaceKnowledgeSource(workspaceRoot) : loadBuiltinProductKnowledgeSource(options);
}
