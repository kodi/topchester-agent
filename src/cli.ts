#!/usr/bin/env node
import { cwd } from "node:process";
import { isAbsolute, resolve } from "node:path";
import { Command } from "commander";
import { createAppContext } from "./app/context.js";
import { ui } from "./cli/ui.js";
import { getKnowledgeStatus } from "./knowledge/status.js";
import { TopchesterTuiShell } from "./tui/index.js";

const program = new Command();

program.name("topchester").description("KB-first terminal coding agent").version("0.0.0");

program
  .option("-c, --config <path>", "explicit config file path")
  .option("--workspace <path>", "workspace root", cwd());

program.action(async () => {
  const context = createContextFromOptions();

  await new TopchesterTuiShell(context).render();
});

program
  .command("dev")
  .description("start local development mode")
  .action(() => {
    const context = createContextFromOptions();

    console.log("Topchester local dev mode");
    printStartupSummary(context);
  });

const kbCommand = program.command("kb").description("knowledge base commands");

kbCommand
  .command("init")
  .description("initialize a project knowledge base")
  .action(() => {
    const context = createContextFromOptions();

    console.log("KB init: not implemented yet");
    console.log(`workspace: ${context.workspaceRoot}`);
  });

kbCommand
  .command("compile")
  .description("compile the project knowledge base")
  .action(() => {
    const context = createContextFromOptions();

    console.log("KB compile: not implemented yet");
    console.log(`workspace: ${context.workspaceRoot}`);
  });

kbCommand
  .command("status")
  .description("show project knowledge base status")
  .action(async () => {
    const context = createContextFromOptions();
    const status = await ui.spinner("Checking knowledge base...", () => getKnowledgeStatus(context.workspaceRoot));

    console.log(ui.heading("KB status"));
    console.log(`${ui.label("workspace")}: ${status.workspaceRoot}`);
    console.log(
      `${ui.label("knowledge folder")}: ${formatPathStatus(status.kbPath, status.kbExists, status.kbIsDirectory)} ${ui.label(`(${status.kbPathSource})`)}`
    );
    console.log(
      `${ui.label("local cache folder")}: ${formatPathStatus(status.cachePath, status.cacheExists, status.cacheIsDirectory)} ${ui.label(`(${status.cachePathSource})`)}`
    );

    if (!status.kbExists) {
      console.log(`${ui.label("state")}: ${ui.warn("no knowledge base found yet")}`);
    } else if (!status.kbIsDirectory) {
      console.log(`${ui.label("state")}: ${ui.error("knowledge base path is not a folder")}`);
    } else {
      console.log(`${ui.label("state")}: ${ui.ok("knowledge base found")}`);
    }
  });

await program.parseAsync();

function printStartupSummary(context: ReturnType<typeof createAppContext>) {
  const assignments = context.config.models?.assignments ?? {};
  const providers = context.config.models?.providers ?? {};

  console.log(`workspace: ${context.workspaceRoot}`);
  console.log(`default model purpose: ${context.config.models?.defaultPurpose ?? "agent.primary"}`);

  if (Object.keys(assignments).length === 0) {
    console.log("model assignments: none configured");
  } else {
    console.log("model assignments:");
    for (const [purpose, modelRef] of Object.entries(assignments)) {
      console.log(`  ${purpose}: ${modelRef}`);
    }
  }

  if (Object.keys(providers).length === 0) {
    console.log("providers: none configured");
  } else {
    console.log("providers:");
    for (const [providerId, provider] of Object.entries(providers)) {
      const auth = provider.apiKeyEnv ? `env:${provider.apiKeyEnv}` : provider.apiKey ? "inline" : "none";
      console.log(`  ${providerId}: ${provider.type} ${provider.baseURL} auth=${auth}`);
    }
  }
}

function createContextFromOptions() {
  const options = program.opts<{ config?: string; workspace: string }>();

  return createAppContext({
    workspaceRoot: options.workspace,
    configPath: options.config && (isAbsolute(options.config) ? options.config : resolve(cwd(), options.config)),
  });
}

function formatPathStatus(path: string, exists: boolean, isDirectory: boolean): string {
  if (!exists) {
    return `${path} ${ui.warn("[missing]")}`;
  }

  if (!isDirectory) {
    return `${path} ${ui.error("[not a folder]")}`;
  }

  return `${path} ${ui.ok("[ok]")}`;
}
