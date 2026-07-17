/// <reference types="bun" />

export type StandalonePlatform = "darwin" | "linux";
export type StandaloneArch = "arm64" | "x64";

export interface StandaloneTarget {
  id: string;
  platform: StandalonePlatform;
  arch: StandaloneArch;
  libc?: "glibc";
  bunTarget: Bun.Build.CompileTarget;
  directoryName: string;
  npmAliasName: string;
  npmDistTag: string;
  openTuiPackageName: string;
  executableName: "topchester";
}

export const STANDALONE_TARGETS: readonly StandaloneTarget[] = [
  createTarget("darwin", "arm64", "bun-darwin-arm64"),
  createTarget("darwin", "x64", "bun-darwin-x64-baseline"),
  createTarget("linux", "arm64", "bun-linux-arm64"),
  createTarget("linux", "x64", "bun-linux-x64-baseline"),
];

export function getCurrentStandaloneTarget(): StandaloneTarget {
  const target = STANDALONE_TARGETS.find(
    (candidate) => candidate.platform === process.platform && candidate.arch === process.arch
  );

  if (!target) {
    throw new Error(
      `Standalone Topchester packages do not support ${process.platform}-${process.arch}. Supported targets: ${STANDALONE_TARGETS.map((candidate) => candidate.id).join(", ")}.`
    );
  }

  return target;
}

export function resolveStandaloneTargets(args: readonly string[]): readonly StandaloneTarget[] {
  if (args.includes("--all")) {
    if (args.some((arg) => arg.startsWith("--target="))) {
      throw new Error("Use either --all or --target=<platform-arch>, not both.");
    }
    return STANDALONE_TARGETS;
  }

  const requestedIds = args.filter((arg) => arg.startsWith("--target=")).map((arg) => arg.slice("--target=".length));
  const unknownArgs = args.filter((arg) => arg !== "--all" && !arg.startsWith("--target="));
  if (unknownArgs.length > 0) {
    throw new Error(`Unknown standalone build arguments: ${unknownArgs.join(", ")}.`);
  }
  if (requestedIds.length === 0) {
    return [getCurrentStandaloneTarget()];
  }

  return requestedIds.map((id) => {
    const target = STANDALONE_TARGETS.find((candidate) => candidate.id === id);
    if (!target) {
      throw new Error(
        `Unknown standalone target ${id}. Supported targets: ${STANDALONE_TARGETS.map((candidate) => candidate.id).join(", ")}.`
      );
    }
    return target;
  });
}

function createTarget(
  platform: StandalonePlatform,
  arch: StandaloneArch,
  bunTarget: Bun.Build.CompileTarget
): StandaloneTarget {
  const id = `${platform}-${arch}`;
  return {
    id,
    platform,
    arch,
    ...(platform === "linux" ? { libc: "glibc" as const } : {}),
    bunTarget,
    directoryName: `topchester-${id}`,
    npmAliasName: `topchester-ai-${id}`,
    npmDistTag: id,
    openTuiPackageName: `@opentui/core-${id}`,
    executableName: "topchester",
  };
}
