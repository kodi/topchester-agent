import { isToolAllowed, type ToolPermissionView } from "../profiles.js";
import {
  getToolDefinition,
  getToolDefinitionsForPermissions,
  isParallelSafeToolName,
  isToolName,
  type ToolName,
} from "./registry.js";
import { type ToolDefinition, type ToolResult } from "./types.js";

export type RuntimeToolDefinition = ToolDefinition<string, unknown, ToolResult>;

export interface ToolCatalog {
  definitions(): RuntimeToolDefinition[];
  has(name: string): boolean;
  get(name: string): RuntimeToolDefinition | undefined;
  isParallelSafe(name: string): boolean;
}

export function createToolCatalog(definitions: readonly RuntimeToolDefinition[]): ToolCatalog {
  const definitionMap = new Map(definitions.map((definition) => [definition.name, definition]));

  return {
    definitions() {
      return [...definitionMap.values()];
    },
    has(name) {
      return definitionMap.has(name);
    },
    get(name) {
      return definitionMap.get(name);
    },
    isParallelSafe(name) {
      const definition = definitionMap.get(name);

      return Boolean(
        definition?.parallelSafe && !definition.mutatesWorkspace && !definition.requiresExclusiveWorkspace
      );
    },
  };
}

export function createStaticToolCatalog(filter?: (toolName: ToolName) => boolean): ToolCatalog {
  return createToolCatalog(getToolDefinitionsForPermissions(filter) as RuntimeToolDefinition[]);
}

export function createProfileToolCatalog(
  permissionView: ToolPermissionView,
  dynamicDefinitions: readonly RuntimeToolDefinition[] = []
): ToolCatalog {
  const staticDefinitions = getToolDefinitionsForPermissions((toolName) => isToolAllowed(permissionView, toolName));
  const permittedDynamicDefinitions =
    permissionView.profileId === "primary" && permissionView.defaultPermission === "allow" ? dynamicDefinitions : [];

  return createToolCatalog([...staticDefinitions, ...permittedDynamicDefinitions] as RuntimeToolDefinition[]);
}

export const staticToolCatalog = createStaticToolCatalog();

export function getCatalogToolDefinition(catalog: ToolCatalog, name: string): RuntimeToolDefinition | undefined {
  return catalog.get(name);
}

export function isCatalogToolAllowed(catalog: ToolCatalog, permissionView: ToolPermissionView, name: string): boolean {
  if (!catalog.has(name)) {
    return false;
  }

  if (isToolName(name)) {
    return isToolAllowed(permissionView, name);
  }

  return permissionView.profileId === "primary" && permissionView.defaultPermission === "allow";
}

export function getStaticOrCatalogToolDefinition(
  catalog: ToolCatalog | undefined,
  name: string
): RuntimeToolDefinition | undefined {
  if (catalog) {
    return catalog.get(name);
  }

  return isToolName(name) ? (getToolDefinition(name) as RuntimeToolDefinition) : undefined;
}

export function isStaticOrCatalogParallelSafe(catalog: ToolCatalog | undefined, name: string): boolean {
  return catalog ? catalog.isParallelSafe(name) : isParallelSafeToolName(name);
}
