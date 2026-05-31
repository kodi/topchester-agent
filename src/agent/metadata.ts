import { z } from "zod";
import agentsMetadataFile from "../../agents.json" with { type: "json" };

const urlSchema = z.url();

export const agentModelRequirementsSchema = z
  .object({
    tool_calling: z.boolean().optional(),
    streaming: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    vision: z.boolean().optional(),
    json_mode: z.boolean().optional(),
  })
  .strict();

export const agentRecommendedModelSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    purpose: z.string().min(1).optional(),
    notes: z.string().min(1).optional(),
  })
  .strict();

export const agentModelSupportSchema = z
  .object({
    providers: z.array(z.string().min(1)).optional(),
    recommended: z.array(agentRecommendedModelSchema).optional(),
    requirements: agentModelRequirementsSchema.optional(),
  })
  .strict();

export const agentMetadataSchema = z
  .object({
    display_name: z.string().min(1),
    description: z.string().min(1),
    logo_image: z.string().min(1).optional(),
    external_url: urlSchema.optional(),
    source_url: urlSchema.optional(),
    docs_url: urlSchema.optional(),
    tags: z.array(z.string().min(1)).optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    model_support: agentModelSupportSchema.optional(),
  })
  .strict();

export const agentsMetadataFileSchema = z
  .object({
    version: z.literal(1),
    agents: z.record(z.string().min(1), agentMetadataSchema),
  })
  .strict();

export type AgentMetadata = z.infer<typeof agentMetadataSchema>;
export type AgentsMetadataFile = z.infer<typeof agentsMetadataFileSchema>;

export const agentsMetadata = agentsMetadataFileSchema.parse(agentsMetadataFile);

export function getAgentMetadata(agentId: string): AgentMetadata | undefined {
  return agentsMetadata.agents[agentId];
}

export function listAgentMetadata(): Array<{ id: string; metadata: AgentMetadata }> {
  return Object.entries(agentsMetadata.agents)
    .map(([id, metadata]) => ({ id, metadata }))
    .sort((left, right) => left.id.localeCompare(right.id));
}
