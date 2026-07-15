import {
  getToolDefinitionsForPermissions,
  toolRegistry,
  type RegisteredTool,
  type ToolName,
} from "./tools/registry.js";

export type AgentProfileMode = "primary" | "subagent" | "all";
export type ToolPermissionDefault = "allow" | "deny";

export interface AgentProfile {
  id: string;
  displayName: string;
  mode: AgentProfileMode;
  promptAdditions: string[];
  modelPurpose: "agent.primary" | "agent.fast";
  toolPermissionDefault: ToolPermissionDefault;
  allowedTools: readonly ToolName[];
  deniedTools: readonly ToolName[];
}

export interface ToolPermissionView {
  profileId: string;
  defaultPermission: ToolPermissionDefault;
  allowedTools: ReadonlySet<ToolName>;
  deniedTools: ReadonlySet<ToolName>;
}

export interface ToolPermissionParentView {
  deniedTools?: Iterable<ToolName>;
}

const READ_ONLY_TOOLS = [
  "read_file",
  "list_files",
  "grep",
  "find_file",
  "git_status",
  "git_diff",
  "git_log",
  "skills_list",
  "skill_view",
  "skill_read",
] as const satisfies readonly ToolName[];

export const PRIMARY_AGENT_PROFILE: AgentProfile = {
  id: "primary",
  displayName: "Primary",
  mode: "primary",
  promptAdditions: [],
  modelPurpose: "agent.primary",
  toolPermissionDefault: "allow",
  allowedTools: [],
  deniedTools: [],
};

export const SUBAGENT_PROFILES = [
  {
    id: "explore",
    displayName: "Explore",
    mode: "subagent",
    promptAdditions: [
      "You are running as a read-only exploration subagent. Inspect the workspace and return concise findings to the parent agent.",
    ],
    modelPurpose: "agent.fast",
    toolPermissionDefault: "deny",
    allowedTools: READ_ONLY_TOOLS,
    deniedTools: ["task", "plan_todo", "bash"],
  },
  {
    id: "general",
    displayName: "General",
    mode: "subagent",
    promptAdditions: [
      "You are running as a constrained subagent. Work only on the delegated prompt and return a concise result.",
    ],
    modelPurpose: "agent.primary",
    toolPermissionDefault: "allow",
    allowedTools: [],
    deniedTools: ["task", "plan_todo", "bash"],
  },
] as const satisfies readonly AgentProfile[];

export const AGENT_PROFILES = [PRIMARY_AGENT_PROFILE, ...SUBAGENT_PROFILES] as const satisfies readonly AgentProfile[];

export function resolveAgentProfile(profileId = PRIMARY_AGENT_PROFILE.id): AgentProfile {
  const profile = AGENT_PROFILES.find((candidate) => candidate.id === profileId);

  if (!profile) {
    throw new Error(`Unknown agent profile "${profileId}".`);
  }

  return profile;
}

export function createToolPermissionView(
  profile: AgentProfile,
  parent: ToolPermissionParentView = {}
): ToolPermissionView {
  const deniedTools = new Set<ToolName>(profile.deniedTools);

  for (const tool of parent.deniedTools ?? []) {
    deniedTools.add(tool);
  }

  return {
    profileId: profile.id,
    defaultPermission: profile.toolPermissionDefault,
    allowedTools: new Set(profile.allowedTools),
    deniedTools,
  };
}

export function isToolAllowed(permissionView: ToolPermissionView, toolName: string): toolName is ToolName {
  if (!isRegisteredToolName(toolName)) {
    return false;
  }

  if (permissionView.deniedTools.has(toolName)) {
    return false;
  }

  if (permissionView.defaultPermission === "deny") {
    return permissionView.allowedTools.has(toolName);
  }

  return true;
}

export function getProfileToolDefinitions(permissionView: ToolPermissionView): RegisteredTool[] {
  return getToolDefinitionsForPermissions((toolName) => isToolAllowed(permissionView, toolName));
}

export function getDeniedToolNames(permissionView: ToolPermissionView): ToolName[] {
  return [...permissionView.deniedTools].sort();
}

function isRegisteredToolName(toolName: string): toolName is ToolName {
  return toolName in toolRegistry;
}
