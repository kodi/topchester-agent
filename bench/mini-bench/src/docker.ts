import { composeFilePath, miniBenchRoot } from "./paths.ts";
import { runCommand } from "./command.ts";

export async function dockerCompose(args: string[]): Promise<void> {
  const result = await runCommand("docker", ["compose", "-f", composeFilePath, ...args], {
    cwd: miniBenchRoot,
    timeoutMs: 120_000,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      [
        `docker compose ${args.join(" ")} failed with exit code ${result.exitCode}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
}
