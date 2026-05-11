export interface KnowledgeProgressEvent {
  message: string;
}

export type KnowledgeProgressReporter = (event: KnowledgeProgressEvent) => void;
