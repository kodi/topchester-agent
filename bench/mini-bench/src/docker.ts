import { composeFilePath, miniBenchRoot } from "./paths.ts";
import { runCommand } from "./command.ts";

export const containerPostgresDatabaseUrl = "postgres://mini_bench:mini_bench@postgres:5432/mini_bench";
export const hostPostgresDatabaseUrl = "postgres://mini_bench:mini_bench@localhost:55432/mini_bench";

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

export async function startTaskServices(services: string[]): Promise<void> {
  if (services.length === 0) {
    return;
  }

  await dockerCompose(["up", "-d", ...services]);

  if (services.includes("postgres")) {
    await waitForPostgres();
  }
}

async function waitForPostgres(): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError = "";

  while (Date.now() < deadline) {
    const result = await runCommand(
      "docker",
      [
        "compose",
        "-f",
        composeFilePath,
        "exec",
        "-T",
        "postgres",
        "pg_isready",
        "-U",
        "mini_bench",
        "-d",
        "mini_bench",
      ],
      {
        cwd: miniBenchRoot,
        timeoutMs: 10_000,
      }
    );

    if (result.exitCode === 0) {
      return;
    }

    lastError = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`postgres service did not become ready within 60s${lastError ? `\n${lastError}` : ""}`);
}
