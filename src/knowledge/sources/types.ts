import { type L1InMemoryIndex } from "../search.js";

export type KnowledgeSourceId = "project" | "topchester";
export type KnowledgeSourceKind = "workspace" | "builtin-product";
export type KnowledgeSourceSelection = KnowledgeSourceId | "all";

export interface KnowledgeSourceDescriptor {
  id: KnowledgeSourceId;
  kind: KnowledgeSourceKind;
  rootPath: string;
  pathLabel: string;
  readOnly: boolean;
  ready: boolean;
  supportsSync: boolean;
  version?: string;
  warning?: string;
}

export interface LoadedKnowledgeSource extends KnowledgeSourceDescriptor {
  index: L1InMemoryIndex;
  entryCount: number;
  invalidEntryCount: number;
}
