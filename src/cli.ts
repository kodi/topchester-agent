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
  .option("--workspace <path>", "workspace root", cwd())
  .option("--dev <flag>", "enable a development flag", collectDevFlag, []);

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
  if (context.devFlags.size > 0) {
    console.log(`dev flags: ${[...context.devFlags].join(", ")}`);
  }

  if (Object.keys(assignments).length === 0) {
    console.log("model assignments: none configured");
  } else {
    console.log("model assignments:");
    for (const [purpose, model] of Object.entries(assignments)) {
      const provider = model.provider ? ` [${model.provider}]` : "";
      console.log(`  ${purpose}: ${model.name}${provider}`);
    }
  }

  const namedProviders = Object.entries(providers).filter(([providerId]) => providerId !== "default");

  if (namedProviders.length === 0) {
    console.log("providers: none configured");
  } else {
    console.log("providers:");
    if (typeof providers.default === "string") {
      console.log(`  default: ${providers.default}`);
    }
    for (const [providerId, provider] of namedProviders) {
      if (typeof provider === "string") {
        continue;
      }
      const auth = provider.apiKeyEnv ? `env:${provider.apiKeyEnv}` : provider.apiKey ? "inline" : "none";
      console.log(`  ${providerId}: ${provider.type} ${provider.baseURL} auth=${auth}`);
    }
  }
}

function createContextFromOptions() {
  const options = program.opts<{ config?: string; workspace: string; dev: string[] }>();

  return createAppContext({
    workspaceRoot: options.workspace,
    configPath: options.config && (isAbsolute(options.config) ? options.config : resolve(cwd(), options.config)),
    devFlags: options.dev,
  });
}

function collectDevFlag(flag: string, flags: string[]): string[] {
  return [...flags, flag];
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
