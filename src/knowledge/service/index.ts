export interface KnowledgeService {
  start(): Promise<void>;
  stop(): Promise<void>;
}
